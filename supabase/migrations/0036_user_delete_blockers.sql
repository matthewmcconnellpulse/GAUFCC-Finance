-- 0036 — helper for hard-deleting a login.
--
-- A profile row is referenced by many tables. Some FKs clean up on their own
-- (fund_managers CASCADE, user_activity CASCADE, people.profile_id SET NULL);
-- the rest deliberately block deletion because the rows are financial history
-- (expenses, imports, stamps, packs, notes). This function counts rows behind
-- every BLOCKING reference so delete-user can refuse with a precise message
-- instead of surfacing a raw FK violation. Discovering the FKs dynamically
-- means new tables are covered without touching this function.
--
-- Service-role only: it is called exclusively from the delete-user edge
-- function after the caller's pulse_admin role has been verified.

create or replace function public.user_delete_blockers(target uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n bigint;
  blockers jsonb := '{}'::jsonb;
begin
  for r in
    select kcu.table_schema, kcu.table_name, kcu.column_name
    from information_schema.referential_constraints rc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = rc.constraint_name
     and kcu.constraint_schema = rc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = rc.constraint_name
     and ccu.constraint_schema = rc.constraint_schema
    where ccu.table_schema = 'public'
      and ccu.table_name = 'profiles'
      and ccu.column_name = 'id'
      and rc.delete_rule not in ('CASCADE', 'SET NULL')
  loop
    execute format(
      'select count(*) from %I.%I where %I = $1',
      r.table_schema, r.table_name, r.column_name
    ) into n using target;
    if n > 0 then
      blockers := blockers || jsonb_build_object(r.table_name, n);
    end if;
  end loop;
  return blockers;
end;
$$;

revoke all on function public.user_delete_blockers(uuid) from public, anon, authenticated;
grant execute on function public.user_delete_blockers(uuid) to service_role;
