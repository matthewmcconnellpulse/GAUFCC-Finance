-- 0024 — YTD runs from GAUFCC's financial year start: 1 October.
--
-- 0012 assumed the standard UK charity year (1 April); GAUFCC's year runs
-- 1 October – 30 September (FY 25/26 = 01.10.2025 – 30.09.2026). The
-- expression (date_trunc('year', current_date + interval '3 months')
-- - interval '3 months') yields the latest 1 October on or before today.
-- Everything else about the view is unchanged from 0012.

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
        and ft.date >= (date_trunc('year', current_date + interval '3 months') - interval '3 months')::date
    ), 0) as ytd_income,
    coalesce(sum(ft.net) filter (
      where ft.class = 'EXPENSE'
        and ft.date >= (date_trunc('year', current_date + interval '3 months') - interval '3 months')::date
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
  'Per-fund balance = opening_balance + REVENUE-class net − EXPENSE-class net. YTD = since the most recent 1 October (GAUFCC FY). security_invoker: trustees see only their funds.';
