import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

/** Write an audit_log entry from an edge function (server-side actions). */
export async function auditLog(
  svc: SupabaseClient,
  entry: {
    actor_id: string | null
    action: string
    entity: string
    entity_id?: string | null
    before?: unknown
    after?: unknown
    ip?: string | null
  },
): Promise<void> {
  await svc.from('audit_log').insert({
    actor_id: entry.actor_id,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entity_id ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
  })
}
