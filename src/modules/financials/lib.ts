/**
 * Financials module — account transactions from the xero_transactions mirror,
 * plus Profit & Loss / Balance Sheet proxied live from Xero's Reports API
 * (the mirror deliberately holds no journal-level data, so statements come
 * straight from Xero via the xero-report edge function).
 */

import { supabase } from '@/lib/supabase'
import type { Fund, XeroAccount, XeroTransaction } from '@/types/db'

// ── Xero report shapes (Reports API) ─────────────────────────────────────────

export interface XeroReportCell {
  Value?: string
  Attributes?: Array<{ Value?: string; Id?: string }>
}

export interface XeroReportRow {
  RowType: 'Header' | 'Section' | 'Row' | 'SummaryRow'
  Title?: string
  Cells?: XeroReportCell[]
  Rows?: XeroReportRow[]
}

export interface XeroReport {
  ReportID?: string
  ReportName?: string
  ReportType?: string
  ReportTitles?: string[]
  ReportDate?: string
  UpdatedDateUTC?: string
  Rows?: XeroReportRow[]
}

export type ReportName = 'ProfitAndLoss' | 'BalanceSheet'

export interface ReportParams {
  fromDate?: string
  toDate?: string
  date?: string
  periods?: number
  timeframe?: 'MONTH' | 'QUARTER' | 'YEAR'
}

/**
 * Invoke the xero-report proxy. supabase-js wraps non-2xx responses in a
 * FunctionsHttpError whose message is just "non-2xx status code" — the
 * server's actual explanation lives in the response body, so dig it out.
 */
export async function fetchXeroReport(
  report: ReportName,
  params: ReportParams,
): Promise<XeroReport> {
  const { data, error } = await supabase.functions.invoke<{ report: XeroReport }>('xero-report', {
    body: { report, ...params },
  })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context) {
      try {
        const body = (await context.json()) as { error?: string }
        if (body?.error) throw new Error(body.error)
      } catch (e) {
        if (e instanceof Error && !e.message.includes('JSON')) throw e
      }
    }
    throw new Error(error.message)
  }
  if (!data?.report) throw new Error('Xero returned no report')
  return data.report
}

/** Xero serialises dates as `/Date(1712345678000+0000)/` — normalise to ISO. */
export function xeroDateToIso(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(value)
  if (m) return new Date(Number(m[1])).toISOString()
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// ── Date helpers (YYYY-MM-DD, local) ─────────────────────────────────────────

export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function today(): string {
  return isoDate(new Date())
}

export function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`
}

export function startOfMonth(): string {
  const now = new Date()
  return isoDate(new Date(now.getFullYear(), now.getMonth(), 1))
}

export function monthsAgoStart(months: number): string {
  const now = new Date()
  return isoDate(new Date(now.getFullYear(), now.getMonth() - months, 1))
}

export function endOfLastMonth(): string {
  const now = new Date()
  return isoDate(new Date(now.getFullYear(), now.getMonth(), 0))
}

export function endOfLastYear(): string {
  return `${new Date().getFullYear() - 1}-12-31`
}

// ── Account transactions (mirror) ────────────────────────────────────────────

export const TXN_PAGE_SIZE = 50

export interface TransactionFilters {
  search: string
  accountCode: string // '' = all
  sourceType: string // '' = all
  fundOptionId: string // '' = all (matches tracking_option_1_id)
  dateFrom: string // '' = open
  dateTo: string // '' = open
}

export const EMPTY_TXN_FILTERS: TransactionFilters = {
  search: '',
  accountCode: '',
  sourceType: '',
  fundOptionId: '',
  dateFrom: '',
  dateTo: '',
}

export interface TransactionPage {
  rows: XeroTransaction[]
  total: number
}

export async function fetchTransactions(
  filters: TransactionFilters,
  page: number,
): Promise<TransactionPage> {
  let query = supabase
    .from('xero_transactions')
    .select('*', { count: 'exact' })
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })

  if (filters.accountCode) query = query.eq('account_code', filters.accountCode)
  if (filters.sourceType) query = query.eq('source_type', filters.sourceType)
  if (filters.fundOptionId) query = query.eq('tracking_option_1_id', filters.fundOptionId)
  if (filters.dateFrom) query = query.gte('date', filters.dateFrom)
  if (filters.dateTo) query = query.lte('date', filters.dateTo)
  if (filters.search.trim()) {
    const term = filters.search.trim().replace(/[%_,()]/g, ' ')
    query = query.or(`description.ilike.%${term}%,contact_name.ilike.%${term}%`)
  }

  const from = page * TXN_PAGE_SIZE
  const { data, error, count } = await query.range(from, from + TXN_PAGE_SIZE - 1)
  if (error) throw new Error(error.message)
  return { rows: (data ?? []) as XeroTransaction[], total: count ?? 0 }
}

export async function fetchActiveAccounts(): Promise<XeroAccount[]> {
  const { data, error } = await supabase
    .from('xero_accounts')
    .select('*')
    .order('code', { ascending: true })
    .limit(1000)
  if (error) throw new Error(error.message)
  return (data ?? []) as XeroAccount[]
}

export async function fetchFundsForFilter(): Promise<Fund[]> {
  const { data, error } = await supabase
    .from('funds')
    .select('*')
    .not('tracking_option_id', 'is', null)
    .order('name', { ascending: true })
    .limit(1000)
  if (error) throw new Error(error.message)
  return (data ?? []) as Fund[]
}
