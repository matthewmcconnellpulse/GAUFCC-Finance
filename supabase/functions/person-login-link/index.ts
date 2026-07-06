/**
 * person-login-link — create or fetch a login for an employee/volunteer and
 * return a copyable sign-in link WITHOUT sending any email (JWT-verified;
 * pulse_admin ONLY). Pulse pastes the link into whatever channel they like.
 *
 * Body { person_id, email, full_name }:
 *  - No auth user with that email yet → generateLink(type 'invite') creates
 *    the user silently and returns the action link; a submitter/gaufcc
 *    profile is set up and people.profile_id linked.
 *  - Auth user already exists → the person record is linked to that login
 *    (their profile/role is left untouched) and a set-password link
 *    (type 'recovery') is returned instead.
 *
 * Returns { action_link, existing }. The link is single-use and short-lived —
 * generate a fresh one whenever it is needed.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

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
    | { person_id?: unknown; email?: unknown; full_name?: unknown }
    | null
  const personId = typeof body?.person_id === 'string' ? body.person_id : null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const fullName = typeof body?.full_name === 'string' ? body.full_name.trim() : ''

  if (!personId) return errorResponse('person_id is required')
  if (!isEmail(email)) return errorResponse('A valid email address is required')

  const origin = req.headers.get('origin') ?? Deno.env.get('SITE_URL') ?? null
  const redirectTo = origin ? `${origin.replace(/\/+$/, '')}/reset-password` : undefined

  const svc = serviceClient()

  // Try to create the user silently; fall back to a set-password link when
  // the email is already registered.
  let userId: string | null = null
  let actionLink: string | null = null
  let existing = false

  const invite = await svc.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      data: fullName ? { full_name: fullName } : undefined,
      ...(redirectTo ? { redirectTo } : {}),
    },
  })

  if (!invite.error) {
    userId = invite.data.user?.id ?? null
    actionLink = invite.data.properties?.action_link ?? null

    // New login → submitter profile in the charity's organisation.
    if (userId) {
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
  } else if (/already|registered|exists/i.test(invite.error.message)) {
    existing = true
    const recovery = await svc.auth.admin.generateLink({
      type: 'recovery',
      email,
      ...(redirectTo ? { options: { redirectTo } } : {}),
    })
    if (recovery.error) {
      return errorResponse(
        `A login exists for ${email} but a sign-in link could not be generated: ${recovery.error.message}`,
        500,
      )
    }
    userId = recovery.data.user?.id ?? null
    actionLink = recovery.data.properties?.action_link ?? null
    // Deliberately no profile upsert: the login may belong to an existing
    // user whose role must not be touched — linking is enough.
  } else {
    return errorResponse(`The login could not be created: ${invite.error.message}`, 500)
  }

  if (!userId || !actionLink) {
    return errorResponse('No sign-in link came back — try again', 500)
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
    action: 'person_login_link_generated',
    entity: 'people',
    entity_id: personId,
    after: { email, existing },
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  return json({ action_link: actionLink, existing })
})
