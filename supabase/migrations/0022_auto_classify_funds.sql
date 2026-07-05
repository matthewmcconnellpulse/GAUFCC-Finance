-- 0022 — auto-classify funds from their Xero tracking-option names.
--
-- GAUFCC's Fund tracking options follow a strict naming scheme:
--   1xx  "Restricted funds - …"  or  "1xx - RF …"      → restricted
--   2xx  "Endowment funds - …"                          → endowment
--   3xx  "Designated funds - …"                         → designated
--   9xx  "Unrestricted funds - …"                       → general
-- Classification is keyed on the words, not the numbers, so renumbering does
-- not silently misfile a fund. Only rows still awaiting classification
-- (classified_at is null) are touched — manual classifications always win.
-- The same rules run in the sync engine for tracking options that appear
-- later (supabase/functions/_shared/sync-engine.ts, classifyFundName).
--
-- Order matters only for readability: '\m' anchors at a word start, so
-- 'Unrestricted' can never match '\mrestricted' — but general is still set
-- before restricted to keep the intent obvious.

update public.funds
set fund_type = 'endowment', classified_at = now(), updated_at = now()
where classified_at is null
  and name ~* '\mendowment';

update public.funds
set fund_type = 'designated', classified_at = now(), updated_at = now()
where classified_at is null
  and name ~* '\mdesignated';

update public.funds
set fund_type = 'general', classified_at = now(), updated_at = now()
where classified_at is null
  and name ~* '\munrestricted';

update public.funds
set fund_type = 'restricted', classified_at = now(), updated_at = now()
where classified_at is null
  and (name ~* '\mrestricted' or name ~* '\mRF\M');
