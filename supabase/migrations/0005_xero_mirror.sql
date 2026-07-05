-- 0005 — Xero mirror (read model) + sync runs.
--
-- These tables are written ONLY by the sync engine running as service_role
-- (which bypasses RLS); clients get read access per role in migration 0014.
-- ~4,500 transactions/year means the line mirror stays small, but the fund
-- dashboard aggregates it constantly — hence the heavy indexes.

-- ── xero_connections ─────────────────────────────────────────────────────────
-- OAuth tokens are stored encrypted (bytea via app_private.encrypt_pii, see
-- 0008); plaintext tokens never touch the table. Token columns are not part of
-- the frontend contract (src/types/db.ts) and only service_role ever writes.

create table public.xero_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text,
  connection_type text not null default 'custom_connection'
    check (connection_type in ('custom_connection', 'oauth2')),
  status text not null default 'disconnected'
    check (status in ('connected', 'disconnected', 'error')),
  access_token_enc bytea,
  refresh_token_enc bytea,
  token_expires_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists xero_connections_set_updated_at on public.xero_connections;
create trigger xero_connections_set_updated_at
  before update on public.xero_connections
  for each row execute function app_private.set_updated_at();

-- ── reference mirrors ────────────────────────────────────────────────────────
-- updated_at on mirror tables is owned by the sync engine (set to the moment of
-- upsert), so no set_updated_at trigger here.

create table public.xero_accounts (
  id uuid primary key default gen_random_uuid(),
  account_id text not null unique, -- Xero AccountID
  code text,
  name text not null,
  type text not null,
  class text, -- ASSET | EQUITY | EXPENSE | LIABILITY | REVENUE — drives income vs expenditure in the fund views
  reporting_code text,
  status text,
  updated_at timestamptz not null default now()
);

create index xero_accounts_code_idx on public.xero_accounts (code);

create table public.xero_contacts (
  id uuid primary key default gen_random_uuid(),
  contact_id text not null unique, -- Xero ContactID
  name text not null,
  email text,
  is_supplier boolean not null default false,
  is_customer boolean not null default false,
  status text,
  updated_at timestamptz not null default now()
);

create table public.xero_tracking_categories (
  id uuid primary key default gen_random_uuid(),
  tracking_category_id text not null unique,
  name text not null,
  status text,
  "position" smallint not null default 1 check ("position" in (1, 2)), -- funds live in slot 1; quoted — POSITION is a keyword
  updated_at timestamptz not null default now()
);

create table public.xero_tracking_options (
  id uuid primary key default gen_random_uuid(),
  tracking_option_id text not null unique,
  tracking_category_id text not null,
  name text not null,
  status text,
  updated_at timestamptz not null default now()
);

-- no FK to xero_tracking_categories: the sync engine upserts entity types
-- independently and must not fail on arrival order. Joined in views instead.
create index xero_tracking_options_category_idx
  on public.xero_tracking_options (tracking_category_id);

-- ── xero_transactions (line-level mirror) ────────────────────────────────────
-- Sign convention (DOCUMENTED — the fund views depend on it):
--   net/vat/gross carry the document-natural amount: positive on sales
--   invoices (ACCREC), bills (ACCPAY), bank RECEIVE and SPEND lines; credit
--   notes and reversals arrive negative. Whether a line is fund INCOME or fund
--   EXPENDITURE is decided by the account's class in xero_accounts
--   (REVENUE → income, EXPENSE → expenditure), NOT by the sign. So a £100
--   sales credit note on a revenue account is income of −100.

create table public.xero_transactions (
  id uuid primary key default gen_random_uuid(),
  xero_id text not null, -- source document id
  line_id text not null, -- unique per line within the document
  source_type text not null check (source_type in
    ('ACCREC', 'ACCPAY', 'RECEIVE', 'SPEND', 'BANK_TRANSFER', 'CREDIT_NOTE', 'PREPAYMENT', 'OVERPAYMENT')),
  date date not null,
  account_code text,
  contact_id text,
  contact_name text,
  description text,
  net numeric(14, 2) not null default 0,
  vat numeric(14, 2) not null default 0,
  gross numeric(14, 2) not null default 0,
  tracking_option_1_id text, -- fund slot (tracking category position 1)
  tracking_option_2_id text,
  status text,
  updated_date_utc timestamptz not null,
  created_at timestamptz not null default now(),
  unique (xero_id, line_id)
);

create index xero_transactions_tracking_date_idx
  on public.xero_transactions (tracking_option_1_id, date);
create index xero_transactions_account_date_idx
  on public.xero_transactions (account_code, date);
create index xero_transactions_updated_idx
  on public.xero_transactions (updated_date_utc);
create index xero_transactions_date_idx
  on public.xero_transactions (date);

-- ── sync_runs ────────────────────────────────────────────────────────────────

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  "trigger" public.sync_trigger not null,
  status text not null default 'running' check (status in ('running', 'success', 'error')),
  records_upserted integer not null default 0,
  errors jsonb,
  triggered_by uuid references public.profiles (id) on delete set null
);

create index sync_runs_started_idx on public.sync_runs (started_at desc);

comment on table public.sync_runs is
  'One row per sync execution (nightly cron or manual Refresh now). Read by the top bar for the last-synced stamp.';
