-- 0025 — fund_notes: separate, editable notes per fund, replacing the single
-- funds.description blob. Each note can be marked "for the attention of" a
-- named user. Existing descriptions migrate into one opening note so nothing
-- typed so far is lost (the description column stays but the UI stops using it).

create table public.fund_notes (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funds(id) on delete cascade,
  body text not null,
  -- "For the attention of" — a user this note is flagged to (optional).
  attention_of uuid references public.profiles(id) on delete set null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index fund_notes_fund_idx on public.fund_notes (fund_id, created_at desc);

alter table public.fund_notes enable row level security;

-- Read mirrors funds_select: Pulse + CEO everywhere, trustees on their funds.
create policy fund_notes_select on public.fund_notes
  for select to authenticated
  using (
    app_private.is_pulse(auth.uid())
    or app_private.get_role(auth.uid()) = 'ceo'
    or (
      app_private.get_role(auth.uid()) = 'trustee'
      and app_private.manages_fund(auth.uid(), fund_id)
    )
  );

-- Pulse + CEO write; a note is always authored as yourself.
create policy fund_notes_insert on public.fund_notes
  for insert to authenticated
  with check (
    (app_private.is_pulse(auth.uid()) or app_private.get_role(auth.uid()) = 'ceo')
    and created_by = auth.uid()
  );

-- Edit/delete: the author, or the Pulse admin (moderation).
create policy fund_notes_update on public.fund_notes
  for update to authenticated
  using (created_by = auth.uid() or app_private.is_pulse_admin(auth.uid()))
  with check (created_by = auth.uid() or app_private.is_pulse_admin(auth.uid()));

create policy fund_notes_delete on public.fund_notes
  for delete to authenticated
  using (created_by = auth.uid() or app_private.is_pulse_admin(auth.uid()));

revoke all on public.fund_notes from anon;

drop trigger if exists fund_notes_audit on public.fund_notes;
create trigger fund_notes_audit
  after insert or update or delete on public.fund_notes
  for each row execute function app_private.audit_changes();

-- Migrate legacy single-blob notes. Attributed to the longest-standing Pulse
-- admin: the original author is unknowable from a plain text column.
insert into public.fund_notes (fund_id, body, created_by)
select f.id, f.description, p.id
from public.funds f
cross join lateral (
  select id from public.profiles where role = 'pulse_admin' order by created_at limit 1
) p
where f.description is not null and btrim(f.description) <> '';
