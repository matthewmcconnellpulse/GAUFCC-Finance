-- 0027 — receipts policies for on-behalf expense entry.
--
-- Pulse (admin + bookkeeper) can now enter a claim for an employee or
-- volunteer. Receipts keep the owner-folder convention (<submitter uid>/…),
-- which needs two changes:
--   * Pulse may write receipt objects into any folder (the UI stores them
--     under the claim owner's uid so the owner keeps sight of them).
--   * A claim owner may read any object referenced by one of their claim's
--     lines — covers objects a Pulse user happened to store elsewhere.
-- Wrapped like 0015: storage.objects DDL can need elevated rights on some
-- stacks, so failures surface as notices rather than killing the migration.

do $$
begin

  begin
    drop policy if exists receipts_insert_own on storage.objects;
    create policy receipts_insert_own on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'receipts'
        and (
          (name like auth.uid()::text || '/%' and app_private.get_role(auth.uid()) is not null)
          or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
        )
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
          or (
            app_private.get_role(auth.uid()) is not null
            and exists (
              select 1
              from public.expense_lines el
              join public.expense_claims ec on ec.id = el.claim_id
              where el.receipt_storage_path = storage.objects.name
                and ec.submitter_id = auth.uid()
            )
          )
        )
      );

    drop policy if exists receipts_update_own on storage.objects;
    create policy receipts_update_own on storage.objects
      for update to authenticated
      using (
        bucket_id = 'receipts'
        and (
          (name like auth.uid()::text || '/%' and app_private.get_role(auth.uid()) is not null)
          or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
        )
      )
      with check (
        bucket_id = 'receipts'
        and (
          (name like auth.uid()::text || '/%' and app_private.get_role(auth.uid()) is not null)
          or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
        )
      );

    drop policy if exists receipts_delete_own on storage.objects;
    create policy receipts_delete_own on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'receipts'
        and (
          (name like auth.uid()::text || '/%' and app_private.get_role(auth.uid()) is not null)
          or app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_bookkeeper')
        )
      );
  exception when insufficient_privilege then
    raise notice 'storage.objects policies could not be updated — re-run 0027 with elevated rights';
  end;

end $$;
