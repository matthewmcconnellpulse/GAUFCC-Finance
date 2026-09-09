/**
 * Reconciliation — the checks that say whether the fund reporting and the
 * statutory position actually agree, and where they do not.
 *
 * Three questions, each answered against a different authority:
 *
 * 1. Do the funds add up to net assets? Total funds comes from our own fund
 *    register; net assets can only come from Xero's Balance Sheet, because the
 *    transaction mirror deliberately holds no journal-level data and so cannot
 *    produce a complete balance sheet (there are no control-account or bank-side
 *    postings in it).
 * 2. Is the unallocated movement the current surplus? Everything ought to carry
 *    a Fund tracking option; whatever does not is unallocated, and it should be
 *    explainable as this period's result rather than a gap.
 * 3. Do the funds' results add up to the whole-business result? The mirror IS
 *    complete for revenue and expenditure lines, so the whole-business P&L is
 *    computed here and compared with the sum of the funds. Any difference is
 *    ledger lines with no fund against them, itemised so they can be fixed.
 *
 * A check that cannot be evaluated reports itself as indeterminate rather than
 * passing. Nothing here should ever be able to say "agreed" on missing data.
 */

import { supabase } from '@/lib/supabase'
import { SORP_EXPENDITURE, SORP_INCOME, sorpLabel } from '@/lib/sorp'
import type { SorpCategory } from '@/types/db'

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Figures agree if they are within a penny — floating point, not judgement. */
const TOLERANCE = 0.01

/**
 * Voided and deleted documents are records, not transactions.
 *
 * The sync clears their mirrored lines, and the integrity views exclude them
 * too (app_private.is_live_document). Excluding them here as well keeps a
 * voided bill out of the whole-charity result and out of the unallocated
 * drill-down, so nobody is sent to code a bill that no longer exists.
 */
const DEAD_STATUSES = ['VOIDED', 'DELETED']

// ── Whole-business profit and loss (from the mirror) ────────────────────────

export interface PlAccountRow {
  code: string
  name: string
  sorp: SorpCategory | null
  /** Signed, account-natural: positive income is a credit, positive spend a debit. */
  amount: number
  /** The part of `amount` carrying no Fund tracking option. */
  unallocated: number
}

export interface PlGroup {
  key: SorpCategory | 'unmapped'
  label: string
  rows: PlAccountRow[]
  total: number
  unallocated: number
}

export interface WholeBusinessPl {
  income: PlGroup[]
  expenditure: PlGroup[]
  totalIncome: number
  totalExpenditure: number
  net: number
  /** Movement on P&L accounts with no Fund tracking option against it. */
  unallocatedIncome: number
  unallocatedExpenditure: number
  unallocatedNet: number
  lineCount: number
  /** Whole-charity income and expenditure by month, oldest first. */
  months: PlMonth[]
  /** True if the mirror hit the pagination cap — figures would be short. */
  truncated: boolean
}

// PostgREST serves at most 1,000 rows per request. A full financial year of
// P&L lines is a couple of thousand; the cap is a runaway guard well above it.
const CHUNK = 1000
const CAP = 40000

interface PlLine {
  account_code: string | null
  net: number
  date: string
  tracking_option_1_id: string | null
}

export interface PlMonth {
  /** 'YYYY-MM' */
  month: string
  income: number
  expenditure: number
  net: number
}

/**
 * Every revenue and expenditure line in the period, grouped by SORP heading.
 *
 * Signs are kept exactly as the mirror stores them (account-natural: plus is a
 * credit on revenue, a debit on expenditure), so a refund out of an income
 * account reduces income instead of inflating it.
 */
export async function fetchWholeBusinessPl(period: {
  start: string
  end: string
}): Promise<WholeBusinessPl> {
  const { data: accountRows, error: accountError } = await supabase
    .from('xero_accounts')
    .select('code, name, class, sorp_category')
    .in('class', ['REVENUE', 'EXPENSE'])
    .limit(1000)
  if (accountError) throw new Error(accountError.message)

  const accounts = new Map<
    string,
    { name: string; class: string; sorp: SorpCategory | null }
  >()
  for (const row of (accountRows ?? []) as Array<{
    code: string | null
    name: string
    class: string
    sorp_category: SorpCategory | null
  }>) {
    if (row.code) accounts.set(row.code, { name: row.name, class: row.class, sorp: row.sorp_category })
  }
  const plCodes = [...accounts.keys()]
  if (plCodes.length === 0) {
    return emptyPl()
  }

  const lines: PlLine[] = []
  let truncated = false
  for (let offset = 0; offset < CAP; offset += CHUNK) {
    const { data, error } = await supabase
      .from('xero_transactions')
      .select('account_code, net, date, tracking_option_1_id')
      .in('account_code', plCodes)
      .not('status', 'in', `(${DEAD_STATUSES.join(',')})`)
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date', { ascending: true })
      .order('line_id', { ascending: true })
      .range(offset, offset + CHUNK - 1)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as PlLine[]
    lines.push(...batch)
    if (batch.length < CHUNK) break
    if (offset + CHUNK >= CAP) truncated = true
  }

  const byCode = new Map<string, PlAccountRow>()
  const byMonth = new Map<string, { income: number; expenditure: number }>()
  for (const line of lines) {
    const code = line.account_code
    if (!code) continue
    const account = accounts.get(code)
    if (!account) continue
    let row = byCode.get(code)
    if (!row) {
      row = { code, name: account.name, sorp: account.sorp, amount: 0, unallocated: 0 }
      byCode.set(code, row)
    }
    row.amount += line.net
    if (!line.tracking_option_1_id) row.unallocated += line.net

    const month = line.date.slice(0, 7)
    const bucket = byMonth.get(month) ?? { income: 0, expenditure: 0 }
    if (account.class === 'REVENUE') bucket.income += line.net
    else bucket.expenditure += line.net
    byMonth.set(month, bucket)
  }

  const months: PlMonth[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, b]) => ({
      month,
      income: round2(b.income),
      expenditure: round2(b.expenditure),
      net: round2(b.income - b.expenditure),
    }))

  const group = (
    keys: Array<SorpCategory | 'unmapped'>,
    classWanted: 'REVENUE' | 'EXPENSE',
  ): PlGroup[] => {
    const groups: PlGroup[] = []
    for (const key of keys) {
      const rows = [...byCode.values()]
        .filter((r) => {
          const account = accounts.get(r.code)
          if (!account || account.class !== classWanted) return false
          return key === 'unmapped' ? r.sorp === null : r.sorp === key
        })
        .map((r) => ({ ...r, amount: round2(r.amount), unallocated: round2(r.unallocated) }))
        .filter((r) => r.amount !== 0 || r.unallocated !== 0)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      if (rows.length === 0) continue
      groups.push({
        key,
        label: key === 'unmapped' ? 'Not yet mapped to a SORP heading' : sorpLabel(key),
        rows,
        total: round2(rows.reduce((s, r) => s + r.amount, 0)),
        unallocated: round2(rows.reduce((s, r) => s + r.unallocated, 0)),
      })
    }
    return groups
  }

  const income = group([...SORP_INCOME, 'unmapped'], 'REVENUE')
  const expenditure = group([...SORP_EXPENDITURE, 'unmapped'], 'EXPENSE')
  const totalIncome = round2(income.reduce((s, g) => s + g.total, 0))
  const totalExpenditure = round2(expenditure.reduce((s, g) => s + g.total, 0))
  const unallocatedIncome = round2(income.reduce((s, g) => s + g.unallocated, 0))
  const unallocatedExpenditure = round2(expenditure.reduce((s, g) => s + g.unallocated, 0))

  return {
    income,
    expenditure,
    totalIncome,
    totalExpenditure,
    net: round2(totalIncome - totalExpenditure),
    unallocatedIncome,
    unallocatedExpenditure,
    unallocatedNet: round2(unallocatedIncome - unallocatedExpenditure),
    lineCount: lines.length,
    months,
    truncated,
  }
}

function emptyPl(): WholeBusinessPl {
  return {
    income: [],
    expenditure: [],
    totalIncome: 0,
    totalExpenditure: 0,
    net: 0,
    unallocatedIncome: 0,
    unallocatedExpenditure: 0,
    unallocatedNet: 0,
    lineCount: 0,
    months: [],
    truncated: false,
  }
}

// ── Fund side of the reconciliation ─────────────────────────────────────────

export interface FundTotals {
  income: number
  expenditure: number
  net: number
  opening: number
  closing: number
  fundCount: number
}

export async function fetchFundTotals(): Promise<FundTotals> {
  const { data, error } = await supabase
    .from('v_fund_balances')
    .select('opening_balance, balance, ytd_income, ytd_expenditure')
    .limit(1000)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{
    opening_balance: number
    balance: number
    ytd_income: number
    ytd_expenditure: number
  }>
  const sum = (pick: (r: (typeof rows)[number]) => number) => round2(rows.reduce((s, r) => s + pick(r), 0))
  const income = sum((r) => r.ytd_income)
  const expenditure = sum((r) => r.ytd_expenditure)
  return {
    income,
    expenditure,
    net: round2(income - expenditure),
    opening: sum((r) => r.opening_balance),
    closing: sum((r) => r.balance),
    fundCount: rows.length,
  }
}

/**
 * Ledger lines in the period with no Fund tracking option, largest first —
 * the drill-down behind the unallocated figure. This is what someone actually
 * has to go and code in Xero.
 */
export interface UnallocatedLine {
  id: string
  date: string
  source_type: string
  description: string | null
  account_code: string | null
  account_name: string | null
  contact_name: string | null
  net: number
}

export async function fetchUnallocatedPlLines(
  period: { start: string; end: string },
  limit = 200,
): Promise<UnallocatedLine[]> {
  const { data: accountRows, error: accountError } = await supabase
    .from('xero_accounts')
    .select('code, name')
    .in('class', ['REVENUE', 'EXPENSE'])
    .limit(1000)
  if (accountError) throw new Error(accountError.message)
  const names = new Map<string, string>()
  for (const row of (accountRows ?? []) as Array<{ code: string | null; name: string }>) {
    if (row.code) names.set(row.code, row.name)
  }
  const codes = [...names.keys()]
  if (codes.length === 0) return []

  const { data, error } = await supabase
    .from('xero_transactions')
    .select('id, date, source_type, description, account_code, contact_name, net')
    .in('account_code', codes)
    .is('tracking_option_1_id', null)
    .not('status', 'in', `(${DEAD_STATUSES.join(',')})`)
    .gte('date', period.start)
    .lte('date', period.end)
    .order('date', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<Omit<UnallocatedLine, 'account_name'>>).map((r) => ({
    ...r,
    account_name: r.account_code ? (names.get(r.account_code) ?? null) : null,
  }))
}

// ── Reading figures out of a Xero report ────────────────────────────────────

export interface XeroReportCell {
  Value?: string
}

export interface XeroReportRow {
  RowType: 'Header' | 'Section' | 'Row' | 'SummaryRow'
  Title?: string
  Cells?: XeroReportCell[]
  Rows?: XeroReportRow[]
}

export interface XeroReportLike {
  Rows?: XeroReportRow[]
}

function normalise(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function parseFigure(value: string | undefined): number | null {
  if (!value) return null
  let s = value.trim().replace(/[£,\s]/g, '').replace(/−/g, '-')
  if (!s) return null
  let sign = 1
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1
    s = s.slice(1, -1)
  }
  const n = Number(s)
  return Number.isFinite(n) ? round2(n * sign) : null
}

/**
 * Every labelled row in a Xero report, flattened and indexed by its
 * normalised label. Xero's layouts vary with the chart of accounts, so figures
 * are looked up by label alias rather than by position — and a label we do not
 * recognise yields null, which callers must handle as indeterminate.
 */
export function indexReportRows(report: XeroReportLike | null | undefined): Map<string, number> {
  const index = new Map<string, number>()
  const walk = (rows: XeroReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      const label = row.Cells?.[0]?.Value
      if (label) {
        const figure = parseFigure(row.Cells?.[1]?.Value)
        const key = normalise(label)
        if (figure !== null && !index.has(key)) index.set(key, figure)
      }
      if (row.Rows) walk(row.Rows)
    }
  }
  walk(report?.Rows)
  return index
}

/** First alias present in the index, or null when none of them are. */
export function figureByAlias(index: Map<string, number>, aliases: string[]): number | null {
  for (const alias of aliases) {
    const key = normalise(alias)
    const value = index.get(key)
    if (value !== undefined) return value
  }
  return null
}

export const NET_ASSETS_ALIASES = [
  'Net Assets',
  'Total Net Assets',
  'Net assets',
  'Total Equity',
  'Total equity',
]

export const CURRENT_EARNINGS_ALIASES = [
  'Current Year Earnings',
  'Current year earnings',
  'Current Year Surplus',
  'Net Surplus/(Deficit)',
  'Unallocated',
  'Unallocated funds',
]

export const TOTAL_ASSETS_ALIASES = ['Total Assets', 'Total assets']
export const TOTAL_LIABILITIES_ALIASES = ['Total Liabilities', 'Total liabilities']
export const RECEIVABLES_ALIASES = [
  'Accounts Receivable',
  'Trade Debtors',
  'Debtors',
  'Total Accounts Receivable',
]
export const PAYABLES_ALIASES = [
  'Accounts Payable',
  'Trade Creditors',
  'Creditors',
  'Total Accounts Payable',
]
export const CASH_ALIASES = ['Total Bank', 'Cash at bank and in hand', 'Cash and cash equivalents']

// ── The checks ──────────────────────────────────────────────────────────────

export type CheckStatus = 'agreed' | 'difference' | 'indeterminate'

export interface ReconCheck {
  id: 'net_assets_vs_funds' | 'unallocated_vs_result' | 'fund_result_vs_pl'
  title: string
  /** What the check is for, in one sentence a trustee would follow. */
  purpose: string
  status: CheckStatus
  leftLabel: string
  left: number | null
  rightLabel: string
  right: number | null
  difference: number | null
  /** Why it is indeterminate, or what the difference consists of. */
  explanation: string
  /** Where to go to do something about it. */
  actionLabel?: string
  actionTo?: string
}

export interface ReconInputs {
  pl: WholeBusinessPl
  funds: FundTotals
  /** Xero Balance Sheet as at the period end; null if it could not be loaded. */
  balanceSheet: Map<string, number> | null
  balanceSheetError: string | null
  periodLabel: string
}

export function buildReconChecks(input: ReconInputs): ReconCheck[] {
  const { pl, funds, balanceSheet, balanceSheetError } = input

  const netAssets = balanceSheet ? figureByAlias(balanceSheet, NET_ASSETS_ALIASES) : null
  const currentEarnings = balanceSheet ? figureByAlias(balanceSheet, CURRENT_EARNINGS_ALIASES) : null

  const compare = (
    left: number | null,
    right: number | null,
  ): { status: CheckStatus; difference: number | null } => {
    if (left === null || right === null) return { status: 'indeterminate', difference: null }
    const difference = round2(left - right)
    return { status: Math.abs(difference) <= TOLERANCE ? 'agreed' : 'difference', difference }
  }

  // 1 — net assets vs total funds
  const one = compare(netAssets, funds.closing)
  const checks: ReconCheck[] = [
    {
      id: 'net_assets_vs_funds',
      title: 'Net assets equal total funds',
      purpose:
        'Everything the charity owns, less what it owes, has to be held in one of the funds. If it does not, either a fund is missing from the register or a balance is sitting outside the fund structure.',
      status: one.status,
      leftLabel: 'Net assets per Xero balance sheet',
      left: netAssets,
      rightLabel: 'Total funds per the fund register',
      right: funds.closing,
      difference: one.difference,
      explanation:
        netAssets === null
          ? balanceSheetError
            ? `The balance sheet could not be read from Xero, so this cannot be checked — ${balanceSheetError}`
            : 'Xero’s balance sheet was read but no net assets line could be identified in it, so this cannot be checked.'
          : one.status === 'agreed'
            ? `Net assets and the ${funds.fundCount} funds in the register agree.`
            : 'A difference here usually means a balance sheet account has no Fund tracking option, so it never reaches a fund. The fund coverage check lists those accounts.',
      actionLabel: one.status === 'difference' ? 'Fund coverage check' : undefined,
      actionTo: one.status === 'difference' ? '/funds/integrity' : undefined,
    },
  ]

  // 2 — unallocated vs the period result
  const two = compare(currentEarnings, pl.net)
  checks.push({
    id: 'unallocated_vs_result',
    title: 'Unallocated equals the current result',
    purpose:
      'Until a surplus or deficit is appropriated it sits unallocated, so the unallocated figure should be this period’s result and nothing else.',
    status: two.status,
    leftLabel: 'Unallocated per Xero balance sheet',
    left: currentEarnings,
    rightLabel: `Result for ${input.periodLabel}`,
    right: pl.net,
    difference: two.difference,
    explanation:
      currentEarnings === null
        ? balanceSheetError
          ? `The balance sheet could not be read from Xero, so this cannot be checked — ${balanceSheetError}`
          : 'No unallocated or current-year-earnings line could be identified on Xero’s balance sheet, so this cannot be checked.'
        : two.status === 'agreed'
          ? 'The unallocated balance is this period’s result, as it should be.'
          : 'A difference means part of the unallocated balance is older than this period — a prior-year result that was never appropriated to a fund.',
  })

  // 3 — sum of the funds' results vs the whole-business result
  const three = compare(funds.net, pl.net)
  const unallocatedExplains = Math.abs(round2((three.difference ?? 0) + pl.unallocatedNet)) <= TOLERANCE
  checks.push({
    id: 'fund_result_vs_pl',
    title: 'Funds’ results add up to the profit and loss',
    purpose:
      'Every income and expenditure line should carry a fund, so the funds’ results added together should equal the whole charity’s result.',
    status: three.status,
    leftLabel: 'Sum of the funds’ results',
    left: funds.net,
    rightLabel: 'Whole-charity result',
    right: pl.net,
    difference: three.difference,
    explanation:
      three.status === 'agreed'
        ? 'Every income and expenditure line in the period carries a fund.'
        : unallocatedExplains
          ? `The difference is entirely ledger lines with no Fund tracking option against them — ${pl.unallocatedNet >= 0 ? 'a net credit' : 'a net charge'} that never reaches a fund. They are listed below.`
          : 'The difference is larger than the lines with no fund against them, so something else is also at work — check for lines carrying a tracking option that is not mapped to a fund.',
    actionLabel: three.status === 'difference' ? 'Unmapped tracking options' : undefined,
    actionTo: three.status === 'difference' ? '/funds/integrity' : undefined,
  })

  return checks
}

// ── Sign-off ────────────────────────────────────────────────────────────────

export interface ReconSignoff {
  id: string
  check_id: string
  period_start: string
  period_end: string
  left_value: number | null
  right_value: number | null
  difference: number | null
  note: string | null
  signed_by: string
  signed_at: string
  signer_name: string | null
}

export async function fetchReconSignoffs(period: {
  start: string
  end: string
}): Promise<ReconSignoff[]> {
  const { data, error } = await supabase
    .from('recon_signoffs')
    .select('*, signer:profiles!recon_signoffs_signed_by_fkey(full_name)')
    .eq('period_start', period.start)
    .eq('period_end', period.end)
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as Array<
    Omit<ReconSignoff, 'signer_name'> & { signer: { full_name: string | null } | null }
  >).map((row) => ({ ...row, signer_name: row.signer?.full_name ?? null }))
}

export async function signOffCheck(
  check: ReconCheck,
  period: { start: string; end: string },
  userId: string,
  note: string | null,
): Promise<void> {
  const { error } = await supabase.from('recon_signoffs').upsert(
    {
      check_id: check.id,
      period_start: period.start,
      period_end: period.end,
      left_value: check.left,
      right_value: check.right,
      difference: check.difference,
      note: note?.trim() || null,
      signed_by: userId,
      signed_at: new Date().toISOString(),
    },
    { onConflict: 'check_id,period_start,period_end' },
  )
  if (error) throw new Error(error.message)
}

export async function withdrawSignoff(id: string): Promise<void> {
  const { error } = await supabase.from('recon_signoffs').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export type SignoffState =
  | { kind: 'unsigned' }
  | { kind: 'signed'; signoff: ReconSignoff }
  /** Signed, but the figures have moved since — the assurance no longer holds. */
  | { kind: 'superseded'; signoff: ReconSignoff; movedBy: number | null }

/**
 * Whether a sign-off still covers the figures on screen.
 *
 * A tick that survives the numbers changing underneath it is worse than no
 * tick, so the figures at sign-off are compared with the live ones and any
 * movement demotes the sign-off to superseded. Comparing the *difference*
 * catches the case that matters: both sides can move together while the check
 * still agrees, and that is not something to re-sign.
 */
export function signoffState(
  check: ReconCheck,
  signoffs: ReconSignoff[],
): SignoffState {
  const signoff = signoffs.find((s) => s.check_id === check.id)
  if (!signoff) return { kind: 'unsigned' }

  const moved = (was: number | null, now: number | null): number | null => {
    if (was === null && now === null) return null
    if (was === null || now === null) return now ?? was ?? null
    return round2(now - was)
  }
  const leftMove = moved(signoff.left_value, check.left)
  const rightMove = moved(signoff.right_value, check.right)
  const diffMove = moved(signoff.difference, check.difference)

  const beyondTolerance = (v: number | null) => v !== null && Math.abs(v) > TOLERANCE
  if (beyondTolerance(leftMove) || beyondTolerance(rightMove) || beyondTolerance(diffMove)) {
    return { kind: 'superseded', signoff, movedBy: diffMove ?? leftMove ?? rightMove }
  }
  return { kind: 'signed', signoff }
}

export function checksSummary(checks: ReconCheck[]): {
  agreed: number
  differences: number
  indeterminate: number
  allAgreed: boolean
} {
  const agreed = checks.filter((c) => c.status === 'agreed').length
  const differences = checks.filter((c) => c.status === 'difference').length
  const indeterminate = checks.filter((c) => c.status === 'indeterminate').length
  return { agreed, differences, indeterminate, allAgreed: differences === 0 && indeterminate === 0 }
}
