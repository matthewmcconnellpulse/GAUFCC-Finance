-- 0003 — profiles, auth bootstrap trigger, and the role helpers every RLS
-- policy leans on.
--
-- Security intent (trustee-facing): the old Aqilla setup had poor data
-- security. Here, every policy in the database resolves the caller's role
-- through ONE audited code path — app_private.get_role() — which is
-- SECURITY DEFINER so policies on profiles never have to select from profiles
-- themselves (no recursive RLS), and which returns NULL for deactivated users
-- so flipping profiles.active off instantly revokes all data access.

-- ── profiles ────────────────────────────────────────────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  role public.role not null default 'submitter',
  organisation public.organisation not null default 'gaufcc',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. role + active drive every RLS decision via app_private.get_role().';

-- ── shared updated_at maintenance ───────────────────────────────────────────

create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.set_updated_at() from public;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function app_private.set_updated_at();

-- ── new-user bootstrap ──────────────────────────────────────────────────────
-- Matthew's two addresses bootstrap as pulse_admin; anyone on the Pulse domain
-- lands in the pulse organisation; everyone else defaults to gaufcc/submitter
-- until a pulse_admin assigns a real role. Invite-only signup is enforced at
-- the auth layer; this trigger only shapes the profile row.

create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(coalesce(new.email, ''));
  v_role public.role := 'submitter';
  v_org public.organisation := 'gaufcc';
begin
  if v_email in ('matthewmcconnellpulse@gmail.com', 'matthew@pulse-accountants.co.uk') then
    v_role := 'pulse_admin';
  end if;

  if v_email like '%pulse-accountants.co.uk' or v_email = 'matthewmcconnellpulse@gmail.com' then
    v_org := 'pulse';
  end if;

  insert into public.profiles (id, full_name, email, role, organisation)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), v_email),
    v_email,
    v_role,
    v_org
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function app_private.handle_new_user() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function app_private.handle_new_user() to supabase_auth_admin;
  end if;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- ── role helpers used by ALL RLS policies ───────────────────────────────────
-- SECURITY DEFINER (owner: postgres, who owns profiles and therefore bypasses
-- its RLS) so a policy on profiles can call get_role without recursing into
-- profiles' own policies. STABLE so the planner caches the lookup per query.
-- A deactivated user (active = false) gets NULL, which fails every policy.

create or replace function app_private.get_role(uid uuid)
returns public.role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = uid
    and p.active
$$;

create or replace function app_private.is_pulse(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.get_role(uid) in
    ('pulse_admin'::public.role, 'pulse_bookkeeper'::public.role, 'pulse_payroll'::public.role)
$$;

create or replace function app_private.is_pulse_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.get_role(uid) = 'pulse_admin'::public.role
$$;

-- Grants: policies evaluate these AS the querying role, so authenticated (and
-- anon, so unauthenticated requests fail closed with "no rows" rather than a
-- permission error) need execute. Nothing here leaks data — worst case output
-- is a role label for a uuid the caller already holds.
revoke all on function app_private.get_role(uuid) from public;
revoke all on function app_private.is_pulse(uuid) from public;
revoke all on function app_private.is_pulse_admin(uuid) from public;
grant execute on function app_private.get_role(uuid) to authenticated, anon, service_role;
grant execute on function app_private.is_pulse(uuid) to authenticated, anon, service_role;
grant execute on function app_private.is_pulse_admin(uuid) to authenticated, anon, service_role;
