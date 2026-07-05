-- 0009 — import tools: HSBC bank statements and Epworth investment reports.
--
-- Security intent: imports are a Pulse-only workflow (there is no HSBC feed,
-- so statement files are the bank record — they must be tamper-evident).
-- bank_imports and epworth_fund_mappings carry the audit trigger (0013) so
-- overrides and mapping changes are always attributable.

create table public.bank_imports (
  id uuid primary key default gen_random_uuid(),
  file_path text not null, -- object in the imports bucket
  file_name text not null,
  statement_start date,
  statement_end date,
  opening_balance numeric(14, 2),
  closing_balance numeric(14, 2),
  parsed_rows jsonb, -- BankImportRow[]
  sense_check_results jsonb, -- SenseCheckResult[]
  status public.import_status not null default 'uploaded',
  override_reason text, -- required when a Pulse user overrides failed checks
  overridden_by uuid references public.profiles (id),
  generated_csv_path text, -- Xero-ready CSV in the imports bucket
  uploaded_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bank_imports_period_idx on public.bank_imports (statement_start, statement_end);
create index bank_imports_status_idx on public.bank_imports (status);

drop trigger if exists bank_imports_set_updated_at on public.bank_imports;
create trigger bank_imports_set_updated_at
  before update on public.bank_imports
  for each row execute function app_private.set_updated_at();

-- an override without a reason is not an override — belt-and-braces check
alter table public.bank_imports
  add constraint bank_imports_override_reason_chk
  check (status <> 'overridden' or (override_reason is not null and override_reason <> ''));

create table public.epworth_imports (
  id uuid primary key default gen_random_uuid(),
  file_path text not null,
  file_name text not null,
  period text not null check (period ~ '^\d{4}-\d{2}$'), -- e.g. '2026-06'
  parsed jsonb,
  mapping_results jsonb,
  status public.import_status not null default 'uploaded',
  uploaded_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index epworth_imports_period_idx on public.epworth_imports (period);

drop trigger if exists epworth_imports_set_updated_at on public.epworth_imports;
create trigger epworth_imports_set_updated_at
  before update on public.epworth_imports
  for each row execute function app_private.set_updated_at();

-- remembered month-to-month: an Epworth holding maps to one fund per income type
create table public.epworth_fund_mappings (
  id uuid primary key default gen_random_uuid(),
  epworth_holding_ref text not null,
  fund_id uuid not null references public.funds (id) on delete cascade,
  income_type public.income_type not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (epworth_holding_ref, income_type)
);

create index epworth_fund_mappings_fund_idx on public.epworth_fund_mappings (fund_id);
