-- 0054_pack_shares.sql
--
-- A management report shared by link.
--
-- The management team read the report before a PDF pack is finalised, and
-- most of them have no login here. A share is therefore a snapshot of the
-- rendered pack, reachable by an unguessable URL and nothing else.
--
-- The exposure is real and deliberate, chosen with the client: anyone holding
-- the URL can read the charity's finances, with no passcode and no expiry. So
-- the token is 24 random bytes rather than anything derived or sequential, a
-- share can be revoked at any moment, and every open is counted so it is
-- visible whether a link has travelled further than intended.
--
-- The stored html is a snapshot, not a live view. A trustee pack that changed
-- under the reader between two openings would be worse than one that is a
-- little behind, and "the period we sign off" is a fixed thing by definition.

create table if not exists public.pack_shares (
  id uuid primary key default gen_random_uuid(),

  -- 24 bytes = 48 hex characters. Defaulted here so the client never chooses
  -- its own token and cannot weaken one.
  token text not null unique default encode(gen_random_bytes(24), 'hex'),

  title text not null,
  period_start date not null,
  period_end date not null,
  period_label text not null,
  scope text not null,
  scope_fund_ids uuid[],

  -- The rendered pack, already sanitised client-side (see serialisePack).
  html text not null,
  -- Which sections the pack carried, so a reader's side panel and the pack agree.
  sections jsonb not null default '[]'::jsonb,

  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),

  view_count integer not null default 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz
);

create index if not exists pack_shares_created_idx on public.pack_shares (created_at desc);

alter table public.pack_shares enable row level security;

-- Only the people who can build a pack can create or manage a share. There is
-- deliberately NO anon policy on this table: an unauthenticated reader never
-- touches it directly, only through the token function below.
drop policy if exists pack_shares_manage on public.pack_shares;
create policy pack_shares_manage on public.pack_shares
  for all
  to authenticated
  using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo')
  )
  with check (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo')
  );

/**
 * Read one share by its token.
 *
 * SECURITY DEFINER so an anonymous reader can open the link without any
 * policy granting anon access to the table — the token is the whole
 * credential, and it is checked here rather than anywhere a query could be
 * shaped by the caller. A missing token, a wrong token and a revoked token
 * are indistinguishable from outside: all three return no rows.
 *
 * It counts the open as a side effect, which is why it is volatile. That is
 * the only thing an anonymous caller can cause to happen.
 */
create or replace function public.pack_share_by_token(p_token text)
returns table (
  title text,
  period_label text,
  period_start date,
  period_end date,
  html text,
  sections jsonb,
  created_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Reject anything that is not the shape of a token before touching the
  -- table, so a probe cannot be used to time the lookup.
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then
    return;
  end if;

  update public.pack_shares s
  set view_count = s.view_count + 1,
      first_viewed_at = coalesce(s.first_viewed_at, now()),
      last_viewed_at = now()
  where s.token = p_token
    and s.revoked_at is null;

  return query
  select s.title, s.period_label, s.period_start, s.period_end, s.html, s.sections, s.created_at
  from public.pack_shares s
  where s.token = p_token
    and s.revoked_at is null;
end;
$$;

comment on function public.pack_share_by_token(text) is
  'Read a shared management report by its unguessable token. Returns no rows for a missing, malformed or revoked token. Counts the open.';

revoke all on function public.pack_share_by_token(text) from public;
grant execute on function public.pack_share_by_token(text) to anon, authenticated;
