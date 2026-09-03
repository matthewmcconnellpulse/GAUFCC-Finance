-- 0037 — claim review workflow: return for amendment, archive, mileage lines.
--
-- · Reviewers (Pulse on submitted/approved claims, the CEO on submitted ones)
--   can hand a claim back to the claimant with a note instead of rejecting it
--   outright: status → draft, review_note / returned_by / returned_at set,
--   any CEO approval cleared so the amended claim is approved afresh.
-- · Claims can be archived — hidden from the working lists, fully reversible
--   (archived_at / archived_by). Deletion stays as 0014 left it: own drafts,
--   or the Pulse admin.
-- · Mileage lines: miles × rate. The rate (pence per mile) is captured on the
--   line so old claims keep the rate that applied; the current company rate
--   lives in settings (HMRC's approved rate is 45p but the charity may differ).

alter table public.expense_claims
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles (id) on delete set null,
  add column if not exists review_note text,
  add column if not exists returned_by uuid references public.profiles (id) on delete set null,
  add column if not exists returned_at timestamptz;

create index if not exists expense_claims_archived_idx
  on public.expense_claims (archived_at)
  where archived_at is not null;

alter table public.expense_lines
  add column if not exists is_mileage boolean not null default false,
  add column if not exists miles numeric(8, 1) check (miles is null or miles >= 0),
  add column if not exists mileage_rate_pence numeric(6, 2)
    check (mileage_rate_pence is null or mileage_rate_pence >= 0);

insert into public.settings (key, value, description) values
  ('mileage_rate_pence', '45'::jsonb,
   'Pence per mile paid on mileage claims. HMRC''s approved rate is 45p for the first 10,000 business miles; the charity may set its own.')
on conflict (key) do nothing;

-- ── claim column/transition guard (supersedes 0007) ─────────────────────────
-- RLS decides which ROWS a role may update; this decides which COLUMNS and
-- which status transitions. service_role / definer paths (auth.uid() is null)
-- bypass — the edge functions are trusted.

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
  -- a reviewer handing the claim back to the claimant for amendment
  v_returning boolean := old.status in ('submitted', 'approved') and new.status = 'draft';
begin
  if auth.uid() is null then
    return new;
  end if;

  -- nobody hand-edits the trigger-maintained total
  if new.total is distinct from old.total and not v_total_refresh and v_role <> 'pulse_admin' then
    raise exception 'claim total is calculated from its lines and cannot be edited directly';
  end if;

  -- a return for amendment always carries a note and is stamped by the
  -- reviewer; the CEO's earlier decision (if any) no longer applies.
  if v_returning then
    if coalesce(btrim(new.review_note), '') = '' then
      raise exception 'a note for the claimant is required when returning a claim';
    end if;
    new.returned_by := auth.uid();
    new.returned_at := now();
    new.ceo_approved_by := null;
    new.ceo_approved_at := null;
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
       or new.xero_bill_id is distinct from old.xero_bill_id
       or new.review_note is distinct from old.review_note
       or new.returned_by is distinct from old.returned_by
       or new.returned_at is distinct from old.returned_at then
      raise exception 'review fields are not editable on your own claim';
    end if;
    -- every (re)submission gets a fresh timestamp
    if new.status = 'submitted' then
      new.submitted_at := now();
    end if;
    return new;
  end if;

  if v_role = 'ceo' then
    -- CEO decides on a submitted claim: approve, reject, or return for amendment
    if old.status <> 'submitted' then
      raise exception 'only submitted claims can be approved, rejected or returned';
    end if;
    if new.status not in ('approved', 'rejected', 'submitted', 'draft') then
      raise exception 'CEO may only approve, reject or return a claim';
    end if;
    if new.period is distinct from old.period
       or new.xero_bill_id is distinct from old.xero_bill_id
       or new.submitted_at is distinct from old.submitted_at
       or new.archived_at is distinct from old.archived_at
       or new.archived_by is distinct from old.archived_by then
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
    -- (clearing one as part of a return for amendment is the exception)
    if not v_returning
       and (new.ceo_approved_by is distinct from old.ceo_approved_by
            or new.ceo_approved_at is distinct from old.ceo_approved_at) then
      raise exception 'CEO approval fields are set by the CEO';
    end if;
    if new.status is distinct from old.status
       and not (
         (old.status = 'approved' and new.status in ('pushed_to_xero', 'submitted'))
         or (old.status = 'pushed_to_xero' and new.status = 'paid')
         or v_returning
       ) then
      raise exception 'invalid claim status transition for bookkeeper: % -> %', old.status, new.status;
    end if;
    return new;
  end if;

  raise exception 'role % may not update this claim', coalesce(v_role::text, 'none');
end;
$$;

revoke all on function app_private.guard_expense_claim_update() from public;

-- The CEO's row policy has to admit the return-to-draft transition too.
drop policy if exists expense_claims_update_ceo on public.expense_claims;
create policy expense_claims_update_ceo on public.expense_claims
  for update to authenticated
  using (app_private.get_role(auth.uid()) = 'ceo' and status = 'submitted')
  with check (
    app_private.get_role(auth.uid()) = 'ceo'
    and status in ('submitted', 'approved', 'rejected', 'draft')
  );
