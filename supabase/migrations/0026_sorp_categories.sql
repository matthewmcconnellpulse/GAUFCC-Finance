-- 0026 — SORP (Charities SORP FRS 102) SOFA headings for the chart of accounts.
--
-- Xero's chart carries no SORP structure, so fund and charity reporting maps
-- each P&L account to a SOFA heading. Defaults below are name/class
-- heuristics; Pulse refines them under Settings → Fund classification → SORP
-- mapping. The sync engine never writes sorp_category, so manual choices
-- survive every sync (upserts only touch the columns the engine names).

alter table public.xero_accounts
  add column if not exists sorp_category text
  constraint xero_accounts_sorp_category_check check (
    sorp_category is null or sorp_category in (
      -- income
      'donations_legacies',
      'charitable_activities_income',
      'other_trading',
      'investments_income',
      'other_income',
      -- expenditure
      'raising_funds',
      'charitable_activities_expenditure',
      'other_expenditure'
    )
  );

-- Defaults fill NULLs only — never overwrite a manual mapping.
update public.xero_accounts
set sorp_category = 'donations_legacies'
where sorp_category is null and class = 'REVENUE'
  and name ~* '\m(donat|legac|gift|grant|appeal|collect)';

update public.xero_accounts
set sorp_category = 'investments_income'
where sorp_category is null and class = 'REVENUE'
  and name ~* '\m(invest|interest|dividend)';

update public.xero_accounts
set sorp_category = 'other_trading'
where sorp_category is null and class = 'REVENUE'
  and name ~* '\m(trading|shop|merchandi|advertis)';

update public.xero_accounts
set sorp_category = 'other_income'
where sorp_category is null and class = 'REVENUE' and type = 'OTHERINCOME';

update public.xero_accounts
set sorp_category = 'charitable_activities_income'
where sorp_category is null and class = 'REVENUE';

update public.xero_accounts
set sorp_category = 'raising_funds'
where sorp_category is null and class = 'EXPENSE'
  and name ~* '\m(fundrais|raising)';

update public.xero_accounts
set sorp_category = 'charitable_activities_expenditure'
where sorp_category is null and class = 'EXPENSE';

-- Client editing: sorp_category is the ONLY column browsers may update, and
-- only Pulse/CEO at that. Everything else on the mirror stays sync-only.
revoke update on public.xero_accounts from authenticated;
grant update (sorp_category) on public.xero_accounts to authenticated;

drop policy if exists xero_accounts_update_sorp on public.xero_accounts;
create policy xero_accounts_update_sorp on public.xero_accounts
  for update to authenticated
  using (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
  with check (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo');
