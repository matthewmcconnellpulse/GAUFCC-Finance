-- 0053_report_default_period.sql
--
-- What period a report opens on.
--
-- Until now it opened on the current financial year. GAUFCC's year starts on
-- 1 October, so from 1 October every report in the system opened on a
-- financial year that was days old and effectively empty: on 13 October 2026
-- the default was FY27, holding 36 lines against a ~245-line month.
--
-- The shipped default is therefore resolved from the ledger rather than the
-- clock — the latest month carrying a normal amount of activity — and Pulse
-- can override it with a fixed preset or a fixed range.

insert into public.settings (key, value, description)
values (
  'report_default_period',
  '{"mode": "latest_data_month"}'::jsonb,
  'What the report builder opens on. mode: latest_data_month | preset | fixed. preset: month|quarter|year|fy. fixed: {start,end} ISO dates.'
)
on conflict (key) do nothing;

-- Month-by-month line counts, so the client can resolve the default without
-- reading the ledger itself.
--
-- SECURITY DEFINER deliberately, and narrowly: this returns a month and a row
-- count, and no money at all. It is defined that way because the default
-- period is a property of the ledger, not of who is looking at it — a
-- fund-scoped reader resolving through RLS would otherwise land on a
-- different default from everyone else, and two people would disagree about
-- what "the current period" means.
--
-- Dead documents are excluded on the same footing as everywhere else: a month
-- whose only entries were voided has no activity to open on.
create or replace function public.ledger_activity_months()
returns table (month date, line_count bigint)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select (date_trunc('month', t.date))::date as month, count(*)::bigint
  from public.xero_transactions t
  where app_private.is_live_document(t.status)
  group by 1
  order by 1
$$;

comment on function public.ledger_activity_months() is
  'Live ledger line counts per month, oldest first. Counts only — no amounts — so the report builder can resolve its default period identically for every reader.';

revoke all on function public.ledger_activity_months() from public;
grant execute on function public.ledger_activity_months() to authenticated;
