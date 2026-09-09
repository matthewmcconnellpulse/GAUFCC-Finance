-- 0043 — voided and deleted documents are not transactions.
--
-- The sync now fetches every document endpoint without a status filter and
-- clears a document's mirrored lines before writing the live ones back, so a
-- bill voided after it was first synced actually disappears from the mirror
-- (see the "Voided and deleted documents" note in _shared/sync-engine.ts).
--
-- These view changes are the second line of defence. If a VOIDED or DELETED
-- row ever reaches the mirror by any path, it must not be reported as a
-- transaction missing a fund code, as a tracking conflict, or as a GL
-- variance — none of those are hygiene failures a bookkeeper can act on, and
-- a check that cries wolf gets ignored.
--
-- app_private.is_live_document() keeps the rule in ONE place so the views
-- cannot drift apart. It is immutable and takes the status text, so Postgres
-- can inline it.

create or replace function app_private.is_live_document(p_status text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(upper(p_status), '') not in ('VOIDED', 'DELETED')
$$;

comment on function app_private.is_live_document(text) is
  'False for Xero documents that have been voided or deleted — they are records, not transactions.';

-- ── integrity check 1: P&L lines with no fund tag ───────────────────────────

create or replace view public.v_integrity_missing_tracking
with (security_invoker = true)
as
select
  t.id,
  t.date,
  t.xero_id,
  t.line_id,
  t.source_type,
  t.description,
  t.account_code,
  t.contact_name,
  t.net,
  t.gross
from public.xero_transactions t
join public.xero_accounts a
  on a.code = t.account_code
where a.class in ('REVENUE', 'EXPENSE')
  and t.tracking_option_1_id is null
  and app_private.is_live_document(t.status);

-- ── integrity check 2: conflicting / double tracking assignments ────────────

create or replace view public.v_integrity_conflicting_tracking
with (security_invoker = true)
as
select
  t.id,
  t.date,
  t.xero_id,
  t.line_id,
  t.source_type,
  t.description,
  t.account_code,
  t.contact_name,
  t.net,
  t.gross,
  case
    when t.tracking_option_1_id is not null and o1.id is null
      then 'fund slot carries an unrecognised tracking option'
    when c1.position = 2
      then 'fund slot carries an option from the second tracking category'
    when c2.position = 1
      then 'second slot carries a fund option — double fund assignment'
  end as reason
from public.xero_transactions t
left join public.xero_tracking_options o1
  on o1.tracking_option_id = t.tracking_option_1_id
left join public.xero_tracking_categories c1
  on c1.tracking_category_id = o1.tracking_category_id
left join public.xero_tracking_options o2
  on o2.tracking_option_id = t.tracking_option_2_id
left join public.xero_tracking_categories c2
  on c2.tracking_category_id = o2.tracking_category_id
where app_private.is_live_document(t.status)
  and (
    (t.tracking_option_1_id is not null and o1.id is null)
    or c1.position = 2
    or c2.position = 1
  );

-- ── integrity check 4: GL control reconciliation ────────────────────────────

create or replace view public.v_integrity_gl_recon
with (security_invoker = true)
as
select
  t.account_code,
  a.name as account_name,
  (date_trunc('month', t.date))::date as period_month,
  coalesce(sum(t.net), 0)::numeric(14, 2) as total,
  coalesce(sum(t.net) filter (where t.tracking_option_1_id is not null), 0)::numeric(14, 2) as tracked_total,
  (coalesce(sum(t.net), 0)
   - coalesce(sum(t.net) filter (where t.tracking_option_1_id is not null), 0))::numeric(14, 2) as variance
from public.xero_transactions t
join public.xero_accounts a
  on a.code = t.account_code
where a.class in ('REVENUE', 'EXPENSE')
  and app_private.is_live_document(t.status)
group by t.account_code, a.name, (date_trunc('month', t.date))::date;

grant execute on function app_private.is_live_document(text) to authenticated;
