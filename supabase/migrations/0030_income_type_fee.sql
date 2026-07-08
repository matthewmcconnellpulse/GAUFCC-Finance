-- 0030 — add 'fee' to income_type.
--
-- The Epworth monthly workbook carries discretionary management and platform
-- fees per portfolio account. They post as a debit to an investment-fees
-- expense account (credit the investment asset), tracked per fund — so fees
-- become a first-class posting type alongside dividends, interest and gains.

alter type public.income_type add value if not exists 'fee' after 'dividend';
