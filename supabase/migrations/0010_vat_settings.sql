-- 0010 — VAT periods and platform settings.

create table public.vat_periods (
  id uuid primary key default gen_random_uuid(),
  period text not null unique, -- e.g. '2026-Q2' or '2026-06'
  taxable_supplies numeric(14, 2) not null default 0,
  exempt_supplies numeric(14, 2) not null default 0,
  residual_input_vat numeric(14, 2) not null default 0,
  directly_attributable jsonb not null default '{"taxable": 0, "exempt": 0}'::jsonb,
  de_minimis_result jsonb, -- DeMinimisResult; null until calculated
  narrative text, -- AI-drafted, always edited/confirmed by a human before packs
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists vat_periods_set_updated_at on public.vat_periods;
create trigger vat_periods_set_updated_at
  before update on public.vat_periods
  for each row execute function app_private.set_updated_at();

-- ── settings ─────────────────────────────────────────────────────────────────
-- Key/value with typed jsonb. Readable by every signed-in user (the expenses
-- banner needs the deadline days); writable by pulse_admin, and by the CEO for
-- exactly two keys — enforced by the guard trigger below, per the brief.

create table public.settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function app_private.guard_settings_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.role := app_private.get_role(auth.uid());
  v_key text;
begin
  -- trusted paths: service role / definer functions
  if auth.uid() is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if v_role = 'pulse_admin' then
    if tg_op <> 'DELETE' then
      new.updated_by := auth.uid();
      new.updated_at := now();
      return new;
    end if;
    return old;
  end if;

  -- CEO may update (not insert/delete) the two payment-cycle keys only
  if v_role = 'ceo' and tg_op = 'UPDATE' then
    v_key := old.key;
    if v_key in ('expense_approval_day', 'payment_run_day') and new.key = old.key then
      new.updated_by := auth.uid();
      new.updated_at := now();
      return new;
    end if;
  end if;

  raise exception 'setting % is not editable by your role', coalesce(v_key, case when tg_op = 'DELETE' then old.key else new.key end);
end;
$$;

revoke all on function app_private.guard_settings_write() from public;

drop trigger if exists settings_guard on public.settings;
create trigger settings_guard
  before insert or update or delete on public.settings
  for each row execute function app_private.guard_settings_write();

-- seed defaults (idempotent)
insert into public.settings (key, value, description) values
  ('expense_approval_day', '10'::jsonb,
   'Day of the month by which claims must be submitted and CEO-approved to make the payment run.'),
  ('payment_run_day', '17'::jsonb,
   'Day of the month on which approved claims are paid.'),
  ('sync_hour', '4'::jsonb,
   'Hour (Europe/London) of the nightly Xero sync. The pg_cron schedule mirrors this.'),
  ('warning_defaults',
   '{"min_balance": null, "flag_deficit": true, "unusual_movement_factor": 2.5, "dormancy_months": 24}'::jsonb,
   'Default warning rules applied to funds without per-fund overrides.')
on conflict (key) do nothing;
