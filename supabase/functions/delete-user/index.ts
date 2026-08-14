/**
 * delete-user — permanently remove a login (JWT-verified; pulse_admin only).
 *
 * Deleting is reserved for users with no platform history — someone invited
 * by mistake, a test login, a duplicate. Anyone who has submitted expenses,
 * uploaded imports, stamped funds or left notes is part of the audit trail
 * and must be archived (profiles.active = false) instead; the
 * user_delete_blockers RPC enumerates those references and this function
 * refuses with a 409 naming them.
 *
 * Guards: callers cannot delete themselves, and pulse_admin logins cannot be
 * deleted at all (change the role first) — so the last admin can never be
 * removed. Deleting the auth user cascades to profiles, fund_managers and
 * user_activity; a linked people record keeps its row with profile_id nulled.
 *
 * Body { user_id }. Returns { ok: true }.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as { user_id?: unknown } | null
  const userId = typeof body?.user_id === 'string' ? body.user_id : ''
  if (!userId) return errorResponse('user_id is required')
  if (userId === caller!.userId) {
    return errorResponse('You cannot delete your own login')
  }

  const svc = serviceClient()
  const { data: target, error: targetError } = await svc
    .from('profiles')
    .select('id, email, full_name, role, organisation, active')
    .eq('id', userId)
    .maybeSingle()
  if (targetError) return errorResponse(targetError.message, 500)
  if (!target) return errorResponse('User not found', 404)
  if (target.role === 'pulse_admin') {
    return errorResponse('Pulse admin logins cannot be deleted — change their role first')
  }

  const { data: blockers, error: blockersError } = await svc.rpc('user_delete_blockers', {
    target: userId,
  })
  if (blockersError) return errorResponse(blockersError.message, 500)

  const counts = (blockers ?? {}) as Record<string, number>
  if (Object.keys(counts).length > 0) {
    const summary = Object.entries(counts)
      .map(([table, n]) => `${n} × ${table.replace(/_/g, ' ')}`)
      .join(', ')
    return json(
      {
        error:
          `${target.full_name || target.email} has history on the platform (${summary}) ` +
          'which must stay for the audit trail — archive them instead.',
        blockers: counts,
      },
      409,
    )
  }

  await auditLog(svc, {
    actor_id: caller!.userId,
    action: 'user_deleted',
    entity: 'profiles',
    entity_id: userId,
    before: {
      email: target.email,
      full_name: target.full_name,
      role: target.role,
      organisation: target.organisation,
      active: target.active,
    },
  })

  const { error: deleteError } = await svc.auth.admin.deleteUser(userId)
  if (deleteError) return errorResponse(deleteError.message, 500)

  return json({ ok: true })
})
