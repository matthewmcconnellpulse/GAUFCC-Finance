-- 0045 — keep voided and deleted documents out of the fund balances too.
--
-- 0043 excluded them from the integrity checks, which was the reported
-- symptom. This is the consequential half: v_fund_balances and v_fund_monthly
-- summed every mirrored line regardless of status, so a bill voided in Xero
-- after it was first synced was still moving a fund's balance and its monthly
-- movement — and therefore the fund cards, the SOFA pages, the board pack and
-- the reconciliation's fund side as well.
--
-- Filtering at read time as well as fixing the sync means the figures are
-- right immediately, without waiting for a full re-sync to clear the stale
-- rows out. Otherwise unchanged from 0024 / 0019.

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
  where (f.opening_balance_date is null or t.date >= f.opening_balance_date)
    and app_private.is_live_document(t.status)
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
where (f.opening_balance_date is null or t.date >= f.opening_balance_date)
  and app_private.is_live_document(t.status)
group by f.id, (date_trunc('month', t.date))::date;
