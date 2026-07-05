-- 0013 — attach the audit trigger to every sensitive table.
--
-- app_private.audit_changes() (0004) snapshots before/after as jsonb with all
-- *_enc columns stripped, so encrypted PII and Xero tokens never reach the log.

drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
  after insert or update or delete on public.profiles
  for each row execute function app_private.audit_changes();

drop trigger if exists funds_audit on public.funds;
create trigger funds_audit
  after insert or update or delete on public.funds
  for each row execute function app_private.audit_changes();

drop trigger if exists fund_managers_audit on public.fund_managers;
create trigger fund_managers_audit
  after insert or update or delete on public.fund_managers
  for each row execute function app_private.audit_changes();

drop trigger if exists expense_claims_audit on public.expense_claims;
create trigger expense_claims_audit
  after insert or update or delete on public.expense_claims
  for each row execute function app_private.audit_changes();

drop trigger if exists expense_lines_audit on public.expense_lines;
create trigger expense_lines_audit
  after insert or update or delete on public.expense_lines
  for each row execute function app_private.audit_changes();

drop trigger if exists people_audit on public.people;
create trigger people_audit
  after insert or update or delete on public.people
  for each row execute function app_private.audit_changes();

drop trigger if exists settings_audit on public.settings;
create trigger settings_audit
  after insert or update or delete on public.settings
  for each row execute function app_private.audit_changes();

drop trigger if exists epworth_fund_mappings_audit on public.epworth_fund_mappings;
create trigger epworth_fund_mappings_audit
  after insert or update or delete on public.epworth_fund_mappings
  for each row execute function app_private.audit_changes();

drop trigger if exists bank_imports_audit on public.bank_imports;
create trigger bank_imports_audit
  after insert or update or delete on public.bank_imports
  for each row execute function app_private.audit_changes();

drop trigger if exists vat_periods_audit on public.vat_periods;
create trigger vat_periods_audit
  after insert or update or delete on public.vat_periods
  for each row execute function app_private.audit_changes();

drop trigger if exists integrity_stamps_audit on public.integrity_stamps;
create trigger integrity_stamps_audit
  after insert or update or delete on public.integrity_stamps
  for each row execute function app_private.audit_changes();
