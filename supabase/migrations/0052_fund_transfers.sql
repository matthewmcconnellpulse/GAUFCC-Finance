-- 0052 — show transfers between funds.
--
-- Fund figures counted REVENUE and EXPENSE only. An apportionment of the
-- general fund across the restricted and designated funds is not income or
-- expenditure to the charity — it is posted on the EQUITY accounts, tagged to
-- the receiving fund — so every one of those movements was invisible: the fund
-- balances did not move, and the reports showed "Transfers" as nil because the
-- model hardcoded a zero and the footnote said transfers were not recorded.
--
-- Transfers are therefore equity-class movement tagged to a fund. Two
-- conditions keep that from double counting the funds' own capital:
--
--   * STRICTLY AFTER the fund's opening balance date. The brought-forward
--     journals sit ON that date (30.09.2025) and ARE the opening balance
--     restated — counting them would add every fund's capital twice, which is
--     the same double count 0051 had to unpick.
--   * The fund must HAVE an opening balance date. Without one there is no line
--     between "this is the opening position" and "this is a movement", and one
--     mis-tagged 1.6m brought-forward journal would land as a transfer.
--
-- Balance becomes opening + income - expenditure + transfers. Net for the
-- period deliberately excludes transfers: an apportionment is not a result,
-- which is exactly what the separate SOFA column is for.
--
-- New columns are appended rather than slotted in, because create-or-replace
-- on a view cannot reorder or rename existing ones.

create or replace view public.v_fund_balances
with (security_invoker = true)
as
with fund_tx as (
  select
    f.id as fund_id,
    t.date,
    t.net,
    a.class,
    f.opening_balance_date
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
      where ft.class = 'EQUITY'
        and ft.opening_balance_date is not null
        and ft.date > ft.opening_balance_date
    ), 0) as transfers_all,
    coalesce(sum(ft.net) filter (
      where ft.class = 'REVENUE'
        and ft.date >= (date_trunc('year', current_date + interval '3 months') - interval '3 months')::date
    ), 0) as ytd_income,
    coalesce(sum(ft.net) filter (
      where ft.class = 'EXPENSE'
        and ft.date >= (date_trunc('year', current_date + interval '3 months') - interval '3 months')::date
    ), 0) as ytd_expenditure,
    coalesce(sum(ft.net) filter (
      where ft.class = 'EQUITY'
        and ft.opening_balance_date is not null
        and ft.date > ft.opening_balance_date
        and ft.date >= (date_trunc('year', current_date + interval '3 months') - interval '3 months')::date
    ), 0) as ytd_transfers
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
  (f.opening_balance
   + coalesce(g.income_all, 0)
   - coalesce(g.expenditure_all, 0)
   + coalesce(g.transfers_all, 0))::numeric(14, 2) as balance,
  coalesce(g.ytd_income, 0)::numeric(14, 2) as ytd_income,
  coalesce(g.ytd_expenditure, 0)::numeric(14, 2) as ytd_expenditure,
  coalesce(ow.open_warning_count, 0) as open_warning_count,
  coalesce(g.transfers_all, 0)::numeric(14, 2) as transfers,
  coalesce(g.ytd_transfers, 0)::numeric(14, 2) as ytd_transfers
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
  coalesce(sum(t.net) filter (where a.class = 'EXPENSE'), 0)::numeric(14, 2) as expenditure,
  coalesce(sum(t.net) filter (
    where a.class = 'EQUITY'
      and f.opening_balance_date is not null
      and t.date > f.opening_balance_date
  ), 0)::numeric(14, 2) as transfers
from public.funds f
join public.xero_transactions t
  on t.tracking_option_1_id = f.tracking_option_id
left join public.xero_accounts a
  on a.code = t.account_code
where (f.opening_balance_date is null or t.date >= f.opening_balance_date)
  and app_private.is_live_document(t.status)
group by f.id, (date_trunc('month', t.date))::date;

drop function if exists public.fund_balances_as_at(date);

create function public.fund_balances_as_at(p_date date)
returns table (
  fund_id uuid,
  name text,
  fund_type public.fund_type,
  opening numeric(14, 2),
  movement numeric(14, 2),
  transfers numeric(14, 2),
  balance numeric(14, 2)
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    f.id,
    f.name,
    f.fund_type,
    f.opening_balance::numeric(14, 2),
    coalesce(mv.net, 0)::numeric(14, 2),
    coalesce(mv.transfers, 0)::numeric(14, 2),
    (f.opening_balance + coalesce(mv.net, 0) + coalesce(mv.transfers, 0))::numeric(14, 2)
  from public.funds f
  left join lateral (
    select
      coalesce(sum(t.net) filter (where a.class = 'REVENUE'), 0)
      - coalesce(sum(t.net) filter (where a.class = 'EXPENSE'), 0) as net,
      coalesce(sum(t.net) filter (
        where a.class = 'EQUITY'
          and f.opening_balance_date is not null
          and t.date > f.opening_balance_date
      ), 0) as transfers
    from public.xero_transactions t
    left join public.xero_accounts a on a.code = t.account_code
    where t.tracking_option_1_id = f.tracking_option_id
      and t.date <= p_date
      and (f.opening_balance_date is null or t.date >= f.opening_balance_date)
      and app_private.is_live_document(t.status)
  ) mv on true
  where f.active
$$;

comment on function public.fund_balances_as_at(date) is
  'Every active fund''s balance as at a date: opening balance, plus income less expenditure, plus transfers in or out on the equity accounts. Voided documents excluded.';

grant execute on function public.fund_balances_as_at(date) to authenticated;
