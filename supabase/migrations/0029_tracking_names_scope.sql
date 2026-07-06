-- 0029 — tracking metadata reads scoped to fund-facing roles.
--
-- 0014 let ANY active role read xero_tracking_categories/options as
-- "low-sensitivity reference data". Option names mirror fund names, and no
-- submitter-facing flow reads them (the expense fund picker goes through
-- v_fund_balances, which submitters cannot see), so least privilege wins:
-- Pulse + CEO + trustees only. The chart of accounts stays readable to all
-- active roles — the expense category picker genuinely needs it.

drop policy if exists xero_tracking_categories_select on public.xero_tracking_categories;
create policy xero_tracking_categories_select on public.xero_tracking_categories
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) in ('ceo', 'trustee')
  );

drop policy if exists xero_tracking_options_select on public.xero_tracking_options;
create policy xero_tracking_options_select on public.xero_tracking_options
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) in ('ceo', 'trustee')
  );
