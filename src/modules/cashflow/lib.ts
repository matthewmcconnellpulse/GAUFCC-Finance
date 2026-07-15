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
  kind: 'week' | 'month'
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

export function buildPeriods(config: Pick<CashflowConfig, 'opening_date' | 'weekly_weeks' | 'monthly_months'>): CfPeriod[] {
  const periods: CfPeriod[] = []
  const start = mondayOf(fromIso(config.opening_date))
  let cursor = new Date(start)
  for (let i = 0; i < config.weekly_weeks; i++) {
    const end = new Date(cursor)
    end.setDate(end.getDate() + 7)
    periods.push({
      start: iso(cursor),
      endExclusive: iso(end),
      label: `W/C ${String(cursor.getDate()).padStart(2, '0')} ${MONTHS_SHORT[cursor.getMonth()]}`,
      kind: 'week',
    })
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
      kind: 'month',
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
  rows.push(['Week beginning / Month', ...opts.periods.map((p) => p.label)])
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
