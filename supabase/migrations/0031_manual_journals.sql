-- 0031 — mirror Xero manual journals.
--
-- Payroll (and other GL-only postings) reach Xero as MANUAL JOURNALS, which
-- the sync engine never mirrored — so wages tracked to funds in Xero were
-- invisible to per-fund reporting here (v_fund_balances, fund pages, SOFA).
-- The sync engine now pulls ManualJournals into xero_transactions with
-- source_type 'MANJOURNAL'; this migration widens the check constraint.
--
-- Sign convention for journal lines (documented in _shared/sync-engine.ts):
-- Xero journal lines are debit-positive/credit-negative, so a credit to a
-- REVENUE-class account is stored sign-flipped (income positive) to match the
-- mirror's document-natural convention; EXPENSE and balance-sheet lines are
-- stored as-is (debit to expense = positive expenditure).

alter table public.xero_transactions
  drop constraint xero_transactions_source_type_check;

alter table public.xero_transactions
  add constraint xero_transactions_source_type_check check (source_type in
    ('ACCREC', 'ACCPAY', 'RECEIVE', 'SPEND', 'BANK_TRANSFER', 'CREDIT_NOTE',
     'PREPAYMENT', 'OVERPAYMENT', 'MANJOURNAL'));
