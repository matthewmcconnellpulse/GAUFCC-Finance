/**
 * Endowment distribution — the James Speed Trust model, made general.
 *
 * This reproduces "DRAFT Speed distribution 2026-27.xlsx" cell for cell, and
 * the test alongside it holds it to the spreadsheet's own figures. The model:
 *
 *   B5  proposed distribution   = fund value × rate
 *   B6  fixed grants            = Σ each payee's fixed grant (£50 per minister)
 *   B7  balance of distribution = −B6, borne equally by every payee
 *   B8  payment                 = B5 + B7, split equally across the payees
 *   C12 payee's annual amount   = fixed grant + equal share + backlog
 *   B11 GA fee                  = Σ annual amounts × GA fee rate (2%)
 *   B12 required transfer       = Σ annual amounts + GA fee
 *   C17 each instalment         = ROUND(annual ÷ instalments, 2)
 *   B46 year-end transfer       = B12 − restricted fund closing balance
 *
 * Two things are reproduced deliberately even though they look like
 * accidents, because the figures have been agreed in this form:
 *
 *  - The backlog is added to the annual amount but takes no part in the equal
 *    split — row 12 is C6 + C8 + C9, not including row 7. Row 7 is shown only
 *    to explain why B8 is lower than B5.
 *  - Each instalment is rounded independently, so four of them can total up
 *    to two pence away from the annual amount (Edinburgh's minister is paid
 *    £14,316.68 against an annual £14,316.6707). The spreadsheet does this and
 *    the trustees have seen it; quietly absorbing the penny in Q4 would make
 *    the system disagree with the paper they approved. The difference is
 *    returned so the screen can show it rather than hide it.
 */

export interface DistributionPayee {
  id: string
  label: string
  /** 'Ministers' / 'Congregations' in the Speed Trust — a heading, nothing more. */
  group: string
  /** Row 6: a fixed sum paid before the equal split (£50 per minister). */
  fixedGrant: number
  /** Rows 9–10: an agreed catch-up payment added to this payee only. */
  backlog: number
  backlogNote?: string | null
}

export interface DistributionInstalment {
  label: string
  /** ISO date the instalment falls due. */
  payDate: string
}

export interface DistributionInputs {
  /** B2 — the combined endowment and restricted fund value at the valuation date. */
  fundValue: number
  /** B3 — the distribution rate, e.g. 0.04. */
  rate: number
  /** The GA fee on the sums paid out, e.g. 0.02. */
  gaFeeRate: number
  /**
   * The restricted fund's closing balance, for the year-end transfer (B46).
   * Optional: without it the transfer is simply not computed.
   */
  restrictedClosing: number | null
  payees: DistributionPayee[]
  instalments: DistributionInstalment[]
}

export interface PayeeLine {
  payeeId: string
  label: string
  group: string
  fixedGrant: number
  /** Row 7 — this payee's share of the fixed grants, as a negative. */
  balanceShare: number
  /** Row 8 — the equal share of the payment. */
  share: number
  backlog: number
  backlogNote: string | null
  /** Row 12 — unrounded, exactly as the spreadsheet carries it. */
  annual: number
  /** Row 17 — one instalment, rounded to the penny. */
  instalment: number
  /** Row 21 — the instalments actually paid in the year. */
  paidInYear: number
  /** paidInYear − annual: the rounding the spreadsheet accepts. */
  roundingDifference: number
}

export interface ScheduledInstalment {
  payeeId: string
  payeeLabel: string
  group: string
  instalmentIndex: number
  instalmentLabel: string
  payDate: string
  amount: number
}

export interface DistributionResult {
  proposed: number
  fixedGrants: number
  balanceOfDistribution: number
  payment: number
  payees: PayeeLine[]
  gaFee: number
  requiredTransfer: number
  /** B12 − restricted closing; null when no closing balance was given. */
  yearEndTransfer: number | null
  schedule: ScheduledInstalment[]
  totalScheduled: number
}

/**
 * Excel's ROUND: half away from zero, to `places` decimals.
 *
 * JavaScript's Math.round goes half toward +∞, and both suffer from binary
 * representation (1.005 is stored as 1.00499…). Scaling through a string
 * exponent sidesteps the representation error, which matters here because a
 * penny out on a bill is a penny the payee chases.
 */
export function excelRound(value: number, places = 2): number {
  if (!Number.isFinite(value)) return value
  const sign = value < 0 ? -1 : 1
  const shifted = Number(`${Math.abs(value)}e${places}`)
  const rounded = Math.round(shifted)
  return sign * Number(`${rounded}e-${places}`)
}

export function computeDistribution(inputs: DistributionInputs): DistributionResult {
  const n = inputs.payees.length
  const proposed = inputs.fundValue * inputs.rate
  const fixedGrants = inputs.payees.reduce((s, p) => s + (p.fixedGrant || 0), 0)
  const balanceOfDistribution = -fixedGrants
  const payment = proposed + balanceOfDistribution
  const share = n > 0 ? payment / n : 0
  const balanceShare = n > 0 ? -fixedGrants / n : 0
  const instalmentCount = inputs.instalments.length

  const payees: PayeeLine[] = inputs.payees.map((p) => {
    const annual = (p.fixedGrant || 0) + share + (p.backlog || 0)
    const instalment = instalmentCount > 0 ? excelRound(annual / instalmentCount, 2) : 0
    const paidInYear = excelRound(instalment * instalmentCount, 2)
    return {
      payeeId: p.id,
      label: p.label,
      group: p.group,
      fixedGrant: p.fixedGrant || 0,
      balanceShare,
      share,
      backlog: p.backlog || 0,
      backlogNote: p.backlogNote ?? null,
      annual,
      instalment,
      paidInYear,
      roundingDifference: excelRound(paidInYear - annual, 4),
    }
  })

  const totalAnnual = payees.reduce((s, p) => s + p.annual, 0)
  const gaFee = totalAnnual * inputs.gaFeeRate
  const requiredTransfer = totalAnnual + gaFee
  const yearEndTransfer =
    inputs.restrictedClosing === null || inputs.restrictedClosing === undefined
      ? null
      : requiredTransfer - inputs.restrictedClosing

  const schedule: ScheduledInstalment[] = []
  inputs.instalments.forEach((inst, i) => {
    for (const p of payees) {
      schedule.push({
        payeeId: p.payeeId,
        payeeLabel: p.label,
        group: p.group,
        instalmentIndex: i,
        instalmentLabel: inst.label,
        payDate: inst.payDate,
        amount: p.instalment,
      })
    }
  })

  return {
    proposed,
    fixedGrants,
    balanceOfDistribution,
    payment,
    payees,
    gaFee,
    requiredTransfer,
    yearEndTransfer,
    schedule,
    totalScheduled: excelRound(
      schedule.reduce((s, x) => s + x.amount, 0),
      2,
    ),
  }
}

/** The 2026/27 Speed Trust inputs, as agreed on the draft spreadsheet. */
export const SPEED_TRUST_2026_27: Omit<DistributionInputs, 'fundValue' | 'restrictedClosing'> = {
  rate: 0.04,
  gaFeeRate: 0.02,
  payees: [
    {
      id: 'edinburgh-minister',
      label: 'Edinburgh - Rev Janine Sim',
      group: 'Ministers',
      fixedGrant: 50,
      backlog: 3902,
      backlogNote: 'Backlog at £3,902pa (Yr 2 of 10, agreed with GW and DMcA)',
    },
    {
      id: 'dundee-minister',
      label: 'Dundee - Rev Rob Whiteman',
      group: 'Ministers',
      fixedGrant: 50,
      backlog: 2800,
      backlogNote: 'Backlog at £2,800pa (Yr 10 of 10, agreed with DMcA)',
    },
    { id: 'edinburgh-congregation', label: 'Edinburgh', group: 'Congregations', fixedGrant: 0, backlog: 0 },
    { id: 'dundee-congregation', label: 'Dundee', group: 'Congregations', fixedGrant: 0, backlog: 0 },
  ],
  instalments: [
    { label: 'Q1 2026/27', payDate: '2026-12-20' },
    { label: 'Q2 2026/27', payDate: '2027-03-20' },
    { label: 'Q3 2026/27', payDate: '2027-06-20' },
    { label: 'Q4 2026/27', payDate: '2027-09-20' },
  ],
}
