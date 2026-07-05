-- 0023 — expose read_cron_secret through PostgREST.
--
-- The sync-xero edge function reads the cron secret via supabase-js RPC, but
-- PostgREST only serves schemas on its exposed list (public, graphql_public)
-- — app_private.read_cron_secret() is unreachable that way, so every cron
-- call failed its secret check with 401. This public wrapper is the missing
-- bridge. Execute stays service_role-only: the function calls it with the
-- service key; browser clients (anon/authenticated) are refused.

create or replace function public.read_cron_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.read_cron_secret();
$$;

comment on function public.read_cron_secret() is
  'PostgREST-reachable wrapper over app_private.read_cron_secret(). Execute: service_role only.';

revoke all on function public.read_cron_secret() from public;
revoke all on function public.read_cron_secret() from anon;
revoke all on function public.read_cron_secret() from authenticated;
grant execute on function public.read_cron_secret() to service_role;
