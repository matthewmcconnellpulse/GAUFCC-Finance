-- 0044 — signing off a reconciliation check.
--
-- A tick that survives the figures changing underneath it is worse than no
-- tick, so a sign-off records the FIGURES IT WAS GIVEN as well as who signed
-- and when. The reconciliation screen compares those against the live figures
-- and shows the sign-off as superseded the moment they move: nobody can
-- inherit somebody else's assurance over numbers that have since changed.
--
-- Scoped to (check, period) — the same check signed for September is a
-- different assertion from the same check signed for the year.

create table if not exists public.recon_signoffs (
  id uuid primary key default gen_random_uuid(),
  -- Matches ReconCheck.id in src/modules/recon/lib.ts. Deliberately text and
  -- unconstrained: adding a check should not need a migration, and an
  -- orphaned row for a retired check is harmless.
  check_id text not null,
  period_start date not null,
  period_end date not null,
  -- The two figures and the gap between them, as they stood at sign-off.
  left_value numeric(14, 2),
  right_value numeric(14, 2),
  difference numeric(14, 2),
  -- Why it was signed despite a difference, where there was one. Required by
  -- the UI in that case: a difference signed off without a reason is the one
  -- thing this table exists to prevent.
  note text,
  signed_by uuid not null references public.profiles (id),
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (check_id, period_start, period_end)
);

create index if not exists recon_signoffs_period_idx
  on public.recon_signoffs (period_start, period_end);

alter table public.recon_signoffs enable row level security;

-- Read: the same audience as the reconciliation screen (Pulse, CEO, trustee).
create policy recon_signoffs_select on public.recon_signoffs
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) in ('ceo', 'trustee')
  );

-- Sign: Pulse and the CEO, always as yourself. A trustee reads the assurance;
-- they do not give it.
create policy recon_signoffs_insert on public.recon_signoffs
  for insert to authenticated
  with check (
    (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
    and signed_by = auth.uid()
  );

create policy recon_signoffs_update on public.recon_signoffs
  for update to authenticated
  using (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
  with check (
    (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
    and signed_by = auth.uid()
  );

-- Withdrawing a sign-off is the author's own call, or a Pulse admin's.
create policy recon_signoffs_delete on public.recon_signoffs
  for delete to authenticated
  using (signed_by = auth.uid() or app_private.is_pulse_admin(auth.uid()));

revoke all on public.recon_signoffs from anon;

drop trigger if exists recon_signoffs_set_updated_at on public.recon_signoffs;
create trigger recon_signoffs_set_updated_at
  before update on public.recon_signoffs
  for each row execute function app_private.set_updated_at();

drop trigger if exists recon_signoffs_audit on public.recon_signoffs;
create trigger recon_signoffs_audit
  after insert or update or delete on public.recon_signoffs
  for each row execute function app_private.audit_changes();
