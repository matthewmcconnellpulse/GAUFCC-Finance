/**
 * The data behind the Excel export: 24 months of ledger, shaped for a
 * spreadsheet rather than for a page.
 *
 * Everything on one read. The whole window is about five thousand ledger
 * lines, which is nothing to hold in memory and saves asking the database the
 * same question five different ways — the profit and loss, the fund movement,
 * the transaction list and the coding gaps are all projections of the same
 * set of lines, and deriving them together is what guarantees they agree with
 * each other. A reader who finds the sheets disagreeing stops trusting the
 * whole workbook, so this is worth more than the round trips it costs.
 *
 * The trial balance is the exception and is NOT here: it needs opening
 * balances for every balance-sheet account, which the mirror does not hold —
 * it holds the movements it has mirrored, not the position they started from.
 * That has to come from Xero's own TrialBalance report.
 */
import { supabase } from '@/lib/supabase'
import type { FundType } from '@/types/db'
import { latestDataMonth, type ActivityMonth } from './lib'

/** PostgREST serves at most 1,000 rows; the cap below is a runaway guard. */
const CHUNK = 1000
const CAP = 60000

export interface ExportWindow {
  start: string
  end: string
  /** 'YYYY-MM' keys, oldest first — the month columns of every wide sheet. */
  months: string[]
  label: string
}

export interface LedgerLine {
  date: string
  source_type: string
  status: string | null
  account_code: string | null
  contact_name: string | null
  description: string | null
  net: number
  vat: number
  gross: number
  tracking_option_1_id: string | null
  tracking_option_2_id: string | null
  xero_id: string
  line_id: string
  updated_date_utc: string | null
}

export interface AccountRow {
  code: string
  name: string
  type: string | null
  class: string | null
  reporting_code: string | null
}

export interface FundRow {
  id: string
  name: string
  fund_type: FundType
  tracking_option_id: string | null
  opening_balance: number
  opening_balance_date: string | null
  active: boolean
}

export interface ExportDataset {
  window: ExportWindow
  lines: LedgerLine[]
  accounts: Map<string, AccountRow>
  funds: FundRow[]
  /** tracking option id → fund. */
  fundByOption: Map<string, FundRow>
  truncated: boolean
}

// ── The window ───────────────────────────────────────────────────────────────

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The 24 months ending at the last month the ledger is really reporting on.
 *
 * Anchored on the ledger rather than on today for the same reason the report
 * builder is: today is 13 October and October holds a fortnight of postings,
 * so a window ending "this month" would put a stub month on the end of every
 * comparison. It also keeps the workbook lined up with what the person sees
 * on screen, which matters when they are reconciling one against the other.
 */
export function exportWindow(activity: ActivityMonth[], today = new Date()): ExportWindow {
  const latest = latestDataMonth(activity, today)
  const anchor = latest
    ? new Date(Number(latest.month.slice(0, 4)), Number(latest.month.slice(5, 7)) - 1, 1)
    : new Date(today.getFullYear(), today.getMonth() - 1, 1)

  const months: string[] = []
  for (let i = 23; i >= 0; i--) {
    months.push(monthKey(new Date(anchor.getFullYear(), anchor.getMonth() - i, 1)))
  }
  const start = new Date(anchor.getFullYear(), anchor.getMonth() - 23, 1)
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  return {
    start: iso(start),
    end: iso(end),
    months,
    label: `${months[0]} to ${months[months.length - 1]}`,
  }
}

// ── The read ─────────────────────────────────────────────────────────────────

export async function fetchActivityForWindow(): Promise<ActivityMonth[]> {
  const { data, error } = await supabase.rpc('ledger_activity_months')
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ month: string; line_count: number }>).map((r) => ({
    month: r.month,
    lineCount: Number(r.line_count) || 0,
  }))
}

async function fetchAccounts(): Promise<Map<string, AccountRow>> {
  const out = new Map<string, AccountRow>()
  for (let offset = 0; offset < CAP; offset += CHUNK) {
    const { data, error } = await supabase
      .from('xero_accounts')
      .select('code, name, type, class, reporting_code')
      .not('code', 'is', null)
      .order('code')
      .range(offset, offset + CHUNK - 1)
    if (error) throw new Error(`Accounts could not be read: ${error.message}`)
    const batch = (data ?? []) as AccountRow[]
    for (const a of batch) out.set(a.code, a)
    if (batch.length < CHUNK) break
  }
  return out
}

async function fetchFunds(): Promise<FundRow[]> {
  const { data, error } = await supabase
    .from('funds')
    .select('id, name, fund_type, tracking_option_id, opening_balance, opening_balance_date, active')
    .order('name')
    .limit(CHUNK)
  if (error) throw new Error(`Funds could not be read: ${error.message}`)
  return (data ?? []) as FundRow[]
}

async function fetchLines(window: ExportWindow): Promise<{ lines: LedgerLine[]; truncated: boolean }> {
  const lines: LedgerLine[] = []
  let truncated = false
  for (let offset = 0; offset < CAP; offset += CHUNK) {
    const { data, error } = await supabase
      .from('xero_transactions')
      .select(
        'date, source_type, status, account_code, contact_name, description, net, vat, gross, tracking_option_1_id, tracking_option_2_id, xero_id, line_id, updated_date_utc',
      )
      .gte('date', window.start)
      .lte('date', window.end)
      .order('date')
      .order('line_id')
      .range(offset, offset + CHUNK - 1)
    if (error) throw new Error(`Ledger lines could not be read: ${error.message}`)
    const batch = (data ?? []) as LedgerLine[]
    lines.push(...batch)
    if (batch.length < CHUNK) break
    if (offset + CHUNK >= CAP) truncated = true
  }
  // Voided and deleted documents are cleared by the sync, but a mirror that
  // has not re-synced since a void could still hold them — and a workbook
  // built for reconciliation must not disagree with the reports on screen,
  // which exclude them.
  const live = lines.filter((l) => {
    const s = (l.status ?? '').toUpperCase()
    return s !== 'VOIDED' && s !== 'DELETED'
  })
  return { lines: live, truncated }
}

export async function fetchExportDataset(today = new Date()): Promise<ExportDataset> {
  const activity = await fetchActivityForWindow()
  const window = exportWindow(activity, today)
  const [accounts, funds, lineResult] = await Promise.all([
    fetchAccounts(),
    fetchFunds(),
    fetchLines(window),
  ])
  const fundByOption = new Map<string, FundRow>()
  for (const f of funds) if (f.tracking_option_id) fundByOption.set(f.tracking_option_id, f)
  return {
    window,
    lines: lineResult.lines,
    accounts,
    funds,
    fundByOption,
    truncated: lineResult.truncated,
  }
}

// ── Derivations ──────────────────────────────────────────────────────────────

export const NO_FUND = '(no fund tagged)'

/**
 * Income-positive, expenditure-negative — the sign a reader expects when they
 * sum a column and want the surplus for the month.
 *
 * The mirror stores account-natural (a plus is a credit on a credit-natural
 * account and a debit on a debit-natural one), so REVENUE passes through and
 * EXPENSE flips. Both conventions appear as named columns in the long sheets
 * rather than one being chosen silently, because every argument about a
 * finance export is ultimately about which way a number points.
 */
export function incomePositive(net: number, accountClass: string | null): number {
  return accountClass === 'REVENUE' ? net : -net
}

/** Debit-positive, the trial-balance convention: asset/expense +, the rest −. */
export function debitPositive(net: number, accountClass: string | null): number {
  const credit = accountClass === 'REVENUE' || accountClass === 'LIABILITY' || accountClass === 'EQUITY'
  return credit ? -net : net
}

export function isPl(accountClass: string | null): boolean {
  return accountClass === 'REVENUE' || accountClass === 'EXPENSE'
}

export interface MonthlyCell {
  amount: number
  lineCount: number
}

/** key → month key → amount, for any grouping of the lines. */
export function groupByMonth<T>(
  lines: LedgerLine[],
  keyOf: (line: LedgerLine) => T | null,
  amountOf: (line: LedgerLine) => number,
): Map<T, Map<string, MonthlyCell>> {
  const out = new Map<T, Map<string, MonthlyCell>>()
  for (const line of lines) {
    const key = keyOf(line)
    if (key === null) continue
    const month = line.date.slice(0, 7)
    let byMonth = out.get(key)
    if (!byMonth) {
      byMonth = new Map()
      out.set(key, byMonth)
    }
    const cell = byMonth.get(month) ?? { amount: 0, lineCount: 0 }
    cell.amount += amountOf(line)
    cell.lineCount += 1
    byMonth.set(month, cell)
  }
  return out
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
