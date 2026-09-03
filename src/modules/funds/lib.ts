/**
 * Funds module — data contracts for the reporting views, fetch helpers and
 * date/period utilities. Owned by the dashboard + funds slice; other modules
 * should not import from here.
 *
 * View shapes mirror the migrations agent's contracts exactly:
 *   v_fund_balances, v_fund_monthly, v_integrity_missing_tracking,
 *   v_integrity_conflicting_tracking, v_integrity_unmapped_options,
 *   v_integrity_gl_recon, table integrity_stamps.
 */
import { supabase } from '@/lib/supabase'
import type { Fund, FundNote, FundType, FundWarning, Profile, SorpCategory, XeroTransaction } from '@/types/db'

// ── View row types ───────────────────────────────────────────────────────────

export interface VFundBalance {
  fund_id: string
  name: string
  fund_type: FundType
  active: boolean
  classified_at: string | null
  opening_balance: number
  balance: number
  ytd_income: number
  ytd_expenditure: number
  open_warning_count: number
}

export interface VFundMonthly {
  fund_id: string
  month: string // ISO date, first of month
  income: number
  expenditure: number
}

export interface IntegrityTxnRow {
  id: string
  date: string
  xero_id: string
  line_id: string
  source_type: string
  description: string | null
  account_code: string | null
  contact_name: string | null
  net: number
  gross: number
}

export interface IntegrityConflictRow extends IntegrityTxnRow {
  reason: string
}

export interface UnmappedOptionRow {
  tracking_option_id: string
  name: string
  tracking_category_id: string
}

export interface GlReconRow {
  account_code: string
  account_name: string
  period_month: string // ISO date, first of month
  total: number
  tracked_total: number
  variance: number
}

/** Open warning joined with its fund's name (embedded resource). */
export type OpenWarningRow = FundWarning & { funds: { name: string } | null }

export interface FundManagerRow {
  profile_id: string
  whole_board: boolean
  profiles: { full_name: string; email: string | null } | null
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

export async function fetchFundBalances(): Promise<VFundBalance[]> {
  const { data, error } = await supabase
    .from('v_fund_balances')
    .select('*')
    .order('balance', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as VFundBalance[]
}

export async function fetchFundMonthly(opts: { since?: string; fundId?: string } = {}): Promise<VFundMonthly[]> {
  let q = supabase.from('v_fund_monthly').select('*').order('month', { ascending: true })
  if (opts.since) q = q.gte('month', opts.since)
  if (opts.fundId) q = q.eq('fund_id', opts.fundId)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as VFundMonthly[]
}

export async function fetchOpenWarnings(opts: { fundId?: string; limit?: number } = {}): Promise<OpenWarningRow[]> {
  let q = supabase
    .from('fund_warnings')
    .select('*, funds(name)')
    .is('resolved_at', null)
    .order('as_of', { ascending: false })
  if (opts.fundId) q = q.eq('fund_id', opts.fundId)
  if (opts.limit) q = q.limit(opts.limit)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as OpenWarningRow[]
}

export async function fetchFund(id: string): Promise<Fund | null> {
  const { data, error } = await supabase.from('funds').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Fund | null) ?? null
}

/**
 * The funds table stores a reference to its Xero tracking option
 * (funds.tracking_option_id, 1:1 with xero_tracking_options) while the
 * transaction mirror stores whatever id the sync wrote to
 * tracking_option_1_id. Both Xero TrackingOptionIDs and our row ids are
 * GUID-shaped, so we resolve the option row and match transactions against
 * every candidate id — robust to either schema decision.
 */
const trackingIdCache = new Map<string, string[]>()

export async function resolveTrackingOptionIds(trackingOptionId: string | null): Promise<string[]> {
  if (!trackingOptionId) return []
  const cached = trackingIdCache.get(trackingOptionId)
  if (cached) return cached
  const ids = new Set<string>([trackingOptionId])
  try {
    const { data } = await supabase
      .from('xero_tracking_options')
      .select('id, tracking_option_id')
      .or(`id.eq.${trackingOptionId},tracking_option_id.eq.${trackingOptionId}`)
    for (const row of (data ?? []) as Array<{ id: string; tracking_option_id: string }>) {
      ids.add(row.id)
      ids.add(row.tracking_option_id)
    }
  } catch {
    // fall back to the stored id alone
  }
  const result = [...ids]
  trackingIdCache.set(trackingOptionId, result)
  return result
}

export interface AccountInfo {
  name: string
  class: string | null
  sorp: SorpCategory | null
}

export async function fetchAccountMap(): Promise<Map<string, AccountInfo>> {
  const { data, error } = await supabase
    .from('xero_accounts')
    .select('code, name, class, sorp_category')
  if (error) throw new Error(error.message)
  const map = new Map<string, AccountInfo>()
  for (const row of (data ?? []) as Array<{
    code: string | null
    name: string
    class: string | null
    sorp_category: SorpCategory | null
  }>) {
    if (row.code) map.set(row.code, { name: row.name, class: row.class, sorp: row.sorp_category })
  }
  return map
}

// ── P&L grouping ─────────────────────────────────────────────────────────────

export interface PlRow {
  sorp: SorpCategory | null
  account_code: string
  account_name: string
  amount: number
}

export type BalanceSheetClass = 'ASSET' | 'LIABILITY' | 'EQUITY'

export const BALANCE_SHEET_CLASSES: ReadonlySet<string> = new Set<BalanceSheetClass>([
  'ASSET',
  'LIABILITY',
  'EQUITY',
])

export interface BalanceSheetRow {
  class: BalanceSheetClass
  account_code: string
  account_name: string
  amount: number
}

export interface PlSummary {
  income: PlRow[]
  expenditure: PlRow[]
  /**
   * Lines coded to ASSET / LIABILITY / EQUITY accounts tagged with the fund —
   * investment purchases and sales, transfers, debtors, creditors. They never
   * move the fund balance (v_fund_balances counts REVENUE and EXPENSE only) so
   * they must not be shown as income or expenditure.
   */
  balanceSheet: BalanceSheetRow[]
  totalIncome: number
  totalExpenditure: number
}

/**
 * Presentation-level P&L: group by account, classify income vs expenditure by
 * the account's Xero class (REVENUE = income, EXPENSE = expenditure) with a
 * source-type fallback for unmapped codes; balance sheet classes are set
 * aside. Authoritative period figures come from v_fund_monthly /
 * v_fund_balances — this view exists for the drill-down narrative.
 */
export function buildPl(
  txns: Array<Pick<XeroTransaction, 'account_code' | 'net' | 'source_type'>>,
  accounts: Map<string, AccountInfo>,
): PlSummary {
  const sums = new Map<string, { net: number; incomeVotes: number; total: number }>()
  for (const t of txns) {
    const code = t.account_code ?? '—'
    const entry = sums.get(code) ?? { net: 0, incomeVotes: 0, total: 0 }
    entry.net += t.net
    entry.total += 1
    if (t.source_type === 'ACCREC' || t.source_type === 'RECEIVE') entry.incomeVotes += 1
    sums.set(code, entry)
  }
  const income: PlRow[] = []
  const expenditure: PlRow[] = []
  const balanceSheet: BalanceSheetRow[] = []
  for (const [code, entry] of sums) {
    const account = accounts.get(code)
    const cls = account?.class?.toUpperCase() ?? null
    const name = account?.name ?? (code === '—' ? 'Uncoded' : `Account ${code}`)
    if (cls && BALANCE_SHEET_CLASSES.has(cls)) {
      balanceSheet.push({
        class: cls as BalanceSheetClass,
        account_code: code,
        account_name: name,
        amount: Math.abs(entry.net),
      })
      continue
    }
    const isIncome = cls ? cls === 'REVENUE' : entry.incomeVotes * 2 >= entry.total
    const row: PlRow = {
      sorp: account?.sorp ?? null,
      account_code: code,
      account_name: name,
      amount: Math.abs(entry.net),
    }
    ;(isIncome ? income : expenditure).push(row)
  }
  income.sort((a, b) => b.amount - a.amount)
  expenditure.sort((a, b) => b.amount - a.amount)
  balanceSheet.sort((a, b) => b.amount - a.amount)
  return {
    income,
    expenditure,
    balanceSheet,
    totalIncome: income.reduce((s, r) => s + r.amount, 0),
    totalExpenditure: expenditure.reduce((s, r) => s + r.amount, 0),
  }
}

// ── Balance series ───────────────────────────────────────────────────────────

export interface BalancePoint {
  month: string // ISO date, first of month
  balance: number
}

/**
 * Cumulative balance per month: opening balance + running net movement.
 * Months with no activity carry the previous balance forward so the line has
 * no gaps; the series is extended to the current month.
 */
export function cumulativeBalances(rows: VFundMonthly[], openingBalance: number): BalancePoint[] {
  if (rows.length === 0) return []
  const byMonth = new Map<string, VFundMonthly>()
  for (const r of rows) byMonth.set(r.month.slice(0, 7), r)
  const first = rows[0].month.slice(0, 7)
  const now = new Date()
  const endKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const series: BalancePoint[] = []
  let [y, m] = first.split('-').map(Number)
  let balance = openingBalance
  let key = first
  let guard = 0
  while (key <= endKey && guard < 480) {
    const row = byMonth.get(key)
    if (row) balance += row.income - row.expenditure
    series.push({ month: `${key}-01`, balance })
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
    key = `${y}-${String(m).padStart(2, '0')}`
    guard += 1
  }
  return series
}

/** Last-n-months movement trend per fund, for register sparklines. */
export function sparklineByFund(rows: VFundMonthly[], months: string[]): Map<string, number[]> {
  const byFund = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const fund = byFund.get(r.fund_id) ?? new Map<string, number>()
    fund.set(r.month.slice(0, 7), r.income - r.expenditure)
    byFund.set(r.fund_id, fund)
  }
  const result = new Map<string, number[]>()
  for (const [fundId, movements] of byFund) {
    let running = 0
    const points = months.map((key) => {
      running += movements.get(key) ?? 0
      return running
    })
    result.set(fundId, points)
  }
  return result
}

/** The last n month keys ('YYYY-MM'), oldest first, ending this month. */
export function lastMonthKeys(n: number, today = new Date()): string[] {
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1)
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return keys
}

// ── Periods ──────────────────────────────────────────────────────────────────

/** GAUFCC's financial year runs 1 October – 30 September. */
export const FY_START_MONTH = 9 // 0-indexed → October

export type PeriodPreset = 'month' | 'quarter' | 'year' | 'fy' | 'custom'

export interface Period {
  preset: PeriodPreset
  start: string // ISO date, inclusive
  end: string // ISO date, inclusive
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, today = new Date()): { start: string; end: string } {
  const y = today.getFullYear()
  const m = today.getMonth()
  switch (preset) {
    case 'month':
      return { start: isoDate(new Date(y, m, 1)), end: isoDate(new Date(y, m + 1, 0)) }
    case 'quarter': {
      const qStart = Math.floor(m / 3) * 3
      return { start: isoDate(new Date(y, qStart, 1)), end: isoDate(new Date(y, qStart + 3, 0)) }
    }
    case 'year':
      return { start: isoDate(new Date(y, 0, 1)), end: isoDate(new Date(y, 11, 31)) }
    case 'fy': {
      const fyYear = m >= FY_START_MONTH ? y : y - 1
      return {
        start: isoDate(new Date(fyYear, FY_START_MONTH, 1)),
        end: isoDate(new Date(fyYear + 1, FY_START_MONTH, 0)),
      }
    }
  }
}

export function fyLabel(today = new Date()): string {
  const y = today.getMonth() >= FY_START_MONTH ? today.getFullYear() : today.getFullYear() - 1
  return `FY ${y}/${String((y + 1) % 100).padStart(2, '0')}`
}

/** '2026-06' → { start: '2026-06-01', end: '2026-06-30' } */
export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number)
  return { start: isoDate(new Date(y, m - 1, 1)), end: isoDate(new Date(y, m, 0)) }
}

export function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** '2026-07-01' → 'Jul 26' */
export function monthShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString('en-GB', { month: 'short' })} ${String(d.getFullYear() % 100).padStart(2, '0')}`
}

/** Compact axis money: £8.0m · £250k · £612 */
export function compactMoney(v: number): string {
  const sign = v < 0 ? '−' : ''
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(1)}m`
  if (abs >= 100_000) return `${sign}£${Math.round(abs / 1000)}k`
  if (abs >= 1_000) return `${sign}£${(abs / 1000).toFixed(1)}k`
  return `${sign}£${Math.round(abs)}`
}

// ── Xero deep links ──────────────────────────────────────────────────────────

/**
 * Best-effort deep links into Xero's classic UI. Where a source type has no
 * stable URL we fall back to Xero's global search seeded with the document id.
 */
export function xeroDeepLink(sourceType: string, xeroId: string): string {
  const id = encodeURIComponent(xeroId)
  switch (sourceType) {
    case 'ACCREC':
      return `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${id}`
    case 'ACCPAY':
      return `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${id}`
    case 'CREDIT_NOTE':
      return `https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${id}`
    case 'RECEIVE':
    case 'SPEND':
    case 'BANK_TRANSFER':
    case 'PREPAYMENT':
    case 'OVERPAYMENT':
      return `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${id}`
    case 'MANJOURNAL':
      return `https://go.xero.com/Journal/View.aspx?invoiceID=${id}`
    default:
      return `https://go.xero.com/Search/Search.aspx?searchQuery=${id}`
  }
}

export function xeroTrackingSetupLink(): string {
  return 'https://go.xero.com/Setup/Tracking.aspx'
}

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  ACCREC: 'Invoice',
  ACCPAY: 'Bill',
  RECEIVE: 'Bank in',
  SPEND: 'Bank out',
  BANK_TRANSFER: 'Transfer',
  CREDIT_NOTE: 'Credit note',
  PREPAYMENT: 'Prepayment',
  OVERPAYMENT: 'Overpayment',
  MANJOURNAL: 'Journal',
}

export function sourceTypeLabel(sourceType: string): string {
  return SOURCE_TYPE_LABELS[sourceType] ?? sourceType
}

// ── Fund-type presentation ───────────────────────────────────────────────────

export const FUND_TYPE_ORDER: FundType[] = [
  'restricted',
  'endowment',
  'designated',
  'general',
  'dormant',
]

export const FUND_TYPE_ACCENTS: Record<FundType, string> = {
  restricted: '#211951',
  designated: '#16b6ce',
  endowment: '#9747ff',
  general: '#08f2c7',
  dormant: '#d6d3c9',
}

/** Softer accents for row edges so the register stays calm. */
export const FUND_TYPE_ROW_ACCENTS: Record<FundType, string> = {
  restricted: 'rgba(33,25,81,.38)',
  designated: 'rgba(22,182,206,.45)',
  endowment: 'rgba(151,71,255,.4)',
  general: 'rgba(4,184,148,.45)',
  dormant: 'rgba(179,175,163,.5)',
}

export const FUND_TYPE_BLURBS: Record<FundType, string> = {
  restricted: 'may only be applied to their stated purposes',
  designated: 'earmarked by the Board, releasable by resolution',
  endowment: 'capital held on trust — income may be spent, capital preserved',
  general: 'free reserves',
  dormant: 'no recent movement — kept on the register for the record',
}

// ── Fund notes ───────────────────────────────────────────────────────────────

/** fund_notes row with author and FAO names embedded (null for roles that cannot read profiles). */
export type FundNoteRow = FundNote & {
  author: { full_name: string } | null
  fao: { full_name: string } | null
}

export async function fetchFundNotes(fundId: string): Promise<FundNoteRow[]> {
  const { data, error } = await supabase
    .from('fund_notes')
    .select(
      '*, author:profiles!fund_notes_created_by_fkey(full_name), fao:profiles!fund_notes_attention_of_fkey(full_name)',
    )
    .eq('fund_id', fundId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as FundNoteRow[]
}

export async function addFundNote(
  fundId: string,
  authorId: string,
  body: string,
  attentionOf: string | null,
): Promise<void> {
  const { error } = await supabase.from('fund_notes').insert({
    fund_id: fundId,
    body,
    attention_of: attentionOf,
    created_by: authorId,
  })
  if (error) throw new Error(error.message)
}

export async function updateFundNote(
  id: string,
  patch: { body: string; attention_of: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('fund_notes')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteFundNote(id: string): Promise<void> {
  const { error } = await supabase.from('fund_notes').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Fund managers (person responsible) ───────────────────────────────────────

/** Active users a fund can be assigned to / a note flagged for. Pulse + CEO only (profiles RLS). */
export async function fetchAssignableProfiles(): Promise<Pick<Profile, 'id' | 'full_name' | 'role'>[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('active', true)
    .order('full_name', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as Pick<Profile, 'id' | 'full_name' | 'role'>[]
}

export async function addFundManager(fundId: string, profileId: string): Promise<void> {
  const { error } = await supabase
    .from('fund_managers')
    .insert({ fund_id: fundId, profile_id: profileId, whole_board: false })
  if (error) throw new Error(error.message)
}

export async function removeFundManager(fundId: string, profileId: string): Promise<void> {
  const { error } = await supabase
    .from('fund_managers')
    .delete()
    .eq('fund_id', fundId)
    .eq('profile_id', profileId)
  if (error) throw new Error(error.message)
}
