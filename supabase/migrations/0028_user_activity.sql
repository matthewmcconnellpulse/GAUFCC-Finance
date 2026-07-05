-- 0028 — user_activity: a lightweight page-view trail per signed-in user.
--
-- The app records one row per route change (deduped client-side). Users write
-- only their own trail; ONLY the Pulse admin reads it (Settings → Users →
-- User activity, including the AI interest summaries). High-volume table:
-- bigint identity pk, no audit trigger, 90-day retention via pg_cron.

create table public.user_activity (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  path text not null,
  page text not null,
  occurred_at timestamptz not null default now()
);

create index user_activity_profile_idx on public.user_activity (profile_id, occurred_at desc);
create index user_activity_time_idx on public.user_activity (occurred_at desc);

alter table public.user_activity enable row level security;

create policy user_activity_insert_own on public.user_activity
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and app_private.get_role(auth.uid()) is not null
  );

create policy user_activity_select_admin on public.user_activity
  for select to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

revoke all on public.user_activity from anon;

-- ── retention: keep 90 days ──────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — schedule user-activity-prune manually once it is enabled';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'user-activity-prune') then
    perform cron.unschedule('user-activity-prune');
  end if;

  perform cron.schedule(
    'user-activity-prune',
    '30 3 * * *',
    'delete from public.user_activity where occurred_at < now() - interval ''90 days'''
  );
end;
$$;
