-- 0048 — per-user access to specific parts of the system.
--
-- Until now one `role` decided everything. That works for the six defined
-- roles and not at all for "Nick manages a fund budget, so he needs Funds and
-- Expenses" — there is no role for that, and inventing one per person does not
-- scale.
--
-- A module grant is ADDITIVE and READ-ONLY. It widens who may look at a part
-- of the system; it never widens what anyone may do there. Approving a claim,
-- editing a fund or pushing to Xero still needs the role that already carries
-- it, so a grant can be handed out without anyone acquiring the ability to
-- move money.
--
-- Row scope is unchanged: a Funds grant sees the funds that person is named
-- responsible for, exactly as a trustee does, and the ledger lines behind
-- them. Restricted-fund data stays need-to-know, and widening someone's view
-- is done by assigning them another fund rather than by editing policies.
--
-- 'settings' is deliberately NOT grantable. Settings is where roles and grants
-- themselves are administered, so a grant that opened it would let a grant
-- escalate into any other grant.

create table if not exists public.profile_modules (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  module text not null check (module in (
    'funds', 'reports', 'expenses', 'financials', 'cashflow',
    'month_end', 'vat', 'projects', 'people', 'imports'
  )),
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (profile_id, module)
);

create index if not exists profile_modules_profile_idx on public.profile_modules (profile_id);

alter table public.profile_modules enable row level security;

-- Everyone may see their OWN grants (the sidebar needs them); Pulse and the
-- CEO see everyone's, because they are the ones administering access.
drop policy if exists profile_modules_select on public.profile_modules;
create policy profile_modules_select on public.profile_modules
  for select to authenticated
  using (
    profile_id = auth.uid()
    or app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  );

-- Only a Pulse admin grants and revokes. Not the CEO: handing out access to
-- the ledger is our control, and it is auditable below.
drop policy if exists profile_modules_write on public.profile_modules;
create policy profile_modules_write on public.profile_modules
  for all to authenticated
  using (app_private.is_pulse_admin(auth.uid()))
  with check (app_private.is_pulse_admin(auth.uid()));

revoke all on public.profile_modules from anon;

drop trigger if exists profile_modules_audit on public.profile_modules;
create trigger profile_modules_audit
  after insert or update or delete on public.profile_modules
  for each row execute function app_private.audit_changes();

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Explicit grants ONLY. What a role already implies stays expressed in the
-- policies themselves, so there is never a second place that also decides.
create or replace function app_private.has_module(p_uid uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile_modules m
    where m.profile_id = p_uid and m.module = p_module
  )
$$;

/**
 * Who reads fund data at fund scope: trustees by role, plus anyone holding the
 * Funds grant. One helper rather than the same disjunction copied into five
 * policies — two copies of one rule drift, which is exactly how the fund
 * coverage check came to report funds that were plainly there.
 */
create or replace function app_private.reads_scoped_funds(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.get_role(p_uid) = 'trustee'
      or app_private.has_module(p_uid, 'funds')
$$;

comment on function app_private.reads_scoped_funds(uuid) is
  'True for callers who may read fund data limited to the funds they are named responsible for: trustees by role, and holders of the Funds module grant.';

grant execute on function app_private.has_module(uuid, text) to authenticated;
grant execute on function app_private.reads_scoped_funds(uuid) to authenticated;

-- ── Fund data: swap the trustee-only clause for the shared helper ───────────

drop policy if exists funds_select on public.funds;
create policy funds_select on public.funds
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (app_private.reads_scoped_funds(auth.uid()) and app_private.manages_fund(auth.uid(), id))
  );

drop policy if exists fund_warnings_select on public.fund_warnings;
create policy fund_warnings_select on public.fund_warnings
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (app_private.reads_scoped_funds(auth.uid()) and app_private.manages_fund(auth.uid(), fund_id))
  );

drop policy if exists fund_notes_select on public.fund_notes;
create policy fund_notes_select on public.fund_notes
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (app_private.reads_scoped_funds(auth.uid()) and app_private.manages_fund(auth.uid(), fund_id))
  );

drop policy if exists xero_transactions_select on public.xero_transactions;
create policy xero_transactions_select on public.xero_transactions
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (
      app_private.reads_scoped_funds(auth.uid())
      and tracking_option_1_id is not null
      and app_private.manages_tracking_option(auth.uid(), tracking_option_1_id)
    )
  );

-- Who else is responsible for the funds you are responsible for.
drop policy if exists fund_managers_select on public.fund_managers;
create policy fund_managers_select on public.fund_managers
  for select to authenticated
  using (
    (profile_id = auth.uid() and app_private.get_role(auth.uid()) is not null)
    or app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (app_private.reads_scoped_funds(auth.uid()) and app_private.manages_fund(auth.uid(), fund_id))
  );

-- ── Expenses: claims that spend the funds you are responsible for ───────────
--
-- Scoped the same way as everything else rather than opening every claim: the
-- reason to grant Expenses alongside Funds is to watch spend against a fund
-- budget, and that does not require reading colleagues' unrelated claims.

create or replace function app_private.claim_touches_managed_fund(p_uid uuid, p_claim_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.expense_lines l
    where l.claim_id = p_claim_id
      and l.fund_id is not null
      and app_private.manages_fund(p_uid, l.fund_id)
  )
$$;

grant execute on function app_private.claim_touches_managed_fund(uuid, uuid) to authenticated;

drop policy if exists expense_claims_select on public.expense_claims;
create policy expense_claims_select on public.expense_claims
  for select to authenticated
  using (
    (submitter_id = auth.uid() and app_private.get_role(auth.uid()) is not null)
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
    or (
      app_private.has_module(auth.uid(), 'expenses')
      and app_private.claim_touches_managed_fund(auth.uid(), id)
    )
  );

drop policy if exists expense_lines_select on public.expense_lines;
create policy expense_lines_select on public.expense_lines
  for select to authenticated
  using (
    (app_private.claim_owner(claim_id) = auth.uid() and app_private.get_role(auth.uid()) is not null)
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
    or (
      app_private.has_module(auth.uid(), 'expenses')
      and app_private.claim_touches_managed_fund(auth.uid(), claim_id)
    )
  );
