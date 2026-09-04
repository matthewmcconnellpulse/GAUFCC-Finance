-- 0040 — mileage journey log, and closes that can run quarterly.
--
-- Mileage: HMRC expects a contemporaneous log behind an AMAP claim — date,
-- where from, where to, why, and the miles. The line already carries date and
-- miles; these columns carry the rest so the claim IS the log and nothing has
-- to be reconstructed later.
--
-- Quarterly: management accounts are not always monthly. A close period is now
-- either a month ('2026-09') or a quarter ('2026-Q3'), and each template line
-- says which cadence it belongs to — most apply to both, a few (board pack,
-- variance analysis, reserves) only make sense on a quarter.

alter table public.expense_lines
  add column if not exists journey_from text,
  add column if not exists journey_to text,
  add column if not exists journey_purpose text,
  -- descriptive only: `miles` is always the total claimed, there and back
  add column if not exists is_return_journey boolean not null default false;

-- ── periods may be months or quarters ───────────────────────────────────────

alter table public.close_periods
  add column if not exists period_type text not null default 'month'
    check (period_type in ('month', 'quarter'));

do $$
declare
  v_constraint text;
begin
  select con.conname into v_constraint
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'close_periods'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%period %~%';
  if v_constraint is not null then
    execute format('alter table public.close_periods drop constraint %I', v_constraint);
  end if;
end $$;

alter table public.close_periods
  drop constraint if exists close_periods_period_format,
  add constraint close_periods_period_format
    check (period ~ '^\d{4}-(0[1-9]|1[0-2])$' or period ~ '^\d{4}-Q[1-4]$');

alter table public.close_task_templates
  add column if not exists applies_to text not null default 'both'
    check (applies_to in ('month', 'quarter', 'both'));

-- ── opening a period, month or quarter ──────────────────────────────────────

drop function if exists public.open_close_period(text);

create or replace function public.open_close_period(
  p_period text,
  p_period_type text default 'month'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not app_private.is_pulse(auth.uid()) then
    raise exception 'only the Pulse team can open a close';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'a close is either a month or a quarter';
  end if;
  if p_period_type = 'month' and p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'a month looks like 2026-09';
  end if;
  if p_period_type = 'quarter' and p_period !~ '^\d{4}-Q[1-4]$' then
    raise exception 'a quarter looks like 2026-Q3';
  end if;

  select id into v_id from public.close_periods where period = p_period;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.close_periods (period, period_type, opened_by)
  values (p_period, p_period_type, auth.uid())
  returning id into v_id;

  insert into public.close_tasks (
    period_id, template_key, group_label, title, detail, link_to, external_url,
    sort_order, is_client_signoff
  )
  select v_id, t.key, t.group_label, t.title, t.detail, t.link_to, t.external_url,
         t.sort_order, t.is_client_signoff
    from public.close_task_templates t
   where t.active
     and t.applies_to in ('both', p_period_type)
   order by t.sort_order;

  return v_id;
end;
$$;

revoke all on function public.open_close_period(text, text) from public;
grant execute on function public.open_close_period(text, text) to authenticated;

-- ── shared progress carries the cadence so it can be labelled ───────────────

create or replace function public.close_share_progress(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period public.close_periods;
  v_tasks jsonb;
begin
  select * into v_period
    from public.close_periods
   where share_token = p_token and share_enabled
   limit 1;
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'group_label', t.group_label,
           'title', t.title,
           'detail', t.detail,
           'status', t.status,
           'note', t.note,
           'owner', p.full_name,
           'signed_off_at', t.signed_off_at,
           'signed_off_by', s.full_name,
           'is_client_signoff', t.is_client_signoff
         ) order by t.sort_order), '[]'::jsonb)
    into v_tasks
    from public.close_tasks t
    left join public.profiles p on p.id = t.assignee_id
    left join public.profiles s on s.id = t.signed_off_by
   where t.period_id = v_period.id;

  return jsonb_build_object(
    'period', v_period.period,
    'period_type', v_period.period_type,
    'status', v_period.status,
    'note', v_period.note,
    'opened_at', v_period.opened_at,
    'completed_at', v_period.completed_at,
    'tasks', v_tasks
  );
end;
$$;

revoke all on function public.close_share_progress(text) from public;
grant execute on function public.close_share_progress(text) to anon, authenticated;

-- ── quarter-only checklist lines ────────────────────────────────────────────

insert into public.close_task_templates (key, group_label, title, detail, link_to, external_url, sort_order, is_client_signoff, applies_to) values
  ('quarter_variance', 'Reporting', 'Quarter-on-quarter variance reviewed',
   'Movements against the previous quarter and budget explained.', '/financials/profit-loss', null, 172, false, 'quarter'),
  ('reserves_position', 'Funds', 'Reserves position against policy',
   'Free reserves measured against the reserves policy and reported to the trustees.', '/funds', null, 155, false, 'quarter'),
  ('trustee_pack', 'Reporting', 'Board pack issued to trustees',
   'Quarterly pack finalised and circulated ahead of the meeting.', '/reports', null, 195, false, 'quarter')
on conflict (key) do nothing;
