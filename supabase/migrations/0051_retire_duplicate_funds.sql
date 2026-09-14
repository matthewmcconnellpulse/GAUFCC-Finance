-- 0051 — stand down the three duplicated fund records.
--
-- 131/132/133 were the same three funds as 116/117/110 under corrected
-- spellings, and the opening balance at 30.09.2025 was recorded against BOTH
-- of each pair. The Xero journals dated 30.09.2025 tag 116, 117 and 110; the
-- 131/132/133 options carried no ledger entry at all, which is why the client
-- removed those tracking categories in Xero.
--
-- That removal cannot reach the mirror on its own: a deleted tracking option
-- simply stops being returned by the API, and the sync upserts without ever
-- reconciling what has gone — so the rows sit here marked ACTIVE for good.
-- The sync-engine fix for that is separate; this corrects the data.
--
-- Deactivated and zeroed rather than deleted, so the correction is visible and
-- reversible. Together they carried 58,539.40, which is exactly the gap
-- between the register's 8,100,230.81 and the 8,041,691.41 the accounts show
-- at 30.09.2025. After this the register agrees to the penny.

update public.funds f
set active = false,
    opening_balance = 0,
    description = concat_ws(
      E'\n',
      nullif(f.description, ''),
      'Retired ' || to_char(now(), 'DD Mon YYYY') ||
      ': duplicate of the same fund under its earlier spelling, which carries the Xero journal. ' ||
      'Opening balance of ' || to_char(f.opening_balance, 'FM999,999,990.00') ||
      ' at 30.09.2025 was recorded on both records; it remains on the earlier one.'
    )
where f.name ~ '^(131|132|133)\y'
  and f.active;
