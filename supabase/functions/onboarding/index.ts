/**
 * onboarding — public, token-based onboarding form endpoint.
 *
 * verify_jwt: FALSE — this function must be deployed with --no-verify-jwt
 * (or [functions.onboarding] verify_jwt = false in supabase/config.toml).
 * Access is gated by single-use onboarding tokens plus per-IP rate limiting.
 *
 * POST { action: 'validate', token } → { valid, person_type?, email? }
 * POST { action: 'submit', token, payload } → { ok }
 *
 * Token failures never leak detail: invalid, expired and used tokens all
 * return { valid: false } / { ok: false }.
 *
 * Sensitive fields (bank account, sort code, NI number) are never stored in
 * plain text by this function: masked values are computed here for the
 * people row, and the raw values are handed to the SECURITY DEFINER rpc
 * set_person_bank_details (provided by the migrations) for encryption at
 * rest. If that rpc is missing, the raw values are dropped — never stored.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

// ── Rate limiting (lightweight, per-instance, per-IP) ────────────────────────

const WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 20
const MAX_TRACKED_IPS = 10_000
const hits = new Map<string, number[]>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > MAX_TRACKED_IPS) {
    // Drop the stalest entries so the map cannot grow without bound.
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key)
      if (hits.size <= MAX_TRACKED_IPS / 2) break
    }
  }
  return recent.length > MAX_REQUESTS_PER_WINDOW
}

// ── Token lookup ─────────────────────────────────────────────────────────────

interface TokenRow {
  id: string
  token: string
  person_id: string | null
  person_type: 'employee' | 'volunteer'
  email: string
  expires_at: string
  used_at: string | null
}

async function loadValidToken(
  svc: ReturnType<typeof serviceClient>,
  token: string,
): Promise<TokenRow | null> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null
  const { data } = await svc
    .from('onboarding_tokens')
    .select('id, token, person_id, person_type, email, expires_at, used_at')
    .eq('token', token)
    .maybeSingle()
  if (!data) return null
  const row = data as TokenRow
  if (row.used_at) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null
  return row
}

// ── Payload handling ─────────────────────────────────────────────────────────

const SENSITIVE_KEYS = ['bank_account', 'bank_sort_code', 'ni_number'] as const

function str(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function isoDate(value: unknown): string | null {
  const s = str(value, 30)
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const iso = `${m[1]}-${m[2]}-${m[3]}`
  return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? null : iso
}

function maskAccount(value: string | null): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••'
}

function maskSortCode(value: string | null): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  return digits.length >= 2 ? `••-••-${digits.slice(-2)}` : '••-••-••'
}

function maskNi(value: string | null): string | null {
  if (!value) return null
  const clean = value.replace(/\s/g, '')
  return clean.length >= 3 ? `••••••${clean.slice(-3).toUpperCase()}` : '•••••••••'
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (isRateLimited(ip)) {
    return errorResponse('Too many requests — try again shortly', 429)
  }

  const body = (await req.json().catch(() => null)) as
    | { action?: unknown; token?: unknown; payload?: unknown }
    | null
  const action = body?.action
  const token = typeof body?.token === 'string' ? body.token : ''

  if (action !== 'validate' && action !== 'submit') {
    return errorResponse("action must be 'validate' or 'submit'")
  }

  const svc = serviceClient()
  const tokenRow = await loadValidToken(svc, token)

  if (action === 'validate') {
    if (!tokenRow) return json({ valid: false })
    return json({ valid: true, person_type: tokenRow.person_type, email: tokenRow.email })
  }

  // action === 'submit'
  if (!tokenRow) return json({ ok: false })
  const payload = body?.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return errorResponse('payload is required')
  }
  const p = payload as Record<string, unknown>

  const firstName = str(p.first_name, 100)
  const lastName = str(p.last_name, 100)
  if (!firstName || !lastName) {
    return errorResponse('First name and last name are required')
  }

  const bankName = str(p.bank_name, 100)
  const bankAccount = str(p.bank_account, 50)
  const bankSortCode = str(p.bank_sort_code, 20)
  const niNumber = str(p.ni_number, 20)

  const personFields = {
    type: tokenRow.person_type,
    first_name: firstName,
    last_name: lastName,
    email: str(p.email, 320) ?? tokenRow.email,
    phone: str(p.phone, 50),
    address: str(p.address, 1000),
    date_of_birth: isoDate(p.date_of_birth),
    bank_name: bankName,
    bank_account_masked: maskAccount(bankAccount),
    bank_sort_code_masked: maskSortCode(bankSortCode),
    ni_number_masked: maskNi(niNumber),
    emergency_contact_name: str(p.emergency_contact_name, 200),
    emergency_contact_phone: str(p.emergency_contact_phone, 50),
    role_title: str(p.role_title, 200),
    volunteer_capacity: str(p.volunteer_capacity, 500),
    start_date: isoDate(p.start_date),
    onboarding_status: 'submitted' as const,
  }

  // Create or update the people row.
  let personId = tokenRow.person_id
  if (personId) {
    const { error } = await svc.from('people').update(personFields).eq('id', personId)
    if (error) {
      console.error('[onboarding] people update failed', error.message)
      return errorResponse('Your details could not be saved — please try again', 500)
    }
  } else {
    const { data, error } = await svc.from('people').insert(personFields).select('id').single()
    if (error || !data) {
      console.error('[onboarding] people insert failed', error?.message)
      return errorResponse('Your details could not be saved — please try again', 500)
    }
    personId = (data as { id: string }).id
    await svc.from('onboarding_tokens').update({ person_id: personId }).eq('id', tokenRow.id)
  }

  // Sensitive values go through the SECURITY DEFINER rpc for encryption at
  // rest. If the rpc is not available the raw values are simply not stored —
  // masked values above are all that persists.
  if (bankAccount || bankSortCode || niNumber) {
    const { error: rpcError } = await svc.rpc('set_person_bank_details', {
      p_person_id: personId,
      p_bank_name: bankName,
      p_bank_account: bankAccount,
      p_bank_sort_code: bankSortCode,
      p_ni_number: niNumber,
    })
    if (rpcError) {
      // Never store the raw values anywhere else; surface for Pulse follow-up.
      console.error('[onboarding] set_person_bank_details unavailable:', rpcError.message)
    }
  }

  // Record the submission with the sensitive fields stripped.
  const safePayload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(p)) {
    if (!(SENSITIVE_KEYS as readonly string[]).includes(key)) safePayload[key] = value
  }
  const { error: submissionError } = await svc.from('onboarding_submissions').insert({
    person_id: personId,
    payload: safePayload,
  })
  if (submissionError) {
    console.error('[onboarding] submission insert failed', submissionError.message)
  }

  // Mark the token as used — single use.
  const { error: tokenError } = await svc
    .from('onboarding_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', tokenRow.id)
    .is('used_at', null)
  if (tokenError) {
    console.error('[onboarding] token update failed', tokenError.message)
  }

  await auditLog(svc, {
    actor_id: null,
    action: 'onboarding_submitted',
    entity: 'people',
    entity_id: personId,
    after: { person_type: tokenRow.person_type, onboarding_status: 'submitted' },
    ip,
  })

  return json({ ok: true })
})
