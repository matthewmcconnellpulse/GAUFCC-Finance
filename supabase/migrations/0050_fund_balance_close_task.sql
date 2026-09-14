-- 0050 — route the month end close at the fund balance reconciliation.
--
-- The close already had "Restricted fund balances reviewed", which pointed at
-- the funds register — a list of balances with nothing to agree them against.
-- The reconciliation screen now values every fund at a date, compares the
-- total with the figure recorded for that date and lets each fund be ticked
-- off, which is what that step was always asking someone to do.
--
-- Added to open periods too: a checklist copied into a period keeps its own
-- rows by design, so a new template alone would not reach the month anyone is
-- working on now.

insert into public.close_task_templates
  (key, group_label, title, detail, link_to, external_url, sort_order, is_client_signoff)
values
  ('fund_balances_agree', 'Funds', 'Fund balances agree to the accounts',
   'Every fund valued at the period end and ticked off, with the total agreeing to the figure recorded for that date.',
   '/reconciliation', null, 145, false)
on conflict (key) do update
  set group_label = excluded.group_label,
      title = excluded.title,
      detail = excluded.detail,
      link_to = excluded.link_to,
      sort_order = excluded.sort_order;

-- Point the existing review step at the same screen: it asks for the same
-- thing and the register cannot answer it.
update public.close_task_templates
set link_to = '/reconciliation'
where key = 'restricted_review';

update public.close_tasks
set link_to = '/reconciliation'
where template_key = 'restricted_review';

-- Give any period still open the new step.
insert into public.close_tasks
  (period_id, template_key, group_label, title, detail, link_to, external_url, sort_order, is_client_signoff)
select p.id, t.key, t.group_label, t.title, t.detail, t.link_to, t.external_url, t.sort_order, t.is_client_signoff
from public.close_periods p
cross join public.close_task_templates t
where t.key = 'fund_balances_agree'
  and p.status <> 'complete'
  and not exists (
    select 1 from public.close_tasks ct
    where ct.period_id = p.id and ct.template_key = 'fund_balances_agree'
  );
