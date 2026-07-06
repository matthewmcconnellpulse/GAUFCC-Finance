/**
 * Xero client for a **custom connection** (machine-to-machine).
 *
 * Custom connections use the OAuth 2.0 client_credentials grant: one app is
 * authorised against exactly one Xero organisation, there is no redirect
 * flow and no refresh token — you simply request a fresh access token (valid
 * 30 minutes) whenever needed. No `xero-tenant-id` header is required.
 *
 * Rate limits: 60 calls/minute, 5,000/day per connection. `xeroFetch`
 * retries on 429 using the Retry-After header.
 */

const TOKEN_URL = 'https://identity.xero.com/connect/token'
const API_BASE = 'https://api.xero.com/api.xro/2.0'

let cachedToken: { token: string; expiresAt: number } | null = null

export async function getXeroToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token
  }
  const clientId = Deno.env.get('XERO_CLIENT_ID')
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error(
      'XERO_CLIENT_ID / XERO_CLIENT_SECRET are not set — add them under Supabase → Edge Functions → Secrets',
    )
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Xero token request failed (${res.status}): ${body}`)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  }
  return json.access_token
}

export interface XeroFetchOptions {
  method?: 'GET' | 'POST' | 'PUT'
  body?: unknown
  /** e.g. { page: '2', where: '...' } */
  params?: Record<string, string>
  /** If-Modified-Since for incremental sync */
  modifiedSince?: string
  maxRetries?: number
}

export async function xeroFetch<T = unknown>(
  path: string,
  opts: XeroFetchOptions = {},
): Promise<{ status: number; data: T | null }> {
  const { method = 'GET', body, params, modifiedSince, maxRetries = 3 } = opts
  const url = new URL(`${API_BASE}/${path.replace(/^\//, '')}`)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)

  let refreshedAuth = false
  for (let attempt = 0; ; attempt++) {
    const token = await getXeroToken()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    if (body) headers['Content-Type'] = 'application/json'
    if (modifiedSince) headers['If-Modified-Since'] = modifiedSince

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '5')
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000))
      continue
    }
    if ((res.status === 401 || res.status === 403) && !refreshedAuth) {
      // The cached token predates any scope/authorisation change (tokens live
      // 30 minutes) — mint a fresh one and retry once before giving up, so a
      // newly-granted scope works immediately.
      refreshedAuth = true
      cachedToken = null
      await res.body?.cancel()
      continue
    }
    if (res.status === 304) return { status: 304, data: null } // not modified
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Xero ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`)
    }
    return { status: res.status, data: (await res.json()) as T }
  }
}

/**
 * Attach a file to a Xero document (raw-body PUT — xeroFetch only speaks
 * JSON). Requires the accounting.attachments scope on the connection.
 * Endpoint: PUT /{docType}/{guid}/Attachments/{filename}.
 */
export async function uploadXeroAttachment(
  docType: 'Invoices' | 'BankTransactions',
  documentId: string,
  fileName: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const token = await getXeroToken()
  const url = `${API_BASE}/${docType}/${documentId}/Attachments/${encodeURIComponent(fileName)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': contentType,
    },
    body: bytes,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Xero attachment upload failed (${res.status}): ${text.slice(0, 300)}`)
  }
}

/** Xero serialises dates as `/Date(1712345678000+0000)/` — normalise to ISO. */
export function parseXeroDate(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(value)
  if (m) return new Date(Number(m[1])).toISOString()
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
