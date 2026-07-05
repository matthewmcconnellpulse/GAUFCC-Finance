-- 0006 — funds, fund managers, warnings, integrity stamps.
--
-- Security intent: funds are the trustee-facing heart of the platform. A
-- trustee sees only the funds they manage via fund_managers (or everything in
-- read-only form when whole_board is set). The SECURITY DEFINER helpers at the
-- bottom let RLS on other tables (xero_transactions, board_packs, storage)
-- answer "may this trustee see this fund?" without nesting RLS lookups.

create table public.funds (
  id uuid primary key default gen_random_uuid(),
  -- 1:1 with a Xero tracking option (category slot 1). Null while a fund exists
  -- only locally (e.g. pre-classification placeholder).
  tracking_option_id text unique
    references public.xero_tracking_options (tracking_option_id)
    on update cascade on delete set null,
  name text not null,
  fund_type public.fund_type not null default 'general',
  opening_balance numeric(14, 2) not null default 0,
  opening_balance_date date,
  description text,
  purpose text,
  -- shape: { min_balance, flag_deficit, unusual_movement_factor, dormancy_months }
  warning_rules jsonb not null default '{}'::jsonb,
  -- null until Pulse classifies a newly-synced tracking option
  classified_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists funds_set_updated_at on public.funds;
create trigger funds_set_updated_at
  before update on public.funds
  for each row execute function app_private.set_updated_at();

comment on column public.funds.warning_rules is
  'Per-fund overrides of settings.warning_defaults: {min_balance, flag_deficit, unusual_movement_factor, dormancy_months}.';

-- ── fund_managers (junction driving trustee visibility) ─────────────────────

create table public.fund_managers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  fund_id uuid not null references public.funds (id) on delete cascade,
  whole_board boolean not null default false, -- true = this trustee sees all funds in packs
  created_at timestamptz not null default now(),
  unique (profile_id, fund_id)
);

create index fund_managers_profile_idx on public.fund_managers (profile_id);
create index fund_managers_fund_idx on public.fund_managers (fund_id);

-- ── fund_warnings ────────────────────────────────────────────────────────────
-- Written by the warning engine (service role) on each sync; resolved by Pulse.

create table public.fund_warnings (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds (id) on delete cascade,
  rule text not null check (rule in ('deficit', 'min_balance', 'unusual_movement', 'dormancy')),
  message text not null,
  severity text not null default 'amber' check (severity in ('amber', 'red')),
  as_of date not null default current_date,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index fund_warnings_fund_idx on public.fund_warnings (fund_id) where resolved_at is null;

-- ── integrity_stamps ─────────────────────────────────────────────────────────
-- A period is stamped "complete" once the four integrity checks pass. Insert
-- only — stamps are audit evidence and are never edited (see RLS in 0014).

create table public.integrity_stamps (
  id uuid primary key default gen_random_uuid(),
  period text not null unique check (period ~ '^\d{4}-\d{2}$'), -- e.g. '2026-06'
  stamped_by uuid not null references public.profiles (id),
  stamped_at timestamptz not null default now(),
  results jsonb
);

comment on table public.integrity_stamps is
  'Who signed off the data-integrity checks for a month, when, and the check results at that moment.';

-- ── trustee visibility helpers ──────────────────────────────────────────────
-- SECURITY DEFINER so RLS policies on transactions/packs/storage can consult
-- fund_managers without re-entering RLS. STABLE for per-query caching.

create or replace function app_private.is_whole_board(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fund_managers fm
    where fm.profile_id = uid and fm.whole_board
  )
$$;

create or replace function app_private.manages_fund(uid uuid, p_fund_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_whole_board(uid)
      or exists (
        select 1 from public.fund_managers fm
        where fm.profile_id = uid and fm.fund_id = p_fund_id
      )
$$;

create or replace function app_private.manages_tracking_option(uid uuid, p_option_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.is_whole_board(uid)
      or exists (
        select 1
        from public.fund_managers fm
        join public.funds f on f.id = fm.fund_id
        where fm.profile_id = uid
          and f.tracking_option_id = p_option_id
      )
$$;

create or replace function app_private.managed_fund_ids(uid uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(fm.fund_id), '{}'::uuid[])
  from public.fund_managers fm
  where fm.profile_id = uid
$$;

revoke all on function app_private.is_whole_board(uuid) from public;
revoke all on function app_private.manages_fund(uuid, uuid) from public;
revoke all on function app_private.manages_tracking_option(uuid, text) from public;
revoke all on function app_private.managed_fund_ids(uuid) from public;
grant execute on function app_private.is_whole_board(uuid) to authenticated, anon, service_role;
grant execute on function app_private.manages_fund(uuid, uuid) to authenticated, anon, service_role;
grant execute on function app_private.manages_tracking_option(uuid, text) to authenticated, anon, service_role;
grant execute on function app_private.managed_fund_ids(uuid) to authenticated, anon, service_role;
