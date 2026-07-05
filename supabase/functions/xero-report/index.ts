/**
 * xero-report — read-only proxy for Xero's Reports API (JWT-verified).
 *
 * Serves the Financials screens: Profit & Loss and Balance Sheet are
 * rendered live from Xero (they need journal-level data the transaction
 * mirror deliberately does not hold). Report name and parameters are
 * whitelisted — nothing else reaches Xero.
 *
 * Roles: pulse_admin, pulse_bookkeeper, pulse_payroll, ceo, trustee — the
 * same audience as the Reports module; statutory-style reports are board
 * material, not submitter material.
 *
 * Requires the custom connection to hold the accounting.reports.read scope.
 * A 403 from Xero is translated into an actionable message that says so.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole } from '../_shared/auth.ts'
import { xeroFetch } from '../_shared/xero.ts'

const REPORTS = {
  ProfitAndLoss: 'Reports/ProfitAndLoss',
  BalanceSheet: 'Reports/BalanceSheet',
} as const

type ReportName = keyof typeof REPORTS

interface ReportRequest {
  report?: string
  /** P&L: period start/end. YYYY-MM-DD. */
  fromDate?: string
  toDate?: string
  /** Balance sheet: as-at date. YYYY-MM-DD. */
  date?: string
  /** Comparative columns: 1–11 prior periods of the given timeframe. */
  periods?: number
  timeframe?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const TIMEFRAMES = new Set(['MONTH', 'QUARTER', 'YEAR'])

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (
    !callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo', 'trustee'])
  ) {
    return errorResponse('Not authorised', 403)
  }

  let body: ReportRequest
  try {
    body = (await req.json()) as ReportRequest
  } catch {
    return errorResponse('Request body must be JSON')
  }

  const report = body.report as ReportName | undefined
  if (!report || !(report in REPORTS)) {
    return errorResponse(`report must be one of: ${Object.keys(REPORTS).join(', ')}`)
  }

  const params: Record<string, string> = {}
  for (const key of ['fromDate', 'toDate', 'date'] as const) {
    const value = body[key]
    if (value === undefined) continue
    if (!ISO_DATE.test(value)) return errorResponse(`${key} must be YYYY-MM-DD`)
    params[key] = value
  }
  if (body.periods !== undefined) {
    const periods = Number(body.periods)
    if (!Number.isInteger(periods) || periods < 1 || periods > 11) {
      return errorResponse('periods must be an integer between 1 and 11')
    }
    params.periods = String(periods)
  }
  if (body.timeframe !== undefined) {
    const timeframe = String(body.timeframe).toUpperCase()
    if (!TIMEFRAMES.has(timeframe)) return errorResponse('timeframe must be MONTH, QUARTER or YEAR')
    params.timeframe = timeframe
  }
  params.standardLayout = 'true'

  try {
    const { data } = await xeroFetch<{ Reports?: unknown[] }>(REPORTS[report], { params })
    const first = data?.Reports?.[0]
    if (!first) return errorResponse('Xero returned no report', 502)
    return json({ report: first })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes('(403)')) {
      return errorResponse(
        'Xero refused the report (403). The custom connection needs the accounting.reports.read scope — tick it under developer.xero.com → your app → Configuration, then try again.',
        502,
      )
    }
    return errorResponse(`Could not fetch ${report} from Xero: ${message}`, 502)
  }
})
