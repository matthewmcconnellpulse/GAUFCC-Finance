-- 0047 — say receivables and payables, not debtors and creditors.
--
-- The client's house wording. Applies to text the app writes for itself; the
-- Xero balance-sheet row labels we MATCH against keep their old spellings
-- (see RECEIVABLES_ALIASES in src/modules/recon/lib.ts), because the chart of
-- accounts is Xero's to name, not ours.
--
-- Both the template and any already-opened month are updated: a checklist
-- copied into an open period keeps its own text by design, so leaving those
-- behind would strand the old wording in the months being worked on now.

update public.close_task_templates
set detail = replace(replace(detail, 'debtor', 'receivable'), 'creditor', 'payable')
where detail ilike '%debtor%' or detail ilike '%creditor%';

update public.close_tasks
set detail = replace(replace(detail, 'debtor', 'receivable'), 'creditor', 'payable')
where detail ilike '%debtor%' or detail ilike '%creditor%';
