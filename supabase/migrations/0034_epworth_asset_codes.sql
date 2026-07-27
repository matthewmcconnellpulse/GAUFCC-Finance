-- 0034 — per-account balance-sheet mappings for the Epworth journal.
--
-- The debit side of the Epworth journal is not one asset account: each of
-- the six portfolio accounts (and the Cash Plus deposit accounts) is its own
-- current-asset investment in Xero. Store a holding-ref → asset-code map so
-- the journal debits the right balance-sheet account per Epworth account;
-- the single asset_account_code column remains as the fallback for refs
-- without a specific mapping.

alter table public.epworth_journal_settings
  add column asset_account_codes jsonb not null default '{}'::jsonb;
