-- 0016 — nightly sync schedule and the cron shared secret.
--
-- The sync-xero edge function is deployed with verify_jwt: false so pg_cron can
-- call it; it authenticates callers by comparing the x-cron-secret header with
-- the vault secret 'cron_secret' (read server-side via read_cron_secret()).
-- Secret VALUES are inserted at deploy time — this migration references names
-- only and degrades gracefully when a secret or extension is missing.

-- ── read_cron_secret: service_role only ─────────────────────────────────────

create or replace function app_private.read_cron_secret()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'cron_secret'
  limit 1;

  return v_secret; -- null when not yet provisioned; the edge function treats null as "reject"
end;
$$;

comment on function app_private.read_cron_secret() is
  'Returns the shared secret the sync-xero edge function compares against x-cron-secret. Execute: service_role only.';

revoke all on function app_private.read_cron_secret() from public;
revoke all on function app_private.read_cron_secret() from anon;
revoke all on function app_private.read_cron_secret() from authenticated;
grant execute on function app_private.read_cron_secret() to service_role;

-- ── the job body ─────────────────────────────────────────────────────────────
-- Reads the secret at FIRE time (not schedule time), so provisioning or
-- rotating cron_secret needs no re-migration. Skips with a notice if the
-- secret is missing.

create or replace function app_private.invoke_nightly_sync()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'cron_secret'
  limit 1;

  if v_secret is null then
    raise notice 'vault secret cron_secret is missing — nightly sync skipped';
    return;
  end if;

  perform net.http_post(
    url := 'https://uldtyqzchwkbitgnworq.supabase.co/functions/v1/sync-xero',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret
    ),
    body := '{"trigger":"cron"}'::jsonb
  );
end;
$$;

revoke all on function app_private.invoke_nightly_sync() from public;
revoke all on function app_private.invoke_nightly_sync() from anon;
revoke all on function app_private.invoke_nightly_sync() from authenticated;

-- ── schedule ─────────────────────────────────────────────────────────────────
-- pg_cron runs in UTC. '0 3 * * *' = 03:00 UTC, which is 04:00 Europe/London
-- during British Summer Time (the sync_hour=4 setting refers to London time).
-- In winter it fires at 03:00 London — acceptable for a nightly batch; adjust
-- the cron expression seasonally from Settings if exactness ever matters.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — schedule sync-xero-nightly manually once it is enabled';
    return;
  end if;

  -- reschedule idempotently
  if exists (select 1 from cron.job where jobname = 'sync-xero-nightly') then
    perform cron.unschedule('sync-xero-nightly');
  end if;

  perform cron.schedule(
    'sync-xero-nightly',
    '0 3 * * *',
    'select app_private.invoke_nightly_sync()'
  );
end;
$$;
