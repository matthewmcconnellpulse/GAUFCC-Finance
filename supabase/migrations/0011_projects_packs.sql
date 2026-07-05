-- 0011 — project tracker and board packs, with build-plan seed data.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status public.project_status not null default 'planned',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function app_private.set_updated_at();

create table public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null,
  status public.project_task_status not null default 'todo',
  assignee text, -- free text: Pulse staff name or team
  start_date date,
  due_date date,
  depends_on uuid[] not null default '{}'::uuid[], -- task ids, for Gantt rendering
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_tasks_project_idx on public.project_tasks (project_id, sort_order);

drop trigger if exists project_tasks_set_updated_at on public.project_tasks;
create trigger project_tasks_set_updated_at
  before update on public.project_tasks
  for each row execute function app_private.set_updated_at();

-- ── board_packs ──────────────────────────────────────────────────────────────
-- Generated PDFs live in the packs bucket; this table is the register the
-- role-scoped storage policy consults (a trustee can only fetch a pack object
-- whose register row their RLS lets them see).

create table public.board_packs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  period_start date not null,
  period_end date not null,
  scope text not null check (scope in ('whole_charity', 'fund_group', 'single_fund')),
  scope_fund_ids uuid[],
  storage_path text, -- object in the packs bucket
  status text not null default 'draft' check (status in ('draft', 'final')),
  version integer not null default 1,
  commentary jsonb, -- AI-drafted sections; always human-edited before final
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index board_packs_period_idx on public.board_packs (period_start, period_end);

drop trigger if exists board_packs_set_updated_at on public.board_packs;
create trigger board_packs_set_updated_at
  before update on public.board_packs
  for each row execute function app_private.set_updated_at();

-- ── seed: the build plan itself, so the client can watch delivery ───────────

do $$
declare
  v_build uuid;
  v_t0 uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid;
  v_t5 uuid; v_t6 uuid; v_t7 uuid; v_t8 uuid;
begin
  if exists (select 1 from public.projects where name = 'Platform build') then
    return; -- already seeded
  end if;

  insert into public.projects (name, description, status, sort_order)
  values (
    'Platform build',
    'Delivery of the GAUFCC finance platform. MVP order: phases 0–3 then 7 (funds, sync, reporting and packs) so trustees see value first; then 5 (expenses), 4 (imports), 6 (people), 8 (VAT), 9 (hardening).',
    'in_progress',
    0
  )
  returning id into v_build;

  insert into public.project_tasks (project_id, title, status, sort_order, notes)
  values (v_build, 'Phase 0 — Project scaffold', 'done', 0,
          'React + Vite + Tailwind on Vercel, Supabase auth, app shell. MVP order position 1.')
  returning id into v_t0;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 1 — Database schema and RLS', 'in_progress', 1, array[v_t0],
          'Full schema, deny-by-default RLS, encrypted PII, audit log. MVP order position 2.')
  returning id into v_t1;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 2 — Xero integration and sync engine', 'todo', 2, array[v_t1],
          'Nightly sync, manual refresh, bill push. MVP order position 3.')
  returning id into v_t2;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 3 — Fund dashboard, integrity checks and warnings', 'todo', 3, array[v_t2],
          'Funds overview and detail, four integrity checks, warning engine. MVP order position 4.')
  returning id into v_t3;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 7 — Reporting, board packs and AI commentary', 'todo', 4, array[v_t3],
          'Report builder, one-click packs, EML distribution. MVP order position 5 — pulled forward so trustees see value first.')
  returning id into v_t7;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 5 — Expense portal, AI OCR and approvals', 'todo', 5, array[v_t2],
          'Submitter portal, receipt extraction, CEO queue, deadline logic. MVP order position 6.')
  returning id into v_t5;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 4 — Import tools (HSBC and Epworth)', 'todo', 6, array[v_t1],
          'Statement drop-in with sense checks; Epworth mapping. MVP order position 7.')
  returning id into v_t4;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 6 — People module and onboarding', 'todo', 7, array[v_t1],
          'Tokenised onboarding, payroll pipeline, encrypted bank details. MVP order position 8.')
  returning id into v_t6;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 8 — VAT partial exemption module', 'todo', 8, array[v_t2],
          'De minimis tests, registration case for trustees. MVP order position 9.')
  returning id into v_t8;

  insert into public.project_tasks (project_id, title, status, sort_order, depends_on, notes)
  values (v_build, 'Phase 9 — Settings, audit and hardening', 'todo', 9,
          array[v_t3, v_t4, v_t5, v_t6, v_t7, v_t8],
          'Security pass, RLS tests, trustee-facing security summary. MVP order position 10.');

  -- parked Phase 2 idea, logged so it is visible in the tracker
  insert into public.projects (name, description, status, sort_order)
  values (
    'Member communication platform',
    'Value-add communications to Assembly members. Parked as Phase 2 pending trustee decision.',
    'parked',
    1
  );
end;
$$;
