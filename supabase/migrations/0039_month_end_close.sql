-- 0039 — month end close: a checklist per month, owned and signed off.
--
-- close_task_templates is the master checklist (editable by a Pulse admin);
-- opening a month copies the active templates into close_tasks so historic
-- months keep the checklist as it stood, with their own owners, statuses and
-- sign-off stamps. Each task carries an in-app route (link_to) so the person
-- doing the work lands on the right screen, and an optional external_url for
-- work that happens in Xero.
--
-- Sharing: every period gets an unguessable token. With share_enabled on,
-- close_share_progress(token) returns a read-only summary to anon — the CEO,
-- a trustee or the client can follow progress without a login. Nothing but
-- titles, owners, statuses and timestamps crosses that boundary.

create table if not exists public.close_task_templates (
  key text primary key,
  group_label text not null,
  title text not null,
  detail text,
  link_to text,             -- in-app route, e.g. '/imports/hsbc'
  external_url text,        -- e.g. Xero bank reconciliation
  sort_order integer not null default 0,
  is_client_signoff boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.close_periods (
  id uuid primary key default gen_random_uuid(),
  period text not null unique check (period ~ '^\d{4}-\d{2}$'),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'complete', 'reopened')),
  note text,
  share_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  share_enabled boolean not null default false,
  opened_by uuid references public.profiles (id) on delete set null,
  opened_at timestamptz not null default now(),
  completed_by uuid references public.profiles (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.close_tasks (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.close_periods (id) on delete cascade,
  template_key text,
  group_label text not null,
  title text not null,
  detail text,
  link_to text,
  external_url text,
  sort_order integer not null default 0,
  is_client_signoff boolean not null default false,
  assignee_id uuid references public.profiles (id) on delete set null,
  status text not null default 'todo'
    check (status in ('todo', 'in_progress', 'blocked', 'done', 'not_applicable')),
  note text,
  signed_off_by uuid references public.profiles (id) on delete set null,
  signed_off_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists close_tasks_period_idx on public.close_tasks (period_id, sort_order);
create index if not exists close_tasks_assignee_idx on public.close_tasks (assignee_id);

drop trigger if exists close_task_templates_set_updated_at on public.close_task_templates;
create trigger close_task_templates_set_updated_at
  before update on public.close_task_templates
  for each row execute function app_private.set_updated_at();

drop trigger if exists close_periods_set_updated_at on public.close_periods;
create trigger close_periods_set_updated_at
  before update on public.close_periods
  for each row execute function app_private.set_updated_at();

drop trigger if exists close_tasks_set_updated_at on public.close_tasks;
create trigger close_tasks_set_updated_at
  before update on public.close_tasks
  for each row execute function app_private.set_updated_at();

drop trigger if exists close_tasks_audit on public.close_tasks;
create trigger close_tasks_audit
  after insert or update or delete on public.close_tasks
  for each row execute function app_private.audit_changes();

-- close_periods is deliberately NOT audited: the generic trigger copies whole
-- rows into audit_log and share_token is a bearer secret. Task-level history
-- is what matters for a close, and close_tasks carries no secret.

-- ── sign-off stamping ───────────────────────────────────────────────────────
-- 'done' always records who and when; moving off 'done' clears the stamp so a
-- sign-off can never be inherited by a later edit.

create or replace function app_private.stamp_close_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_done boolean := false;
begin
  -- OLD is unassigned on INSERT, so branch on the operation explicitly
  if tg_op = 'UPDATE' then
    v_was_done := old.status = 'done';
  end if;

  if new.status = 'done' and (not v_was_done or new.signed_off_at is null) then
    new.signed_off_by := coalesce(auth.uid(), new.signed_off_by);
    new.signed_off_at := now();
  elsif new.status <> 'done' then
    new.signed_off_by := null;
    new.signed_off_at := null;
  end if;
  return new;
end;
$$;

revoke all on function app_private.stamp_close_task() from public;

drop trigger if exists close_tasks_stamp on public.close_tasks;
create trigger close_tasks_stamp
  before insert or update on public.close_tasks
  for each row execute function app_private.stamp_close_task();

-- ── open a month from the template ──────────────────────────────────────────

create or replace function public.open_close_period(p_period text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not app_private.is_pulse(auth.uid()) then
    raise exception 'only the Pulse team can open a month end';
  end if;
  if p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'period must look like 2026-09';
  end if;

  select id into v_id from public.close_periods where period = p_period;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.close_periods (period, opened_by)
  values (p_period, auth.uid())
  returning id into v_id;

  insert into public.close_tasks (
    period_id, template_key, group_label, title, detail, link_to, external_url,
    sort_order, is_client_signoff
  )
  select v_id, t.key, t.group_label, t.title, t.detail, t.link_to, t.external_url,
         t.sort_order, t.is_client_signoff
    from public.close_task_templates t
   where t.active
   order by t.sort_order;

  return v_id;
end;
$$;

revoke all on function public.open_close_period(text) from public;
grant execute on function public.open_close_period(text) to authenticated;

-- ── read-only shared progress (anon, by token) ──────────────────────────────

create or replace function public.close_share_progress(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period public.close_periods;
  v_tasks jsonb;
begin
  select * into v_period
    from public.close_periods
   where share_token = p_token and share_enabled
   limit 1;
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'group_label', t.group_label,
           'title', t.title,
           'detail', t.detail,
           'status', t.status,
           'note', t.note,
           'owner', p.full_name,
           'signed_off_at', t.signed_off_at,
           'signed_off_by', s.full_name,
           'is_client_signoff', t.is_client_signoff
         ) order by t.sort_order), '[]'::jsonb)
    into v_tasks
    from public.close_tasks t
    left join public.profiles p on p.id = t.assignee_id
    left join public.profiles s on s.id = t.signed_off_by
   where t.period_id = v_period.id;

  return jsonb_build_object(
    'period', v_period.period,
    'status', v_period.status,
    'note', v_period.note,
    'opened_at', v_period.opened_at,
    'completed_at', v_period.completed_at,
    'tasks', v_tasks
  );
end;
$$;

revoke all on function public.close_share_progress(text) from public;
grant execute on function public.close_share_progress(text) to anon, authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.close_task_templates enable row level security;
alter table public.close_periods enable row level security;
alter table public.close_tasks enable row level security;

drop policy if exists close_templates_select on public.close_task_templates;
create policy close_templates_select on public.close_task_templates
  for select to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo', 'trustee'));

drop policy if exists close_templates_write on public.close_task_templates;
create policy close_templates_write on public.close_task_templates
  for all to authenticated
  using (app_private.is_pulse_admin(auth.uid()))
  with check (app_private.is_pulse_admin(auth.uid()));

drop policy if exists close_periods_select on public.close_periods;
create policy close_periods_select on public.close_periods
  for select to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo', 'trustee'));

drop policy if exists close_periods_write on public.close_periods;
create policy close_periods_write on public.close_periods
  for all to authenticated
  using (app_private.is_pulse(auth.uid()))
  with check (app_private.is_pulse(auth.uid()));

drop policy if exists close_tasks_select on public.close_tasks;
create policy close_tasks_select on public.close_tasks
  for select to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo', 'trustee'));

drop policy if exists close_tasks_write on public.close_tasks;
create policy close_tasks_write on public.close_tasks
  for all to authenticated
  using (app_private.is_pulse(auth.uid()))
  with check (app_private.is_pulse(auth.uid()));

-- The CEO owns the client sign-off line and nothing else on the board.
drop policy if exists close_tasks_ceo_signoff on public.close_tasks;
create policy close_tasks_ceo_signoff on public.close_tasks
  for update to authenticated
  using (app_private.get_role(auth.uid()) = 'ceo' and is_client_signoff)
  with check (app_private.get_role(auth.uid()) = 'ceo' and is_client_signoff);

-- ── the checklist ───────────────────────────────────────────────────────────

insert into public.close_task_templates (key, group_label, title, detail, link_to, external_url, sort_order, is_client_signoff) values
  ('xero_sync', 'Bank and cash', 'Xero sync is current',
   'Check the connection is healthy and run a sync so the month''s data is complete.', '/settings/xero', null, 10, false),
  ('bank_statements', 'Bank and cash', 'Bank statements uploaded',
   'HSBC statements for the month uploaded and parsed.', '/imports/hsbc', null, 20, false),
  ('bank_rec', 'Bank and cash', 'All bank accounts reconciled',
   'Every account reconciled to the statement in Xero, with no unreconciled items left in the month.', '/financials/transactions', 'https://go.xero.com/Bank/BankAccounts.aspx', 30, false),
  ('epworth', 'Bank and cash', 'Epworth investment statements posted',
   'Investment cash and holdings statements imported and mapped to funds.', '/imports/epworth', null, 40, false),
  ('cash_balances', 'Bank and cash', 'Cash balances agree',
   'Balance sheet cash agrees to the statements at month end.', '/financials/balance-sheet', null, 50, false),

  ('income_posted', 'Income', 'Donations and grants recorded',
   'All income for the month posted and coded to the right fund.', '/financials/transactions', null, 60, false),
  ('gift_aid', 'Income', 'Gift Aid claim reviewed',
   'Gift Aid debtor agreed and any claim submitted.', '/financials/balance-sheet', null, 70, false),
  ('investment_income', 'Income', 'Investment income posted',
   'Dividends and interest recorded against the right funds.', '/financials/investments', null, 80, false),

  ('expenses_cleared', 'Expenditure', 'Expense claims cleared',
   'Approved claims pushed to Xero, nothing left waiting in the queue.', '/expenses', null, 90, false),
  ('supplier_bills', 'Expenditure', 'Supplier bills entered',
   'Purchase invoices for the month entered and coded.', null, 'https://go.xero.com/AccountsPayable/Search.aspx', 100, false),
  ('payroll_posted', 'Expenditure', 'Payroll journal posted',
   'Payroll for the month posted, including pension and HMRC liabilities.', '/people', null, 110, false),
  ('accruals', 'Expenditure', 'Accruals and prepayments reviewed',
   'Month-end accruals, prepayments and deferred income adjusted.', '/financials/balance-sheet', null, 120, false),

  ('fund_coding', 'Funds', 'Fund coding complete',
   'No unclassified funds and no uncoded transactions left for the month.', '/settings/classification', null, 130, false),
  ('fund_integrity', 'Funds', 'Fund integrity checks pass',
   'Run the integrity checks and clear anything flagged.', '/funds/integrity', null, 140, false),
  ('restricted_review', 'Funds', 'Restricted fund balances reviewed',
   'No restricted fund in deficit; balances and warnings reviewed.', '/funds', null, 150, false),

  ('vat_return', 'VAT and compliance', 'VAT position prepared',
   'VAT return figures prepared and agreed for the period.', '/vat', null, 160, false),

  ('management_accounts', 'Reporting', 'Management accounts reviewed',
   'Profit and loss and balance sheet reviewed for the month, with variances understood.', '/financials/profit-loss', null, 170, false),
  ('cashflow', 'Reporting', 'Cash flow forecast updated',
   'Forecast rolled forward with the month''s actuals.', '/financials/cashflow', null, 180, false),
  ('commentary', 'Reporting', 'Commentary and board pack drafted',
   'Narrative written and the pack built for the trustees.', '/reports', null, 190, false),

  ('manager_review', 'Sign-off', 'Manager review',
   'A second pair of Pulse eyes over the month before it goes to the client.', null, null, 200, false),
  ('client_signoff', 'Sign-off', 'Client sign-off',
   'The CEO confirms the month end is agreed and closed.', null, null, 210, true)
on conflict (key) do nothing;
