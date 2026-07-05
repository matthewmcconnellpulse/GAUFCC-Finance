/**
 * VAT module data layer — vat_periods CRUD plus the deterministic "pull
 * candidates from Xero" heuristics. Module-owned; the calculation itself
 * lives in vatCalc.ts.
 */
import { supabase } from '@/lib/supabase'
import type { VatPeriod, XeroTransaction } from '@/types/db'
import { periodSortKey, round2, type VatCalcInput } from './vatCalc'

// ── vat_periods CRUD ─────────────────────────────────────────────────────────

export async function fetchVatPeriods(): Promise<VatPeriod[]> {
  const { data, error } = await supabase.from('vat_periods').select('*')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as VatPeriod[]
  return rows.sort((a, b) => periodSortKey(a.period) - periodSortKey(b.period))
}

export interface VatPeriodDraft {
  period: string
  taxable_supplies: number
  exempt_supplies: number
  residual_input_vat: number
  directly_attributable: { taxable: number; exempt: number }
  de_minimis_result: unknown
  narrative?: string | null
}

export async function insertVatPeriod(draft: VatPeriodDraft): Promise<VatPeriod> {
  const { data, error } = await supabase.from('vat_periods').insert(draft).select().single()
  if (error) throw new Error(error.message)
  return data as VatPeriod
}

export async function updateVatPeriod(id: string, patch: Partial<VatPeriodDraft>): Promise<VatPeriod> {
  const { data, error } = await supabase.from('vat_periods').update(patch).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return data as VatPeriod
}

export async function deleteVatPeriod(id: string): Promise<void> {
  const { error } = await supabase.from('vat_periods').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** VatPeriod row → calculation input (months derived from the period string). */
export function inputFromPeriod(p: VatPeriod, months: number): VatCalcInput {
  return {
    taxable_supplies: p.taxable_supplies,
    exempt_supplies: p.exempt_supplies,
    directly_attributable: {
      taxable: p.directly_attributable?.taxable ?? 0,
      exempt: p.directly_attributable?.exempt ?? 0,
    },
    residual_input_vat: p.residual_input_vat,
    months,
  }
}

// ── Xero candidate figures ───────────────────────────────────────────────────
// Deterministic heuristics over the transaction mirror — NOT the answer, just
// a prefill the bookkeeper confirms or edits:
//   · income candidate  = Σ net on income-side lines (ACCREC invoices + bank
//     receipts) → suggested as taxable supplies; the split between taxable and
//     exempt supplies is a judgement Xero cannot make.
//   · input VAT candidate = Σ vat on purchase-side lines (ACCPAY bills + bank
//     spend) → suggested as residual input VAT with nothing directly
//     attributed, because attribution is also a judgement call.

export interface XeroCandidates {
  income_total: number
  income_lines: number
  input_vat_total: number
  expense_lines: number
  start: string
  end: string
}

type TxnSlice = Pick<XeroTransaction, 'source_type' | 'net' | 'vat'>

const INCOME_SOURCES = new Set(['ACCREC', 'RECEIVE'])
const EXPENSE_SOURCES = new Set(['ACCPAY', 'SPEND'])

/** Page through xero_transactions for a date range (PostgREST caps at 1,000 rows). */
async function fetchTxnSlices(start: string, end: string): Promise<TxnSlice[]> {
  const pageSize = 1000
  const out: TxnSlice[] = []
  for (let page = 0; page < 40; page += 1) {
    const { data, error } = await supabase
      .from('xero_transactions')
      .select('source_type, net, vat')
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as TxnSlice[]
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

export async function pullXeroCandidates(start: string, end: string): Promise<XeroCandidates> {
  const txns = await fetchTxnSlices(start, end)
  let incomeTotal = 0
  let incomeLines = 0
  let inputVatTotal = 0
  let expenseLines = 0
  for (const t of txns) {
    if (INCOME_SOURCES.has(t.source_type)) {
      incomeTotal += Math.abs(t.net)
      incomeLines += 1
    } else if (EXPENSE_SOURCES.has(t.source_type)) {
      inputVatTotal += Math.abs(t.vat)
      expenseLines += 1
    }
  }
  return {
    income_total: round2(incomeTotal),
    income_lines: incomeLines,
    input_vat_total: round2(inputVatTotal),
    expense_lines: expenseLines,
    start,
    end,
  }
}

// ── Rolling 12-month taxable turnover (registration threshold monitor) ───────

export interface TurnoverMonth {
  month: string // 'YYYY-MM'
  income: number
}

export interface RollingTurnover {
  total: number
  months: TurnoverMonth[] // oldest → newest, 12 entries
}

/**
 * Rolling 12-month income from the Xero mirror, grouped by month. Returns
 * null when the mirror has no income lines in the window — the UI then falls
 * back to a manual figure. All income is treated as taxable turnover, which
 * overstates it if some is exempt — a safe direction for threshold watching.
 */
export async function fetchRollingTurnover(today = new Date()): Promise<RollingTurnover | null> {
  const startDate = new Date(today.getFullYear() - 1, today.getMonth(), 1)
  const start = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-01`
  const end = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const pageSize = 1000
  const byMonth = new Map<string, number>()
  let sawIncome = false
  for (let page = 0; page < 40; page += 1) {
    const { data, error } = await supabase
      .from('xero_transactions')
      .select('source_type, net, date')
      .gte('date', start)
      .lte('date', end)
      .in('source_type', ['ACCREC', 'RECEIVE'])
      .order('date', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<Pick<XeroTransaction, 'source_type' | 'net' | 'date'>>
    for (const r of rows) {
      sawIncome = true
      const key = r.date.slice(0, 7)
      byMonth.set(key, (byMonth.get(key) ?? 0) + Math.abs(r.net))
    }
    if (rows.length < pageSize) break
  }
  if (!sawIncome) return null

  const months: TurnoverMonth[] = []
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    months.push({ month: key, income: round2(byMonth.get(key) ?? 0) })
  }
  return { total: round2(months.reduce((s, m) => s + m.income, 0)), months }
}
