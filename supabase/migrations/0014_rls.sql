-- 0014 — row-level security: enable on EVERY table, deny by default.
--
-- Principles (trustee-facing security intent):
--   * No table is reachable without a policy that names the caller's role via
--     app_private.get_role(auth.uid()) — a single, audited code path. A
--     deactivated profile gets NULL and every policy fails closed.
--   * service_role (edge functions, sync engine) bypasses RLS by design;
--     browsers hold only the anon/authenticated keys and never bypass.
--   * Trustees are read-only and scoped to the funds they manage via
--     fund_managers (whole_board grants read across all funds).
--   * Submitters: own draft claims, own lines while draft, own person row
--     while onboarding — and nothing else.
--   * onboarding_tokens and audit_log writes have NO client policies at all.

-- ── enable RLS everywhere ────────────────────────────────────────────────────

alter table public.profiles enable row level security;
alter table public.fund_managers enable row level security;
alter table public.xero_connections enable row level security;
alter table public.xero_accounts enable row level security;
alter table public.xero_contacts enable row level security;
alter table public.xero_tracking_categories enable row level security;
alter table public.xero_tracking_options enable row level security;
alter table public.xero_transactions enable row level security;
alter table public.sync_runs enable row level security;
alter table public.funds enable row level security;
alter table public.fund_warnings enable row level security;
alter table public.integrity_stamps enable row level security;
alter table public.expense_claims enable row level security;
alter table public.expense_lines enable row level security;
alter table public.people enable row level security;
alter table public.onboarding_submissions enable row level security;
alter table public.onboarding_tokens enable row level security;
alter table public.bank_imports enable row level security;
alter table public.epworth_imports enable row level security;
alter table public.epworth_fund_mappings enable row level security;
alter table public.vat_periods enable row level security;
alter table public.settings enable row level security;
alter table public.audit_log enable row level security;
alter table public.projects enable row level security;
alter table public.project_tasks enable row level security;
alter table public.board_packs enable row level security;

-- belt-and-braces: the token table is service-role territory only
revoke all on public.onboarding_tokens from anon, authenticated;

-- ── profiles ─────────────────────────────────────────────────────────────────
-- Own row always readable — DELIBERATELY including deactivated users, so the
-- app can show "your account is deactivated" instead of a blank screen; that
-- row is the only thing a deactivated JWT can still see. Pulse staff and the
-- CEO can read the user directory (expense queues, people admin). Only
-- pulse_admin writes — role changes are privileged and audit-logged.

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  );

create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (app_private.is_pulse_admin(auth.uid()))
  with check (app_private.is_pulse_admin(auth.uid()));

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

-- inserts happen only via the auth trigger (definer) / service role: no policy.

-- ── fund_managers ────────────────────────────────────────────────────────────

create policy fund_managers_select on public.fund_managers
  for select to authenticated
  using (
    (profile_id = auth.uid() and app_private.get_role(auth.uid()) is not null)
    or app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  );

create policy fund_managers_write_admin on public.fund_managers
  for all to authenticated
  using (app_private.is_pulse_admin(auth.uid()))
  with check (app_private.is_pulse_admin(auth.uid()));

-- ── xero_connections ─────────────────────────────────────────────────────────
-- Status card in Settings. Tokens are encrypted bytea, but still: admin + CEO
-- read only; all writes via service role (sync engine).

create policy xero_connections_select on public.xero_connections
  for select to authenticated
  using (
    app_private.is_pulse_admin(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  );

-- ── Xero reference mirrors ───────────────────────────────────────────────────
-- Chart of accounts and tracking metadata are low-sensitivity reference data;
-- any active signed-in user may read (expense category pickers, fund joins).
-- Contacts carry supplier details: Pulse + CEO only.

create policy xero_accounts_select on public.xero_accounts
  for select to authenticated
  using (app_private.get_role(auth.uid()) is not null);

create policy xero_tracking_categories_select on public.xero_tracking_categories
  for select to authenticated
  using (app_private.get_role(auth.uid()) is not null);

create policy xero_tracking_options_select on public.xero_tracking_options
  for select to authenticated
  using (app_private.get_role(auth.uid()) is not null);

create policy xero_contacts_select on public.xero_contacts
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  );

-- ── xero_transactions ────────────────────────────────────────────────────────
-- Pulse + CEO: everything. Trustees: only lines tagged to a fund they manage
-- (or all fund-tagged lines when whole_board). Submitters: nothing.
-- Writes: sync engine (service role) only — no client write policies.

create policy xero_transactions_select on public.xero_transactions
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (
      app_private.get_role(auth.uid()) = 'trustee'
      and tracking_option_1_id is not null
      and app_private.manages_tracking_option(auth.uid(), tracking_option_1_id)
    )
  );

-- ── sync_runs ────────────────────────────────────────────────────────────────
-- The top bar shows "last synced" to every signed-in user; runs are written by
-- the sync engine (service role) only.

create policy sync_runs_select on public.sync_runs
  for select to authenticated
  using (app_private.get_role(auth.uid()) is not null);

-- ── funds ────────────────────────────────────────────────────────────────────
-- Read: Pulse + CEO all; trustees their own (whole_board = all). Write:
-- pulse_admin + pulse_bookkeeper (classification, opening balances).
-- Submitters have no fund access ("nothing else" per the brief).

create policy funds_select on public.funds
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (
      app_private.get_role(auth.uid()) = 'trustee'
      and app_private.manages_fund(auth.uid(), id)
    )
  );

create policy funds_insert_pulse on public.funds
  for insert to authenticated
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy funds_update_pulse on public.funds
  for update to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy funds_delete_admin on public.funds
  for delete to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

-- ── fund_warnings ────────────────────────────────────────────────────────────
-- Written by the warning engine (service role); Pulse resolves; CEO and
-- trustees (scoped) read their badges.

create policy fund_warnings_select on public.fund_warnings
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (
      app_private.get_role(auth.uid()) = 'trustee'
      and app_private.manages_fund(auth.uid(), fund_id)
    )
  );

create policy fund_warnings_update_pulse on public.fund_warnings
  for update to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy fund_warnings_insert_pulse on public.fund_warnings
  for insert to authenticated
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

-- ── integrity_stamps ─────────────────────────────────────────────────────────
-- Insert-only evidence: no update/delete policies exist, so stamps are
-- immutable to every client role including pulse_admin.

create policy integrity_stamps_select on public.integrity_stamps
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) in ('ceo', 'trustee')
  );

create policy integrity_stamps_insert_pulse on public.integrity_stamps
  for insert to authenticated
  with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
    and stamped_by = auth.uid()
  );

-- ── expense_claims ───────────────────────────────────────────────────────────
-- Row access here; column/transition rules in the guard trigger (0007).

-- "own row" arms always require get_role(...) is not null: a deactivated
-- profile keeps a valid JWT until it expires, and must still be locked out.

create policy expense_claims_select on public.expense_claims
  for select to authenticated
  using (
    (submitter_id = auth.uid() and app_private.get_role(auth.uid()) is not null)
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  );

create policy expense_claims_insert on public.expense_claims
  for insert to authenticated
  with check (
    (
      submitter_id = auth.uid()
      and status = 'draft'
      and app_private.get_role(auth.uid()) is not null
    )
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
  );

create policy expense_claims_update_own_draft on public.expense_claims
  for update to authenticated
  using (
    submitter_id = auth.uid()
    and status = 'draft'
    and app_private.get_role(auth.uid()) is not null
  )
  with check (
    submitter_id = auth.uid()
    and status in ('draft', 'submitted')
    and app_private.get_role(auth.uid()) is not null
  );

create policy expense_claims_update_pulse on public.expense_claims
  for update to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy expense_claims_update_ceo on public.expense_claims
  for update to authenticated
  using (app_private.get_role(auth.uid()) = 'ceo' and status = 'submitted')
  with check (
    app_private.get_role(auth.uid()) = 'ceo'
    and status in ('submitted', 'approved', 'rejected')
  );

create policy expense_claims_delete on public.expense_claims
  for delete to authenticated
  using (
    (
      submitter_id = auth.uid()
      and status = 'draft'
      and app_private.get_role(auth.uid()) is not null
    )
    or app_private.is_pulse_admin(auth.uid())
  );

-- ── expense_lines ────────────────────────────────────────────────────────────

create policy expense_lines_select on public.expense_lines
  for select to authenticated
  using (
    (
      app_private.claim_owner(claim_id) = auth.uid()
      and app_private.get_role(auth.uid()) is not null
    )
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
  );

create policy expense_lines_insert on public.expense_lines
  for insert to authenticated
  with check (
    (
      app_private.claim_owner(claim_id) = auth.uid()
      and app_private.claim_status(claim_id) = 'draft'
      and app_private.get_role(auth.uid()) is not null
    )
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
  );

create policy expense_lines_update on public.expense_lines
  for update to authenticated
  using (
    (
      app_private.claim_owner(claim_id) = auth.uid()
      and app_private.claim_status(claim_id) = 'draft'
      and app_private.get_role(auth.uid()) is not null
    )
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
  )
  with check (
    (
      app_private.claim_owner(claim_id) = auth.uid()
      and app_private.claim_status(claim_id) = 'draft'
      and app_private.get_role(auth.uid()) is not null
    )
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
  );

create policy expense_lines_delete on public.expense_lines
  for delete to authenticated
  using (
    (
      app_private.claim_owner(claim_id) = auth.uid()
      and app_private.claim_status(claim_id) = 'draft'
      and app_private.get_role(auth.uid()) is not null
    )
    or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
  );

-- ── people ───────────────────────────────────────────────────────────────────
-- Payroll + admin manage records; a submitter reads and (while onboarding)
-- updates their own linked row. Encrypted columns only ever yield ciphertext;
-- decryption is exclusively via get_person_bank_details (audited).

create policy people_select on public.people
  for select to authenticated
  using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll')
    or (profile_id = auth.uid() and app_private.get_role(auth.uid()) is not null)
  );

create policy people_insert_payroll on public.people
  for insert to authenticated
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll'));

create policy people_update on public.people
  for update to authenticated
  using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll')
    or (
      profile_id = auth.uid()
      and onboarding_status in ('invited', 'in_progress', 'submitted')
      and app_private.get_role(auth.uid()) is not null
    )
  )
  with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll')
    or (profile_id = auth.uid() and app_private.get_role(auth.uid()) is not null)
  );

create policy people_delete_admin on public.people
  for delete to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

-- ── onboarding_submissions ───────────────────────────────────────────────────
-- Written by the onboarding edge function (service role); payroll reviews.

create policy onboarding_submissions_select on public.onboarding_submissions
  for select to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll'));

create policy onboarding_submissions_insert on public.onboarding_submissions
  for insert to authenticated
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll'));

-- ── onboarding_tokens ────────────────────────────────────────────────────────
-- NO policies: RLS is enabled and no client role can touch it. Only the
-- onboarding edge function (service role, bypasses RLS) validates tokens.

-- ── imports ──────────────────────────────────────────────────────────────────

create policy bank_imports_select on public.bank_imports
  for select to authenticated
  using (app_private.is_pulse(auth.uid()));

create policy bank_imports_write on public.bank_imports
  for insert to authenticated
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy bank_imports_update on public.bank_imports
  for update to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy bank_imports_delete_admin on public.bank_imports
  for delete to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

create policy epworth_imports_select on public.epworth_imports
  for select to authenticated
  using (app_private.is_pulse(auth.uid()));

create policy epworth_imports_insert on public.epworth_imports
  for insert to authenticated
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy epworth_imports_update on public.epworth_imports
  for update to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

create policy epworth_imports_delete_admin on public.epworth_imports
  for delete to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

create policy epworth_fund_mappings_select on public.epworth_fund_mappings
  for select to authenticated
  using (app_private.is_pulse(auth.uid()));

create policy epworth_fund_mappings_write on public.epworth_fund_mappings
  for all to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

-- ── vat_periods ──────────────────────────────────────────────────────────────
-- Trustee-friendly output is the point of the module: CEO + trustees read.

create policy vat_periods_select on public.vat_periods
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) in ('ceo', 'trustee')
  );

create policy vat_periods_write on public.vat_periods
  for all to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper'));

-- ── settings ─────────────────────────────────────────────────────────────────
-- Read: every active user (deadline banner). Write: pulse_admin everything;
-- CEO limited to the two payment-cycle keys — the guard trigger (0010)
-- enforces the key allow-list, this policy grants the row access.

create policy settings_select on public.settings
  for select to authenticated
  using (app_private.get_role(auth.uid()) is not null);

create policy settings_insert_admin on public.settings
  for insert to authenticated
  with check (app_private.is_pulse_admin(auth.uid()));

create policy settings_update on public.settings
  for update to authenticated
  using (
    app_private.is_pulse_admin(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  )
  with check (
    app_private.is_pulse_admin(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
  );

create policy settings_delete_admin on public.settings
  for delete to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

-- ── audit_log ────────────────────────────────────────────────────────────────
-- pulse_admin reads; nobody inserts/updates/deletes from a client. Inserts
-- come only from SECURITY DEFINER functions (owner bypasses RLS) and the
-- service role.

create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (app_private.is_pulse_admin(auth.uid()));

-- ── projects / project_tasks ─────────────────────────────────────────────────
-- The tracker is deliberately visible to the client (they watch delivery);
-- only Pulse staff write.

create policy projects_select on public.projects
  for select to authenticated
  using (app_private.get_role(auth.uid()) is not null);

create policy projects_write_pulse on public.projects
  for all to authenticated
  using (app_private.is_pulse(auth.uid()))
  with check (app_private.is_pulse(auth.uid()));

create policy project_tasks_select on public.project_tasks
  for select to authenticated
  using (app_private.get_role(auth.uid()) is not null);

create policy project_tasks_write_pulse on public.project_tasks
  for all to authenticated
  using (app_private.is_pulse(auth.uid()))
  with check (app_private.is_pulse(auth.uid()));

-- ── board_packs ──────────────────────────────────────────────────────────────
-- Trustees see whole-charity packs only when whole_board; fund-scoped packs
-- when the scope overlaps their managed funds. The packs storage policy (0015)
-- defers to this table, so file access follows the same rule.

create policy board_packs_select on public.board_packs
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (
      app_private.get_role(auth.uid()) = 'trustee'
      and (
        app_private.is_whole_board(auth.uid())
        or (
          scope_fund_ids is not null
          and scope_fund_ids && app_private.managed_fund_ids(auth.uid())
        )
      )
    )
  );

create policy board_packs_insert on public.board_packs
  for insert to authenticated
  with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo')
    and created_by = auth.uid()
  );

create policy board_packs_update on public.board_packs
  for update to authenticated
  using (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo'))
  with check (app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'ceo'));

create policy board_packs_delete_admin on public.board_packs
  for delete to authenticated
  using (app_private.is_pulse_admin(auth.uid()));
