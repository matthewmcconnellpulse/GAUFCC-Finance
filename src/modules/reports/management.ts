/**
 * Whole-charity management reporting for the board pack — the general reports
 * that sit above the individual fund pages.
 *
 * Where each figure comes from, and why:
 *
 * - Profit and loss: computed from the transaction mirror on SORP headings.
 *   The mirror is complete for revenue and expenditure, so this is exact, and
 *   presenting it as a SOFA rather than replaying Xero's trading layout keeps
 *   gross profit and its margin off a charity's board pack entirely.
 * - Balance sheet: read live from Xero. The mirror holds no journal-level data
 *   and cannot produce a complete balance sheet, so it is rendered as Xero
 *   gives it rather than re-derived.
 * - Receivables and payables: read live from Xero via xero-aged. Nothing in the
 *   mirror distinguishes settled from outstanding.
 * - Budget: read live from Xero via xero-budgets, which needs the
 *   accounting.budgets.read scope on the connection.
 * - Reserve coverage: (general funds + cash at bank) ÷ annual operating
 *   budget. The denominator comes from the tracked budget if there is one, and
 *   otherwise from a figure typed in Settings. With neither, coverage reports
 *   as unavailable rather than guessing — a coverage ratio on a made-up
 *   denominator is worse than no ratio.
 */

import { invokeFunction, supabase } from '@/lib/supabase'
import { SETTING_KEYS, type Setting } from '@/types/db'
import {
  CASH_ALIASES,
  PAYABLES_ALIASES,
  RECEIVABLES_ALIASES,
  TOTAL_ASSETS_ALIASES,
  TOTAL_LIABILITIES_ALIASES,
  NET_ASSETS_ALIASES,
  figureByAlias,
  round2,
} from '@/modules/recon/lib'
import type { ReportModel } from './lib'

// ── Aged receivables and payables ───────────────────────────────────────────

export type AgedBucketKey = 'current' | 'days_1_30' | 'days_31_60' | 'days_61_90' | 'days_90_plus'

export interface AgedInvoice {
  invoice_id: string
  number: string | null
  reference: string | null
  contact: string
  date: string | null
  due_date: string | null
  amount_due: number
  days_overdue: number
  bucket: AgedBucketKey
}

export interface AgedContact {
  name: string
  total: number
  invoice_count: number
  buckets: Record<AgedBucketKey, number>
  oldest_days: number
}

export interface AgedSide {
  total: number
  buckets: Record<AgedBucketKey, number>
  contacts: AgedContact[]
  invoices: AgedInvoice[]
  invoice_count: number
  contact_count: number
  oldest_days: number
}

export interface AgedAnalysis {
  as_at: string
  buckets: Array<{ key: AgedBucketKey; label: string }>
  receivables: AgedSide
  payables: AgedSide
}

export async function fetchAgedAnalysis(asAt: string): Promise<AgedAnalysis> {
  return invokeFunction<AgedAnalysis>('xero-aged', { as_at: asAt })
}

// ── Budgets ─────────────────────────────────────────────────────────────────

export interface BudgetSummary {
  budget_id: string
  type: string | null
  description: string
  updated: string | null
}

export interface BudgetList {
  budgets: BudgetSummary[]
  /** False when Xero refused for want of the accounting.budgets.read scope. */
  scope_ok: boolean
  error?: string
}

export interface BudgetAccount {
  code: string
  name: string
  months: Record<string, number>
  total: number
}

export interface BudgetDetail {
  budget_id: string
  type: string | null
  description: string
  from: string | null
  to: string | null
  months: string[]
  accounts: BudgetAccount[]
  total: number
}

export async function fetchBudgetList(): Promise<BudgetList> {
  return invokeFunction<BudgetList>('xero-budgets', {})
}

export async function fetchBudgetDetail(
  budgetId: string,
  range?: { from?: string; to?: string },
): Promise<BudgetDetail> {
  return invokeFunction<BudgetDetail>('xero-budgets', {
    budget_id: budgetId,
    ...(range?.from ? { from: range.from } : {}),
    ...(range?.to ? { to: range.to } : {}),
  })
}

// ── Budget vs actual ────────────────────────────────────────────────────────

export interface BudgetVarianceRow {
  code: string
  name: string
  actual: number
  budget: number
  /** actual − budget, in the account's natural direction. */
  variance: number
  /** Variance as a percentage of budget; null where the budget is nil. */
  variancePct: number | null
  priorBudget: number | null
}

export interface BudgetComparison {
  rows: BudgetVarianceRow[]
  actualTotal: number
  budgetTotal: number
  priorBudgetTotal: number | null
  variance: number
  /** Accounts with actuals but no budget line — a budget gap, not a variance. */
  unbudgeted: string[]
}

/**
 * Actual against budget by account.
 *
 * Xero budgets are signed the way the P&L is, so revenue and expenditure both
 * compare directly against the mirror's account-natural figures. Accounts with
 * an actual but no budget line are reported separately: those are a hole in
 * the budget, and folding them in as a 100% adverse variance would misdescribe
 * them.
 */
export function compareToBudget(
  actualByCode: Map<string, { name: string; amount: number }>,
  budget: BudgetDetail | null,
  priorBudget: BudgetDetail | null,
): BudgetComparison {
  const budgetByCode = new Map((budget?.accounts ?? []).map((a) => [a.code, a]))
  const priorByCode = new Map((priorBudget?.accounts ?? []).map((a) => [a.code, a]))
  const codes = new Set<string>([...actualByCode.keys(), ...budgetByCode.keys()])

  const rows: BudgetVarianceRow[] = []
  const unbudgeted: string[] = []
  for (const code of codes) {
    const actual = round2(actualByCode.get(code)?.amount ?? 0)
    const budgetAmount = round2(budgetByCode.get(code)?.total ?? 0)
    const prior = priorByCode.get(code)
    if (actual !== 0 && budgetAmount === 0) {
      unbudgeted.push(actualByCode.get(code)?.name ?? code)
    }
    if (actual === 0 && budgetAmount === 0) continue
    rows.push({
      code,
      name: actualByCode.get(code)?.name ?? budgetByCode.get(code)?.name ?? code,
      actual,
      budget: budgetAmount,
      variance: round2(actual - budgetAmount),
      variancePct: budgetAmount === 0 ? null : round2(((actual - budgetAmount) / Math.abs(budgetAmount)) * 100),
      priorBudget: prior ? round2(prior.total) : null,
    })
  }

  rows.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
  const actualTotal = round2(rows.reduce((s, r) => s + r.actual, 0))
  const budgetTotal = round2(rows.reduce((s, r) => s + r.budget, 0))
  const priorRows = rows.filter((r) => r.priorBudget !== null)
  return {
    rows,
    actualTotal,
    budgetTotal,
    priorBudgetTotal: priorRows.length > 0 ? round2(priorRows.reduce((s, r) => s + (r.priorBudget ?? 0), 0)) : null,
    variance: round2(actualTotal - budgetTotal),
    unbudgeted: unbudgeted.sort(),
  }
}

/**
 * The annual operating budget implied by a Xero budget: a full financial
 * year's budgeted expenditure.
 *
 * Only EXPENSE-class accounts count — the denominator of reserve coverage is
 * what it costs to run the charity for a year, not the net of budgeted income
 * and cost. Returns null when the budget carries no expenditure lines, so the
 * caller falls back to the figure recorded on the platform rather than
 * dividing by something meaningless.
 */
export async function annualOperatingBudgetFromXero(
  budgetId: string,
  financialYear: { start: string; end: string },
): Promise<number | null> {
  const [detail, accountRows] = await Promise.all([
    fetchBudgetDetail(budgetId, { from: financialYear.start, to: financialYear.end }),
    supabase.from('xero_accounts').select('code, class').eq('class', 'EXPENSE').limit(1000),
  ])
  if (accountRows.error) throw new Error(accountRows.error.message)
  const expenseCodes = new Set(
    ((accountRows.data ?? []) as Array<{ code: string | null }>)
      .map((a) => a.code)
      .filter((c): c is string => !!c),
  )
  const total = detail.accounts
    .filter((a) => expenseCodes.has(a.code))
    .reduce((s, a) => s + Math.abs(a.total), 0)
  return total > 0 ? round2(total) : null
}

// ── Reserve coverage ────────────────────────────────────────────────────────

export interface ReserveCoverage {
  /** Unrestricted general funds — the free reserves half of the numerator. */
  generalFunds: number
  /** Cash at bank per the balance sheet; null when it could not be read. */
  cashAtBank: number | null
  numerator: number | null
  /** Annual operating budget — the denominator. */
  annualBudget: number | null
  /** Where the denominator came from, for the footnote. */
  budgetSource: 'xero_budget' | 'setting' | null
  /** Coverage as a multiple of annual operating cost. */
  months: number | null
  ratio: number | null
  /** Why it could not be computed, when it could not. */
  unavailableReason: string | null
}

export function buildReserveCoverage(input: {
  model: ReportModel
  balanceSheet: Map<string, number> | null
  balanceSheetError: string | null
  annualBudget: number | null
  budgetSource: 'xero_budget' | 'setting' | null
}): ReserveCoverage {
  // "General fund" in the client's formula means unrestricted general funds —
  // designated funds are unrestricted but earmarked by the Board, and
  // endowment and restricted funds cannot be spent on running costs at all.
  const generalFunds = round2(
    input.model.rows.filter((r) => r.fund_type === 'general').reduce((s, r) => s + r.closing, 0),
  )
  const cashAtBank = input.balanceSheet ? figureByAlias(input.balanceSheet, CASH_ALIASES) : null

  let unavailableReason: string | null = null
  if (cashAtBank === null) {
    unavailableReason = input.balanceSheetError
      ? `Cash at bank could not be read from Xero — ${input.balanceSheetError}`
      : 'No cash at bank line could be identified on Xero’s balance sheet.'
  } else if (input.annualBudget === null || input.annualBudget <= 0) {
    unavailableReason =
      'No annual operating budget is set. Enter one under Settings, or choose a Xero budget to track once the figures are in Xero.'
  }

  const numerator = cashAtBank === null ? null : round2(generalFunds + cashAtBank)
  const ratio =
    numerator === null || !input.annualBudget || input.annualBudget <= 0
      ? null
      : round2(numerator / input.annualBudget)

  return {
    generalFunds,
    cashAtBank,
    numerator,
    annualBudget: input.annualBudget,
    budgetSource: input.budgetSource,
    ratio,
    months: ratio === null ? null : round2(ratio * 12),
    unavailableReason,
  }
}

// ── Balance sheet headline figures ──────────────────────────────────────────

export interface BalanceSheetHeadlines {
  totalAssets: number | null
  totalLiabilities: number | null
  netAssets: number | null
  receivables: number | null
  payables: number | null
  cashAtBank: number | null
}

export function balanceSheetHeadlines(index: Map<string, number> | null): BalanceSheetHeadlines {
  if (!index) {
    return {
      totalAssets: null,
      totalLiabilities: null,
      netAssets: null,
      receivables: null,
      payables: null,
      cashAtBank: null,
    }
  }
  return {
    totalAssets: figureByAlias(index, TOTAL_ASSETS_ALIASES),
    totalLiabilities: figureByAlias(index, TOTAL_LIABILITIES_ALIASES),
    netAssets: figureByAlias(index, NET_ASSETS_ALIASES),
    receivables: figureByAlias(index, RECEIVABLES_ALIASES),
    payables: figureByAlias(index, PAYABLES_ALIASES),
    cashAtBank: figureByAlias(index, CASH_ALIASES),
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface ManagementSettings {
  annualOperatingBudget: number | null
  xeroBudgetId: string | null
  xeroPriorBudgetId: string | null
}

export async function fetchManagementSettings(): Promise<ManagementSettings> {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [
      SETTING_KEYS.annualOperatingBudget,
      SETTING_KEYS.xeroBudgetId,
      SETTING_KEYS.xeroPriorBudgetId,
    ])
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<Pick<Setting, 'key' | 'value'>>
  const raw = (key: string): unknown => rows.find((r) => r.key === key)?.value
  const asNumber = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? round2(n) : null
  }
  const asString = (value: unknown): string | null => {
    const s = typeof value === 'string' ? value.trim() : ''
    return s || null
  }
  return {
    annualOperatingBudget: asNumber(raw(SETTING_KEYS.annualOperatingBudget)),
    xeroBudgetId: asString(raw(SETTING_KEYS.xeroBudgetId)),
    xeroPriorBudgetId: asString(raw(SETTING_KEYS.xeroPriorBudgetId)),
  }
}
