/**
 * sync-now — the top-bar "Refresh now" button (JWT-verified).
 *
 * Roles: pulse_admin, pulse_bookkeeper, pulse_payroll, ceo.
 * Server-side debounce: if any sync run (running or success) started within
 * the last 5 minutes, respond { started: false, debounced: true } instead of
 * starting another. Otherwise the sync runs via EdgeRuntime.waitUntil and a
 * 202 { started: true } is returned immediately.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { runSync } from '../_shared/sync-engine.ts'

interface EdgeRuntimeLike {
  waitUntil(promise: Promise<unknown>): void
}

function waitUntil(promise: Promise<unknown>): void {
  const runtime = (globalThis as unknown as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime
  if (runtime && typeof runtime.waitUntil === 'function') {
    runtime.waitUntil(promise)
  } else {
    void promise.catch((e) => console.error('[sync-now] background sync failed', e))
  }
}

const DEBOUNCE_MS = 5 * 60_000

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo'])) {
    return errorResponse('Not authorised', 403)
  }

  const svc = serviceClient()
  const cutoff = new Date(Date.now() - DEBOUNCE_MS).toISOString()
  const { data: recent, error } = await svc
    .from('sync_runs')
    .select('id')
    .in('status', ['running', 'success'])
    .gte('started_at', cutoff)
    .limit(1)
  if (error) {
    return errorResponse(`Could not check recent sync runs: ${error.message}`, 500)
  }
  if (recent && recent.length > 0) {
    return json({ started: false, debounced: true })
  }

  // { full: true } forces a complete re-pull (ignores If-Modified-Since) —
  // used after mapping changes so untouched documents are re-written too.
  let full = false
  try {
    const body = (await req.json()) as { full?: boolean } | null
    full = body?.full === true
  } catch {
    // no body — a plain refresh
  }

  waitUntil(runSync('manual', caller.userId, { full }))
  return json({ started: true }, 202)
})
