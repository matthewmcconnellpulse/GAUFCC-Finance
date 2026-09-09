/**
 * xero-budgets — budget figures, live from Xero.
 *
 * JWT-verified; roles pulse_*, ceo, trustee.
 *
 * Body:
 * - { } or { list: true } → the budgets available on the connection:
 *   [{ budget_id, type, description, updated }]
 * - { budget_id, from?, to? } → one budget's lines by account and month:
 *   { budget_id, description, from, to, accounts: [{ code, name, months:
 *   { 'YYYY-MM': amount }, total }], months: ['YYYY-MM'], total }
 *
 * Requires accounting.budgets.read on the custom connection. That scope is NOT
 * part of the default set, so a fresh connection will refuse this call; the
 * 403 is translated into a message naming the scope rather than a bare error,
 * because "add accounting.budgets.read and reconnect" is the entire fix.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { xeroFetch } from '../_shared/xero.ts'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const SCOPE_MESSAGE =
  'Xero refused the budget read. The custom connection needs the accounting.budgets.read scope — add it to the app in the Xero developer portal, then reconnect. Until then budget tracking stays empty.'

interface XeroBudgetSummary {
  BudgetID?: string
  Type?: string
  Description?: string
  UpdatedDateUTC?: string
}

interface XeroBudgetLine {
  AccountID?: string
  AccountCode?: string
  BudgetBalances?: Array<{ Period?: string; Amount?: number; Notes?: string }>
}

interface XeroBudgetDetail {
  BudgetID?: string
  Type?: string
  Description?: string
  BudgetLines?: XeroBudgetLine[]
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function xeroDateIso(value: string | undefined): string | null {
  if (!value) return null
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(value)
  const d = m ? new Date(Number(m[1])) : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function isScopeError(message: string): boolean {
  return /\b403\b|forbidden|unauthoriz|scope|AuthenticationUnsuccessful/i.test(message)
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo', 'trustee'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as
    | { budget_id?: unknown; from?: unknown; to?: unknown; list?: unknown }
    | null

  const budgetId = typeof body?.budget_id === 'string' ? body.budget_id.trim() : ''

  // ── List the budgets on the connection ───────────────────────────────────
  if (!budgetId) {
    try {
      const { data } = await xeroFetch<{ Budgets?: XeroBudgetSummary[] }>('Budgets')
      const budgets = (data?.Budgets ?? []).map((b) => ({
        budget_id: b.BudgetID ?? '',
        type: b.Type ?? null,
        description: b.Description?.trim() || 'Untitled budget',
        updated: xeroDateIso(b.UpdatedDateUTC),
      }))
      return json({ budgets, scope_ok: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Xero could not be reached'
      if (isScopeError(message)) {
        return json({ budgets: [], scope_ok: false, error: SCOPE_MESSAGE })
      }
      console.error('[xero-budgets] list', message)
      return errorResponse(`Budgets could not be read from Xero: ${message}`, 502)
    }
  }

  // ── One budget's lines ───────────────────────────────────────────────────
  const params: Record<string, string> = {}
  for (const key of ['from', 'to'] as const) {
    const value = body?.[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || !ISO_DATE.test(value)) {
      return errorResponse(`${key} must be YYYY-MM-DD`)
    }
    params[`Date${key === 'from' ? 'From' : 'To'}`] = value
  }

  let detail: XeroBudgetDetail | undefined
  try {
    const { data } = await xeroFetch<{ Budgets?: XeroBudgetDetail[] }>(
      `Budgets/${encodeURIComponent(budgetId)}`,
      { params },
    )
    detail = data?.Budgets?.[0]
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Xero could not be reached'
    if (isScopeError(message)) return errorResponse(SCOPE_MESSAGE, 502)
    console.error('[xero-budgets] detail', message)
    return errorResponse(`The budget could not be read from Xero: ${message}`, 502)
  }
  if (!detail) return errorResponse('Xero returned no budget for that id', 404)

  // Account names come from our own mirror rather than a second Xero call —
  // the chart of accounts is already synced, and this keeps the call count
  // down against a 60-per-minute rate limit. Names are a nicety anyway; if the
  // read fails the codes alone still report.
  const accountNames = new Map<string, string>()
  try {
    const { data } = await serviceClient()
      .from('xero_accounts')
      .select('code, name')
      .limit(1000)
    for (const a of (data ?? []) as Array<{ code: string | null; name: string }>) {
      if (a.code) accountNames.set(a.code, a.name)
    }
  } catch {
    // Codes alone still report.
  }

  const monthSet = new Set<string>()
  const accounts = (detail.BudgetLines ?? []).map((line) => {
    const months: Record<string, number> = {}
    let total = 0
    for (const balance of line.BudgetBalances ?? []) {
      const period = typeof balance.Period === 'string' ? balance.Period.slice(0, 7) : ''
      if (!/^\d{4}-\d{2}$/.test(period)) continue
      const amount = typeof balance.Amount === 'number' ? balance.Amount : 0
      if (amount === 0) continue
      months[period] = round2((months[period] ?? 0) + amount)
      total = round2(total + amount)
      monthSet.add(period)
    }
    const code = line.AccountCode ?? ''
    return { code, name: accountNames.get(code) ?? code, months, total }
  })

  const withFigures = accounts.filter((a) => a.total !== 0)
  return json({
    budget_id: detail.BudgetID ?? budgetId,
    type: detail.Type ?? null,
    description: detail.Description?.trim() || 'Untitled budget',
    from: params.DateFrom ?? null,
    to: params.DateTo ?? null,
    months: [...monthSet].sort(),
    accounts: withFigures.sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    total: round2(withFigures.reduce((s, a) => s + a.total, 0)),
  })
})
