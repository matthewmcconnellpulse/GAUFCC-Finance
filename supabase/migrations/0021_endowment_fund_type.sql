-- 0021 — add 'endowment' to fund_type.
--
-- GAUFCC's Xero tracking options carry endowment funds (201–203 "Endowment
-- funds - …"). SORP treats endowment as its own class of fund (capital held
-- on trust), distinct from restricted income funds, so it becomes a first-class
-- fund_type rather than being lumped under 'restricted'.
--
-- ALTER TYPE ... ADD VALUE must not be used by any statement in the same
-- transaction, so the auto-classification that consumes it lives in 0022.

alter type public.fund_type add value if not exists 'endowment' after 'designated';
