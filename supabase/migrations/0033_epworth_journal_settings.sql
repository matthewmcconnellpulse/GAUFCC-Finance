-- 0033 — persist the Epworth journal export mappings.
--
-- The account codes on the Epworth journal export (the investment asset code
-- on the debit side, the per-income-type income/expense codes, and the
-- tracking category name) were page state only, retyped every month. One row
-- keyed 'default' saves them so each import pre-fills the last mapping.
--
-- Not in public.settings: its insert policy is pulse_admin-only, and the
-- monthly Epworth run is bookkeeper work — this table lets the bookkeeper
-- save the mapping (matching epworth_imports' update policy).

create table public.epworth_journal_settings (
  key text primary key default 'default' check (key = 'default'),
  tracking_category_name text,
  asset_account_code text,
  -- income_type → account code, e.g. {"dividend": "200090", "fee": "437001"}
  income_account_codes jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

alter table public.epworth_journal_settings enable row level security;

create policy epworth_journal_settings_select on public.epworth_journal_settings
  for select using (app_private.is_pulse(auth.uid()));
create policy epworth_journal_settings_write on public.epworth_journal_settings
  for all using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
  ) with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
  );

grant select, insert, update, delete on public.epworth_journal_settings to authenticated, service_role;
revoke all on public.epworth_journal_settings from anon;
