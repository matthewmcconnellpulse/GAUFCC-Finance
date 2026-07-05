/**
 * sync-xero — cron-triggered nightly sync (04:00 Europe/London via pg_cron).
 *
 * Deployed with verify_jwt = false: pg_cron cannot mint a user JWT, so the
 * caller authenticates with the `x-cron-secret` header instead, checked
 * against app_private.read_cron_secret() (service-role RPC). Fails closed —
 * if the secret cannot be read, the request is rejected.
 *
 * Returns 202 immediately; the sync itself runs via EdgeRuntime.waitUntil so
 * long runs are not cut off when the response is sent.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { serviceClient } from '../_shared/auth.ts'
import { runSync } from '../_shared/sync-engine.ts'

interface EdgeRuntimeLike {
  waitUntil(promise: Promise<unknown>): void
}

function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as unknown as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime
  if (runtime && typeof runtime.waitUntil === 'function') {
    runtime.waitUntil(promise)
  } else {
    void promise.catch((e) => console.error('[sync-xero] background sync failed', e))
  }
}

/**
 * The cron secret lives in app_private. The migrations agent exposes
 * read_cron_secret() — prefer calling it on the app_private schema, fall
 * back to the public search path if the schema is not exposed to PostgREST.
 */
async function readCronSecret(svc: SupabaseClient): Promise<string | null> {
  const viaPrivate = await svc.schema('app_private').rpc('read_cron_secret')
  if (!viaPrivate.error && typeof viaPrivate.data === 'string' && viaPrivate.data) {
    return viaPrivate.data
  }
  const viaPublic = await svc.rpc('read_cron_secret')
  if (!viaPublic.error && typeof viaPublic.data === 'string' && viaPublic.data) {
    return viaPublic.data
  }
  return null
}

/** Constant-time string comparison — no early exit on first mismatch. */
function secureEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i]
  return diff === 0
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const provided = req.headers.get('x-cron-secret')
  if (!provided) return errorResponse('Unauthorised', 401)

  let secret: string | null = null
  try {
    secret = await readCronSecret(serviceClient())
  } catch (e) {
    console.error('[sync-xero] could not read cron secret', e)
  }
  if (!secret || !secureEquals(provided, secret)) {
    return errorResponse('Unauthorised', 401)
  }

  waitUntil(runSync('cron', null))
  return json({ started: true }, 202)
})
