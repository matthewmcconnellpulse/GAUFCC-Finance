-- 0007 — expense claims and lines.
--
-- Security intent: submitters own their drafts and nothing else. Claim totals
-- are trigger-maintained from the lines so a submitter can never hand-edit a
-- total; a guard trigger enforces WHO may change WHICH columns on a claim
-- (column-level rules RLS alone cannot express). Every change is audit-logged
-- (trigger attached in 0013), so status transitions are audited.

create table public.expense_claims (
  id uuid primary key default gen_random_uuid(),
  submitter_id uuid not null references public.profiles (id) on delete restrict,
  status public.claim_status not null default 'draft',
  period text not null check (period ~ '^\d{4}-\d{2}$'), -- e.g. '2026-06'
  total numeric(14, 2) not null default 0, -- maintained by trigger from expense_lines
  ceo_approved_by uuid references public.profiles (id),
  ceo_approved_at timestamptz,
  ceo_comment text,
  xero_bill_id text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index expense_claims_submitter_idx on public.expense_claims (submitter_id, status);
create index expense_claims_status_idx on public.expense_claims (status, period);

drop trigger if exists expense_claims_set_updated_at on public.expense_claims;
create trigger expense_claims_set_updated_at
  before update on public.expense_claims
  for each row execute function app_private.set_updated_at();

create table public.expense_lines (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.expense_claims (id) on delete cascade,
  date date not null,
  description text not null default '',
  category text, -- Xero account code
  fund_id uuid references public.funds (id) on delete set null,
  net numeric(14, 2) not null default 0,
  vat numeric(14, 2) not null default 0,
  gross numeric(14, 2) not null default 0,
  receipt_storage_path text, -- object in the receipts bucket
  ai_extraction jsonb, -- AiExtraction payload; always shown with AiBadge + editable
  ai_confidence numeric(4, 3) check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index expense_lines_claim_idx on public.expense_lines (claim_id);
create index expense_lines_fund_idx on public.expense_lines (fund_id);

drop trigger if exists expense_lines_set_updated_at on public.expense_lines;
create trigger expense_lines_set_updated_at
  before update on public.expense_lines
  for each row execute function app_private.set_updated_at();

-- ── claim total maintenance ──────────────────────────────────────────────────
-- SECURITY DEFINER: fires when a submitter edits their own lines, but the
-- resulting claim update must succeed even though the submitter has no RLS
-- right to write expense_claims.total directly. A transaction-local GUC lets
-- the claim guard below distinguish this trusted path from a hand-edit.

create or replace function app_private.refresh_claim_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim uuid;
begin
  -- OLD/NEW must not be referenced for the wrong operation — branch explicitly
  if tg_op = 'DELETE' then
    v_claim := old.claim_id;
  else
    v_claim := new.claim_id;
  end if;

  perform set_config('app.claim_total_refresh', 'on', true);

  update public.expense_claims c
     set total = coalesce((select sum(l.gross) from public.expense_lines l where l.claim_id = v_claim), 0)
   where c.id = v_claim;

  -- a line moved between claims: refresh the claim it left, too
  -- (nested if: AND does not guarantee short-circuit, and OLD is unassigned on INSERT)
  if tg_op = 'UPDATE' then
    if new.claim_id is distinct from old.claim_id then
      update public.expense_claims c
         set total = coalesce((select sum(l.gross) from public.expense_lines l where l.claim_id = old.claim_id), 0)
       where c.id = old.claim_id;
    end if;
  end if;

  perform set_config('app.claim_total_refresh', '', true);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function app_private.refresh_claim_total() from public;

drop trigger if exists expense_lines_refresh_total on public.expense_lines;
create trigger expense_lines_refresh_total
  after insert or update or delete on public.expense_lines
  for each row execute function app_private.refresh_claim_total();

-- ── claim column/transition guard ───────────────────────────────────────────
-- RLS (0014) decides which ROWS a role may update; this trigger decides which
-- COLUMNS and which status transitions. service_role and definer paths
-- (auth.uid() is null) bypass — the edge functions are trusted.

create or replace function app_private.guard_expense_claim_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.role := app_private.get_role(auth.uid());
  v_total_refresh boolean :=
    coalesce(current_setting('app.claim_total_refresh', true), '') = 'on';
begin
  -- trusted paths: service role / cron / definer functions
  if auth.uid() is null then
    return new;
  end if;

  -- nobody hand-edits the trigger-maintained total
  if new.total is distinct from old.total and not v_total_refresh and v_role <> 'pulse_admin' then
    raise exception 'claim total is calculated from its lines and cannot be edited directly';
  end if;

  if v_role = 'pulse_admin' then
    return new;
  end if;

  -- immutable facts for everyone below admin
  if new.submitter_id is distinct from old.submitter_id
     or new.created_at is distinct from old.created_at then
    raise exception 'claim ownership cannot be changed';
  end if;

  -- anyone ACTIVE editing THEIR OWN draft claim follows the submitter rules —
  -- this also covers the CEO or a bookkeeper claiming their own expenses.
  -- v_role is null for deactivated profiles, which always fail closed.
  if v_role is not null and old.submitter_id = auth.uid() and old.status = 'draft' then
    if new.status not in ('draft', 'submitted') then
      raise exception 'a draft can only stay draft or be submitted';
    end if;
    if new.ceo_approved_by is not null
       or new.ceo_approved_at is not null
       or new.ceo_comment is distinct from old.ceo_comment
       or new.xero_bill_id is distinct from old.xero_bill_id then
      raise exception 'approval fields are not editable on your own claim';
    end if;
    if new.status = 'submitted' and new.submitted_at is null then
      new.submitted_at := now();
    end if;
    return new;
  end if;

  if v_role = 'ceo' then
    -- CEO touches only the approval fields on a submitted claim
    if old.status <> 'submitted' then
      raise exception 'only submitted claims can be approved or rejected';
    end if;
    if new.status not in ('approved', 'rejected', 'submitted') then
      raise exception 'CEO may only approve or reject';
    end if;
    if new.period is distinct from old.period
       or new.xero_bill_id is distinct from old.xero_bill_id
       or new.submitted_at is distinct from old.submitted_at then
      raise exception 'CEO may only change approval fields';
    end if;
    if new.status in ('approved', 'rejected') then
      new.ceo_approved_by := auth.uid();
      new.ceo_approved_at := now();
    end if;
    return new;
  end if;

  if v_role = 'pulse_bookkeeper' then
    -- bookkeeper processes claims but never fabricates a CEO decision
    if new.ceo_approved_by is distinct from old.ceo_approved_by
       or new.ceo_approved_at is distinct from old.ceo_approved_at then
      raise exception 'CEO approval fields are set by the CEO';
    end if;
    if new.status is distinct from old.status
       and not (
         (old.status = 'approved' and new.status in ('pushed_to_xero', 'submitted'))
         or (old.status = 'pushed_to_xero' and new.status = 'paid')
         or (old.status = 'submitted' and new.status = 'draft') -- return to submitter
       ) then
      raise exception 'invalid claim status transition for bookkeeper: % -> %', old.status, new.status;
    end if;
    return new;
  end if;

  -- submitters editing anything that is not their own draft (and any role not
  -- matched above) are refused; RLS should already have filtered these rows.
  raise exception 'role % may not update this claim', coalesce(v_role::text, 'none');
end;
$$;

revoke all on function app_private.guard_expense_claim_update() from public;

drop trigger if exists expense_claims_guard on public.expense_claims;
create trigger expense_claims_guard
  before update on public.expense_claims
  for each row execute function app_private.guard_expense_claim_update();

-- ── helpers for expense_lines RLS ───────────────────────────────────────────

create or replace function app_private.claim_owner(p_claim_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.submitter_id from public.expense_claims c where c.id = p_claim_id
$$;

create or replace function app_private.claim_status(p_claim_id uuid)
returns public.claim_status
language sql
stable
security definer
set search_path = ''
as $$
  select c.status from public.expense_claims c where c.id = p_claim_id
$$;

revoke all on function app_private.claim_owner(uuid) from public;
revoke all on function app_private.claim_status(uuid) from public;
grant execute on function app_private.claim_owner(uuid) to authenticated, anon, service_role;
grant execute on function app_private.claim_status(uuid) to authenticated, anon, service_role;
