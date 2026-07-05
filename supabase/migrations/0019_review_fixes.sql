-- 0019 — post-review corrections
--
-- Fixes from the adversarial review pass:
--  (1) v_fund_monthly must apply the same opening_balance_date cutoff that
--      v_fund_balances does, or the balance chart and pack closing figures
--      disagree with the headline balance for funds with an opening date.
--  (2) Segregation of duties: the CEO must not approve their own expense claim.
--
-- The sync engine's document-natural sign convention is corrected in
-- supabase/functions/_shared/sync-engine.ts (redeployed) — no DDL needed, the
-- views were already written for the document-natural convention.

-- ── (1) v_fund_monthly — respect opening_balance_date ────────────────────────

create or replace view public.v_fund_monthly
with (security_invoker = true)
as
select
  f.id as fund_id,
  (date_trunc('month', t.date))::date as month,
  coalesce(sum(t.net) filter (where a.class = 'REVENUE'), 0)::numeric(14, 2) as income,
  coalesce(sum(t.net) filter (where a.class = 'EXPENSE'), 0)::numeric(14, 2) as expenditure
from public.funds f
join public.xero_transactions t
  on t.tracking_option_1_id = f.tracking_option_id
left join public.xero_accounts a
  on a.code = t.account_code
where f.opening_balance_date is null
   or t.date >= f.opening_balance_date
group by f.id, (date_trunc('month', t.date))::date;

comment on view public.v_fund_monthly is
  'Monthly income/expenditure per fund (document-natural net, classified by account class), from opening_balance_date onwards — so the cumulative chart reconciles to v_fund_balances. security_invoker: trustees see only their funds.';

-- ── (2) CEO cannot approve their own claim ───────────────────────────────────
-- Full replacement of the guard function with one added check in the CEO
-- branch. Everything else is byte-identical to 0007.

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
    -- segregation of duties: the CEO cannot approve or reject a claim they
    -- themselves submitted. Their own claim must be handled by a Pulse admin.
    if old.submitter_id = auth.uid() then
      raise exception 'a claim cannot be approved by the person who submitted it';
    end if;
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
