/**
 * VAT partial exemption — standard method and de minimis tests.
 *
 * Pure calculation module: no IO, no React. Everything here follows HMRC
 * VAT Notice 706 (partial exemption). The numbers this file produces are the
 * numbers trustees see, so every step is commented against the notice.
 *
 * The shape stored in vat_periods.de_minimis_result is DeMinimisResult from
 * src/types/db.ts; VatCalcResult extends it with the full working so the
 * jsonb column keeps an auditable snapshot of how the answer was reached.
 *
 * ── The standard method in one paragraph ────────────────────────────────────
 * Input VAT is recovered in three buckets:
 *   1. VAT directly attributable to TAXABLE supplies — fully recoverable.
 *   2. VAT directly attributable to EXEMPT supplies — irrecoverable (unless
 *      de minimis, below).
 *   3. RESIDUAL VAT (overheads used for both) — apportioned by the ratio
 *      taxable supplies ÷ total supplies, with the percentage rounded UP to
 *      the next whole number (Notice 706 s4.7; businesses with residual input
 *      tax over £400,000 a month must instead round to two decimal places —
 *      GAUFCC is nowhere near that, so whole-percent round-up applies).
 *
 * ── De minimis (Notice 706 s11) ─────────────────────────────────────────────
 * If exempt input VAT is de minimis, ALL input VAT is recoverable. There are
 * three routes; passing ANY ONE of them is enough. The two simplified tests
 * exist so a business can skip the full apportionment:
 *   · Simplified test 1: total input VAT ≤ £625 a month on average, AND
 *     exempt supplies ≤ 50% of all supplies.
 *   · Simplified test 2: total input VAT LESS input VAT directly attributable
 *     to taxable supplies ≤ £625 a month on average, AND exempt supplies
 *     ≤ 50% of all supplies.
 *   · Main test: exempt input VAT (directly attributable exempt + exempt
 *     share of residual) ≤ £625 a month on average, AND ≤ 50% of total
 *     input VAT.
 *
 * ── Annual adjustment (Notice 706 s12) ──────────────────────────────────────
 * At year end the whole year is recalculated as one "longer period"; the
 * difference between that answer and the sum of the individual periods is the
 * annual adjustment. `annualAdjustment` below does exactly that.
 */
import type { DeMinimisResult } from '@/types/db'

// ── Constants ────────────────────────────────────────────────────────────────

/** De minimis limit: £625 per month on average (£1,875/quarter, £7,500/year). */
export const DE_MINIMIS_MONTHLY_LIMIT = 625

/** VAT registration threshold — rolling 12-month taxable turnover (from 1 April 2024). */
export const REGISTRATION_THRESHOLD = 90_000

/** Deregistration threshold, quoted in the registration panel. */
export const DEREGISTRATION_THRESHOLD = 88_000

// ── Types ────────────────────────────────────────────────────────────────────

export interface VatCalcInput {
  /** VAT-exclusive value of taxable supplies (standard, reduced and zero-rated) */
  taxable_supplies: number
  /** Value of exempt supplies */
  exempt_supplies: number
  /** Input VAT wholly attributable to taxable / exempt activity */
  directly_attributable: { taxable: number; exempt: number }
  /** Input VAT on overheads used for both (the pot to apportion) */
  residual_input_vat: number
  /** Length of the VAT period in months (1, 3 or 12) */
  months: number
}

/**
 * DeMinimisResult (the db contract) plus the full working. Extra fields ride
 * along in the jsonb column so a stored result can be audited later.
 * Contract-field semantics:
 *   test1_pass = simplified test 1 · test2_pass = simplified test 2
 *   (main_test_pass carries the third route; de_minimis_met = any of the three)
 */
export interface VatCalcResult extends DeMinimisResult {
  main_test_pass: boolean
  de_minimis_met: boolean
  /** standard-method recovery percentage, rounded up to a whole number */
  recovery_pct: number
  residual_taxable: number
  residual_exempt: number
  total_input_vat: number
  /** directly attributable taxable + taxable share of residual */
  taxable_input_vat: number
  total_supplies: number
  /** exempt supplies as a % of all supplies (the 50% condition in both simplified tests) */
  exempt_supplies_share_pct: number
  /** £625 × months — the absolute de minimis limit for this period */
  de_minimis_limit: number
  months: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Round to pennies. VAT working papers are kept to 2dp. */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

// ── The calculation ──────────────────────────────────────────────────────────

export function calculatePartialExemption(input: VatCalcInput): VatCalcResult {
  const taxable = Math.max(0, input.taxable_supplies)
  const exempt = Math.max(0, input.exempt_supplies)
  const daTaxable = Math.max(0, input.directly_attributable.taxable)
  const daExempt = Math.max(0, input.directly_attributable.exempt)
  const residual = Math.max(0, input.residual_input_vat)
  const months = Math.max(1, input.months)

  const totalSupplies = round2(taxable + exempt)

  // Standard method percentage: taxable ÷ total supplies, rounded UP to the
  // next whole percent (Notice 706 s4.7). With no supplies at all the ratio is
  // undefined — we default to 100% taxable, i.e. no evidenced exempt activity,
  // so nothing is restricted by an accident of an empty period.
  const recoveryPct =
    totalSupplies > 0 ? Math.min(100, Math.ceil((taxable / totalSupplies) * 100)) : 100

  // Apportion the residual pot. The exempt share is the remainder so the two
  // halves always sum back to the residual figure exactly.
  const residualTaxable = round2(residual * (recoveryPct / 100))
  const residualExempt = round2(residual - residualTaxable)

  const totalInputVat = round2(daTaxable + daExempt + residual)
  const exemptInputVat = round2(daExempt + residualExempt)
  const taxableInputVat = round2(daTaxable + residualTaxable)

  const monthlyAverageInputVat = round2(totalInputVat / months)
  const deMinimisLimit = round2(DE_MINIMIS_MONTHLY_LIMIT * months)

  // Exempt supplies as a share of all supplies — the common second condition
  // of both simplified tests. Zero supplies ⇒ zero exempt supplies ⇒ passes.
  const exemptSuppliesSharePct =
    totalSupplies > 0 ? round2((exempt / totalSupplies) * 100) : 0
  const suppliesConditionMet = exempt <= (taxable + exempt) * 0.5

  // Simplified test 1: TOTAL input VAT within the £625/month average AND
  // exempt supplies no more than half of all supplies.
  const test1Pass = totalInputVat <= deMinimisLimit && suppliesConditionMet

  // Simplified test 2: total input VAT LESS the part directly attributable to
  // taxable supplies within the £625/month average, same supplies condition.
  const test2Pass =
    round2(totalInputVat - daTaxable) <= deMinimisLimit && suppliesConditionMet

  // Main test: exempt input VAT within the £625/month average AND no more
  // than half of total input VAT.
  const exemptSharePct =
    totalInputVat > 0 ? round2((exemptInputVat / totalInputVat) * 100) : 0
  const mainTestPass =
    exemptInputVat <= deMinimisLimit && exemptInputVat <= totalInputVat * 0.5

  // Any one route through ⇒ de minimis ⇒ ALL input VAT is recoverable.
  const deMinimisMet = test1Pass || test2Pass || mainTestPass

  const recoverable = deMinimisMet ? totalInputVat : taxableInputVat
  const irrecoverable = round2(totalInputVat - recoverable)

  const narrative = deMinimisMet
    ? `Exempt input VAT is de minimis this period, so all input VAT (£${totalInputVat.toFixed(2)}) would be recoverable if registered.`
    : `Exempt input VAT exceeds the de minimis limits: £${irrecoverable.toFixed(2)} of the £${totalInputVat.toFixed(2)} input VAT would be irrecoverable.`

  return {
    // db contract fields
    test1_pass: test1Pass,
    test2_pass: test2Pass,
    monthly_average_input_vat: monthlyAverageInputVat,
    exempt_input_vat: exemptInputVat,
    exempt_share_pct: exemptSharePct,
    recoverable,
    irrecoverable,
    narrative,
    // full working
    main_test_pass: mainTestPass,
    de_minimis_met: deMinimisMet,
    recovery_pct: recoveryPct,
    residual_taxable: residualTaxable,
    residual_exempt: residualExempt,
    total_input_vat: totalInputVat,
    taxable_input_vat: taxableInputVat,
    total_supplies: totalSupplies,
    exempt_supplies_share_pct: exemptSuppliesSharePct,
    de_minimis_limit: deMinimisLimit,
    months,
  }
}

// ── Annual adjustment ────────────────────────────────────────────────────────

export interface AnnualAdjustment {
  /** the year recalculated as one longer period */
  annual: VatCalcResult
  /** sum of the individual periods' recoverable VAT */
  periodsRecoverable: number
  /**
   * annual recoverable − Σ period recoverable.
   * Positive = additional VAT is recoverable at year end; negative = some
   * in-year recovery has to be paid back.
   */
  adjustment: number
}

/** Sum period inputs into one longer-period input (Notice 706 s12). */
export function aggregateInputs(inputs: VatCalcInput[]): VatCalcInput {
  return inputs.reduce<VatCalcInput>(
    (acc, i) => ({
      taxable_supplies: round2(acc.taxable_supplies + Math.max(0, i.taxable_supplies)),
      exempt_supplies: round2(acc.exempt_supplies + Math.max(0, i.exempt_supplies)),
      directly_attributable: {
        taxable: round2(acc.directly_attributable.taxable + Math.max(0, i.directly_attributable.taxable)),
        exempt: round2(acc.directly_attributable.exempt + Math.max(0, i.directly_attributable.exempt)),
      },
      residual_input_vat: round2(acc.residual_input_vat + Math.max(0, i.residual_input_vat)),
      months: acc.months + Math.max(1, i.months),
    }),
    {
      taxable_supplies: 0,
      exempt_supplies: 0,
      directly_attributable: { taxable: 0, exempt: 0 },
      residual_input_vat: 0,
      months: 0,
    },
  )
}

export function annualAdjustment(inputs: VatCalcInput[]): AnnualAdjustment {
  const annual = calculatePartialExemption(aggregateInputs(inputs))
  const periodsRecoverable = round2(
    inputs.reduce((s, i) => s + calculatePartialExemption(i).recoverable, 0),
  )
  return {
    annual,
    periodsRecoverable,
    adjustment: round2(annual.recoverable - periodsRecoverable),
  }
}

// ── Period string helpers ────────────────────────────────────────────────────
// vat_periods.period is text: 'YYYY-MM' (month), 'YYYY-Qn' (calendar quarter)
// or 'YYYY' (year). Quarters are treated as calendar quarters here; if GAUFCC
// registers on a different VAT stagger the month format still covers it.

export type PeriodKind = 'month' | 'quarter' | 'year'

export function periodKind(period: string): PeriodKind {
  if (/^\d{4}-Q[1-4]$/i.test(period)) return 'quarter'
  if (/^\d{4}-\d{2}$/.test(period)) return 'month'
  return 'year'
}

/** Months covered by a period string — feeds the £625/month average. */
export function periodMonths(period: string): number {
  switch (periodKind(period)) {
    case 'month':
      return 1
    case 'quarter':
      return 3
    case 'year':
      return 12
  }
}

export function periodYear(period: string): string {
  return period.slice(0, 4)
}

const QUARTER_LABELS: Record<string, string> = {
  Q1: 'Jan – Mar',
  Q2: 'Apr – Jun',
  Q3: 'Jul – Sep',
  Q4: 'Oct – Dec',
}

export function periodLabel(period: string): string {
  const kind = periodKind(period)
  if (kind === 'month') {
    const [y, m] = period.split('-').map(Number)
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  }
  if (kind === 'quarter') {
    const q = period.slice(5).toUpperCase()
    return `${q} ${period.slice(0, 4)} (${QUARTER_LABELS[q] ?? ''})`
  }
  return `Calendar year ${period}`
}

/** Inclusive ISO date bounds for a period — drives the Xero candidate pull. */
export function periodRange(period: string): { start: string; end: string } {
  const y = Number(period.slice(0, 4))
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  switch (periodKind(period)) {
    case 'month': {
      const m = Number(period.slice(5, 7))
      return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)) }
    }
    case 'quarter': {
      const q = Number(period.slice(6))
      const startMonth = (q - 1) * 3
      return { start: iso(new Date(y, startMonth, 1)), end: iso(new Date(y, startMonth + 3, 0)) }
    }
    case 'year':
      return { start: `${y}-01-01`, end: `${y}-12-31` }
  }
}

/** Numeric sort key so mixed month/quarter/year periods order sensibly. */
export function periodSortKey(period: string): number {
  const y = Number(period.slice(0, 4))
  switch (periodKind(period)) {
    case 'month':
      return y * 100 + Number(period.slice(5, 7))
    case 'quarter':
      return y * 100 + Number(period.slice(6)) * 3 // end month of the quarter
    case 'year':
      return y * 100 + 12.5 // sorts after December of the same year
  }
}
