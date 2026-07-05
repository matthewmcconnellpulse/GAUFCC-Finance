-- 0015 — storage buckets and object policies.
--
-- All four buckets are private; access flows through storage.objects policies.
-- Folder convention: the first path segment of an owner-scoped object is the
-- uploader's auth uid ("<uid>/receipt-1.jpg"), matched with name like
-- auth.uid() || '/%'.
--
-- Policy DDL on storage.objects can require elevated rights on some hosted
-- stacks, so each statement is wrapped to surface a clear notice instead of
-- failing the whole migration; re-run after fixing grants if any notice fires.

insert into storage.buckets (id, name, public)
values
  ('receipts', 'receipts', false),
  ('imports', 'imports', false),
  ('packs', 'packs', false),
  ('people-docs', 'people-docs', false)
on conflict (id) do nothing;

do $$
begin

  -- ── receipts: submitters write/read their own folder; Pulse + CEO read all ─

  begin
    -- own-folder arms require an ACTIVE profile (get_role null = deactivated)
    drop policy if exists receipts_insert_own on storage.objects;
    create policy receipts_insert_own on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'receipts'
        and name like auth.uid()::text || '/%'
        and app_private.get_role(auth.uid()) is not null
      );

    drop policy if exists receipts_select on storage.objects;
    create policy receipts_select on storage.objects
      for select to authenticated
      using (
        bucket_id = 'receipts'
        and (
          (name like auth.uid()::text || '/%' and app_private.get_role(auth.uid()) is not null)
          or app_private.is_pulse(auth.uid())
          or app_private.get_role(auth.uid()) = 'ceo'
        )
      );

    drop policy if exists receipts_update_own on storage.objects;
    create policy receipts_update_own on storage.objects
      for update to authenticated
      using (
        bucket_id = 'receipts'
        and name like auth.uid()::text || '/%'
        and app_private.get_role(auth.uid()) is not null
      )
      with check (
        bucket_id = 'receipts'
        and name like auth.uid()::text || '/%'
        and app_private.get_role(auth.uid()) is not null
      );

    drop policy if exists receipts_delete_own on storage.objects;
    create policy receipts_delete_own on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'receipts'
        and (
          (name like auth.uid()::text || '/%' and app_private.get_role(auth.uid()) is not null)
          or app_private.is_pulse_admin(auth.uid())
        )
      );
  exception when insufficient_privilege then
    raise notice 'receipts policies could not be created (%). Create them via the dashboard.', sqlerrm;
  end;

  -- ── imports: Pulse only, full access ────────────────────────────────────────

  begin
    drop policy if exists imports_all_pulse on storage.objects;
    create policy imports_all_pulse on storage.objects
      for all to authenticated
      using (bucket_id = 'imports' and app_private.is_pulse(auth.uid()))
      with check (bucket_id = 'imports' and app_private.is_pulse(auth.uid()));
  exception when insufficient_privilege then
    raise notice 'imports policies could not be created (%). Create them via the dashboard.', sqlerrm;
  end;

  -- ── packs: Pulse full access; CEO reads all; trustees read only pack files ──
  --    whose board_packs register row their RLS allows (scope-based).

  begin
    drop policy if exists packs_all_pulse on storage.objects;
    create policy packs_all_pulse on storage.objects
      for all to authenticated
      using (bucket_id = 'packs' and app_private.is_pulse(auth.uid()))
      with check (bucket_id = 'packs' and app_private.is_pulse(auth.uid()));

    drop policy if exists packs_select_ceo on storage.objects;
    create policy packs_select_ceo on storage.objects
      for select to authenticated
      using (bucket_id = 'packs' and app_private.get_role(auth.uid()) = 'ceo');

    drop policy if exists packs_select_trustee on storage.objects;
    create policy packs_select_trustee on storage.objects
      for select to authenticated
      using (
        bucket_id = 'packs'
        and app_private.get_role(auth.uid()) = 'trustee'
        -- board_packs is security-invoker-visible here: the trustee's own RLS
        -- decides which register rows (and therefore which files) they see
        and exists (
          select 1 from public.board_packs bp
          where bp.storage_path = storage.objects.name
        )
      );
  exception when insufficient_privilege then
    raise notice 'packs policies could not be created (%). Create them via the dashboard.', sqlerrm;
  end;

  -- ── people-docs: payroll + admin full access; owner uploads own folder ──────

  begin
    drop policy if exists people_docs_all_payroll on storage.objects;
    create policy people_docs_all_payroll on storage.objects
      for all to authenticated
      using (
        bucket_id = 'people-docs'
        and app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll')
      )
      with check (
        bucket_id = 'people-docs'
        and app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll')
      );

    drop policy if exists people_docs_insert_own on storage.objects;
    create policy people_docs_insert_own on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'people-docs'
        and name like auth.uid()::text || '/%'
        and app_private.get_role(auth.uid()) is not null
      );

    drop policy if exists people_docs_select_own on storage.objects;
    create policy people_docs_select_own on storage.objects
      for select to authenticated
      using (
        bucket_id = 'people-docs'
        and name like auth.uid()::text || '/%'
        and app_private.get_role(auth.uid()) is not null
      );
  exception when insufficient_privilege then
    raise notice 'people-docs policies could not be created (%). Create them via the dashboard.', sqlerrm;
  end;

end;
$$;
