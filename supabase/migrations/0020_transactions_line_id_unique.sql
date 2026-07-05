-- 0020 — align the xero_transactions upsert key with the sync engine.
--
-- The engine upserts line rows with ON CONFLICT (line_id): Xero LineItemIDs
-- are GUIDs (globally unique) and synthetic line ids embed the document id
-- (`<docid>-<n>`), so line_id alone is a valid natural key. The original
-- composite unique (xero_id, line_id) stays — it additionally guards against
-- a line id ever being re-parented across documents.

alter table public.xero_transactions
  add constraint xero_transactions_line_id_key unique (line_id);
