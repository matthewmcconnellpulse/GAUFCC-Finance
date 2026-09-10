-- 0046 — fix the fund coverage check reporting funds that are plainly there.
--
-- 0041 normalised the two sides with two DIFFERENT regexes, and the register
-- side stripped "funds" — plural only. GAUFCC's older tracking options read
-- "112 Restricted funds - X" and normalised fine; the newer ones read
-- "131 - Restricted Fund - X", singular, so the word "Fund" survived:
--
--   account  RF Lay Pastors and Approved Lay Persons in Charge
--            → laypastorsandapprovedlaypersonsincharge
--   fund     131 - Restricted Fund - Lay Pastors and Approved Lay Persons…
--            → FUNDlaypastorsandapprovedlaypersonsincharge
--
-- The keys differed by that one word, so the check reported the account as
-- having no fund AND the fund as having no account — the same non-match
-- counted twice, for three funds holding £58,539.40 between them, all of
-- which were in the register and on their fund pages the whole time.
--
-- The lesson is the asymmetry, not the missing "s": two normalisers for the
-- same job will always drift. There is now ONE, applied to both sides, so a
-- difference in fund-type wording, an account prefix, a stray "The", a
-- missing space or any punctuation cannot break a match again.

create or replace function app_private.fund_match_key(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      -- leading ledger number: "131 - ", "301.1 ", "124 - "
      regexp_replace(lower(coalesce(p_name, '')), '^[0-9.]+\s*-?\s*', ''),
      -- noise words, wherever they fall: account prefixes, fund-type words,
      -- the word fund(s) itself, "Capital", and a leading article
      '\y(rf|df|ef|restricted|designated|endowment|unrestricted|funds|fund|capital|the)\y',
      ' ', 'g'
    ),
    '[^a-z0-9]', '', 'g'
  )
$$;

comment on function app_private.fund_match_key(text) is
  'Normalises a fund capital account name and a Fund tracking option name to a common key, so the coverage check compares like with like. Used by BOTH sides of v_integrity_fund_coverage — never normalise one side separately.';

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
      select sum(t.net)
      from public.xero_transactions t
      where t.account_code = a.code
        and app_private.is_live_document(t.status)
    ), 0), 2) as ledger_amount,
    app_private.fund_match_key(a.name) as match_key
  from public.xero_accounts a
  where a.class = 'EQUITY'
    -- roll-ups and control accounts, not individual funds
    and a.code not in ('800000', '800050', '968')
),
register as (
  select
    f.id as fund_id,
    f.name,
    app_private.fund_match_key(f.name) as match_key
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
  'Fund capital accounts in the balance sheet with no matching fund in the register (and the reverse). Catches funds that exist only as an equity account — invisible to fund pages and board packs. Both sides are normalised by app_private.fund_match_key so a wording difference is not mistaken for a missing fund.';

grant execute on function app_private.fund_match_key(text) to authenticated;
