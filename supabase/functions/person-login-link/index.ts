/**
 * person-login-link — create or fetch a login for an employee/volunteer
 * WITHOUT sending any email (JWT-verified; pulse_admin or ceo). Two shapes:
 *
 *  - No `password` in the body → a copyable one-time link comes back:
 *    generateLink type 'invite' for a brand-new email (the user is created
 *    silently), type 'recovery' when the email already has a login. The
 *    caller pastes the link into whatever channel they like.
 *  - `password` in the body → the password is set directly instead:
 *    createUser (email confirmed) for a new email, updateUserById for an
 *    existing one. No link, nothing sent — the caller passes the password on.
 *
 * Privilege guard: when the email already belongs to a login, that login's
 * profile role must be absent, 'submitter' or 'trustee'. Privileged logins
 * (pulse_* and ceo) can never be recovered or re-passworded through this
 * endpoint, whoever calls it — otherwise a recovery link is an account
 * takeover. New logins are always created as submitters.
 *
 * Body { person_id, email, full_name, password? }.
 * Returns { existing, action_link? , password_set? }.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

const UNPRIVILEGED_ROLES = ['submitter', 'trustee']

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

  const body = (await req.json().catch(() => null)) as
    | { person_id?: unknown; email?: unknown; full_name?: unknown; password?: unknown }
    | null
  const personId = typeof body?.person_id === 'string' ? body.person_id : null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const fullName = typeof body?.full_name === 'string' ? body.full_name.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : null

  if (!personId) return errorResponse('person_id is required')
  if (!isEmail(email)) return errorResponse('A valid email address is required')
  if (password !== null && (password.length < 8 || password.length > 72)) {
    return errorResponse('The password needs to be 8–72 characters')
  }

  const origin = req.headers.get('origin') ?? Deno.env.get('SITE_URL') ?? null
  const redirectTo = origin ? `${origin.replace(/\/+$/, '')}/reset-password` : undefined

  const svc = serviceClient()

  // Does this email already have a login? (paged lookup would be overkill —
  // profiles carries every app login and is keyed to auth users)
  const { data: existingProfile, error: profileLookupError } = await svc
    .from('profiles')
    .select('id, role')
    .eq('email', email)
    .maybeSingle()
  if (profileLookupError) {
    return errorResponse(`The existing logins could not be checked: ${profileLookupError.message}`, 500)
  }

  let userId: string | null = null
  let actionLink: string | null = null
  let passwordSet = false
  let existing = false

  if (existingProfile) {
    // Existing login — takeover guard first, whoever the caller is.
    existing = true
    if (existingProfile.role && !UNPRIVILEGED_ROLES.includes(existingProfile.role)) {
      return errorResponse(
        `${email} belongs to a privileged login (${existingProfile.role}) — its password cannot be set or recovered from here.`,
        403,
      )
    }
    userId = existingProfile.id
    if (password) {
      const { error } = await svc.auth.admin.updateUserById(userId, { password })
      if (error) return errorResponse(`The password could not be set: ${error.message}`, 500)
      passwordSet = true
    } else {
      const recovery = await svc.auth.admin.generateLink({
        type: 'recovery',
        email,
        ...(redirectTo ? { options: { redirectTo } } : {}),
      })
      if (recovery.error) {
        return errorResponse(`A set-password link could not be generated: ${recovery.error.message}`, 500)
      }
      actionLink = recovery.data.properties?.action_link ?? null
    }
    // Deliberately no profile upsert: the login's role must not be touched —
    // linking the person record below is enough.
  } else if (password) {
    // New login, password chosen by the caller — created ready to sign in.
    const created = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : undefined,
    })
    if (created.error) {
      return errorResponse(`The login could not be created: ${created.error.message}`, 500)
    }
    userId = created.data.user?.id ?? null
    passwordSet = true
  } else {
    // New login, no password — a silent invite link to pass on.
    const invite = await svc.auth.admin.generateLink({
      type: 'invite',
      email,
      options: {
        data: fullName ? { full_name: fullName } : undefined,
        ...(redirectTo ? { redirectTo } : {}),
      },
    })
    if (invite.error) {
      return errorResponse(`The login could not be created: ${invite.error.message}`, 500)
    }
    userId = invite.data.user?.id ?? null
    actionLink = invite.data.properties?.action_link ?? null
  }

  if (!userId || (!actionLink && !passwordSet)) {
    return errorResponse('No sign-in link or password confirmation came back — try again', 500)
  }

  // New logins get a submitter profile in the charity's organisation.
  if (!existing) {
    const { error: profileError } = await svc.from('profiles').upsert(
      {
        id: userId,
        email,
        full_name: fullName || email,
        role: 'submitter',
        organisation: 'gaufcc',
        active: true,
      },
      { onConflict: 'id' },
    )
    if (profileError) {
      return errorResponse(`The profile could not be set up: ${profileError.message}`, 500)
    }
  }

  const { error: personError } = await svc
    .from('people')
    .update({ profile_id: userId, email })
    .eq('id', personId)
  if (personError) {
    return errorResponse(`The person record could not be linked: ${personError.message}`, 500)
  }

  await auditLog(svc, {
    actor_id: caller.userId,
    action: passwordSet ? 'person_login_password_set' : 'person_login_link_generated',
    entity: 'people',
    entity_id: personId,
    after: { email, existing }, // never the password
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  return json({ action_link: actionLink, existing, password_set: passwordSet })
})
