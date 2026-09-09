/**
 * Reports module — data contracts, period helpers, fetch helpers and the
 * report model computation that drives both the on-screen builder and the
 * printed board pack. Module-owned: other modules should not import from here
 * (the funds module keeps its own copies of the view row types by design —
 * agents own their slices).
 *
 * View shapes mirror the migrations agent's contracts exactly:
 *   v_fund_balances, v_fund_monthly, integrity_stamps, board_packs.
 */
import { supabase } from '@/lib/supabase'
import type { BoardPack, FundType, FundWarning, Setting } from '@/types/db'
import { SETTING_KEYS } from '@/types/db'

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

export interface FundMeta {
  id: string
  name: string
  fund_type: FundType
  opening_balance: number
  description: string | null
  purpose: string | null
  tracking_option_id: string | null
  active: boolean
}

export type OpenWarningRow = FundWarning & { funds: { name: string } | null }

export interface StampRow {
  id: string
  period: string // 'YYYY-MM'
  stamped_by: string
  stamped_at: string
  results: unknown
}

export interface StampInfo {
  period: string // 'YYYY-MM'
  stamped: boolean
  stampedAt: string | null
  stampedByName: string | null
}

export interface MovementRow {
  id: string
  date: string
  source_type: string
  description: string | null
  account_code: string | null
  contact_name: string | null
  net: number
  gross: number
  tracking_option_1_id: string | null
  fund_name: string | null
}

// ── Periods (GAUFCC's financial year runs 1 October – 30 September) ──────────

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

export function presetRange(
  preset: Exclude<PeriodPreset, 'custom'>,
  today = new Date(),
): { start: string; end: string } {
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

export function defaultPeriod(today = new Date()): Period {
  return { preset: 'fy', ...presetRange('fy', today) }
}

export function fyLabel(today = new Date()): string {
  const y = today.getMonth() >= FY_START_MONTH ? today.getFullYear() : today.getFullYear() - 1
  return `FY ${y}/${String((y + 1) % 100).padStart(2, '0')}`
}

/** Human label for a period: 'June 2026' · 'FY 2025/26' · '1 Apr – 30 Jun 2026' */
export function periodLabel(p: Period): string {
  const s = new Date(p.start)
  const e = new Date(p.end)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${p.start} – ${p.end}`
  if (
    p.start.slice(0, 7) === p.end.slice(0, 7) &&
    s.getDate() === 1 &&
    e.getDate() === new Date(e.getFullYear(), e.getMonth() + 1, 0).getDate()
  ) {
    return s.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  }
  if (p.preset === 'fy') {
    return `${fyLabel(s)} · ${shortDate(s)} – ${shortDate(e)}`
  }
  return `${shortDate(s)} – ${shortDate(e)}`
}

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** 'YYYY-MM' keys for every month the period touches, oldest first. */
export function monthKeysInPeriod(p: Period): string[] {
  const startKey = p.start.slice(0, 7)
  const endKey = p.end.slice(0, 7)
  const keys: string[] = []
  let [y, m] = startKey.split('-').map(Number)
  let key = startKey
  let guard = 0
  while (key <= endKey && guard < 480) {
    keys.push(key)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
    key = `${y}-${String(m).padStart(2, '0')}`
    guard += 1
  }
  return keys
}

/** The n month keys ending at endKey inclusive, oldest first. */
export function trailingMonthKeys(endKey: string, n: number): string[] {
  const [y, m] = endKey.split('-').map(Number)
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(y, m - 1 - i, 1)
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return keys
}

/** '2026-07' or '2026-07-01' → 'Jul 26' */
export function monthShort(key: string): string {
  const d = new Date(`${key.slice(0, 7)}-01`)
  if (Number.isNaN(d.getTime())) return key
  return `${d.toLocaleDateString('en-GB', { month: 'short' })} ${String(d.getFullYear() % 100).padStart(2, '0')}`
}

/** Compact axis money: £8.0m · £250k · £612 */
export function compactMoney(v: number): string {
  const sign = v < 0 ? '−' : ''
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}m`
  if (abs >= 100_000) return `${sign}£${Math.round(abs / 1000)}k`
  if (abs >= 1_000) return `${sign}£${(abs / 1000).toFixed(1)}k`
  return `${sign}£${Math.round(abs)}`
}

/** SOFA-style parenthesised expenditure figure: 61,150 → (61,150) */
export function sofaFigure(v: number): string {
  return new Intl.NumberFormat('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(
    Math.round(Math.abs(v)),
  )
}

// ── Builder state ────────────────────────────────────────────────────────────

export type ReportScope = 'whole_charity' | 'fund_group' | 'single_fund'

export interface BuilderState {
  period: Period
  scope: ReportScope
  groupType: FundType
  fundId: string | null
}

export function defaultBuilderState(): BuilderState {
  return { period: defaultPeriod(), scope: 'whole_charity', groupType: 'restricted', fundId: null }
}

export const SCOPE_LABELS: Record<ReportScope, string> = {
  whole_charity: 'Whole charity',
  fund_group: 'Fund group',
  single_fund: 'Single fund',
}

export const FUND_TYPE_LABELS: Record<FundType, string> = {
  restricted: 'Restricted',
  designated: 'Designated',
  endowment: 'Endowment',
  general: 'General',
  dormant: 'Dormant',
}

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

export function scopeDescription(state: BuilderState, fundName?: string | null): string {
  if (state.scope === 'whole_charity') return 'Whole charity — all funds'
  if (state.scope === 'fund_group') return `${FUND_TYPE_LABELS[state.groupType]} funds`
  return fundName ? `Single fund — ${fundName}` : 'Single fund'
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

interface TrackingOptionRow {
  id: string
  tracking_option_id: string
}

export interface TrackingIndex {
  /** fund_id → every id a mirrored transaction line might carry for that fund */
  byFund: Map<string, string[]>
  /** any candidate id → fund_id */
  fundByOption: Map<string, string>
}

export interface ReportSources {
  balances: VFundBalance[]
  funds: FundMeta[]
  monthly: VFundMonthly[]
  warnings: OpenWarningRow[]
  tracking: TrackingIndex
}

export async function fetchReportSources(): Promise<ReportSources> {
  const [balancesRes, fundsRes, monthlyRes, warningsRes, optionsRes] = await Promise.all([
    supabase.from('v_fund_balances').select('*').order('balance', { ascending: false }),
    supabase
      .from('funds')
      .select('id, name, fund_type, opening_balance, description, purpose, tracking_option_id, active'),
    supabase.from('v_fund_monthly').select('*').order('month', { ascending: true }),
    supabase
      .from('fund_warnings')
      .select('*, funds(name)')
      .is('resolved_at', null)
      .order('as_of', { ascending: false }),
    supabase.from('xero_tracking_options').select('id, tracking_option_id'),
  ])
  for (const res of [balancesRes, fundsRes, monthlyRes, warningsRes]) {
    if (res.error) throw new Error(res.error.message)
  }
  const funds = (fundsRes.data ?? []) as FundMeta[]

  // The funds table stores a reference to its Xero tracking option while the
  // transaction mirror stores whatever id the sync wrote to
  // tracking_option_1_id. Both are GUID-shaped, so index every candidate.
  const optionRows = (optionsRes.error ? [] : (optionsRes.data ?? [])) as TrackingOptionRow[]
  const byRowId = new Map<string, TrackingOptionRow>()
  const byXeroId = new Map<string, TrackingOptionRow>()
  for (const o of optionRows) {
    byRowId.set(o.id, o)
    byXeroId.set(o.tracking_option_id, o)
  }
  const byFund = new Map<string, string[]>()
  const fundByOption = new Map<string, string>()
  for (const f of funds) {
    if (!f.tracking_option_id) continue
    const ids = new Set<string>([f.tracking_option_id])
    const row = byRowId.get(f.tracking_option_id) ?? byXeroId.get(f.tracking_option_id)
    if (row) {
      ids.add(row.id)
      ids.add(row.tracking_option_id)
    }
    const list = [...ids]
    byFund.set(f.id, list)
    for (const id of list) fundByOption.set(id, f.id)
  }

  return {
    balances: (balancesRes.data ?? []) as VFundBalance[],
    funds,
    monthly: (monthlyRes.data ?? []) as VFundMonthly[],
    warnings: (warningsRes.data ?? []) as OpenWarningRow[],
    tracking: { byFund, fundByOption },
  }
}

/**
 * The 10 largest |net| transaction lines in the period. PostgREST cannot
 * order by abs(net), so fetch the extremes from both ends and merge.
 */
export async function fetchTopMovements(
  period: Period,
  /** null = whole charity (no tracking filter); [] = scoped fund has no linked tracking option */
  trackingIds: string[] | null,
  fundByOption: Map<string, string>,
  fundNames: Map<string, string>,
  limit = 10,
): Promise<MovementRow[]> {
  if (trackingIds !== null && trackingIds.length === 0) return []
  const build = (ascending: boolean) => {
    let q = supabase
      .from('xero_transactions')
      .select('id, date, source_type, description, account_code, contact_name, net, gross, tracking_option_1_id')
      .gte('date', period.start)
      .lte('date', period.end)
      .order('net', { ascending })
      .limit(40)
    if (trackingIds && trackingIds.length > 0) q = q.in('tracking_option_1_id', trackingIds)
    return q
  }
  const [desc, asc] = await Promise.all([build(false), build(true)])
  if (desc.error) throw new Error(desc.error.message)
  if (asc.error) throw new Error(asc.error.message)
  const seen = new Set<string>()
  const rows: MovementRow[] = []
  type Raw = Omit<MovementRow, 'fund_name'>
  for (const r of [...((desc.data ?? []) as Raw[]), ...((asc.data ?? []) as Raw[])]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const fundId = r.tracking_option_1_id ? fundByOption.get(r.tracking_option_1_id) : undefined
    rows.push({ ...r, fund_name: fundId ? (fundNames.get(fundId) ?? null) : null })
  }
  rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  return rows.slice(0, limit)
}

export async function fetchIntegrityStamps(monthKeys: string[]): Promise<StampInfo[]> {
  if (monthKeys.length === 0) return []
  const { data, error } = await supabase
    .from('integrity_stamps')
    .select('id, period, stamped_by, stamped_at, results')
    .in('period', monthKeys)
    .order('stamped_at', { ascending: false })
  if (error) throw new Error(error.message)
  const stamps = (data ?? []) as StampRow[]
  const byPeriod = new Map<string, StampRow>()
  for (const s of stamps) if (!byPeriod.has(s.period)) byPeriod.set(s.period, s)

  const stamperIds = [...new Set([...byPeriod.values()].map((s) => s.stamped_by))]
  const names = new Map<string, string>()
  if (stamperIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', stamperIds)
    for (const p of (profiles ?? []) as Array<{ id: string; full_name: string }>) {
      names.set(p.id, p.full_name)
    }
  }
  return monthKeys.map((key) => {
    const s = byPeriod.get(key)
    return {
      period: key,
      stamped: Boolean(s),
      stampedAt: s?.stamped_at ?? null,
      stampedByName: s ? (names.get(s.stamped_by) ?? 'Pulse Accountants') : null,
    }
  })
}

export interface SettingsSnapshot {
  approvalDay: number
  paymentRunDay: number
}

export async function fetchSettingsSnapshot(): Promise<SettingsSnapshot> {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [SETTING_KEYS.expenseApprovalDay, SETTING_KEYS.paymentRunDay])
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<Pick<Setting, 'key' | 'value'>>
  const num = (key: string, fallback: number): number => {
    const raw = rows.find((r) => r.key === key)?.value
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    approvalDay: num(SETTING_KEYS.expenseApprovalDay, 10),
    paymentRunDay: num(SETTING_KEYS.paymentRunDay, 17),
  }
}

export async function fetchPacks(): Promise<BoardPack[]> {
  const { data, error } = await supabase
    .from('board_packs')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as BoardPack[]
}

/** Signed download link for a saved pack in the 'packs' bucket. */
export async function signedPackUrl(storagePath: string, expiresIn = 3600): Promise<string> {
  const path = storagePath.startsWith('packs/') ? storagePath.slice('packs/'.length) : storagePath
  const { data, error } = await supabase.storage.from('packs').createSignedUrl(path, expiresIn)
  if (error) throw new Error(error.message)
  return data.signedUrl
}

export async function markPackFinal(packId: string): Promise<void> {
  const { error } = await supabase.from('board_packs').update({ status: 'final' }).eq('id', packId)
  if (error) throw new Error(error.message)
}

/** Fund managers' emails for the scoped funds — recipients for the .eml. */
export async function fetchFundManagerEmails(fundIds: string[]): Promise<string[]> {
  if (fundIds.length === 0) return []
  const { data, error } = await supabase
    .from('fund_managers')
    .select('fund_id, profiles(email)')
    .in('fund_id', fundIds)
  if (error) throw new Error(error.message)
  const emails = new Set<string>()
  // PostgREST returns the embedded profile as an object for a to-one FK, but
  // supabase-js types it loosely — normalise either shape.
  for (const row of (data ?? []) as unknown as Array<{
    profiles: { email: string | null } | Array<{ email: string | null }> | null
  }>) {
    const p = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
    if (p?.email) emails.add(p.email)
  }
  return [...emails]
}

// ── Report model ─────────────────────────────────────────────────────────────

export interface ReportFundRow {
  fund_id: string
  name: string
  fund_type: FundType
  opening: number
  income: number
  expenditure: number
  transfers: number // placeholder — transfers between funds land in a later phase
  net: number
  closing: number
  flagged: boolean
  description: string | null
  purpose: string | null
}

export interface ReportGroup {
  type: FundType
  rows: ReportFundRow[]
  opening: number
  income: number
  expenditure: number
  transfers: number
  net: number
  closing: number
}

export interface ReportTotals {
  opening: number
  income: number
  expenditure: number
  transfers: number
  net: number
  closing: number
}

export interface ReportSplit {
  restricted: number
  unrestricted: number
  dormant: number
}

export interface ReportModel {
  groups: ReportGroup[]
  rows: ReportFundRow[]
  totals: ReportTotals
  split: ReportSplit
  fundCount: number
  flaggedCount: number
  scopedFundIds: string[]
}

export type MonthlyIndex = Map<string, Map<string, { income: number; expenditure: number }>>

export function buildMonthlyIndex(monthly: VFundMonthly[]): MonthlyIndex {
  const index: MonthlyIndex = new Map()
  for (const r of monthly) {
    const key = r.month.slice(0, 7)
    let fund = index.get(r.fund_id)
    if (!fund) {
      fund = new Map()
      index.set(r.fund_id, fund)
    }
    const entry = fund.get(key) ?? { income: 0, expenditure: 0 }
    entry.income += r.income
    entry.expenditure += r.expenditure
    fund.set(key, entry)
  }
  return index
}

/**
 * Period figures per fund. Income and expenditure come from v_fund_monthly
 * (month granularity — a custom range is measured on the whole months it
 * touches). Opening at the period start is the fund's opening balance plus
 * all net movement in earlier months.
 */
export function buildReportModel(sources: ReportSources, state: BuilderState): ReportModel {
  const monthlyIndex = buildMonthlyIndex(sources.monthly)
  const metaById = new Map(sources.funds.map((f) => [f.id, f]))
  const startKey = state.period.start.slice(0, 7)
  const endKey = state.period.end.slice(0, 7)

  const scoped = sources.balances.filter((b) => {
    if (state.scope === 'single_fund') return b.fund_id === state.fundId
    if (state.scope === 'fund_group') return b.fund_type === state.groupType
    return true
  })

  const rows: ReportFundRow[] = scoped.map((b) => {
    const months = monthlyIndex.get(b.fund_id)
    let priorNet = 0
    let income = 0
    let expenditure = 0
    if (months) {
      for (const [key, m] of months) {
        if (key < startKey) priorNet += m.income - m.expenditure
        else if (key <= endKey) {
          income += m.income
          expenditure += m.expenditure
        }
      }
    }
    const opening = b.opening_balance + priorNet
    const net = income - expenditure
    const meta = metaById.get(b.fund_id)
    return {
      fund_id: b.fund_id,
      name: b.name,
      fund_type: b.fund_type,
      opening,
      income,
      expenditure,
      transfers: 0,
      net,
      closing: opening + net,
      flagged: b.open_warning_count > 0,
      description: meta?.description ?? null,
      purpose: meta?.purpose ?? null,
    }
  })

  const groups: ReportGroup[] = []
  for (const type of FUND_TYPE_ORDER) {
    const groupRows = rows.filter((r) => r.fund_type === type).sort((a, b) => b.closing - a.closing)
    if (groupRows.length === 0) continue
    groups.push({
      type,
      rows: groupRows,
      opening: sum(groupRows, (r) => r.opening),
      income: sum(groupRows, (r) => r.income),
      expenditure: sum(groupRows, (r) => r.expenditure),
      transfers: 0,
      net: sum(groupRows, (r) => r.net),
      closing: sum(groupRows, (r) => r.closing),
    })
  }

  const totals: ReportTotals = {
    opening: sum(rows, (r) => r.opening),
    income: sum(rows, (r) => r.income),
    expenditure: sum(rows, (r) => r.expenditure),
    transfers: 0,
    net: sum(rows, (r) => r.net),
    closing: sum(rows, (r) => r.closing),
  }

  const split: ReportSplit = { restricted: 0, unrestricted: 0, dormant: 0 }
  // Endowment capital is not free reserves — it sits with restricted in the
  // restricted-vs-unrestricted split.
  for (const r of rows) {
    if (r.fund_type === 'restricted' || r.fund_type === 'endowment') split.restricted += r.closing
    else if (r.fund_type === 'dormant') split.dormant += r.closing
    else split.unrestricted += r.closing
  }

  return {
    groups,
    rows,
    totals,
    split,
    fundCount: rows.length,
    flaggedCount: rows.filter((r) => r.flagged).length,
    scopedFundIds: rows.map((r) => r.fund_id),
  }
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  return items.reduce((s, t) => s + pick(t), 0)
}

// ── Top movements by fund ────────────────────────────────────────────────────

export interface TopFundMovement extends ReportFundRow {
  /** Net movement as a share of the opening balance, null where opening is nil. */
  pctOfOpening: number | null
}

export interface TopFundMovements {
  rows: TopFundMovement[]
  /** Funds outside the top N, so the page still reconciles to the grand total. */
  restCount: number
  restNet: number
  totalNet: number
}

/**
 * The funds that actually moved, largest first by absolute net movement.
 *
 * Ranked on |net| rather than net so a large outflow is as visible as a large
 * inflow — a fund £70k down is exactly what trustees need on the page. Funds
 * with no movement are excluded entirely (they carry forward unchanged and are
 * already listed in the SOFA pages).
 */
export function topFundMovements(model: ReportModel, limit = 10): TopFundMovements {
  const moved = model.rows.filter((r) => Math.round(r.net * 100) !== 0)
  const ranked = [...moved].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  const top = ranked.slice(0, limit)
  const rest = ranked.slice(limit)
  return {
    rows: top.map((r) => ({
      ...r,
      pctOfOpening: Math.abs(r.opening) < 1 ? null : (r.net / Math.abs(r.opening)) * 100,
    })),
    restCount: rest.length,
    restNet: sum(rest, (r) => r.net),
    totalNet: model.totals.net,
  }
}

/** Candidate tracking ids for a set of funds (transaction scoping). */
export function trackingIdsForFunds(tracking: TrackingIndex, fundIds: string[]): string[] {
  const ids: string[] = []
  for (const fundId of fundIds) {
    const list = tracking.byFund.get(fundId)
    if (list) ids.push(...list)
  }
  return ids
}

/**
 * Trailing balance series for a fund over the given month window (oldest
 * first). `fund.opening` is the balance immediately before `startKey`; the
 * window may start before or after that month, so the base is adjusted by the
 * net movement between the two. Months with no activity carry the previous
 * balance forward.
 */
export function balanceSeries(
  fund: { fund_id: string; opening: number },
  monthlyIndex: MonthlyIndex,
  startKey: string,
  monthKeys: string[],
): number[] {
  if (monthKeys.length === 0) return []
  const months = monthlyIndex.get(fund.fund_id)
  const windowStart = monthKeys[0]
  let balance = fund.opening
  if (months) {
    for (const [key, m] of months) {
      const net = m.income - m.expenditure
      if (key >= startKey && key < windowStart) balance += net
      else if (key >= windowStart && key < startKey) balance -= net
    }
  }
  const values: number[] = []
  for (const key of monthKeys) {
    const m = months?.get(key)
    if (m) balance += m.income - m.expenditure
    values.push(balance)
  }
  return values
}
