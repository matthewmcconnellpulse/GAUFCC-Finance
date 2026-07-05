-- 0002 — enums
-- String values mirror src/types/db.ts exactly. Each create is wrapped so the
-- migration is idempotent if partially re-applied.

do $$ begin
  create type public.role as enum
    ('pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo', 'trustee', 'submitter');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.organisation as enum ('pulse', 'gaufcc');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.fund_type as enum ('restricted', 'designated', 'general', 'dormant');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.claim_status as enum
    ('draft', 'submitted', 'approved', 'rejected', 'pushed_to_xero', 'paid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.person_type as enum ('employee', 'volunteer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.onboarding_status as enum
    ('invited', 'in_progress', 'submitted', 'verified', 'complete');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.import_status as enum
    ('uploaded', 'parsed', 'checks_failed', 'ready', 'exported', 'overridden');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.income_type as enum
    ('realised_gain', 'unrealised_gain', 'interest', 'dividend');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sync_trigger as enum ('cron', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.project_status as enum ('planned', 'in_progress', 'complete', 'parked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.project_task_status as enum ('todo', 'in_progress', 'blocked', 'done');
exception when duplicate_object then null; end $$;
