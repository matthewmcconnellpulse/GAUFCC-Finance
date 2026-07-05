-- 0017 — sanity: fail the deployment if any public table is missing RLS.
--
-- Expected tables, all with RLS ENABLED (verified programmatically below):
--   profiles                   RLS ✓  (0014)
--   fund_managers              RLS ✓  (0014)
--   xero_connections           RLS ✓  (0014)
--   xero_accounts              RLS ✓  (0014)
--   xero_contacts              RLS ✓  (0014)
--   xero_tracking_categories   RLS ✓  (0014)
--   xero_tracking_options      RLS ✓  (0014)
--   xero_transactions          RLS ✓  (0014)
--   sync_runs                  RLS ✓  (0014)
--   funds                      RLS ✓  (0014)
--   fund_warnings              RLS ✓  (0014)
--   integrity_stamps           RLS ✓  (0014) — insert-only, immutable
--   expense_claims             RLS ✓  (0014) + column guard trigger (0007)
--   expense_lines              RLS ✓  (0014)
--   people                     RLS ✓  (0014) — PII encrypted, masked columns
--   onboarding_submissions     RLS ✓  (0014)
--   onboarding_tokens          RLS ✓  (0014) — ZERO client policies, service role only
--   bank_imports               RLS ✓  (0014)
--   epworth_imports            RLS ✓  (0014)
--   epworth_fund_mappings      RLS ✓  (0014)
--   vat_periods                RLS ✓  (0014)
--   settings                   RLS ✓  (0014) + CEO key allow-list trigger (0010)
--   audit_log                  RLS ✓  (0014) — pulse_admin read, no client writes
--   projects                   RLS ✓  (0014)
--   project_tasks              RLS ✓  (0014)
--   board_packs                RLS ✓  (0014)

do $$
declare
  v_expected text[] := array[
    'profiles', 'fund_managers',
    'xero_connections', 'xero_accounts', 'xero_contacts',
    'xero_tracking_categories', 'xero_tracking_options', 'xero_transactions',
    'sync_runs',
    'funds', 'fund_warnings', 'integrity_stamps',
    'expense_claims', 'expense_lines',
    'people', 'onboarding_submissions', 'onboarding_tokens',
    'bank_imports', 'epworth_imports', 'epworth_fund_mappings',
    'vat_periods', 'settings', 'audit_log',
    'projects', 'project_tasks', 'board_packs'
  ];
  v_name text;
  v_missing_tables text[] := '{}';
  v_missing_rls text[] := '{}';
  r record;
begin
  -- 1) every expected table exists and has RLS enabled
  foreach v_name in array v_expected loop
    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_name and c.relkind = 'r'
    ) then
      v_missing_tables := v_missing_tables || v_name;
    elsif not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_name
        and c.relkind = 'r' and c.relrowsecurity
    ) then
      v_missing_rls := v_missing_rls || v_name;
    end if;
  end loop;

  -- 2) no stray public table has slipped in without RLS
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  loop
    v_missing_rls := v_missing_rls || r.relname;
  end loop;

  if array_length(v_missing_tables, 1) is not null then
    raise exception 'sanity check failed — expected tables missing: %',
      array_to_string(v_missing_tables, ', ');
  end if;

  if array_length(v_missing_rls, 1) is not null then
    raise exception 'sanity check failed — RLS not enabled on: %',
      array_to_string(v_missing_rls, ', ');
  end if;

  raise notice 'sanity check passed: % tables present, RLS enabled on every public table',
    array_length(v_expected, 1);
end;
$$;
