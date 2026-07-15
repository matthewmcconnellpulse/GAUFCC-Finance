/**
 * Investments module — shapes the Epworth import history (epworth_imports,
 * one row per month, values in parsed.meta) into chartable series: monthly
 * income by type, cumulative gain per portfolio account, and portfolio/cash
 * value over time. Read-only over data the Imports module writes.
 *
 * Module-owned: other modules should not import from here.
 */
import { supabase } from '@/lib/supabase'
import type { IncomeType } from '@/types/db'

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// ── Contracts ────────────────────────────────────────────────────────────────

export interface InvestmentAccount {
  ref: string
  /** short display name — org prefix stripped */
  name: string
  kind: 'portfolio' | 'cash'
}

export interface InvestmentPeriod {
  period: string // 'YYYY-MM'
  /** signed income per type across all accounts (fees negative) */
  incomeByType: Record<IncomeType, number>
  /** signed income per `${ref}|${type}` for account filtering */
  incomeByRefType: Record<string, number>
  /** cumulative gain/loss since Epworth's opening valuation, per account */
  cumGainByRef: Record<string, number>
  /** portfolio market value per account at period end */
  closingByRef: Record<string, number>
  /** Cash Plus balance per account at period end */
  cashByRef: Record<string, number>
}

export interface InvestmentSeries {
  periods: InvestmentPeriod[] // ascending; one entry per period (latest import wins)
  accounts: InvestmentAccount[] // fixed order — chart colours key off this
}

export const INCOME_TYPE_ORDER: IncomeType[] = [
  'dividend',
  'interest',
  'realised_gain',
  'unrealised_gain',
  'fee',
]

export const INCOME_TYPE_LABELS: Record<IncomeType, string> = {
  dividend: 'Dividends',
  interest: 'Interest',
  realised_gain: 'Realised gains',
  unrealised_gain: 'Unrealised gains',
  fee: 'Fees',
}

export function emptyIncome(): Record<IncomeType, number> {
  return { dividend: 0, interest: 0, realised_gain: 0, unrealised_gain: 0, fee: 0 }
}

// ── Defensive jsonb extraction (mirror of the imports contract) ──────────────

interface RawHolding {
  holding_ref?: unknown
  holding_name?: unknown
  income_type?: unknown
  amount?: unknown
}

interface RawMeta {
  cumulative_gains?: unknown
  closing_values?: unknown
  cash_values?: unknown
}

function numberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) out[k] = round2(n)
    }
  }
  return out
}

function coerceType(raw: string): IncomeType {
  const s = raw.toLowerCase()
  if (s.includes('fee') || s.includes('charge')) return 'fee'
  if (s.includes('unreal')) return 'unrealised_gain'
  if (s.includes('real')) return 'realised_gain'
  if (s.includes('int')) return 'interest'
  return 'dividend'
}

/** 'General Assembly of Unitarians – Growth & Development Fund' → the fund part. */
export function shortAccountName(name: string): string {
  const parts = name.split(/\s+[–—]\s+/)
  return (parts[parts.length - 1] || name).trim()
}

// ── Fetch + shape ────────────────────────────────────────────────────────────

export async function fetchInvestmentSeries(): Promise<InvestmentSeries> {
  const { data, error } = await supabase
    .from('epworth_imports')
    .select('period, parsed, created_at')
    .order('period', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)

  // Later imports of the same period overwrite earlier ones (rows are sorted
  // ascending, so the last write per period wins).
  const byPeriod = new Map<string, InvestmentPeriod>()
  const names = new Map<string, string>()
  const portfolioRefs = new Set<string>()
  const cashRefs = new Set<string>()

  for (const row of (data ?? []) as { period: string; parsed: unknown }[]) {
    if (!/^\d{4}-\d{2}$/.test(row.period)) continue
    const parsed = (row.parsed ?? {}) as { holdings?: unknown; meta?: unknown }
    const meta = (parsed.meta ?? {}) as RawMeta

    const entry: InvestmentPeriod = {
      period: row.period,
      incomeByType: emptyIncome(),
      incomeByRefType: {},
      cumGainByRef: numberMap(meta.cumulative_gains),
      closingByRef: numberMap(meta.closing_values),
      cashByRef: numberMap(meta.cash_values),
    }

    const holdings = Array.isArray(parsed.holdings) ? (parsed.holdings as RawHolding[]) : []
    for (const h of holdings) {
      const amount = typeof h.amount === 'number' ? h.amount : Number(h.amount)
      if (!Number.isFinite(amount)) continue
      const ref = String(h.holding_ref ?? '').trim()
      if (!ref) continue
      const type = coerceType(String(h.income_type ?? ''))
      entry.incomeByType[type] = round2(entry.incomeByType[type] + amount)
      const key = `${ref}|${type}`
      entry.incomeByRefType[key] = round2((entry.incomeByRefType[key] ?? 0) + amount)
      const name = String(h.holding_name ?? '').trim()
      if (name && !names.has(ref)) names.set(ref, shortAccountName(name))
    }
    for (const ref of Object.keys(entry.closingByRef)) portfolioRefs.add(ref)
    for (const ref of Object.keys(entry.cumGainByRef)) portfolioRefs.add(ref)
    for (const ref of Object.keys(entry.cashByRef)) cashRefs.add(ref)

    byPeriod.set(row.period, entry)
  }

  const periods = [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period))

  // Any ref that earned income but never appeared in the gains/cash maps is
  // still an account — cash-plus style refs start with a letter+digits.
  for (const p of periods) {
    for (const key of Object.keys(p.incomeByRefType)) {
      const ref = key.split('|')[0]
      if (!portfolioRefs.has(ref) && !cashRefs.has(ref)) {
        ;(names.get(ref) ?? '').toLowerCase().includes('cash')
          ? cashRefs.add(ref)
          : portfolioRefs.add(ref)
      }
    }
  }

  // Fixed account order (portfolios first, then cash, each alphabetical by
  // ref) — chart colour slots key off this order and never re-flow when the
  // user filters, so an account keeps its colour.
  const accounts: InvestmentAccount[] = [
    ...[...portfolioRefs].sort().map((ref) => ({
      ref,
      name: names.get(ref) ?? ref,
      kind: 'portfolio' as const,
    })),
    ...[...cashRefs].sort().map((ref) => ({
      ref,
      name: names.get(ref) ?? `Cash Plus ${ref}`,
      kind: 'cash' as const,
    })),
  ]

  return { periods, accounts }
}

// ── Presentation helpers ─────────────────────────────────────────────────────

/** 'YYYY-MM' → 'Jun 26' */
export function periodShort(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m) return period
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[Number(m[2]) - 1]} ${m[1].slice(2)}`
}

