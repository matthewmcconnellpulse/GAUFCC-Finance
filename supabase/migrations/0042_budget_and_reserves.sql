-- 0042 — budget tracking and reserve coverage settings.
--
-- Three figures the board pack needs and cannot infer:
--
-- * annual_operating_budget — the denominator of reserve coverage
--   ((general funds + cash at bank) / annual operating budget). Left null
--   deliberately: coverage reports as unavailable until someone sets it,
--   because a coverage ratio on a guessed denominator is worse than no ratio.
-- * xero_budget_id / xero_prior_budget_id — which Xero budget the pack tracks
--   against this year and last. Reading the budget list needs the
--   accounting.budgets.read scope on the custom connection, which is not in
--   the default set; until it is added the ids stay null and the pack's budget
--   page says so on the page.
--
-- No new tables: budgets and aged debtors/creditors are read live from Xero at
-- the moment a pack is assembled, so a pack is never issued against a stale
-- debtor position and nothing here needs a re-sync to become correct.

insert into public.settings (key, value, description) values
  ('annual_operating_budget', 'null'::jsonb,
   'Annual operating budget in pounds — the denominator of reserve coverage. Null until set; coverage then reports as unavailable rather than guessing.'),
  ('xero_budget_id', 'null'::jsonb,
   'Xero BudgetID the board pack tracks actuals against. Requires accounting.budgets.read on the custom connection.'),
  ('xero_prior_budget_id', 'null'::jsonb,
   'Xero BudgetID for the prior-year comparative column on the board pack budget page.')
on conflict (key) do nothing;
