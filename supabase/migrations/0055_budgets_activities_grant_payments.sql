-- 0055_budgets_activities_grant_payments.sql
--
-- Four things that belong together, because each feeds the next:
--
--   1. What counts as a posted ledger line — tightened BEFORE anything below
--      can create draft bills in Xero.
--   2. Activities: the nominal ledger grouped by what the money was for.
--   3. Budgets: fund × nominal code × month, over any period.
--   4. Grant payments: scheduled payments out of a fund, with an approval
--      checklist, overdue flags and a push to Xero as draft bills — and the
--      endowment distribution schedule that generates them (the James Speed
--      Trust being the first).

-- ── 1. A posted line ─────────────────────────────────────────────────────────
--
-- Until now "live" meant "not voided or deleted", which was correct while
-- every document in the mirror had been approved in Xero. This migration
-- makes it possible to send DRAFT bills to Xero; the next sync would bring
-- them back, and a draft would then count as real expenditure — £48k of
-- Speed Trust payments dated through to September 2027 landing in the fund's
-- balance the moment they were drafted. Xero's own reports exclude DRAFT and
-- SUBMITTED (awaiting approval) documents, so the platform now does too.
--
-- Today the mirror holds only AUTHORISED, PAID and POSTED documents, so this
-- changes no figure on any screen. It is what keeps it that way.

create or replace function app_private.is_live_document(p_status text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(upper(p_status), '') not in ('VOIDED', 'DELETED', 'DRAFT', 'SUBMITTED')
$$;

comment on function app_private.is_live_document(text) is
  'True for a ledger line that is posted in Xero. Excludes voided and deleted documents, and drafts and documents awaiting approval, which Xero itself leaves out of every report.';

-- ── 2. Activities ────────────────────────────────────────────────────────────
--
-- GAUFCC's chart of accounts already carries its activity structure in the
-- account names: EC Executive Committee, AM Annual Meetings, YP, WD, MG, VIS,
-- GA, EH, FIN and the rest. This makes that structure a thing reports and
-- budgets can group by, instead of something a reader decodes from a prefix.
--
-- The mapping is seeded from those prefixes plus a few unambiguous keyword
-- rules, marked assigned_by = 'rule' so a suggestion is never mistaken for a
-- decision, and is editable. Accounts no rule recognises are left unmapped and
-- report as Unassigned rather than being guessed into an activity.

create table if not exists public.activities (
  code text primary key check (code ~ '^[A-Z0-9_]{1,12}$'),
  name text not null,
  description text,
  sort integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_activities (
  account_code text primary key,
  activity_code text not null references public.activities (code) on update cascade,
  -- 'rule' = seeded from the account name; 'manual' = chosen by a person.
  assigned_by text not null default 'manual' check (assigned_by in ('rule', 'manual')),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

insert into public.activities (code, name, sort, description) values
  ('GA',     'General Assembly – central costs', 10, 'Staff, office, audit, legal and insurance (GA accounts).'),
  ('EC',     'Executive Committee',              20, null),
  ('AM',     'Annual Meetings',                  30, null),
  ('MG',     'Ministry & congregations',         40, 'MG and MGSO accounts, congregational development and connections.'),
  ('YP',     'Young people',                     50, null),
  ('WD',     'Welsh programme',                  60, null),
  ('LL',     'Learning & summer school',         70, 'LL / LLI — Hucklow Summer School.'),
  ('VIS',    'Visibility',                       80, null),
  ('COMMS',  'Communications',                   90, null),
  ('CO',     'CO (rename)',                      95, 'From the CO account prefix — name not yet confirmed.'),
  ('GRANTS', 'Grants paid',                     100, 'Grants to individuals, to Unitarians, bursaries.'),
  ('EH',     'Essex Hall',                      110, null),
  ('OE',     'OE – property',                   115, 'From the OE account prefix — name not yet confirmed.'),
  ('FIN',    'Finance',                         120, null),
  ('INV',    'Investments',                     130, 'Interest, dividends, gains and investment fees.'),
  ('DON',    'Donations, legacies & grants received', 140, null),
  ('MEM',    'Membership & quota',              150, null)
on conflict (code) do nothing;

-- Prefix rules first, so "EH Essex Hall Grant Income" is Essex Hall and not a
-- grant received; keyword rules only for what no prefix claimed.
insert into public.account_activities (account_code, activity_code, assigned_by)
select code, activity, 'rule'
from (
  select a.code,
    case
      when a.name ~ '^AM\s'               then 'AM'
      when a.name ~ '^EC\s'               then 'EC'
      when a.name ~ '^CO\s'               then 'CO'
      when a.name ~ '^WD\s'               then 'WD'
      when a.name ~ '^YP\s'               then 'YP'
      when a.name ~ '^LLI?\s'             then 'LL'
      when a.name ~ '^MG(SO)?\s'          then 'MG'
      when a.name ~ '^VIS\s'              then 'VIS'
      when a.name ~ '^GA\s'               then 'GA'
      when a.name ~ '^EH\s'               then 'EH'
      when a.name ~ '^OE\s'               then 'OE'
      when a.name ~ '^FIN\s'              then 'FIN'
      when a.name ~* '^comms\M'           then 'COMMS'
      when a.name ~* 'congregation|congregconn|ministry' then 'MG'
      when a.name ~* '^grants\M'          then 'GRANTS'
      when a.name ~* 'interest income|dividend|gains|epworth fees|revaluation' then 'INV'
      when a.name ~* 'legacy|donation|grant income' then 'DON'
      when a.name ~* 'subscription|quota|membership' then 'MEM'
      -- The GA band, for the one unprefixed account in it (redundancy costs).
      when a.code ~ '^4[0-3][0-9]{4}$'    then 'GA'
    end as activity
  from public.xero_accounts a
  where a.class in ('REVENUE', 'EXPENSE') and a.code is not null
) seeded
where activity is not null
on conflict (account_code) do nothing;

-- ── 3. Budgets ───────────────────────────────────────────────────────────────
--
-- Budgets are held here, not in Xero. Xero's budgets need a scope the
-- connection does not have, cannot carry a fund AND an activity together, and
-- would put budget-setting behind a login most of the people setting budgets
-- do not have.
--
-- A line is fund × nominal code × month. Activity is NOT stored on the line:
-- it is a property of the nominal code, so a budget re-groups by activity the
-- moment the activity mapping changes, and the two can never disagree.
--
-- Amounts are entered as positive figures in the account's own direction — an
-- income budget of £5,000 and a cost budget of £5,000 are both 5000 — which is
-- how people write budgets and how Xero stores them. Direction comes from the
-- account class at reporting time. A fund of NULL means a charity-level line
-- not held against any fund.

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  notes text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  check (extract(day from period_start) = 1)
);

create table if not exists public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references public.budgets (id) on delete cascade,
  fund_id uuid references public.funds (id) on delete restrict,
  account_code text not null,
  month date not null check (extract(day from month) = 1),
  amount numeric(14, 2) not null default 0,
  note text,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (budget_id, fund_id, account_code, month)
);

create index if not exists budget_lines_budget_fund_idx on public.budget_lines (budget_id, fund_id);

insert into public.budgets (name, period_start, period_end, notes)
select 'Budget 2026/27', date '2026-10-01', date '2027-09-30',
       'Financial year 1 October 2026 to 30 September 2027.'
where not exists (select 1 from public.budgets where period_start = date '2026-10-01');

-- ── 4. Distributions and grant payments ──────────────────────────────────────

create table if not exists public.distribution_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  year_label text not null,
  -- The fund the payments are made from (the restricted fund).
  fund_id uuid not null references public.funds (id) on delete restrict,
  -- The funds whose combined value is distributed (endowment + restricted).
  valuation_fund_ids uuid[] not null,
  valuation_date date not null,
  -- NULL = take the value from the ledger at valuation_date.
  fund_value_override numeric(14, 2),
  restricted_closing_override numeric(14, 2),
  rate numeric(8, 5) not null check (rate >= 0 and rate <= 1),
  ga_fee_rate numeric(8, 5) not null default 0.02 check (ga_fee_rate >= 0 and ga_fee_rate <= 1),
  account_code text not null default '436021',
  tracking_option_2_id text,
  instalments jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'agreed')),
  agreed_by uuid references public.profiles (id),
  agreed_at timestamptz,
  notes text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.distribution_payees (
  id uuid primary key default gen_random_uuid(),
  distribution_id uuid not null references public.distribution_schedules (id) on delete cascade,
  label text not null,
  group_label text not null default '',
  xero_contact_id text,
  xero_contact_name text,
  fixed_grant numeric(14, 2) not null default 0,
  backlog numeric(14, 2) not null default 0,
  backlog_note text,
  sort integer not null default 0
);

create table if not exists public.fund_payments (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds (id) on delete restrict,
  distribution_id uuid references public.distribution_schedules (id) on delete set null,
  distribution_payee_id uuid references public.distribution_payees (id) on delete set null,
  instalment_index integer,
  payee_name text not null,
  xero_contact_id text,
  account_code text not null default '436021',
  tracking_option_2_id text,
  reference text,
  description text,
  pay_date date not null,
  amount numeric(14, 2) not null check (amount > 0),
  -- Approval falls due this many days before the payment does.
  approval_lead_days integer not null default 14 check (approval_lead_days between 0 and 365),
  checklist jsonb not null default '[]'::jsonb,
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  -- Written only by the xero-grant-bills function (service role).
  xero_invoice_id text unique,
  xero_status text,
  xero_amount_due numeric(14, 2),
  xero_amount_paid numeric(14, 2),
  xero_checked_at timestamptz,
  pushed_by uuid references public.profiles (id),
  pushed_at timestamptz,
  push_error text,
  notes text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (distribution_id, distribution_payee_id, instalment_index)
);

create index if not exists fund_payments_fund_date_idx on public.fund_payments (fund_id, pay_date);

/**
 * The approval process, enforced where it cannot be bypassed.
 *
 *  - Only the CEO or a Pulse admin may approve, and only once every checklist
 *    item is ticked. Who approved, and when, is stamped here — never taken
 *    from the client.
 *  - Who ticked each checklist item, and when, is stamped the same way, and
 *    survives later edits: re-sending a ticked item cannot change its author.
 *  - Changing anything that matters (amount, date, payee, account, fund)
 *    lapses an existing approval. An approval is of specific figures.
 *  - Unticking a checklist item lapses approval too.
 *  - Once a payment is in Xero it is frozen apart from its notes: the bill is
 *    the record now, and it must be changed or voided there.
 *  - The Xero columns are written by the push function alone.
 */
create or replace function app_private.guard_fund_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.role;
  v_old_checklist jsonb := '[]'::jsonb;
  v_material boolean := false;
  v_all_ticked boolean;
begin
  -- Trusted paths (the push function, migrations) write the Xero columns.
  if v_uid is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_role := app_private.get_role(v_uid);

  if tg_op = 'DELETE' then
    if old.xero_invoice_id is not null then
      raise exception 'This payment is already in Xero as a bill — void it in Xero, it cannot be deleted here.';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    v_old_checklist := coalesce(old.checklist, '[]'::jsonb);

    if new.xero_invoice_id is distinct from old.xero_invoice_id
      or new.xero_status is distinct from old.xero_status
      or new.xero_amount_due is distinct from old.xero_amount_due
      or new.xero_amount_paid is distinct from old.xero_amount_paid
      or new.xero_checked_at is distinct from old.xero_checked_at
      or new.pushed_by is distinct from old.pushed_by
      or new.pushed_at is distinct from old.pushed_at
      or new.push_error is distinct from old.push_error then
      raise exception 'The Xero fields are written by the push to Xero, not edited.';
    end if;

    if old.xero_invoice_id is not null then
      if (new.fund_id, new.payee_name, new.xero_contact_id, new.account_code, new.tracking_option_2_id,
          new.reference, new.description, new.pay_date, new.amount, new.approval_lead_days,
          new.checklist, new.approved_by, new.approved_at)
         is distinct from
         (old.fund_id, old.payee_name, old.xero_contact_id, old.account_code, old.tracking_option_2_id,
          old.reference, old.description, old.pay_date, old.amount, old.approval_lead_days,
          old.checklist, old.approved_by, old.approved_at) then
        raise exception 'This payment is already in Xero (bill %). Change or void the bill in Xero; only the notes can be edited here.', old.xero_invoice_id;
      end if;
      new.updated_at := now();
      return new;
    end if;

    v_material := (new.fund_id, new.payee_name, new.xero_contact_id, new.account_code, new.pay_date, new.amount)
                  is distinct from
                  (old.fund_id, old.payee_name, old.xero_contact_id, old.account_code, old.pay_date, old.amount);
  else
    if new.xero_invoice_id is not null or new.xero_status is not null or new.pushed_at is not null then
      raise exception 'A payment cannot be created already in Xero.';
    end if;
  end if;

  -- Stamp the checklist: author and time for newly ticked items, preserved
  -- for items already ticked, cleared for items unticked.
  select coalesce(jsonb_agg(
           case
             when coalesce((n.e ->> 'done')::boolean, false) then
               (n.e - 'done_by' - 'done_at') || jsonb_build_object(
                 'done_by', case when coalesce((o.e ->> 'done')::boolean, false)
                                 then o.e -> 'done_by' else to_jsonb(v_uid::text) end,
                 'done_at', case when coalesce((o.e ->> 'done')::boolean, false)
                                 then o.e -> 'done_at' else to_jsonb(now()) end)
             else (n.e - 'done_by' - 'done_at') || jsonb_build_object('done', false)
           end
           order by n.ord), '[]'::jsonb)
    into new.checklist
  from jsonb_array_elements(coalesce(new.checklist, '[]'::jsonb)) with ordinality as n(e, ord)
  left join jsonb_array_elements(v_old_checklist) as o(e) on o.e ->> 'key' = n.e ->> 'key';

  v_all_ticked := jsonb_array_length(new.checklist) > 0
    and not exists (
      select 1 from jsonb_array_elements(new.checklist) e
      where not coalesce((e ->> 'done')::boolean, false)
    );

  if tg_op = 'INSERT' then
    if new.approved_at is not null then
      raise exception 'A payment is created unapproved; approve it once its checklist is complete.';
    end if;
    new.approved_by := null;
    new.created_by := v_uid;
    return new;
  end if;

  -- Approving now.
  if new.approved_at is not null and old.approved_at is null then
    if v_role not in ('ceo', 'pulse_admin') then
      raise exception 'Only the CEO or a Pulse admin can approve a grant payment.';
    end if;
    if not v_all_ticked then
      raise exception 'Every checklist item must be ticked before the payment can be approved.';
    end if;
    new.approved_at := now();
    new.approved_by := v_uid;
  -- Already approved: a material change or an unticked item lapses it.
  elsif old.approved_at is not null and new.approved_at is not null then
    if v_material or not v_all_ticked then
      new.approved_at := null;
      new.approved_by := null;
    else
      new.approved_at := old.approved_at;
      new.approved_by := old.approved_by;
    end if;
  -- Withdrawing an approval deliberately.
  elsif old.approved_at is not null and new.approved_at is null then
    if v_role not in ('ceo', 'pulse_admin') then
      raise exception 'Only the CEO or a Pulse admin can withdraw an approval.';
    end if;
    new.approved_by := null;
  else
    new.approved_by := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.guard_fund_payment() from public;

drop trigger if exists fund_payments_guard on public.fund_payments;
create trigger fund_payments_guard
  before insert or update or delete on public.fund_payments
  for each row execute function app_private.guard_fund_payment();

-- Where each payment stands. Derived, never stored, so "overdue" is always
-- measured against today rather than against the day someone last looked.
create or replace view public.v_fund_payments
with (security_invoker = true)
as
select
  p.*,
  (p.pay_date - p.approval_lead_days) as approval_due,
  case
    when upper(coalesce(p.xero_status, '')) = 'PAID' then 'paid'
    when upper(coalesce(p.xero_status, '')) in ('VOIDED', 'DELETED') then 'voided'
    when p.xero_invoice_id is not null then 'in_xero'
    when p.approved_at is not null then 'approved'
    else 'awaiting_approval'
  end as state,
  (p.approved_at is null and p.xero_invoice_id is null
     and current_date >= (p.pay_date - p.approval_lead_days)) as approval_overdue,
  (current_date > p.pay_date
     and upper(coalesce(p.xero_status, '')) not in ('PAID', 'VOIDED', 'DELETED')) as payment_overdue
from public.fund_payments p;

-- One row per fund for the fund register's attention flags.
create or replace view public.v_fund_payment_flags
with (security_invoker = true)
as
select
  v.fund_id,
  count(*) filter (where v.approval_overdue) as approvals_overdue,
  count(*) filter (where v.payment_overdue) as payments_overdue,
  count(*) filter (where v.state not in ('paid', 'voided')
                     and v.pay_date between current_date and current_date + 60) as upcoming_60d,
  min(v.pay_date) filter (where v.state not in ('paid', 'voided') and v.pay_date >= current_date) as next_pay_date
from public.v_fund_payments v
group by v.fund_id;

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Reads follow the fund register exactly: Pulse and the CEO see everything;
-- trustees and Funds-grant holders see only the funds they are named
-- responsible for. Writes are Pulse and the CEO — module grants open a door to
-- read, never to change (agreed when grants were introduced).

alter table public.activities enable row level security;
alter table public.account_activities enable row level security;
alter table public.budgets enable row level security;
alter table public.budget_lines enable row level security;
alter table public.distribution_schedules enable row level security;
alter table public.distribution_payees enable row level security;
alter table public.fund_payments enable row level security;

drop policy if exists activities_select on public.activities;
create policy activities_select on public.activities
  for select to authenticated using (app_private.get_role(auth.uid()) is not null);
drop policy if exists activities_write on public.activities;
create policy activities_write on public.activities
  for all to authenticated
  using (app_private.is_pulse(auth.uid()))
  with check (app_private.is_pulse(auth.uid()));

drop policy if exists account_activities_select on public.account_activities;
create policy account_activities_select on public.account_activities
  for select to authenticated using (app_private.get_role(auth.uid()) is not null);
drop policy if exists account_activities_write on public.account_activities;
create policy account_activities_write on public.account_activities
  for all to authenticated
  using (app_private.is_pulse(auth.uid()))
  with check (app_private.is_pulse(auth.uid()));

drop policy if exists budgets_select on public.budgets;
create policy budgets_select on public.budgets
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or app_private.reads_scoped_funds(auth.uid())
  );
drop policy if exists budgets_write on public.budgets;
create policy budgets_write on public.budgets
  for all to authenticated
  using (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
  with check (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo');

drop policy if exists budget_lines_select on public.budget_lines;
create policy budget_lines_select on public.budget_lines
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (
      app_private.reads_scoped_funds(auth.uid())
      and fund_id is not null
      and app_private.manages_fund(auth.uid(), fund_id)
    )
  );
drop policy if exists budget_lines_write on public.budget_lines;
create policy budget_lines_write on public.budget_lines
  for all to authenticated
  using (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
  with check (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo');

drop policy if exists distribution_schedules_select on public.distribution_schedules;
create policy distribution_schedules_select on public.distribution_schedules
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (app_private.reads_scoped_funds(auth.uid()) and app_private.manages_fund(auth.uid(), fund_id))
  );
drop policy if exists distribution_schedules_write on public.distribution_schedules;
create policy distribution_schedules_write on public.distribution_schedules
  for all to authenticated
  using (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
  with check (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo');

drop policy if exists distribution_payees_select on public.distribution_payees;
create policy distribution_payees_select on public.distribution_payees
  for select to authenticated
  using (
    exists (
      select 1 from public.distribution_schedules s
      where s.id = distribution_id
        and (
          app_private.is_pulse(auth.uid())
          or app_private.get_role(auth.uid()) = 'ceo'
          or (app_private.reads_scoped_funds(auth.uid()) and app_private.manages_fund(auth.uid(), s.fund_id))
        )
    )
  );
drop policy if exists distribution_payees_write on public.distribution_payees;
create policy distribution_payees_write on public.distribution_payees
  for all to authenticated
  using (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
  with check (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo');

drop policy if exists fund_payments_select on public.fund_payments;
create policy fund_payments_select on public.fund_payments
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (app_private.reads_scoped_funds(auth.uid()) and app_private.manages_fund(auth.uid(), fund_id))
  );
drop policy if exists fund_payments_write on public.fund_payments;
create policy fund_payments_write on public.fund_payments
  for all to authenticated
  using (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
  with check (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo');

-- ── Audit ────────────────────────────────────────────────────────────────────

drop trigger if exists budgets_audit on public.budgets;
create trigger budgets_audit after insert or update or delete on public.budgets
  for each row execute function app_private.audit_changes();
drop trigger if exists account_activities_audit on public.account_activities;
create trigger account_activities_audit after insert or update or delete on public.account_activities
  for each row execute function app_private.audit_changes();
drop trigger if exists distribution_schedules_audit on public.distribution_schedules;
create trigger distribution_schedules_audit after insert or update or delete on public.distribution_schedules
  for each row execute function app_private.audit_changes();
drop trigger if exists fund_payments_audit on public.fund_payments;
create trigger fund_payments_audit after insert or update or delete on public.fund_payments
  for each row execute function app_private.audit_changes();

-- ── Seed: the James Speed Trust 2026/27 schedule ─────────────────────────────
--
-- As on "DRAFT Speed distribution 2026-27.xlsx": 4% of the combined fund
-- value at 30 September 2026, four payees, quarterly on the 20th. Left as a
-- DRAFT — the rate is "to be agreed by GA Trustees". Contacts are the ones the
-- September 2026 bills were raised to. Looked up by name, not hard-coded ids.

insert into public.distribution_schedules
  (name, year_label, fund_id, valuation_fund_ids, valuation_date, rate, ga_fee_rate,
   account_code, tracking_option_2_id, instalments, notes)
select
  'James Speed Trust distribution', '2026/27',
  jstr.id,
  array[jstr.id, jste.id],
  date '2026-09-30',
  0.04, 0.02,
  '436021',
  (select o.tracking_option_id from public.xero_tracking_options o
     join public.xero_tracking_categories c on c.tracking_category_id = o.tracking_category_id
    where c.position = 2 and o.name = 'RF - Restricted Funds' limit 1),
  '[{"label":"Q1 2026/27","payDate":"2026-12-20"},
    {"label":"Q2 2026/27","payDate":"2027-03-20"},
    {"label":"Q3 2026/27","payDate":"2027-06-20"},
    {"label":"Q4 2026/27","payDate":"2027-09-20"}]'::jsonb,
  'Proposed distribution rate to be agreed by GA Trustees.'
from public.funds jstr, public.funds jste
where jstr.name = '113 Restricted funds - James Speed Trust'
  and jste.name = '201 Endowment funds - James Speed Trust'
  and not exists (
    select 1 from public.distribution_schedules d
    where d.name = 'James Speed Trust distribution' and d.year_label = '2026/27'
  );

insert into public.distribution_payees
  (distribution_id, label, group_label, xero_contact_id, xero_contact_name, fixed_grant, backlog, backlog_note, sort)
select d.id, p.label, p.group_label, c.contact_id, c.name, p.fixed_grant, p.backlog, p.backlog_note, p.sort
from public.distribution_schedules d
cross join (values
  ('Edinburgh - Rev Janine Sim', 'Ministers', 'Janine Sim', 50.00, 3902.00,
     'Backlog at £3,902pa (Yr 2 of 10, agreed with GW and DMcA)', 1),
  ('Dundee - Rev Rob Whiteman', 'Ministers', 'Rob Whiteman', 50.00, 2800.00,
     'Backlog at £2,800pa (Yr 10 of 10, agreed with DMcA)', 2),
  ('Edinburgh', 'Congregations', 'St Marks Unitarian Church', 0.00, 0.00, null, 3),
  ('Dundee', 'Congregations', 'Williamson Memorial Unitarian Church', 0.00, 0.00, null, 4)
) as p(label, group_label, contact_name, fixed_grant, backlog, backlog_note, sort)
left join public.xero_contacts c on c.name = p.contact_name
where d.name = 'James Speed Trust distribution' and d.year_label = '2026/27'
  and not exists (select 1 from public.distribution_payees x where x.distribution_id = d.id);

-- ── Reports open on the current financial year ───────────────────────────────
--
-- Asked for explicitly now that FY 2026/27 is under way, with the prior year a
-- toggle away. Still a setting, still changeable in Settings.
update public.settings
set value = '{"mode": "preset", "preset": "fy"}'::jsonb
where key = 'report_default_period';
