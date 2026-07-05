/**
 * invite-user — send a Supabase invite email and set up the profile.
 *
 * JWT-verified; pulse_admin ONLY. Body { email, full_name, role,
 * organisation }. Sends the invite via auth.admin.inviteUserByEmail with a
 * redirect to <origin or SITE_URL>/reset-password, then upserts the profiles
 * row with the requested role/organisation (the signup trigger will have
 * created it with defaults), and audit-logs 'user_invited'.
 *
 * Returns { ok: true }.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient, type Role } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

const ROLES: Role[] = [
  'pulse_admin',
  'pulse_bookkeeper',
  'pulse_payroll',
  'ceo',
  'trustee',
  'submitter',
]
const ORGANISATIONS = ['pulse', 'gaufcc'] as const

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as
    | { email?: unknown; full_name?: unknown; role?: unknown; organisation?: unknown }
    | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const fullName = typeof body?.full_name === 'string' ? body.full_name.trim() : ''
  const role = body?.role
  const organisation = body?.organisation

  if (!isEmail(email)) return errorResponse('A valid email address is required')
  if (!fullName || fullName.length > 200) return errorResponse('full_name is required')
  if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
    return errorResponse('role is not valid')
  }
  if (
    typeof organisation !== 'string' ||
    !(ORGANISATIONS as readonly string[]).includes(organisation)
  ) {
    return errorResponse("organisation must be 'pulse' or 'gaufcc'")
  }

  const origin = req.headers.get('origin') ?? Deno.env.get('SITE_URL') ?? null
  const redirectTo = origin ? `${origin.replace(/\/+$/, '')}/reset-password` : undefined

  const svc = serviceClient()
  const { data: invited, error: inviteError } = await svc.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    ...(redirectTo ? { redirectTo } : {}),
  })
  if (inviteError) {
    const message = /already/i.test(inviteError.message)
      ? 'A user with this email address already exists'
      : `Could not send the invite: ${inviteError.message}`
    return errorResponse(message, 422)
  }
  const userId = invited?.user?.id
  if (!userId) return errorResponse('The invite was sent but no user id was returned', 500)

  // The auth signup trigger creates the profile with defaults — apply the
  // requested role and organisation on top.
  const { error: profileError } = await svc.from('profiles').upsert(
    {
      id: userId,
      email,
      full_name: fullName,
      role,
      organisation,
      active: true,
    },
    { onConflict: 'id' },
  )
  if (profileError) {
    return errorResponse(
      `The invite was sent but the profile could not be updated: ${profileError.message}`,
      500,
    )
  }

  await auditLog(svc, {
    actor_id: caller.userId,
    action: 'user_invited',
    entity: 'profiles',
    entity_id: userId,
    after: { email, full_name: fullName, role, organisation },
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  return json({ ok: true })
})
