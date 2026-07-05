/**
 * xero-test-connection — verify the Xero custom connection from the
 * Settings page. JWT-verified; roles pulse_admin, ceo.
 *
 * Calls GET /Organisation and returns { ok: true, org_name } on success or
 * { ok: false, error } with a helpful message (always HTTP 200 so the
 * settings card can render the outcome without special error handling).
 * Also refreshes the xero_connections singleton status/tenant_id.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { xeroFetch } from '../_shared/xero.ts'
import { touchConnection } from '../_shared/sync-engine.ts'

interface XeroOrganisationApi {
  OrganisationID?: string
  Name?: string
  LegalName?: string
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'ceo'])) {
    return errorResponse('Not authorised', 403)
  }

  const clientId = Deno.env.get('XERO_CLIENT_ID')
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    return json({
      ok: false,
      error:
        'Xero credentials are not configured. Add XERO_CLIENT_ID and XERO_CLIENT_SECRET under Supabase → Edge Functions → Secrets, using a Xero custom connection app authorised against the GAUFCC organisation.',
    })
  }

  const svc = serviceClient()
  try {
    const { data } = await xeroFetch<{ Organisations?: XeroOrganisationApi[] }>('Organisation')
    const org = data?.Organisations?.[0]
    if (!org) {
      return json({
        ok: false,
        error:
          'Xero responded but returned no organisation — check the custom connection is authorised against the GAUFCC organisation.',
      })
    }
    try {
      await touchConnection(svc, {
        status: 'connected',
        tenant_id: org.OrganisationID ?? null,
        last_error: null,
      })
    } catch (persistError) {
      console.error('[xero-test-connection] could not update xero_connections', persistError)
    }
    return json({ ok: true, org_name: org.Name ?? org.LegalName ?? 'Unknown organisation' })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    try {
      await touchConnection(svc, { status: 'error', last_error: message })
    } catch (persistError) {
      console.error('[xero-test-connection] could not update xero_connections', persistError)
    }
    return json({ ok: false, error: message })
  }
})
