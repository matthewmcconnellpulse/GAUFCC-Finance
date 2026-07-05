-- 0012 — reporting and integrity views.
--
-- ALL views are security_invoker = true: they run with the querying user's
-- permissions, so the RLS on funds / xero_transactions / fund_warnings applies
-- through them. A trustee querying v_fund_balances therefore sees balances for
-- their funds only, computed from only the transactions their policies allow.
--
-- INCOME/EXPENDITURE SIGN CONVENTION (must match the sync engine — see
-- 0005_xero_mirror.sql): xero_transactions.net is stored with the
-- document-natural sign (invoices, bills and bank lines positive; credit notes
-- negative). Classification comes from xero_accounts.class:
--   class = 'REVENUE' → fund income; class = 'EXPENSE' → fund expenditure.
--   balance = opening_balance + income − expenditure.
-- Balance-sheet classes (ASSET/LIABILITY/EQUITY) are excluded from fund
-- movement; inter-fund transfers are expected to be coded through P&L accounts.
--
-- YTD is the UK financial year to date: from the most recent 1 April
-- (matches the FY 2025/26 convention in src/lib/format.ts). The expression
-- (date_trunc('year', current_date - interval '3 months') + interval '3 months')
-- yields the latest 1 April on or before today.

-- ── v_fund_balances ──────────────────────────────────────────────────────────

create or replace view public.v_fund_balances
with (security_invoker = true)
as
with fund_tx as (
  select
    f.id as fund_id,
    t.date,
    t.net,
    a.class
  from public.funds f
  join public.xero_transactions t
    on t.tracking_option_1_id = f.tracking_option_id
  left join public.xero_accounts a
    on a.code = t.account_code
  where f.opening_balance_date is null
     or t.date >= f.opening_balance_date
),
agg as (
  select
    ft.fund_id,
    coalesce(sum(ft.net) filter (where ft.class = 'REVENUE'), 0) as income_all,
    coalesce(sum(ft.net) filter (where ft.class = 'EXPENSE'), 0) as expenditure_all,
    coalesce(sum(ft.net) filter (
      where ft.class = 'REVENUE'
        and ft.date >= (date_trunc('year', current_date - interval '3 months') + interval '3 months')::date
    ), 0) as ytd_income,
    coalesce(sum(ft.net) filter (
      where ft.class = 'EXPENSE'
        and ft.date >= (date_trunc('year', current_date - interval '3 months') + interval '3 months')::date
    ), 0) as ytd_expenditure
  from fund_tx ft
  group by ft.fund_id
),
open_warnings as (
  select w.fund_id, count(*)::integer as open_warning_count
  from public.fund_warnings w
  where w.resolved_at is null
  group by w.fund_id
)
select
  f.id as fund_id,
  f.name,
  f.fund_type,
  f.active,
  f.classified_at,
  f.opening_balance,
  (f.opening_balance + coalesce(g.income_all, 0) - coalesce(g.expenditure_all, 0))::numeric(14, 2) as balance,
  coalesce(g.ytd_income, 0)::numeric(14, 2) as ytd_income,
  coalesce(g.ytd_expenditure, 0)::numeric(14, 2) as ytd_expenditure,
  coalesce(ow.open_warning_count, 0) as open_warning_count
from public.funds f
left join agg g on g.fund_id = f.id
left join open_warnings ow on ow.fund_id = f.id;

comment on view public.v_fund_balances is
  'Per-fund balance = opening_balance + REVENUE-class net − EXPENSE-class net. YTD = since the most recent 1 April. security_invoker: trustees see only their funds.';

-- ── v_fund_monthly ───────────────────────────────────────────────────────────

create or replace view public.v_fund_monthly
with (security_invoker = true)
as
select
  f.id as fund_id,
  (date_trunc('month', t.date))::date as month,
  coalesce(sum(t.net) filter (where a.class = 'REVENUE'), 0)::numeric(14, 2) as income,
  coalesce(sum(t.net) filter (where a.class = 'EXPENSE'), 0)::numeric(14, 2) as expenditure
from public.funds f
join public.xero_transactions t
  on t.tracking_option_1_id = f.tracking_option_id
left join public.xero_accounts a
  on a.code = t.account_code
group by f.id, (date_trunc('month', t.date))::date;

comment on view public.v_fund_monthly is
  'Monthly income/expenditure per fund for sparklines and movement charts. Same sign convention as v_fund_balances.';

-- ── integrity check 1: P&L lines missing a fund tracking option ──────────────
-- Only REVENUE/EXPENSE-class lines require a fund; balance-sheet lines are
-- legitimately untracked and are not flagged here.

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
  and t.tracking_option_1_id is null;

-- ── integrity check 2: conflicting / double tracking assignments ─────────────

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
where (t.tracking_option_1_id is not null and o1.id is null)
   or c1.position = 2
   or c2.position = 1;

-- ── integrity check 3: tracking options with no fund record ──────────────────
-- Only options in the fund category (slot 1) need a funds row.

create or replace view public.v_integrity_unmapped_options
with (security_invoker = true)
as
select
  o.tracking_option_id,
  o.name,
  o.tracking_category_id
from public.xero_tracking_options o
join public.xero_tracking_categories c
  on c.tracking_category_id = o.tracking_category_id
 and c.position = 1
where not exists (
  select 1 from public.funds f
  where f.tracking_option_id = o.tracking_option_id
);

-- ── integrity check 4: GL control reconciliation ──────────────────────────────
-- For each P&L account and month: total posted vs total carrying a fund tag.
-- variance ≠ 0 means fund reports would not reconcile to the GL.

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
group by t.account_code, a.name, (date_trunc('month', t.date))::date;

-- ── grants ───────────────────────────────────────────────────────────────────
-- security_invoker means the underlying tables' RLS still decides row access;
-- the view grant only lets a role attempt the query.

grant select on public.v_fund_balances to authenticated, service_role;
grant select on public.v_fund_monthly to authenticated, service_role;
grant select on public.v_integrity_missing_tracking to authenticated, service_role;
grant select on public.v_integrity_conflicting_tracking to authenticated, service_role;
grant select on public.v_integrity_unmapped_options to authenticated, service_role;
grant select on public.v_integrity_gl_recon to authenticated, service_role;

revoke all on public.v_fund_balances from anon;
revoke all on public.v_fund_monthly from anon;
revoke all on public.v_integrity_missing_tracking from anon;
revoke all on public.v_integrity_conflicting_tracking from anon;
revoke all on public.v_integrity_unmapped_options from anon;
revoke all on public.v_integrity_gl_recon from anon;
