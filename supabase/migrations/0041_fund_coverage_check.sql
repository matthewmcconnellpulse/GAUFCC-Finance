-- 0041 — does every fund in the balance sheet actually exist as a fund?
--
-- GAUFCC holds each fund's capital in its own EQUITY account (RF/DF/EF …)
-- AND tags transactions with a "Fund" tracking option. The platform can only
-- see the tracking options: a fund that exists only as an equity account is
-- invisible everywhere — register, fund pages, board packs — and nothing said
-- so. RF Bowland Trust Capital (740110) is exactly that, and it holds over
-- £1.5m, which is how it came to be left out of a board pack unnoticed.
--
-- This view lines the two up by name so the gap is visible and monitored
-- rather than discovered. Names are normalised (account prefixes, fund
-- numbers, "funds"/"Capital" wording and punctuation removed) — where the two
-- sides simply spell a fund differently that is worth flagging too, since a
-- reader comparing the pack to the ledger has to make the same leap.

create or replace view public.v_integrity_fund_coverage
with (security_invoker = true)
as
with equity as (
  select
    a.code,
    a.name,
    -- movement we hold for the account; for the many accounts carrying a
    -- single brought-forward journal this IS the fund's capital
    round(coalesce((
      select sum(t.net) from public.xero_transactions t where t.account_code = a.code
    ), 0), 2) as ledger_amount,
    regexp_replace(
      lower(regexp_replace(replace(a.name, ' - Capital', ''), '^(RF|DF|EF)\s+', '', 'i')),
      '[^a-z0-9]', '', 'g'
    ) as match_key
  from public.xero_accounts a
  where a.class = 'EQUITY'
    -- roll-ups and control accounts, not individual funds
    and a.code not in ('800000', '800050', '968')
),
register as (
  select
    f.id as fund_id,
    f.name,
    regexp_replace(
      lower(regexp_replace(
        f.name,
        '^[0-9.]+\s*-?\s*(Restricted|Designated|Endowment|Unrestricted)?\s*(funds)?\s*-?\s*(RF|DF|EF)?\s*-?\s*',
        '', 'i'
      )),
      '[^a-z0-9]', '', 'g'
    ) as match_key
  from public.funds f
  where f.active
)
select
  e.code as account_code,
  e.name as account_name,
  e.ledger_amount,
  'no_fund_in_register'::text as issue
from equity e
where not exists (select 1 from register r where r.match_key = e.match_key)
union all
select
  null,
  r.name,
  null,
  'no_capital_account'::text
from register r
where not exists (select 1 from equity e where e.match_key = r.match_key);

comment on view public.v_integrity_fund_coverage is
  'Fund capital accounts in the balance sheet with no matching fund in the register (and the reverse). Catches funds that exist only as an equity account — invisible to fund pages and board packs — and names that differ between the two.';
