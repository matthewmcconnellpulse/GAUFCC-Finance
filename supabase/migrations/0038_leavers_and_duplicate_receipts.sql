-- 0038 — leavers on people records, and duplicate-receipt detection.
--
-- · People gain a leaver stamp (end_date + archived_at/by). Marking someone
--   as a leaver keeps every record and is reversible; permanent deletion is
--   the delete-person edge function (pulse_admin, audit-logged, storage
--   objects removed with it).
-- · Receipt uploads carry a SHA-256 of the file. claim_duplicate_warnings()
--   reports, for one claim, any line whose receipt file has been claimed
--   before (exact_file) or whose date+amount already appears on another line
--   (same_date_amount) — the second catches re-photographed receipts.

alter table public.people
  add column if not exists end_date date,
  add column if not exists leaver_note text,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles (id) on delete set null;

create index if not exists people_archived_idx
  on public.people (archived_at)
  where archived_at is not null;

alter table public.expense_lines
  add column if not exists receipt_sha256 text;

create index if not exists expense_lines_receipt_hash_idx
  on public.expense_lines (receipt_sha256)
  where receipt_sha256 is not null;

-- ── person guard: leaver fields are payroll's, not the person's ─────────────

create or replace function app_private.guard_person_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.role := app_private.get_role(auth.uid());
begin
  if auth.uid() is null or v_role in ('pulse_admin', 'pulse_payroll') then
    return new;
  end if;

  if new.profile_id is distinct from old.profile_id
     or new.type is distinct from old.type then
    raise exception 'this field is managed by the payroll team';
  end if;

  if new.end_date is distinct from old.end_date
     or new.leaver_note is distinct from old.leaver_note
     or new.archived_at is distinct from old.archived_at
     or new.archived_by is distinct from old.archived_by then
    raise exception 'leaver details are managed by the payroll team';
  end if;

  if new.onboarding_status is distinct from old.onboarding_status
     and new.onboarding_status in ('verified', 'complete') then
    raise exception 'verification is performed by the payroll team';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_person_update() from public;

-- ── duplicate receipt warnings ──────────────────────────────────────────────
-- SECURITY DEFINER so a submitter is told their receipt has been claimed
-- before even when the earlier claim belongs to someone else — the whole
-- point of the check. Only a summary crosses that boundary (who, when, how
-- much, what status), never the other claim's lines or receipts, and the
-- caller must be able to see the claim being checked.

create or replace function public.claim_duplicate_warnings(p_claim_id uuid)
returns table (
  line_id uuid,
  match_type text,
  other_line_id uuid,
  other_claim_id uuid,
  other_claim_status public.claim_status,
  other_submitter text,
  other_date date,
  other_gross numeric,
  other_is_mine boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.role := app_private.get_role(auth.uid());
  v_owner uuid := app_private.claim_owner(p_claim_id);
begin
  if auth.uid() is null then
    return;
  end if;
  -- visibility mirrors expense_claims_select
  if not (
    (v_owner = auth.uid() and v_role is not null)
    or v_role in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  ) then
    return;
  end if;

  return query
  with mine as (
    select l.id, l.receipt_sha256, l.date, l.gross
      from public.expense_lines l
     where l.claim_id = p_claim_id
  )
  select distinct on (m.id, other.id)
         m.id,
         case when m.receipt_sha256 is not null and other.receipt_sha256 = m.receipt_sha256
                then 'exact_file'
              else 'same_date_amount'
         end as match_type,
         other.id,
         other.claim_id,
         c.status,
         coalesce(nullif(btrim(pr.full_name), ''), 'someone else'),
         other.date,
         other.gross,
         c.submitter_id = auth.uid()
    from mine m
    join public.expense_lines other
      on other.claim_id <> p_claim_id
     and (
           (m.receipt_sha256 is not null and other.receipt_sha256 = m.receipt_sha256)
           or (m.gross > 0 and other.gross = m.gross and other.date = m.date)
         )
    join public.expense_claims c on c.id = other.claim_id
    left join public.profiles pr on pr.id = c.submitter_id
   where c.archived_at is null
   order by m.id, other.id, match_type;
end;
$$;

revoke all on function public.claim_duplicate_warnings(uuid) from public;
grant execute on function public.claim_duplicate_warnings(uuid) to authenticated;
