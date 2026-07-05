-- 0001 — extensions and private schema
-- GAUFCC Finance Platform. Applied via the Supabase management API (Postgres 17).
--
-- Security intent: everything helper-shaped lives in the private schema
-- app_private, which is NOT exposed through PostgREST. Clients only ever touch
-- public tables (gated by RLS) and the small set of public RPCs defined later.

-- pgcrypto: pgp_sym_encrypt/decrypt for PII columns, gen_random_bytes for tokens.
-- Supabase convention installs it into the "extensions" schema.
create extension if not exists pgcrypto with schema extensions;

-- pg_net: async HTTP from Postgres — used by the nightly pg_cron job to call the
-- sync-xero edge function. pg_net places its objects in the "net" schema; some
-- builds pin the extension schema, so fall back to the default if the explicit
-- schema is rejected.
do $$
begin
  begin
    create extension if not exists pg_net with schema extensions;
  exception when others then
    create extension if not exists pg_net;
  end;
end
$$;

-- pg_cron: nightly sync scheduler. The control file pins it (objects land in the
-- "cron" schema), so no schema clause. On hosted Supabase this is available but
-- may already be enabled — guard with if not exists and tolerate refusal.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron could not be created here (%). Enable it from the dashboard; migration 0016 guards the schedule call.', sqlerrm;
  end;
end
$$;

-- Private helper schema. Not in PostgREST's exposed schemas, so nothing in it is
-- callable over the API by name — clients reach helpers only indirectly via RLS
-- policies and SECURITY DEFINER public RPCs.
create schema if not exists app_private;

revoke all on schema app_private from public;
-- usage (not create) so RLS policies that call app_private functions can resolve
-- them when evaluated as the querying role.
grant usage on schema app_private to authenticated;
grant usage on schema app_private to anon;
grant usage on schema app_private to service_role;
-- the auth-hook trigger (profiles bootstrap) fires as supabase_auth_admin.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema app_private to supabase_auth_admin;
  end if;
end
$$;

comment on schema app_private is
  'Private helpers for GAUFCC Finance: role lookups for RLS, PII encryption, audit and cron plumbing. Never exposed via PostgREST.';
