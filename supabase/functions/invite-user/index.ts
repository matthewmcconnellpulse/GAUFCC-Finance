/**
 * invite-user — add a portal user WITHOUT depending on email delivery
 * (JWT-verified; pulse_admin or ceo). Two modes via body.mode:
 *
 *  - 'link' (default): the user is created silently (generateLink type
 *    'invite') and a one-time set-password link comes back for the caller to
 *    send through their own channel. Nothing is emailed.
 *  - 'password': the caller supplies the password; the user is created ready
 *    to sign in (email confirmed) and no link is needed.
 *
 * Privilege guard: a pulse_admin can create any role; the ceo can only
 * create 'submitter' and 'trustee' logins in the 'gaufcc' organisation —
 * the CEO must not be able to mint Pulse or CEO logins.
 *
 * Body { email, full_name, role, organisation, person_id?, mode?, password? }.
 * person_id links an employee/volunteer record so their history follows the
 * login. Returns { ok: true, action_link? }.
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
const CEO_ROLES: Role[] = ['trustee', 'submitter']
const ORGANISATIONS = ['pulse', 'gaufcc'] as const

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'ceo'])) {
    return errorResponse('Not authorised', 403)
  }
  const callerIsCeo = caller.role === 'ceo'

  const body = (await req.json().catch(() => null)) as
    | {
        email?: unknown
        full_name?: unknown
        role?: unknown
        organisation?: unknown
        person_id?: unknown
        mode?: unknown
        password?: unknown
      }
    | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const fullName = typeof body?.full_name === 'string' ? body.full_name.trim() : ''
  const role = body?.role
  const organisation = body?.organisation
  const personId = typeof body?.person_id === 'string' ? body.person_id : null
  const mode = body?.mode === 'password' ? 'password' : 'link'
  const password = typeof body?.password === 'string' ? body.password : null

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
  if (callerIsCeo && (!CEO_ROLES.includes(role as Role) || organisation !== 'gaufcc')) {
    return errorResponse('The CEO can only add trustee and submitter logins for GAUFCC', 403)
  }
  if (mode === 'password' && (!password || password.length < 8 || password.length > 72)) {
    return errorResponse('The password needs to be 8–72 characters')
  }

  const origin = req.headers.get('origin') ?? Deno.env.get('SITE_URL') ?? null
  const redirectTo = origin ? `${origin.replace(/\/+$/, '')}/reset-password` : undefined

  const svc = serviceClient()
  let userId: string | null = null
  let actionLink: string | null = null

  if (mode === 'password') {
    const created = await svc.auth.admin.createUser({
      email,
      password: password as string,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })
    if (created.error) {
      const message = /already/i.test(created.error.message)
        ? 'A user with this email address already exists'
        : `The login could not be created: ${created.error.message}`
      return errorResponse(message, 422)
    }
    userId = created.data.user?.id ?? null
  } else {
    const invite = await svc.auth.admin.generateLink({
      type: 'invite',
      email,
      options: {
        data: { full_name: fullName },
        ...(redirectTo ? { redirectTo } : {}),
      },
    })
    if (invite.error) {
      const message = /already|registered|exists/i.test(invite.error.message)
        ? 'A user with this email address already exists'
        : `The login could not be created: ${invite.error.message}`
      return errorResponse(message, 422)
    }
    userId = invite.data.user?.id ?? null
    actionLink = invite.data.properties?.action_link ?? null
    if (!actionLink) return errorResponse('No sign-up link came back — try again', 500)
  }
  if (!userId) return errorResponse('The login was created but no user id was returned', 500)

  // Apply the requested role and organisation on top of the signup trigger's
  // defaults.
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
      `The login was created but the profile could not be updated: ${profileError.message}`,
      500,
    )
  }

  // Link the employee/volunteer record so their history follows the login.
  if (personId) {
    const { error: personError } = await svc
      .from('people')
      .update({ profile_id: userId, email })
      .eq('id', personId)
    if (personError) {
      return errorResponse(
        `The login was created but the person record could not be linked: ${personError.message}`,
        500,
      )
    }
  }

  await auditLog(svc, {
    actor_id: caller.userId,
    action: 'user_invited',
    entity: 'profiles',
    entity_id: userId,
    after: { email, full_name: fullName, role, organisation, person_id: personId, mode }, // never the password
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  return json({ ok: true, action_link: actionLink })
})
