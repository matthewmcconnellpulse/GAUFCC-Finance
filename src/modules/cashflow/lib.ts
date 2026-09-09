/**
 * Cashflow forecast — data layer. Mirrors GAUFCC's weekly Excel template:
 * named income/outgoing lines down the side, weekly columns for the near term
 * rolling into monthly columns, every cell editable, balance rows cascading
 * from an opening balance. Amounts are stored AS TYPED in the template —
 * income positive, outgoings negative — so totals are plain sums.
 *
 * Xero feeds the grid two ways:
 * - read-only "actual cash in/out" comparison rows per period, computed from
 *   the mirrored bank lines (RECEIVE/SPEND gross);
 * - per-line fills: a line mapped to Xero account codes can pull the actual
 *   net cash on those codes for completed periods (note = 'xero').
 *
 * Module-owned: other modules should not import from here.
 */
import { supabase } from '@/lib/supabase'
import type { CashflowCell, CashflowConfig, CashflowLine } from '@/types/db'

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// ── Periods (weekly → monthly, like the template) ────────────────────────────

export interface CfPeriod {
  start: string // ISO date — the cell key
  endExclusive: string // ISO date, first day after the period
  label: string // 'W/C 02 Mar' or 'Jul 26'
  /** Axis-length label — '02 Mar', 'Jul 26'. Full label stays for tooltips. */
  shortLabel: string
  kind: 'week' | 'month'
  /** The period has finished: it is history, not forecast. */
  ended: boolean
  /** The week we are in right now — where the forecast starts from. */
  current: boolean
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fromIso(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return new Date()
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** The Monday of the week containing d. */
export function mondayOf(d: Date): Date {
  const out = new Date(d)
  const dow = (out.getDay() + 6) % 7 // Mon=0
  out.setDate(out.getDate() - dow)
  return out
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The grid's columns.
 *
 * The forecast follows the calendar rather than sitting where it was first
 * set up: `weekly_weeks` counts forward from the week we are in NOW, so the
 * current week is always the first forecast column and the horizon is always
 * the full 13 weeks (or whatever is configured) rather than shrinking away as
 * the weeks pass.
 *
 * Weeks between the opening date and today are still generated — they are the
 * history the balance cascades through, so the current week's brought-forward
 * figure is right — but they are marked `ended` and the grid folds them away
 * by default. `opening_date` therefore stays what it says it is: the date the
 * opening balance is stated at, an anchor of record, not a moving view.
 */
export function buildPeriods(
  config: Pick<CashflowConfig, 'opening_date' | 'weekly_weeks' | 'monthly_months'>,
  today: string = todayIso(),
): CfPeriod[] {
  const periods: CfPeriod[] = []
  const anchor = mondayOf(fromIso(config.opening_date))
  const thisWeek = mondayOf(fromIso(today))
  const currentStart = iso(thisWeek < anchor ? anchor : thisWeek)

  // History weeks (anchor → this week) plus weekly_weeks forward from now.
  let cursor = new Date(anchor)
  const week = (from: Date): { period: CfPeriod; end: Date } => {
    const end = new Date(from)
    end.setDate(end.getDate() + 7)
    const start = iso(from)
    return {
      period: {
        start,
        endExclusive: iso(end),
        label: `W/C ${String(from.getDate()).padStart(2, '0')} ${MONTHS_SHORT[from.getMonth()]}`,
        shortLabel: `${String(from.getDate()).padStart(2, '0')} ${MONTHS_SHORT[from.getMonth()]}`,
        kind: 'week',
        ended: iso(end) <= today,
        current: start === currentStart,
      },
      end,
    }
  }
  // Guard against a far-past opening date generating thousands of columns.
  const MAX_HISTORY_WEEKS = 260
  let guard = 0
  while (iso(cursor) < currentStart && guard < MAX_HISTORY_WEEKS) {
    const { period, end } = week(cursor)
    periods.push(period)
    cursor = end
    guard += 1
  }
  cursor = new Date(fromIso(currentStart))
  for (let i = 0; i < config.weekly_weeks; i++) {
    const { period, end } = week(cursor)
    periods.push(period)
    cursor = end
  }

  // Monthly columns pick up from the first day of the month AFTER the last
  // week ends (part-months are covered by the weekly columns).
  let month = new Date(cursor.getFullYear(), cursor.getMonth() + (cursor.getDate() > 1 ? 1 : 0), 1)
  for (let i = 0; i < config.monthly_months; i++) {
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1)
    periods.push({
      start: iso(month),
      endExclusive: iso(end),
      label: `${MONTHS_SHORT[month.getMonth()]} ${String(month.getFullYear()).slice(2)}`,
      shortLabel: `${MONTHS_SHORT[month.getMonth()]} ${String(month.getFullYear()).slice(2)}`,
      kind: 'month',
      ended: iso(end) <= today,
      current: false,
    })
    month = end
  }
  return periods
}

/** A period is 'past' once its last day is before today. */
export function periodEnded(p: CfPeriod, todayIso: string): boolean {
  return p.endExclusive <= todayIso
}

export function todayIso(): string {
  return iso(new Date())
}

export function defaultOpeningDate(): string {
  return iso(mondayOf(new Date()))
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function fetchConfig(): Promise<CashflowConfig | null> {
  const { data, error } = await supabase.from('cashflow_config').select('*').eq('key', 'default').maybeSingle()
  if (error) throw new Error(error.message)
  return (data as CashflowConfig | null) ?? null
}

export async function upsertConfig(
  patch: Partial<CashflowConfig> & Pick<CashflowConfig, 'opening_balance' | 'opening_date'>,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('cashflow_config')
    .upsert({ key: 'default', updated_by: userId, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'key' })
  if (error) throw new Error(error.message)
}

// ── Lines ────────────────────────────────────────────────────────────────────

export async function fetchLines(): Promise<CashflowLine[]> {
  const { data, error } = await supabase
    .from('cashflow_lines')
    .select('*')
    .eq('active', true)
    .order('section', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as CashflowLine[]
}

export async function insertLine(values: {
  section: 'income' | 'outgoing'
  name: string
  sort_order: number
}): Promise<CashflowLine> {
  const { data, error } = await supabase.from('cashflow_lines').insert(values).select().single()
  if (error) throw new Error(error.message)
  return data as CashflowLine
}

export async function updateLine(id: string, patch: Partial<CashflowLine>): Promise<void> {
  const { error } = await supabase.from('cashflow_lines').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Soft delete — cells stay behind for the audit trail. */
export async function deactivateLine(id: string): Promise<void> {
  const { error } = await supabase.from('cashflow_lines').update({ active: false }).eq('id', id)
  if (error) throw new Error(error.message)
}

/** The GAUFCC template's rows, for a one-click start. */
export const TEMPLATE_LINES: Array<{ section: 'income' | 'outgoing'; name: string }> = [
  { section: 'income', name: 'Annual meeting bookings' },
  { section: 'income', name: 'Annual meeting donations' },
  { section: 'income', name: 'Summer School fees' },
  { section: 'income', name: 'Associate membership' },
  { section: 'income', name: 'Grants receivable' },
  { section: 'income', name: 'Congregational quotas' },
  { section: 'income', name: 'Drawdown from Epworth Cash Plus' },
  { section: 'income', name: 'Rent and other income' },
  { section: 'income', name: 'Miscellaneous income' },
  { section: 'outgoing', name: 'Usual expense BACS runs' },
  { section: 'outgoing', name: 'Regular DD and SO payments' },
  { section: 'outgoing', name: 'Salaries' },
  { section: 'outgoing', name: 'HMRC PAYE / NI' },
  { section: 'outgoing', name: 'Pensions (incl. deficit payment)' },
  { section: 'outgoing', name: 'Summer School accommodation' },
  { section: 'outgoing', name: 'EC expenses' },
  { section: 'outgoing', name: 'Innovation Fund grants / projects' },
  { section: 'outgoing', name: 'Bank charges' },
  { section: 'outgoing', name: 'Other' },
]

export async function seedTemplateLines(): Promise<void> {
  const rows = TEMPLATE_LINES.map((l, i) => ({ ...l, sort_order: i }))
  const { error } = await supabase.from('cashflow_lines').insert(rows)
  if (error) throw new Error(error.message)
}

// ── Cells ────────────────────────────────────────────────────────────────────

export async function fetchCells(): Promise<CashflowCell[]> {
  const { data, error } = await supabase.from('cashflow_cells').select('*').limit(10000)
  if (error) throw new Error(error.message)
  return (data ?? []) as CashflowCell[]
}

export async function upsertCell(values: {
  line_id: string
  period_start: string
  amount: number
  note?: string | null
  updated_by: string
}): Promise<void> {
  const { error } = await supabase
    .from('cashflow_cells')
    .upsert(
      { ...values, note: values.note ?? null, updated_at: new Date().toISOString() },
      { onConflict: 'line_id,period_start' },
    )
  if (error) throw new Error(error.message)
}

export async function deleteCell(lineId: string, periodStart: string): Promise<void> {
  const { error } = await supabase
    .from('cashflow_cells')
    .delete()
    .eq('line_id', lineId)
    .eq('period_start', periodStart)
  if (error) throw new Error(error.message)
}

// ── Xero actuals ─────────────────────────────────────────────────────────────

export interface XeroCashActuals {
  /** period_start → total actual cash in (RECEIVE gross) */
  cashIn: Record<string, number>
  /** period_start → total actual cash out (SPEND gross, negative) */
  cashOut: Record<string, number>
  /** `${accountCode}|${period_start}` → signed net cash on that P&L code */
  byCode: Record<string, number>
}

/**
 * Actual cash movements per period from the mirrored bank lines. RECEIVE
 * lines are money in (positive), SPEND lines money out (stored positive in
 * the mirror — negated here). Line-level account codes let mapped forecast
 * lines pull their own actuals.
 */
export async function fetchXeroActuals(periods: CfPeriod[]): Promise<XeroCashActuals> {
  const result: XeroCashActuals = { cashIn: {}, cashOut: {}, byCode: {} }
  if (periods.length === 0) return result
  const first = periods[0].start
  const last = periods[periods.length - 1].endExclusive

  const CHUNK = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('xero_transactions')
      .select('date, gross, account_code, source_type')
      .in('source_type', ['RECEIVE', 'SPEND'])
      .gte('date', first)
      .lt('date', last)
      .order('date', { ascending: true })
      .range(offset, offset + CHUNK - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<{
      date: string
      gross: number
      account_code: string | null
      source_type: string
    }>

    for (const r of rows) {
      const period = periods.find((p) => r.date >= p.start && r.date < p.endExclusive)
      if (!period) continue
      const signed = r.source_type === 'RECEIVE' ? r.gross : -r.gross
      if (signed >= 0) result.cashIn[period.start] = round2((result.cashIn[period.start] ?? 0) + signed)
      else result.cashOut[period.start] = round2((result.cashOut[period.start] ?? 0) + signed)
      if (r.account_code) {
        const key = `${r.account_code}|${period.start}`
        result.byCode[key] = round2((result.byCode[key] ?? 0) + signed)
      }
    }
    if (rows.length < CHUNK) break
    offset += CHUNK
    if (offset >= 25000) break // hard cap — a year of cash lines is far smaller
  }
  return result
}

/** Sum a mapped line's actual for one period from the by-code index. */
export function lineActual(actuals: XeroCashActuals, codes: string[], periodStart: string): number {
  let total = 0
  for (const code of codes) total += actuals.byCode[`${code}|${periodStart}`] ?? 0
  return round2(total)
}

// ── Spreadsheet import (upload → parse-cashflow → preview → apply) ──────────

export interface ParsedCashflowCell {
  line_id: string
  period_start: string
  amount: number
  source_row?: string
  source_col?: string
}

export interface ParsedCashflow {
  cells: ParsedCashflowCell[]
  unmatched_rows: string[]
  unmatched_columns: string[]
  notes: string
  /** Cells the function refused because the id or date was not one it was given. */
  dropped: number
}

function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cashflow'
}

export const CASHFLOW_IMPORT_ACCEPT = '.xlsx,.xls,.xlsm,.csv,.tsv'

/** Extensions parse-cashflow can read. Checked before the upload, not after. */
export function isSupportedCashflowFile(name: string): boolean {
  return /\.(xlsx|xls|xlsm|csv|tsv|txt)$/i.test(name)
}

export async function uploadCashflowFile(file: File): Promise<string> {
  const path = `cashflow/${Date.now()}-${safeFileName(file.name)}`
  const { error } = await supabase.storage.from('imports').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(error.message)
  return path
}

/**
 * Write an accepted set of parsed cells. Chunked because a full 19-column
 * grid across 20 lines is 380 rows and PostgREST is happier in bites; the
 * note marks them 'import' so the grid can tint them like Xero fills.
 */
export async function applyParsedCells(
  cells: ParsedCashflowCell[],
  userId: string,
): Promise<void> {
  const CHUNK = 200
  for (let i = 0; i < cells.length; i += CHUNK) {
    const rows = cells.slice(i, i + CHUNK).map((c) => ({
      line_id: c.line_id,
      period_start: c.period_start,
      amount: c.amount,
      note: 'import',
      updated_by: userId,
      updated_at: new Date().toISOString(),
    }))
    const { error } = await supabase
      .from('cashflow_cells')
      .upsert(rows, { onConflict: 'line_id,period_start' })
    if (error) throw new Error(error.message)
  }
}

// ── Pack summary (the board pack's three-month forecast) ────────────────────

export interface PackForecastPeriod {
  label: string
  shortLabel: string
  kind: 'week' | 'month'
  income: number
  outgoings: number
  net: number
  balanceBf: number
  balanceCf: number
}

export interface PackForecast {
  /** Weeks and months from the current week out to the horizon. */
  periods: PackForecastPeriod[]
  openingBalance: number
  closingBalance: number
  totalIncome: number
  totalOutgoings: number
  net: number
  /** The first period the balance goes negative, if it does. */
  goesNegativeAt: string | null
  lowestBalance: number
  lowestAt: string | null
  /** Named lines with the largest outflow over the window. */
  topOutgoings: Array<{ name: string; total: number }>
  horizonLabel: string
}

/**
 * The forecast as a board pack wants it: from the week we are in, forward for
 * `weeks` weeks and `months` months, with the balance cascaded through the
 * completed weeks so the opening figure is the real position.
 *
 * Purpose-built for the reports module rather than exposing the whole grid —
 * a pack needs the shape of the next quarter, not 380 editable cells.
 */
export async function fetchPackForecast(opts?: {
  weeks?: number
  months?: number
}): Promise<PackForecast | null> {
  const config = await fetchConfig()
  if (!config) return null

  const [lines, cells] = await Promise.all([fetchLines(), fetchCells()])
  const all = buildPeriods(config)
  const byKey = new Map<string, number>()
  for (const c of cells) byKey.set(`${c.line_id}|${c.period_start}`, c.amount)

  const incomeLines = lines.filter((l) => l.section === 'income')
  const outgoingLines = lines.filter((l) => l.section === 'outgoing')
  const amountFor = (lineIds: string[], periodStart: string): number =>
    round2(lineIds.reduce((s, id) => s + (byKey.get(`${id}|${periodStart}`) ?? 0), 0))

  // Cascade from the anchor so the first shown period's b/fwd is right.
  let running = config.opening_balance
  const cascaded = all.map((per) => {
    const income = amountFor(
      incomeLines.map((l) => l.id),
      per.start,
    )
    const outgoings = amountFor(
      outgoingLines.map((l) => l.id),
      per.start,
    )
    const net = round2(income + outgoings)
    const balanceBf = round2(running)
    running = round2(running + net)
    return { per, income, outgoings, net, balanceBf, balanceCf: running }
  })

  // The window: the current week onwards, trimmed to the requested horizon.
  const wanted = { weeks: opts?.weeks ?? 13, months: opts?.months ?? 3 }
  const forward = cascaded.filter((row) => !row.per.ended)
  const weeks = forward.filter((row) => row.per.kind === 'week').slice(0, wanted.weeks)
  const months = forward.filter((row) => row.per.kind === 'month').slice(0, wanted.months)
  const window = [...weeks, ...months]
  if (window.length === 0) return null

  const periods: PackForecastPeriod[] = window.map((row) => ({
    label: row.per.label,
    shortLabel: row.per.shortLabel,
    kind: row.per.kind,
    income: row.income,
    outgoings: row.outgoings,
    net: row.net,
    balanceBf: row.balanceBf,
    balanceCf: row.balanceCf,
  }))

  const negativeIndex = periods.findIndex((p) => p.balanceCf < 0)
  let lowestAt: string | null = null
  let lowestBalance = periods[0].balanceCf
  for (const p of periods) {
    if (p.balanceCf <= lowestBalance) {
      lowestBalance = p.balanceCf
      lowestAt = p.label
    }
  }

  const windowStarts = new Set(window.map((row) => row.per.start))
  const topOutgoings = outgoingLines
    .map((l) => ({
      name: l.name,
      total: round2(
        [...windowStarts].reduce((s, start) => s + (byKey.get(`${l.id}|${start}`) ?? 0), 0),
      ),
    }))
    .filter((l) => l.total !== 0)
    .sort((a, b) => a.total - b.total)
    .slice(0, 6)

  const monthCount = months.length
  const weekCount = weeks.length
  return {
    periods,
    openingBalance: periods[0].balanceBf,
    closingBalance: periods[periods.length - 1].balanceCf,
    totalIncome: round2(periods.reduce((s, p) => s + p.income, 0)),
    totalOutgoings: round2(periods.reduce((s, p) => s + p.outgoings, 0)),
    net: round2(periods.reduce((s, p) => s + p.net, 0)),
    goesNegativeAt: negativeIndex === -1 ? null : periods[negativeIndex].label,
    lowestBalance,
    lowestAt,
    topOutgoings,
    horizonLabel: [
      weekCount > 0 ? `${weekCount} week${weekCount === 1 ? '' : 's'}` : '',
      monthCount > 0 ? `${monthCount} month${monthCount === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' then '),
  }
}

// ── CSV export (mirrors the template layout) ─────────────────────────────────

function csvField(value: string | number): string {
  const s = typeof value === 'number' ? value.toFixed(2) : value
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function buildForecastCsv(opts: {
  periods: CfPeriod[]
  incomeLines: Array<{ name: string; values: number[] }>
  outgoingLines: Array<{ name: string; values: number[] }>
  totalIncome: number[]
  totalOutgoings: number[]
  netMovement: number[]
  balanceBf: number[]
  balanceCf: number[]
}): string {
  const rows: string[][] = []
  rows.push(['GAUFCC — Cashflow forecast'])
  rows.push(['Week commencing / Month', ...opts.periods.map((p) => p.label)])
  rows.push(['INCOME'])
  for (const l of opts.incomeLines) rows.push([l.name, ...l.values.map((v) => (v === 0 ? '' : v.toFixed(2)))])
  rows.push(['Total income', ...opts.totalIncome.map((v) => v.toFixed(2))])
  rows.push(['OUTGOINGS'])
  for (const l of opts.outgoingLines) rows.push([l.name, ...l.values.map((v) => (v === 0 ? '' : v.toFixed(2)))])
  rows.push(['Total outgoings', ...opts.totalOutgoings.map((v) => v.toFixed(2))])
  rows.push(['Net movement', ...opts.netMovement.map((v) => v.toFixed(2))])
  rows.push(['Balance b/fwd', ...opts.balanceBf.map((v) => v.toFixed(2))])
  rows.push(['Balance c/fwd', ...opts.balanceCf.map((v) => v.toFixed(2))])
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}
