-- 0004 — audit log and the generic change-capture trigger.
--
-- Security intent: an append-only trail of every write to sensitive tables and
-- every view of decrypted bank details. Clients cannot insert, update or
-- delete audit rows — inserts happen only inside SECURITY DEFINER trigger
-- functions and RPCs (owned by postgres, which bypasses RLS). Only pulse_admin
-- can read the trail. Encrypted PII (any *_enc column) is stripped before the
-- row snapshot is stored, so ciphertext never appears in the log either.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid, -- auth.uid() of the actor; null for service-role / system writes
  action text not null, -- INSERT | UPDATE | DELETE | domain actions e.g. bank_details_viewed
  entity text not null, -- table or logical entity name
  entity_id text, -- pk of the affected row when known
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Append-only audit trail. Written only by SECURITY DEFINER functions; readable only by pulse_admin.';

create index audit_log_entity_idx on public.audit_log (entity, entity_id);
create index audit_log_actor_idx on public.audit_log (actor_id, created_at);
create index audit_log_created_idx on public.audit_log (created_at);

-- ── PII stripper ─────────────────────────────────────────────────────────────
-- Removes every key ending in "_enc" from a row snapshot. NOTE: underscore is a
-- LIKE wildcard, hence the escape.

create or replace function app_private.strip_pii(p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_object_agg(e.key, e.value)
      from jsonb_each(p) as e (key, value)
      where e.key not like '%\_enc' escape '\'
    ),
    '{}'::jsonb
  )
$$;

revoke all on function app_private.strip_pii(jsonb) from public;

-- ── generic audit trigger ────────────────────────────────────────────────────
-- Attached (in migration 0013) to: profiles, funds, expense_claims,
-- expense_lines, people, settings, epworth_fund_mappings, bank_imports,
-- vat_periods, integrity_stamps, fund_managers.

create or replace function app_private.audit_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_entity_id text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_before := app_private.strip_pii(to_jsonb(old));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_after := app_private.strip_pii(to_jsonb(new));
  end if;

  -- most tables key on "id"; settings keys on "key"
  v_entity_id := coalesce(
    case when tg_op = 'DELETE' then to_jsonb(old) ->> 'id' else to_jsonb(new) ->> 'id' end,
    case when tg_op = 'DELETE' then to_jsonb(old) ->> 'key' else to_jsonb(new) ->> 'key' end
  );

  insert into public.audit_log (actor_id, action, entity, entity_id, before, after)
  values (auth.uid(), tg_op, tg_table_name, v_entity_id, v_before, v_after);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.audit_changes() from public;
