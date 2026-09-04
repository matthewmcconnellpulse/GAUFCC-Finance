/**
 * delete-person — permanently remove an employee/volunteer record
 * (JWT-verified; pulse_admin only).
 *
 * A leaver should normally just be marked as one: the record stays, payroll
 * history stays, and it can be undone. This endpoint is for records that
 * should never have existed (duplicates, test rows) or where retention has
 * genuinely expired — so it also destroys the uploaded onboarding documents
 * from the people-docs bucket, which a row delete alone would orphan.
 *
 * Refuses while the person still has a portal login attached: unlinking or
 * deleting that login is a separate, deliberate act (Settings → Users), and
 * silently leaving a login whose person record has gone is how orphaned
 * access happens.
 *
 * Body { person_id }. Returns { ok: true, documents_removed }.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

const BUCKET = 'people-docs'

/** Storage paths are stored either bare or bucket-prefixed — normalise. */
function objectPath(raw: string): string {
  return raw.startsWith(`${BUCKET}/`) ? raw.slice(BUCKET.length + 1) : raw
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin'])) {
    return errorResponse('Only a Pulse administrator can delete a person record', 403)
  }

  const body = (await req.json().catch(() => null)) as { person_id?: unknown } | null
  const personId = typeof body?.person_id === 'string' ? body.person_id : null
  if (!personId) return errorResponse('person_id is required')

  const svc = serviceClient()

  const { data: person, error: personError } = await svc
    .from('people')
    .select('id, first_name, last_name, type, email, profile_id, end_date, archived_at')
    .eq('id', personId)
    .maybeSingle()
  if (personError) return errorResponse(`The record could not be read: ${personError.message}`, 500)
  if (!person) return errorResponse('That person record no longer exists', 404)

  if (person.profile_id) {
    return errorResponse(
      'This person still has a portal login. Remove the login first (Settings → Users → Edit → Archive or delete), then delete the record.',
      409,
    )
  }

  // Gather uploaded documents from every onboarding submission before the
  // cascade takes the submissions with the row.
  const { data: submissions, error: subError } = await svc
    .from('onboarding_submissions')
    .select('payload')
    .eq('person_id', personId)
  if (subError) return errorResponse(`The documents could not be listed: ${subError.message}`, 500)

  const paths = new Set<string>()
  for (const row of (submissions ?? []) as Array<{ payload: unknown }>) {
    const docs = (row.payload as { documents?: unknown } | null)?.documents
    if (!Array.isArray(docs)) continue
    for (const doc of docs) {
      const p = (doc as { storage_path?: unknown } | null)?.storage_path
      if (typeof p === 'string' && p) paths.add(objectPath(p))
    }
  }

  let documentsRemoved = 0
  if (paths.size > 0) {
    const { data: removed, error: storageError } = await svc.storage
      .from(BUCKET)
      .remove([...paths])
    if (storageError) {
      return errorResponse(
        `The record was left in place because its documents could not be removed: ${storageError.message}`,
        500,
      )
    }
    documentsRemoved = removed?.length ?? 0
  }

  // Audit BEFORE the delete: if the delete fails the attempt is still on
  // record, and the entry keeps the identifying detail the row took with it.
  await auditLog(svc, {
    actor_id: caller.userId,
    action: 'person_deleted',
    entity: 'people',
    entity_id: personId,
    before: {
      name: `${person.first_name} ${person.last_name}`.trim(),
      type: person.type,
      email: person.email,
      end_date: person.end_date,
      was_archived: person.archived_at != null,
      documents_removed: documentsRemoved,
    },
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  const { error: deleteError } = await svc.from('people').delete().eq('id', personId)
  if (deleteError) return errorResponse(`The record could not be deleted: ${deleteError.message}`, 500)

  return json({ ok: true, documents_removed: documentsRemoved })
})
