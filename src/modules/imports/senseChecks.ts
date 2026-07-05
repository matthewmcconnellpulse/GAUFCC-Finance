/**
 * The four sense checks that gate every HSBC → Xero CSV.
 *
 * Deterministic and client-side: given the parsed statement and the register
 * of earlier imports they always produce the same verdicts, so outcomes can
 * be recomputed for any historical import to restore the drill-down. The
 * persisted record is the plain SenseCheckResult[] (src/types/db.ts).
 */
import { formatDate, formatMoney } from '@/lib/format'
import type { BankImport, BankImportRow, ImportStatus, SenseCheckResult } from '@/types/db'
import { addDays, round2, rowKey } from './lib'

export interface CheckInput {
  rows: BankImportRow[]
  opening_balance: number | null
  closing_balance: number | null
  statement_start: string | null
  statement_end: string | null
}

/** A check result plus the offending rows for the drill-down panel. */
export interface CheckOutcome extends SenseCheckResult {
  offending?: BankImportRow[]
}

export const CHECK_TITLES: Record<SenseCheckResult['check'], string> = {
  opening_matches_prior_closing: 'Opening balance matches the prior statement',
  running_balance_recomputes: 'Running balance recomputes line by line',
  no_date_gaps_or_overlaps: 'No date gaps or overlaps vs previous imports',
  no_duplicates: 'No duplicate rows vs already-imported statements',
}

const TOLERANCE = 0.01

function eq(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE + 1e-9
}

/** Earlier imports sorted latest-statement first. */
function sortPriors(priors: BankImport[]): BankImport[] {
  return [...priors].sort((a, b) => {
    if (a.statement_end == null && b.statement_end == null) return 0
    if (a.statement_end == null) return 1
    if (b.statement_end == null) return -1
    return b.statement_end.localeCompare(a.statement_end)
  })
}

function checkOpening(input: CheckInput, priors: BankImport[]): CheckOutcome {
  const check = 'opening_matches_prior_closing' as const
  // The statement immediately before this one: latest closing date that
  // precedes our start; failing that, the latest import on record.
  const before = input.statement_start
    ? priors.filter((p) => p.statement_end != null && p.statement_end < input.statement_start!)
    : []
  const prior = before[0] ?? priors.find((p) => p.statement_end != null) ?? null

  if (!prior) {
    return { check, pass: true, detail: 'First statement on record — nothing to compare against yet.' }
  }
  if (input.opening_balance == null) {
    return {
      check,
      pass: false,
      detail: `No opening balance could be read from this statement, so it cannot be verified against ${prior.file_name} (closing ${prior.closing_balance != null ? formatMoney(prior.closing_balance) : '—'}).`,
    }
  }
  if (prior.closing_balance == null) {
    return {
      check,
      pass: false,
      detail: `${prior.file_name} has no closing balance on record to compare against.`,
    }
  }
  const diff = round2(input.opening_balance - prior.closing_balance)
  if (eq(diff, 0)) {
    return {
      check,
      pass: true,
      detail: `${formatMoney(input.opening_balance)} agrees with the closing balance of ${prior.file_name} (${formatDate(prior.statement_end)}).`,
    }
  }
  return {
    check,
    pass: false,
    detail: `Opening ${formatMoney(input.opening_balance)} vs prior closing ${formatMoney(prior.closing_balance)} on ${prior.file_name} — out by ${formatMoney(diff)}.`,
  }
}

function checkRunningBalance(input: CheckInput): CheckOutcome {
  const check = 'running_balance_recomputes' as const
  const rows = input.rows
  if (rows.length === 0) {
    return { check, pass: false, detail: 'No transaction rows were parsed, so there is nothing to recompute.' }
  }

  // Establish a starting balance: the stated opening, or back-computed from
  // the first row that carries a balance.
  let start = input.opening_balance
  if (start == null) {
    let prefix = 0
    for (const r of rows) {
      prefix = round2(prefix + r.amount)
      if (r.balance != null) {
        start = round2(r.balance - prefix)
        break
      }
    }
  }
  if (start == null) {
    return {
      check,
      pass: false,
      detail: 'The statement has no opening balance and no balance column — the running balance cannot be verified.',
    }
  }

  const offending: BankImportRow[] = []
  let running = start
  let checkedLines = 0
  for (const r of rows) {
    running = round2(running + r.amount)
    if (r.balance != null) {
      checkedLines += 1
      if (!eq(running, r.balance)) {
        offending.push(r)
        running = r.balance // resync so one bad line does not cascade
      }
    }
  }
  let closingOk = true
  if (input.closing_balance != null) closingOk = eq(running, input.closing_balance)

  if (offending.length === 0 && closingOk) {
    return {
      check,
      pass: true,
      detail:
        checkedLines > 0
          ? `Recomputed ${rows.length} of ${rows.length} lines through to the stated closing balance.`
          : `No per-line balance column — opening plus ${rows.length} movements agrees with the closing balance.`,
    }
  }
  const parts: string[] = []
  if (offending.length > 0) parts.push(`${offending.length} of ${rows.length} lines do not recompute within ${formatMoney(0.01)}`)
  if (!closingOk && input.closing_balance != null) {
    parts.push(`recomputed closing ${formatMoney(running)} vs stated ${formatMoney(input.closing_balance)}`)
  }
  return { check, pass: false, detail: `${parts.join('; ')}.`, offending }
}

function checkDates(input: CheckInput, priors: BankImport[]): CheckOutcome {
  const check = 'no_date_gaps_or_overlaps' as const
  const latest = priors.find((p) => p.statement_end != null) ?? null
  const issues: string[] = []

  if (latest && input.statement_start) {
    const priorEnd = latest.statement_end!
    const expectedStart = addDays(priorEnd, 1)
    if (input.statement_start > expectedStart) {
      const gapEnd = addDays(input.statement_start, -1)
      issues.push(
        `gap — ${formatDate(expectedStart)} to ${formatDate(gapEnd)} is missing after ${latest.file_name}`,
      )
    } else if (input.statement_start <= priorEnd) {
      issues.push(`overlaps ${latest.file_name}, which runs to ${formatDate(priorEnd)}`)
    }
  } else if (latest && !input.statement_start) {
    issues.push('this statement has no start date on record to compare')
  }

  const duplicate = priors.find(
    (p) =>
      p.statement_start != null &&
      p.statement_start === input.statement_start &&
      p.statement_end === input.statement_end,
  )
  if (duplicate) issues.push(`duplicate period — already imported as ${duplicate.file_name}`)

  if (issues.length > 0) {
    const detail = issues.join('; ')
    return { check, pass: false, detail: detail.charAt(0).toUpperCase() + detail.slice(1) + '.' }
  }
  if (!latest) {
    return { check, pass: true, detail: 'First import — no earlier statements to compare.' }
  }
  return {
    check,
    pass: true,
    detail: `Follows straight on from ${latest.file_name} (ends ${formatDate(latest.statement_end)}).`,
  }
}

function checkDuplicates(input: CheckInput, priors: BankImport[]): CheckOutcome {
  const check = 'no_duplicates' as const
  const seen = new Set<string>()
  for (const p of priors) {
    for (const r of p.parsed_rows ?? []) seen.add(rowKey(r))
  }
  const offending = input.rows.filter((r) => seen.has(rowKey(r)))
  if (offending.length === 0) {
    return {
      check,
      pass: true,
      detail:
        seen.size > 0
          ? `None of ${input.rows.length} rows match date, amount and description of earlier imports.`
          : `Nothing imported previously to compare — ${input.rows.length} rows are new by definition.`,
    }
  }
  return {
    check,
    pass: false,
    detail: `${offending.length} of ${input.rows.length} rows already appear in earlier imports (same date, amount and description).`,
    offending,
  }
}

/**
 * Run all four checks. `priors` must be the imports created before this one —
 * the caller filters by created_at so historical recomputation is faithful.
 */
export function runSenseChecks(input: CheckInput, priors: BankImport[]): CheckOutcome[] {
  const usable = sortPriors(
    priors.filter((p) => p.statement_end != null || (p.parsed_rows?.length ?? 0) > 0),
  )
  return [
    checkOpening(input, usable),
    checkRunningBalance(input),
    checkDates(input, usable),
    checkDuplicates(input, usable),
  ]
}

/** Strip drill-down rows before persisting to sense_check_results (jsonb). */
export function toPersisted(outcomes: CheckOutcome[]): SenseCheckResult[] {
  return outcomes.map(({ check, pass, detail }) => ({ check, pass, detail }))
}

export function statusFromChecks(outcomes: CheckOutcome[]): ImportStatus {
  return outcomes.every((o) => o.pass) ? 'ready' : 'checks_failed'
}

export function passCount(results: SenseCheckResult[] | null | undefined): { passed: number; total: number } {
  const list = results ?? []
  return { passed: list.filter((r) => r.pass).length, total: list.length }
}
