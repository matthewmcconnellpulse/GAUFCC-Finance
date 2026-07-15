-- 0032 — Investments dashboard visibility + cashflow forecast tables.
--
-- 1. The CEO can read Epworth imports: the Financials → Investments dashboard
--    is built from epworth_imports (income by type, cumulative gains and
--    portfolio/cash values live in parsed.meta), and investment performance
--    is management-level information, not Pulse-internal.
--
-- 2. Cashflow forecast (mirrors GAUFCC's weekly Excel template): named
--    income/outgoing lines down the side, weekly-then-monthly period columns,
--    every cell editable. Amounts are stored AS TYPED in the template —
--    income positive, outgoings negative — so totals are plain sums.
--    cashflow_config is a single row keyed 'default' holding the opening
--    balance the balance rows cascade from. Lines may carry Xero account
--    codes so past periods can be filled from the mirror with one click.

-- ── Investments: CEO read on Epworth imports ─────────────────────────────────

drop policy epworth_imports_select on public.epworth_imports;
create policy epworth_imports_select on public.epworth_imports
  for select using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  );

-- ── Cashflow forecast ────────────────────────────────────────────────────────

create table public.cashflow_config (
  key text primary key default 'default' check (key = 'default'),
  opening_balance numeric(14, 2) not null default 0,
  opening_date date not null,
  weekly_weeks integer not null default 13 check (weekly_weeks between 1 and 53),
  monthly_months integer not null default 6 check (monthly_months between 0 and 24),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.cashflow_lines (
  id uuid primary key default gen_random_uuid(),
  section text not null check (section in ('income', 'outgoing')),
  name text not null,
  sort_order integer not null default 0,
  -- Xero account codes this line maps to, for one-click actuals per period.
  account_codes text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.cashflow_cells (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references public.cashflow_lines(id) on delete cascade,
  period_start date not null,
  amount numeric(14, 2) not null default 0,
  -- 'xero' when the value was filled from the mirror; free text otherwise.
  note text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  unique (line_id, period_start)
);

create index cashflow_cells_line_idx on public.cashflow_cells (line_id, period_start);

alter table public.cashflow_config enable row level security;
alter table public.cashflow_lines enable row level security;
alter table public.cashflow_cells enable row level security;

-- Read: Pulse + CEO. Write: the people who actually run the forecast —
-- pulse admin, bookkeeper and the CEO.
create policy cashflow_config_select on public.cashflow_config
  for select using (
    app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo'
  );
create policy cashflow_config_write on public.cashflow_config
  for all using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  ) with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  );

create policy cashflow_lines_select on public.cashflow_lines
  for select using (
    app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo'
  );
create policy cashflow_lines_write on public.cashflow_lines
  for all using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  ) with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  );

create policy cashflow_cells_select on public.cashflow_cells
  for select using (
    app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo'
  );
create policy cashflow_cells_write on public.cashflow_cells
  for all using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  ) with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  );

grant select on public.cashflow_config, public.cashflow_lines, public.cashflow_cells
  to authenticated, service_role;
grant insert, update, delete on public.cashflow_config, public.cashflow_lines, public.cashflow_cells
  to authenticated, service_role;
revoke all on public.cashflow_config, public.cashflow_lines, public.cashflow_cells from anon;
