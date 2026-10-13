/**
 * The two parts of the export that cannot come from the ledger mirror.
 *
 * Trial balance: the mirror holds the movements it has mirrored, not the
 * opening positions behind them, so a trial balance built from it would not
 * prove. Xero's own TrialBalance report is read instead — one call per month
 * end, because unlike the profit and loss and balance sheet reports it takes
 * no periods/timeframe. Twenty-four calls is why the export asks first.
 *
 * Budgets: Xero's Budgets API, which needs a scope the connection does not
 * have today. Both report what went wrong rather than coming back empty — a
 * blank sheet in a finance export reads as "there is nothing", which is a
 * different and much worse statement than "this could not be read".
 */
import { fetchXeroReport, type XeroReport, type XeroReportRow } from '@/modules/financials/lib'
import { supabase } from '@/lib/supabase'
import type { BudgetLine, TrialBalanceMonth, TrialBalanceRow } from './exportSheets'
import type { ExportWindow } from './exportData'

/** Xero writes figures as '1,234.56' or '(1,234.56)' for a negative. */
function parseFigure(value: string | undefined): number {
  if (!value) return 0
  let s = value.trim().replace(/[£,\s]/g, '').replace(/−/g, '-')
  if (!s) return 0
  let sign = 1
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1
    s = s.slice(1, -1)
  }
  const n = Number(s)
  return Number.isFinite(n) ? sign * n : 0
}

/**
 * Pull the account rows out of a TrialBalance report.
 *
 * The report's columns are Account, Debit, Credit, YTD Debit, YTD Credit. The
 * account's own code is not a column — it arrives as an Attribute on the first
 * cell, keyed 'account' and holding the Xero AccountID — so the caller passes
 * a map from AccountID to code. Rows whose account cannot be resolved are kept
 * with a blank code rather than dropped, because a trial balance that silently
 * loses a line stops proving anything.
 */
function trialBalanceRows(report: XeroReport, codeById: Map<string, string>): TrialBalanceRow[] {
  const out: TrialBalanceRow[] = []
  const walk = (rows: XeroReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      if (row.RowType === 'Section') {
        walk(row.Rows)
        continue
      }
      if (row.RowType !== 'Row' && row.RowType !== 'SummaryRow') continue
      const cells = row.Cells ?? []
      const name = cells[0]?.Value?.trim()
      if (!name) continue
      const accountId = cells[0]?.Attributes?.find((a) => a.Id === 'account')?.Value
      const debit = parseFigure(cells[1]?.Value)
      const credit = parseFigure(cells[2]?.Value)
      if (debit === 0 && credit === 0) continue
      out.push({
        code: (accountId ? codeById.get(accountId) : undefined) ?? '',
        name,
        debit,
        credit,
      })
      walk(row.Rows)
    }
  }
  walk(report.Rows)
  return out
}

async function accountCodeById(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('xero_accounts')
    .select('account_id, code')
    .not('code', 'is', null)
    .limit(5000)
  if (error) throw new Error(error.message)
  return new Map(
    ((data ?? []) as Array<{ account_id: string; code: string }>).map((a) => [a.account_id, a.code]),
  )
}

function monthEnd(monthKey: string): string {
  const y = Number(monthKey.slice(0, 4))
  const m = Number(monthKey.slice(5, 7))
  const d = new Date(y, m, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface TrialBalanceResult {
  months: TrialBalanceMonth[]
  error: string | null
}

/**
 * One TrialBalance per month end, sequentially.
 *
 * Sequential on purpose: Xero allows 60 calls a minute per connection, and
 * firing 24 at once is the quickest way to spend that allowance and have the
 * whole export fail on a 429 rather than merely take a minute.
 */
export async function fetchTrialBalanceMonths(
  window: ExportWindow,
  onProgress?: (done: number, total: number) => void,
): Promise<TrialBalanceResult> {
  try {
    const codeById = await accountCodeById()
    const months: TrialBalanceMonth[] = []
    for (let i = 0; i < window.months.length; i++) {
      const month = window.months[i]
      const report = await fetchXeroReport('TrialBalance', { date: monthEnd(month) })
      months.push({ month, rows: trialBalanceRows(report, codeById) })
      onProgress?.(i + 1, window.months.length)
    }
    return { months, error: null }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Xero could not be reached'
    return { months: [], error: message }
  }
}

// ── Budgets ──────────────────────────────────────────────────────────────────

interface XeroBudgetsResponse {
  budgets?: Array<{
    budgetId?: string
    BudgetID?: string
    description?: string
    Description?: string
    type?: string
    Type?: string
    trackingCategory?: string | null
    trackingOption?: string | null
    lines?: Array<{
      accountCode?: string
      accountName?: string
      periods?: Array<{ period?: string; amount?: number }>
    }>
  }>
  scope_ok?: boolean
  error?: string
}

export interface BudgetResult {
  lines: BudgetLine[]
  error: string | null
}

/**
 * Every budget Xero holds, flattened to one row per account per period.
 *
 * Budgets held against a Fund are a tracking-category budget in Xero's model,
 * so the category and option travel on each row and the workbook joins them to
 * the fund register by name.
 */
export async function fetchBudgetLines(): Promise<BudgetResult> {
  try {
    const { data, error } = await supabase.functions.invoke<XeroBudgetsResponse>('xero-budgets', {
      body: { detail: true },
    })
    if (error) {
      const context = (error as { context?: Response }).context
      if (context) {
        try {
          const body = (await context.json()) as { error?: string }
          if (body?.error) return { lines: [], error: body.error }
        } catch {
          // fall through to the generic message
        }
      }
      return { lines: [], error: error.message }
    }
    if (data?.scope_ok === false) {
      return { lines: [], error: data.error ?? 'The accounting.budgets.read scope is missing.' }
    }

    const lines: BudgetLine[] = []
    for (const budget of data?.budgets ?? []) {
      const budgetId = budget.budgetId ?? budget.BudgetID ?? ''
      const budgetName = budget.description ?? budget.Description ?? 'Budget'
      for (const line of budget.lines ?? []) {
        for (const period of line.periods ?? []) {
          if (!period.period) continue
          lines.push({
            budgetId,
            budgetName,
            trackingCategory: budget.trackingCategory ?? null,
            trackingOption: budget.trackingOption ?? null,
            accountCode: line.accountCode ?? '',
            accountName: line.accountName ?? '',
            period: period.period.slice(0, 7),
            amount: Number(period.amount ?? 0),
          })
        }
      }
    }
    return { lines, error: lines.length === 0 ? 'Xero returned no budget lines.' : null }
  } catch (e) {
    return { lines: [], error: e instanceof Error ? e.message : 'Budgets could not be read' }
  }
}
