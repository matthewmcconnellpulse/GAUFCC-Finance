-- 0008 — people, PII encryption, onboarding.
--
-- Security intent (the headline for trustees): bank details and NI numbers are
-- NEVER stored in plaintext. Writes encrypt with pgp_sym_encrypt using a key
-- held in Supabase Vault (secret named 'pii_key' — the VALUE is inserted at
-- deploy time, never in a migration). The UI only ever sees server-masked
-- text (last digits). Decryption happens in exactly one place —
-- get_person_bank_details() — which is restricted to pulse_payroll /
-- pulse_admin and writes an audit_log row on EVERY call.

-- ── vault-backed encryption helpers ─────────────────────────────────────────
-- All three are SECURITY DEFINER owned by postgres; the vault is only readable
-- inside them. No client role can execute them directly.

create or replace function app_private.pii_key()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select ds.decrypted_secret into v_key
  from vault.decrypted_secrets ds
  where ds.name = 'pii_key'
  limit 1;

  if v_key is null then
    raise exception 'vault secret pii_key is missing — insert it before writing PII';
  end if;

  return v_key;
end;
$$;

create or replace function app_private.encrypt_pii(p_plain text)
returns bytea
language sql
security definer
set search_path = ''
as $$
  select case
    when p_plain is null or p_plain = '' then null
    else extensions.pgp_sym_encrypt(p_plain, app_private.pii_key())
  end
$$;

create or replace function app_private.decrypt_pii(p_cipher bytea)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_cipher is null then null
    else extensions.pgp_sym_decrypt(p_cipher, app_private.pii_key())
  end
$$;

revoke all on function app_private.pii_key() from public;
revoke all on function app_private.encrypt_pii(text) from public;
revoke all on function app_private.decrypt_pii(bytea) from public;
-- service_role (edge functions) may encrypt/decrypt server-side; browsers never can.
grant execute on function app_private.encrypt_pii(text) to service_role;
grant execute on function app_private.decrypt_pii(bytea) to service_role;

-- masking helper: keep the last N characters, blot the rest
create or replace function app_private.mask_keep_last(p_value text, p_keep integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or p_value = '' then null
    else repeat('•', greatest(length(p_value) - p_keep, 0)) || right(p_value, p_keep)
  end
$$;

revoke all on function app_private.mask_keep_last(text, integer) from public;

-- ── people ───────────────────────────────────────────────────────────────────

create table public.people (
  id uuid primary key default gen_random_uuid(),
  type public.person_type not null,
  first_name text not null default '',
  last_name text not null default '',
  email text,
  phone text,
  address text,
  date_of_birth date,
  -- encrypted-at-rest PII; plaintext never stored, masked derivations below
  ni_number_enc bytea,
  ni_number_masked text,
  bank_name text,
  bank_account_enc bytea,
  bank_account_masked text, -- e.g. '••••1234'
  bank_sort_code_enc bytea,
  bank_sort_code_masked text,
  emergency_contact_name text,
  emergency_contact_phone text,
  role_title text,
  volunteer_capacity text, -- volunteers only; employees skip
  start_date date,
  onboarding_status public.onboarding_status not null default 'invited',
  profile_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index people_profile_idx on public.people (profile_id);
create index people_status_idx on public.people (onboarding_status);

drop trigger if exists people_set_updated_at on public.people;
create trigger people_set_updated_at
  before update on public.people
  for each row execute function app_private.set_updated_at();

-- ── masked columns computed on write ─────────────────────────────────────────
-- Whenever an *_enc column changes, decrypt inside this definer trigger and
-- derive the mask. The plaintext exists only inside this function call.

create or replace function app_private.mask_person_pii()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_changed boolean := true;
  v_sort_changed boolean := true;
  v_ni_changed boolean := true;
begin
  -- note: OLD must not be referenced on INSERT, and Postgres does not
  -- guarantee boolean short-circuiting — hence the explicit branch.
  if tg_op = 'UPDATE' then
    v_account_changed := new.bank_account_enc is distinct from old.bank_account_enc;
    v_sort_changed := new.bank_sort_code_enc is distinct from old.bank_sort_code_enc;
    v_ni_changed := new.ni_number_enc is distinct from old.ni_number_enc;
  end if;

  -- bank account: keep last 4
  if v_account_changed then
    new.bank_account_masked := app_private.mask_keep_last(
      regexp_replace(coalesce(app_private.decrypt_pii(new.bank_account_enc), ''), '\s', '', 'g'), 4);
    if new.bank_account_masked = '' then new.bank_account_masked := null; end if;
  end if;

  -- sort code: keep last 2
  if v_sort_changed then
    new.bank_sort_code_masked := app_private.mask_keep_last(
      regexp_replace(coalesce(app_private.decrypt_pii(new.bank_sort_code_enc), ''), '[^0-9]', '', 'g'), 2);
    if new.bank_sort_code_masked = '' then new.bank_sort_code_masked := null; end if;
  end if;

  -- NI number: keep last 3
  if v_ni_changed then
    new.ni_number_masked := app_private.mask_keep_last(
      regexp_replace(coalesce(app_private.decrypt_pii(new.ni_number_enc), ''), '\s', '', 'g'), 3);
    if new.ni_number_masked = '' then new.ni_number_masked := null; end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.mask_person_pii() from public;

drop trigger if exists people_mask_pii on public.people;
create trigger people_mask_pii
  before insert or update on public.people
  for each row execute function app_private.mask_person_pii();

-- ── submitter guard ──────────────────────────────────────────────────────────
-- RLS (0014) lets a submitter update their own row while onboarding; this
-- trigger stops them promoting their own status or re-linking the row.

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

  if new.onboarding_status is distinct from old.onboarding_status
     and new.onboarding_status in ('verified', 'complete') then
    raise exception 'verification is performed by the payroll team';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_person_update() from public;

drop trigger if exists people_guard on public.people;
create trigger people_guard
  before update on public.people
  for each row execute function app_private.guard_person_update();

-- ── bank details RPC (the ONLY decryption path for humans) ──────────────────

-- volatile (not stable): it INSERTS the audit row — that is the point.
create or replace function public.get_person_bank_details(p_person_id uuid)
returns table (bank_name text, bank_account text, bank_sort_code text, ni_number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.role := app_private.get_role(auth.uid());
begin
  if v_role is null or v_role not in ('pulse_admin', 'pulse_payroll') then
    raise exception 'not authorised to view bank details' using errcode = '42501';
  end if;

  -- every view of decrypted bank details is audit-logged, no exceptions
  insert into public.audit_log (actor_id, action, entity, entity_id)
  values (auth.uid(), 'bank_details_viewed', 'people', p_person_id::text);

  return query
  select
    p.bank_name,
    app_private.decrypt_pii(p.bank_account_enc),
    app_private.decrypt_pii(p.bank_sort_code_enc),
    app_private.decrypt_pii(p.ni_number_enc)
  from public.people p
  where p.id = p_person_id;
end;
$$;

comment on function public.get_person_bank_details(uuid) is
  'Decrypts a person''s bank details for payroll. pulse_payroll/pulse_admin only; every call writes audit_log(bank_details_viewed).';

revoke all on function public.get_person_bank_details(uuid) from public;
revoke all on function public.get_person_bank_details(uuid) from anon;
grant execute on function public.get_person_bank_details(uuid) to authenticated, service_role;

-- Companion setter so PostgREST callers (payroll UI, onboarding edge function)
-- can write encrypted details without ever inserting plaintext into a column.
-- Addition beyond the brief's contract, documented in the handover notes.

create or replace function public.set_person_bank_details(
  p_person_id uuid,
  p_bank_name text default null,
  p_bank_account text default null,
  p_bank_sort_code text default null,
  p_ni_number text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.role := app_private.get_role(auth.uid());
begin
  -- payroll/admin from the browser; auth.uid() is null for service_role (edge fns)
  if auth.uid() is not null and (v_role is null or v_role not in ('pulse_admin', 'pulse_payroll')) then
    raise exception 'not authorised to set bank details' using errcode = '42501';
  end if;

  update public.people p
     set bank_name = coalesce(p_bank_name, p.bank_name),
         bank_account_enc = case when p_bank_account is null then p.bank_account_enc
                                 else app_private.encrypt_pii(p_bank_account) end,
         bank_sort_code_enc = case when p_bank_sort_code is null then p.bank_sort_code_enc
                                   else app_private.encrypt_pii(p_bank_sort_code) end,
         ni_number_enc = case when p_ni_number is null then p.ni_number_enc
                              else app_private.encrypt_pii(p_ni_number) end
   where p.id = p_person_id;

  if not found then
    raise exception 'person % not found', p_person_id;
  end if;

  insert into public.audit_log (actor_id, action, entity, entity_id)
  values (auth.uid(), 'bank_details_updated', 'people', p_person_id::text);
end;
$$;

revoke all on function public.set_person_bank_details(uuid, text, text, text, text) from public;
revoke all on function public.set_person_bank_details(uuid, text, text, text, text) from anon;
grant execute on function public.set_person_bank_details(uuid, text, text, text, text) to authenticated, service_role;

-- ── onboarding_submissions ───────────────────────────────────────────────────

create table public.onboarding_submissions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people (id) on delete cascade,
  payload jsonb not null,
  submitted_at timestamptz not null default now()
);

create index onboarding_submissions_person_idx on public.onboarding_submissions (person_id);

-- ── onboarding_tokens ────────────────────────────────────────────────────────
-- Tokenised form links: random 48-hex-char token, expiring, single-use.
-- No client role can read this table at all (RLS with zero policies + explicit
-- revoke in 0014); only the onboarding edge function (service role) validates.

create table public.onboarding_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  person_id uuid references public.people (id) on delete set null,
  person_type public.person_type not null,
  email text not null,
  expires_at timestamptz not null default now() + interval '14 days',
  used_at timestamptz,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create index onboarding_tokens_email_idx on public.onboarding_tokens (email);
