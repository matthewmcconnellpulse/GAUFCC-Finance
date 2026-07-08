/**
 * parse-import — parse an uploaded HSBC statement (CSV deterministic,
 * PDF via Claude) or an Epworth investment report (xlsx/xls deterministic
 * via SheetJS, PDF/CSV via Claude as a fallback for other layouts).
 *
 * JWT-verified; pulse_* roles only. Body { kind, storage_path } within the
 * 'imports' bucket.
 *
 * Returns per contract:
 * - hsbc_csv / hsbc_pdf → { rows, opening_balance?, closing_balance?,
 *   statement_start?, statement_end? }
 * - epworth → { period: 'YYYY-MM', holdings: [{ holding_ref, holding_name,
 *   income_type, amount }], meta: { source, cumulative_gains, gains_note,
 *   prior_period?, excluded_cash, cash_rows } }
 *
 * Epworth monthly workbooks carry a cumulative gain/loss per portfolio
 * account (since Epworth's opening valuation), not a monthly figure — the
 * month's unrealised movement is derived as the delta against the previous
 * import's stored cumulative gains, less the month's income net of fees.
 * meta.cumulative_gains is persisted in epworth_imports.parsed so the next
 * import can do the same.
 *
 * Note: Sonnet 5 rejects non-default sampling parameters, so the PDF
 * extraction asks for determinism in the prompt instead of temperature 0.
 */

import * as XLSX from 'npm:xlsx@0.18.5'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import {
  callClaude,
  callClaudeVision,
  bytesToBase64,
  resolveMediaType,
  extractJson,
} from '../_shared/ai.ts'

type Kind = 'hsbc_pdf' | 'hsbc_csv' | 'epworth'

interface Row {
  date: string
  description: string
  amount: number
  balance: number | null
  reference: string | null
}

interface StatementResult {
  rows: Row[]
  opening_balance?: number
  closing_balance?: number
  statement_start?: string
  statement_end?: string
}

const INCOME_TYPES = ['realised_gain', 'unrealised_gain', 'interest', 'dividend', 'fee'] as const
type IncomeType = (typeof INCOME_TYPES)[number]

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// ── Deterministic CSV parsing ────────────────────────────────────────────────

/** RFC-4180-ish CSV split: quoted fields, "" escapes, CRLF/CR/LF newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((cell) => cell.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) rows.push(row)
  return rows
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Parse UK statement dates: dd/mm/yyyy, dd/mm/yy, dd MMM yyyy, dd-MMM-yy, ISO. */
function parseUkDate(value: string): string | null {
  const s = value.trim()
  if (!s) return null

  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return validIso(Number(m[1]), Number(m[2]), Number(m[3]))

  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s)
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return validIso(year, Number(m[2]), Number(m[1]))
  }

  m = /^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})$/.exec(s)
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()]
    if (!month) return null
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return validIso(year, month, Number(m[1]))
  }
  return null
}

function validIso(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? null : iso
}

/** Parse '£1,234.56', '(970.00)', '1,234.56 CR', '123.45D' → signed number. */
function parseAmount(value: string): number | null {
  let s = value.trim().replace(/[£\s]/g, '').replace(/,/g, '')
  if (!s) return null
  let sign = 1
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1
    s = s.slice(1, -1)
  }
  const suffix = /^(-?\d+(?:\.\d+)?)(CR|DR|C|D)$/i.exec(s)
  if (suffix) {
    s = suffix[1]
    if (/^(DR|D)$/i.test(suffix[2])) sign = -1
  }
  const n = Number(s)
  return Number.isFinite(n) ? round2(n * sign) : null
}

interface ColumnMap {
  date: number
  description: number[]
  amount: number | null
  credit: number | null
  debit: number | null
  balance: number | null
  reference: number | null
}

/** HSBC net export headers vary — detect columns liberally by header name. */
function detectColumns(rows: string[][]): { map: ColumnMap; headerIndex: number } | null {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase())
    const dateIdx = cells.findIndex((c) => /\bdate\b/.test(c))
    if (dateIdx === -1) continue
    const hasMoney = cells.some((c) =>
      /amount|value|paid in|paid out|money in|money out|credit|debit|deposit|withdrawal|balance/.test(c),
    )
    if (!hasMoney) continue

    const find = (re: RegExp, exclude?: RegExp): number =>
      cells.findIndex((c) => re.test(c) && (!exclude || !exclude.test(c)))

    const credit = find(/credit|paid in|money in|deposit/, /debit|card/)
    const debit = find(/debit|paid out|money out|withdrawal/, /credit|card/)
    const amount = find(/^amount|^value|amount \(|transaction amount/, /balance/)
    const balance = find(/balance/)
    const reference = find(/reference|^ref\b/)
    const descIdxs: number[] = []
    cells.forEach((c, idx) => {
      if (/narrative|description|details|memo|payee|transaction(?! date| amount)/.test(c)) {
        descIdxs.push(idx)
      }
    })
    if (descIdxs.length === 0) {
      // Fall back to the column after the date that is not a money column.
      for (let idx = 0; idx < cells.length; idx++) {
        if (idx !== dateIdx && idx !== credit && idx !== debit && idx !== amount && idx !== balance) {
          descIdxs.push(idx)
          break
        }
      }
    }
    if (amount === -1 && credit === -1 && debit === -1) continue

    return {
      headerIndex: i,
      map: {
        date: dateIdx,
        description: descIdxs,
        amount: amount === -1 ? null : amount,
        credit: credit === -1 ? null : credit,
        debit: debit === -1 ? null : debit,
        balance: balance === -1 ? null : balance,
        reference: reference === -1 ? null : reference,
      },
    }
  }
  return null
}

/** Headerless fallback: HSBC classic order or [date, desc…, amount, balance]. */
function positionalMap(width: number): ColumnMap {
  if (width >= 6) {
    // Date, Type, Description, Paid out, Paid in, Balance
    return {
      date: 0,
      description: [1, 2],
      amount: null,
      debit: width - 3,
      credit: width - 2,
      balance: width - 1,
      reference: null,
    }
  }
  const description: number[] = []
  for (let i = 1; i <= width - 3; i++) description.push(i)
  if (description.length === 0) description.push(1)
  return {
    date: 0,
    description,
    amount: width - 2,
    debit: null,
    credit: null,
    balance: width >= 4 ? width - 1 : null,
    reference: null,
  }
}

function parseHsbcCsv(text: string): StatementResult {
  const grid = parseCsv(text)
  if (grid.length === 0) throw new Error('The file is empty')

  const detected = detectColumns(grid)
  let map: ColumnMap
  let startAt: number
  if (detected) {
    map = detected.map
    startAt = detected.headerIndex + 1
  } else {
    const firstDataRow = grid.find((r) => parseUkDate(r[0] ?? '') !== null)
    if (!firstDataRow) {
      throw new Error('Could not find a header row or dated transactions in this CSV')
    }
    map = positionalMap(firstDataRow.length)
    startAt = 0
  }

  const rows: Row[] = []
  let explicitOpening: number | null = null
  let explicitClosing: number | null = null

  for (let i = startAt; i < grid.length; i++) {
    const cells = grid[i]
    const joined = cells.join(' ').toLowerCase()
    const date = parseUkDate(cells[map.date] ?? '')

    if (/opening balance|balance brought forward/.test(joined)) {
      const bal = map.balance !== null ? parseAmount(cells[map.balance] ?? '') : null
      if (bal !== null) explicitOpening = bal
      continue
    }
    if (/closing balance|balance carried forward/.test(joined)) {
      const bal = map.balance !== null ? parseAmount(cells[map.balance] ?? '') : null
      if (bal !== null) explicitClosing = bal
      continue
    }
    if (!date) continue

    let amount: number | null = null
    if (map.amount !== null) {
      amount = parseAmount(cells[map.amount] ?? '')
    }
    if (amount === null && (map.credit !== null || map.debit !== null)) {
      const credit = map.credit !== null ? parseAmount(cells[map.credit] ?? '') : null
      const debit = map.debit !== null ? parseAmount(cells[map.debit] ?? '') : null
      if (credit !== null || debit !== null) {
        amount = round2((credit ?? 0) - Math.abs(debit ?? 0))
      }
    }
    if (amount === null) continue

    const description = map.description
      .map((idx) => (cells[idx] ?? '').trim())
      .filter(Boolean)
      .join(' — ')
    const balance = map.balance !== null ? parseAmount(cells[map.balance] ?? '') : null
    const reference =
      map.reference !== null ? (cells[map.reference] ?? '').trim() || null : null

    rows.push({ date, description: description || 'Transaction', amount, balance, reference })
  }

  if (rows.length === 0) throw new Error('No transactions could be parsed from this CSV')

  // Ensure chronological order (statements sometimes export newest-first).
  if (rows[0].date > rows[rows.length - 1].date) rows.reverse()

  const result: StatementResult = { rows }
  result.statement_start = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date)
  result.statement_end = rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date)

  const first = rows[0]
  const last = rows[rows.length - 1]
  if (explicitOpening !== null) {
    result.opening_balance = explicitOpening
  } else if (first.balance !== null) {
    result.opening_balance = round2(first.balance - first.amount)
  }
  if (explicitClosing !== null) {
    result.closing_balance = explicitClosing
  } else if (last.balance !== null) {
    result.closing_balance = last.balance
  }
  return result
}

// ── Claude extraction (PDF statements, Epworth) ─────────────────────────────

const HSBC_PDF_SYSTEM = `You transcribe UK bank statements (HSBC corporate) into structured data for a charity bookkeeper.
Be deterministic and literal: transcribe every transaction line exactly as printed — no summarising, no skipping, no inventing.
Respond with ONLY a JSON object, no markdown:
{
  "statement_start": "YYYY-MM-DD or null",
  "statement_end": "YYYY-MM-DD or null",
  "opening_balance": number or null,
  "closing_balance": number or null,
  "rows": [
    {
      "date": "YYYY-MM-DD",
      "description": "full narrative for the line",
      "amount": number — signed, payments OUT are negative, receipts IN are positive,
      "balance": running balance after the line, or null if not printed,
      "reference": "payment type or reference code (e.g. DD, BP, TRF), or null"
    }
  ]
}
Multi-line narratives belong to one transaction — join them with a space.`

interface RawStatement {
  statement_start?: unknown
  statement_end?: unknown
  opening_balance?: unknown
  closing_balance?: unknown
  rows?: unknown
}

function asOptionalNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? round2(n) : undefined
}

function normaliseStatement(raw: RawStatement): StatementResult {
  const rows: Row[] = []
  if (Array.isArray(raw.rows)) {
    for (const item of raw.rows) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      const date = typeof r.date === 'string' ? parseUkDate(r.date) : null
      const amount = asOptionalNumber(r.amount)
      if (!date || amount === undefined) continue
      rows.push({
        date,
        description:
          typeof r.description === 'string' && r.description.trim()
            ? r.description.trim()
            : 'Transaction',
        amount,
        balance: asOptionalNumber(r.balance) ?? null,
        reference:
          typeof r.reference === 'string' && r.reference.trim() ? r.reference.trim() : null,
      })
    }
  }
  if (rows.length === 0) {
    throw new Error('No transactions could be extracted from this statement')
  }
  const result: StatementResult = { rows }
  const start = typeof raw.statement_start === 'string' ? parseUkDate(raw.statement_start) : null
  const end = typeof raw.statement_end === 'string' ? parseUkDate(raw.statement_end) : null
  result.statement_start =
    start ?? rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date)
  result.statement_end =
    end ?? rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date)
  const opening = asOptionalNumber(raw.opening_balance)
  const closing = asOptionalNumber(raw.closing_balance)
  if (opening !== undefined) result.opening_balance = opening
  if (closing !== undefined) result.closing_balance = closing
  return result
}

const EPWORTH_SYSTEM = `You transcribe Epworth Investment Management monthly reports for a UK charity.
Extract the reporting period and, for every holding, the income figures for the month.
Be deterministic and literal — transcribe exactly what is printed; never invent figures.
Respond with ONLY a JSON object, no markdown:
{
  "period": "YYYY-MM — the month the report covers",
  "holdings": [
    {
      "holding_ref": "the holding's reference/account code as printed",
      "holding_name": "the holding or fund name as printed",
      "income_type": one of "realised_gain" | "unrealised_gain" | "interest" | "dividend" | "fee",
      "amount": number — pounds, negative for losses and fees
    }
  ]
}
Emit one entry per holding per income type that appears (a holding with both a dividend and an unrealised gain becomes two entries). Management/platform fees are income_type "fee" with a NEGATIVE amount. Omit zero rows only if they are not printed.`

interface RawEpworth {
  period?: unknown
  holdings?: unknown
}

function normaliseIncomeType(value: unknown): IncomeType | null {
  const s = String(value ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_')
  if ((INCOME_TYPES as readonly string[]).includes(s)) return s as IncomeType
  if (s.includes('fee') || s.includes('charge')) return 'fee'
  if (s.includes('unreal')) return 'unrealised_gain'
  if (s.includes('real')) return 'realised_gain'
  if (s.includes('interest')) return 'interest'
  if (s.includes('dividend') || s.includes('distribution')) return 'dividend'
  return null
}

function normaliseEpworth(raw: RawEpworth): {
  period: string
  holdings: { holding_ref: string; holding_name: string; income_type: IncomeType; amount: number }[]
} {
  const period =
    typeof raw.period === 'string' && /^\d{4}-\d{2}$/.test(raw.period.trim())
      ? raw.period.trim()
      : null
  if (!period) throw new Error('Could not determine the reporting period from this file')

  const holdings: {
    holding_ref: string
    holding_name: string
    income_type: IncomeType
    amount: number
  }[] = []
  if (Array.isArray(raw.holdings)) {
    for (const item of raw.holdings) {
      if (typeof item !== 'object' || item === null) continue
      const h = item as Record<string, unknown>
      const incomeType = normaliseIncomeType(h.income_type)
      const amount = asOptionalNumber(h.amount)
      const ref = typeof h.holding_ref === 'string' ? h.holding_ref.trim() : ''
      const name = typeof h.holding_name === 'string' ? h.holding_name.trim() : ''
      if (!incomeType || amount === undefined || (!ref && !name)) continue
      holdings.push({
        holding_ref: ref || name,
        holding_name: name || ref,
        income_type: incomeType,
        amount,
      })
    }
  }
  if (holdings.length === 0) {
    throw new Error('No holdings could be extracted from this report')
  }
  return { period, holdings }
}

// ── Epworth workbook (xlsx/xls) — deterministic parsing ─────────────────────
//
// The monthly workbook Epworth send has (sheet names may drift slightly, so
// they are matched loosely):
// - 'DSC - Transactions': one row per cash movement on each discretionary
//   portfolio account — dividends/interest in, management & platform fees out
//   (amounts already signed).
// - 'Gains_Losses Inc Cash (adj)': one row per account with the CUMULATIVE
//   gain/loss since Epworth's opening valuation (Close − Open − Injections).
// - 'Epworth Cash Plus Fund Accounts': deposit-fund statements; 'Interest'
//   and 'Subscription' credits are the month's distribution, transfers and
//   redemptions are capital movements (excluded, surfaced in meta).

/** Thrown when the spreadsheet doesn't look like an Epworth monthly workbook. */
class LayoutError extends Error {}

type Grid = (string | number | boolean | null)[][]

function sheetGrid(ws: XLSX.WorkSheet): Grid {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as Grid
}

function cellText(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function cellNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = cellText(v).replace(/[£,\s]/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Excel serial / JS Date / date string → ISO date. */
function cellToIso(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return validIso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 80000) {
    // Excel 1900 date system: serial 25569 = 1970-01-01.
    const d = new Date(Math.round((v - 25569) * 86_400_000))
    return validIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  if (typeof v === 'string') return parseUkDate(v)
  return null
}

/** First row (within the top 12) where every regex matches some cell. */
function findHeaderRow(grid: Grid, tests: RegExp[]): number {
  for (let i = 0; i < Math.min(grid.length, 12); i++) {
    const cells = grid[i].map(cellText)
    if (tests.every((re) => cells.some((c) => re.test(c)))) return i
  }
  return -1
}

function findSheet(wb: XLSX.WorkBook, ...tests: RegExp[]): XLSX.WorkSheet | null {
  const name = wb.SheetNames.find((n) => tests.every((re) => re.test(n)))
  return name ? wb.Sheets[name] : null
}

/** 'General Assembly of Unitarians – Growth & Development Fund' → the fund part. */
function shortAccountName(name: string): string {
  const parts = name.split(/\s+[–—]\s+/)
  return (parts[parts.length - 1] || name).trim()
}

/** Loose key for matching gains-sheet names to transaction-sheet names. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()
}

/** DSC transaction sub-types → posting type; capital movements are excluded. */
function classifySubType(s: string): IncomeType | 'capital' | null {
  const t = s.toLowerCase()
  if (!t) return null
  if (/fee|charge/.test(t)) return 'fee'
  if (/unrealised|unrealized/.test(t)) return 'unrealised_gain'
  if (/realised|realized/.test(t)) return 'realised_gain'
  if (/interest/.test(t)) return 'interest'
  if (/dividend|distribution/.test(t)) return 'dividend'
  if (/purchase|sale|buy|sell|transfer|redemption|subscription|injection|withdraw|switch|deposit/.test(t)) {
    return 'capital'
  }
  return null
}

interface EpworthHolding {
  holding_ref: string
  holding_name: string
  income_type: IncomeType
  amount: number
}

interface EpworthCashRow {
  date: string
  amount: number
  description: string
  reference: string
}

interface ExcludedCash {
  account_ref: string
  date: string
  narrative: string
  amount: number
}

interface EpworthWorkbook {
  period: string
  holdings: EpworthHolding[]
  /** account ref → cumulative gain/loss since Epworth inception */
  cumulativeGains: Record<string, number>
  /** account ref → this month's dividends + interest + fees (fees negative) */
  netIncomeByRef: Record<string, number>
  nameByRef: Record<string, string>
  excludedCash: ExcludedCash[]
  cashRows: EpworthCashRow[]
}

function parseEpworthWorkbook(wb: XLSX.WorkBook): EpworthWorkbook {
  // 1. DSC transactions — the month's dividends, interest and fees.
  const txSheet = findSheet(wb, /transaction/i)
  if (!txSheet) throw new LayoutError('No transactions sheet found in this workbook')
  const grid = sheetGrid(txSheet)
  const headerIdx = findHeaderRow(grid, [/account.?id/i, /amount/i, /date/i])
  if (headerIdx === -1) {
    throw new LayoutError('Could not find the transaction sheet header row')
  }
  const header = grid[headerIdx].map(cellText)
  const col = (re: RegExp) => header.findIndex((c) => re.test(c))
  const cAcct = col(/account.?id/i)
  const cName = col(/account.?name/i)
  const cDate = col(/date/i)
  const cSub = col(/sub.?_?type/i) !== -1 ? col(/sub.?_?type/i) : col(/type/i)
  const cAsset = col(/asset/i)
  const cAmt = col(/^amount/i)
  if (cAcct === -1 || cDate === -1 || cSub === -1 || cAmt === -1) {
    throw new LayoutError('The transaction sheet is missing expected columns')
  }

  interface Tx {
    ref: string
    name: string
    date: string
    sub: string
    asset: string
    amount: number
  }
  const txs: Tx[] = []
  const nameByRef: Record<string, string> = {}
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i]
    const ref = cellText(row[cAcct])
    const date = cellToIso(row[cDate])
    const amount = cellNumber(row[cAmt])
    if (!ref || !date || amount === null) continue
    const name = cName !== -1 ? cellText(row[cName]) : ''
    if (name && !nameByRef[ref]) nameByRef[ref] = name
    txs.push({
      ref,
      name: name || ref,
      date,
      sub: cellText(row[cSub]),
      asset: cAsset !== -1 ? cellText(row[cAsset]) : '',
      amount: round2(amount),
    })
  }
  if (txs.length === 0) throw new LayoutError('No transactions found in this workbook')

  // The reporting period is the latest month present; older rows (some sheets
  // carry history) are ignored for the totals.
  const period = txs.reduce((max, t) => (t.date > max ? t.date : max), txs[0].date).slice(0, 7)
  const inPeriod = (iso: string) => iso.startsWith(period)

  const totals = new Map<string, number>() // `${ref}|${type}` → amount
  const excludedCash: ExcludedCash[] = []
  const cashRows: EpworthCashRow[] = []
  for (const t of txs) {
    if (!inPeriod(t.date)) continue
    const type = classifySubType(t.sub)
    if (type === 'capital' || type === null) {
      excludedCash.push({ account_ref: t.ref, date: t.date, narrative: t.sub || 'Unrecognised', amount: t.amount })
      continue
    }
    const key = `${t.ref}|${type}`
    totals.set(key, round2((totals.get(key) ?? 0) + t.amount))
    cashRows.push({
      date: t.date,
      amount: t.amount,
      description: `${shortAccountName(t.name)}: ${t.sub}${t.asset ? ` — ${t.asset}` : ''}`,
      reference: t.ref,
    })
  }

  // 2. Cash Plus deposit accounts — Interest/Subscription credits are the
  // month's distribution; transfers/redemptions are capital movements.
  const cashSheet = findSheet(wb, /cash\s*plus/i)
  if (cashSheet) {
    const cg = sheetGrid(cashSheet)
    const ch = findHeaderRow(cg, [/narrative/i, /date/i])
    if (ch !== -1) {
      const chead = cg[ch].map(cellText)
      const ccol = (re: RegExp) => chead.findIndex((c) => re.test(c))
      const kRef = ccol(/ref/i)
      const kDate = ccol(/date/i)
      const kNarr = ccol(/narrative/i)
      const kVal = ccol(/value|amount/i)
      if (kRef !== -1 && kDate !== -1 && kNarr !== -1 && kVal !== -1) {
        for (let i = ch + 1; i < cg.length; i++) {
          const row = cg[i]
          const ref = cellText(row[kRef])
          const date = cellToIso(row[kDate])
          const amount = cellNumber(row[kVal])
          if (!ref || !date || amount === null || !inPeriod(date)) continue
          const narrative = cellText(row[kNarr])
          const holdingName = `Epworth Cash Plus ${ref}`
          if (/interest|subscription/i.test(narrative)) {
            // Subscription credits are the deposit fund's distribution
            // reinvested as units — income, posted as interest.
            const key = `${ref}|interest`
            totals.set(key, round2((totals.get(key) ?? 0) + amount))
            if (!nameByRef[ref]) nameByRef[ref] = holdingName
            cashRows.push({ date, amount: round2(amount), description: `${holdingName}: ${narrative}`, reference: ref })
          } else {
            excludedCash.push({ account_ref: ref, date, narrative: narrative || 'Unrecognised', amount: round2(amount) })
          }
        }
      }
    }
  }

  const holdings: EpworthHolding[] = []
  const netIncomeByRef: Record<string, number> = {}
  for (const [key, amount] of totals) {
    if (amount === 0) continue
    const [ref, type] = key.split('|')
    holdings.push({
      holding_ref: ref,
      holding_name: nameByRef[ref] ?? ref,
      income_type: type as IncomeType,
      amount,
    })
    netIncomeByRef[ref] = round2((netIncomeByRef[ref] ?? 0) + amount)
  }

  // 3. Gains sheet — cumulative gain/loss per account. Prefer the '(adj)'
  // variant (its Gain/Loss is net of capital injections).
  const gainsSheet = findSheet(wb, /gain/i, /adj/i) ?? findSheet(wb, /gain/i)
  const cumulativeGains: Record<string, number> = {}
  if (gainsSheet) {
    const gg = sheetGrid(gainsSheet)
    const gh = findHeaderRow(gg, [/gain/i])
    if (gh !== -1) {
      const ghead = gg[gh].map(cellText)
      const gGain = ghead.findIndex((c) => /gain/i.test(c))
      const refByName = new Map<string, string>()
      for (const [ref, name] of Object.entries(nameByRef)) refByName.set(nameKey(name), ref)
      for (let i = gh + 1; i < gg.length; i++) {
        const row = gg[i]
        const name = cellText(row[0])
        if (!name || /^total/i.test(name)) continue
        const gain = cellNumber(row[gGain])
        if (gain === null) continue
        const ref = refByName.get(nameKey(name)) ?? name
        cumulativeGains[ref] = round2(gain)
      }
    }
  }

  return { period, holdings, cumulativeGains, netIncomeByRef, nameByRef, excludedCash, cashRows }
}

interface PriorImport {
  period: string
  gains: Record<string, number>
}

/** Latest earlier import whose stored meta carries cumulative gains. */
async function findPriorImport(svc: SupabaseClient, period: string): Promise<PriorImport | null> {
  const { data } = await svc
    .from('epworth_imports')
    .select('period, parsed, created_at')
    .lt('period', period)
    .order('period', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(10)
  for (const row of data ?? []) {
    const meta = (row.parsed as { meta?: { cumulative_gains?: unknown } } | null)?.meta
    const gains = meta?.cumulative_gains
    if (gains && typeof gains === 'object' && Object.keys(gains).length > 0) {
      const clean: Record<string, number> = {}
      for (const [k, v] of Object.entries(gains as Record<string, unknown>)) {
        const n = typeof v === 'number' ? v : Number(v)
        if (Number.isFinite(n)) clean[k] = n
      }
      if (Object.keys(clean).length > 0) return { period: row.period as string, gains: clean }
    }
  }
  return null
}

/**
 * Derive the month's unrealised-gain movement per account and assemble the
 * final response. Workbook gains are cumulative since Epworth's opening
 * valuation, so: movement = Δcumulative (vs the prior import) − the month's
 * income net of fees (income received sits in the account's cash and is
 * already inside the cumulative figure).
 */
function finaliseEpworth(parsed: EpworthWorkbook, prior: PriorImport | null) {
  const holdings = [...parsed.holdings]
  for (const [ref, cum] of Object.entries(parsed.cumulativeGains)) {
    const prev = prior ? (prior.gains[ref] ?? 0) : 0
    const net = parsed.netIncomeByRef[ref] ?? 0
    const amount = round2(cum - prev - net)
    if (amount === 0) continue
    holdings.push({
      holding_ref: ref,
      holding_name: parsed.nameByRef[ref] ?? ref,
      income_type: 'unrealised_gain',
      amount,
    })
  }

  const gains_note = prior
    ? `Unrealised gains are the movement in Epworth's cumulative gain/loss since the ${prior.period} import, less the month's income net of fees.`
    : `First Epworth import — no earlier import to diff against, so the unrealised gains are the CUMULATIVE gain/loss since Epworth's opening valuation (less this month's income net of fees). Check what is already on the books for earlier months before posting; future imports will show the monthly movement automatically.`

  return {
    period: parsed.period,
    holdings,
    meta: {
      source: 'workbook' as const,
      cumulative_gains: parsed.cumulativeGains,
      gains_note,
      ...(prior ? { prior_period: prior.period } : {}),
      excluded_cash: parsed.excludedCash,
      cash_rows: parsed.cashRows,
    },
  }
}

/** Flatten a workbook to labelled CSV text for the Claude fallback. */
function workbookToText(wb: XLSX.WorkBook): string {
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    parts.push(`=== Sheet: ${name} ===`)
    parts.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]))
  }
  return parts.join('\n').slice(0, 150_000)
}

// ── Handler ──────────────────────────────────────────────────────────────────

function isSafeStoragePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 1024 &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\\')
  )
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as
    | { kind?: unknown; storage_path?: unknown }
    | null
  const kind = body?.kind
  const storagePath = body?.storage_path
  if (kind !== 'hsbc_pdf' && kind !== 'hsbc_csv' && kind !== 'epworth') {
    return errorResponse("kind must be 'hsbc_pdf', 'hsbc_csv' or 'epworth'")
  }
  if (typeof storagePath !== 'string' || !isSafeStoragePath(storagePath)) {
    return errorResponse('storage_path is required')
  }

  const svc = serviceClient()
  const { data: blob, error: downloadError } = await svc.storage
    .from('imports')
    .download(storagePath)
  if (downloadError || !blob) {
    return errorResponse('Import file not found', 404)
  }

  try {
    if ((kind as Kind) === 'hsbc_csv') {
      const text = await blob.text()
      return json(parseHsbcCsv(text))
    }

    if ((kind as Kind) === 'hsbc_pdf') {
      const mediaType = resolveMediaType(storagePath, blob.type)
      if (mediaType !== 'application/pdf') {
        return errorResponse('hsbc_pdf expects a PDF file')
      }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const text = await callClaudeVision(
        { data: bytesToBase64(bytes), media_type: 'application/pdf' },
        'Transcribe this bank statement. Respond with only the JSON object.',
        { system: HSBC_PDF_SYSTEM, maxTokens: 32000 },
      )
      return json(normaliseStatement(extractJson<RawStatement>(text)))
    }

    // epworth — xlsx/xls deterministic (Claude fallback on unfamiliar
    // layouts), PDF via document block, CSV/text inline.
    const ext = storagePath.slice(storagePath.lastIndexOf('.') + 1).toLowerCase()
    if (ext === 'xlsx' || ext === 'xls') {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let wb: XLSX.WorkBook
      try {
        wb = XLSX.read(bytes, { type: 'array' })
      } catch {
        return errorResponse('Could not read this spreadsheet — is it a valid Excel file?', 422)
      }
      try {
        const parsed = parseEpworthWorkbook(wb)
        const prior = await findPriorImport(svc, parsed.period)
        return json(finaliseEpworth(parsed, prior))
      } catch (e) {
        if (!(e instanceof LayoutError)) throw e
        console.warn('[parse-import] epworth workbook layout not recognised, falling back to Claude:', e.message)
        const text = await callClaude({
          system: EPWORTH_SYSTEM,
          maxTokens: 16000,
          messages: [
            {
              role: 'user',
              content: `Here is the Epworth report, one CSV block per spreadsheet tab:\n\n${workbookToText(wb)}\n\nRespond with only the JSON object.`,
            },
          ],
        })
        const result = normaliseEpworth(extractJson<RawEpworth>(text))
        return json({ ...result, meta: { source: 'ai' } })
      }
    }

    const mediaType = resolveMediaType(storagePath, blob.type)
    let text: string
    if (mediaType === 'application/pdf') {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      text = await callClaudeVision(
        { data: bytesToBase64(bytes), media_type: 'application/pdf' },
        'Transcribe this Epworth report. Respond with only the JSON object.',
        { system: EPWORTH_SYSTEM, maxTokens: 16000 },
      )
    } else {
      const fileText = await blob.text()
      if (!fileText.trim()) return errorResponse('The file is empty')
      text = await callClaude({
        system: EPWORTH_SYSTEM,
        maxTokens: 16000,
        messages: [
          {
            role: 'user',
            content: `Here is the Epworth report as CSV/text:\n\n${fileText}\n\nRespond with only the JSON object.`,
          },
        ],
      })
    }
    const result = normaliseEpworth(extractJson<RawEpworth>(text))
    return json({ ...result, meta: { source: 'ai' } })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Import parsing failed'
    console.error('[parse-import]', message)
    return errorResponse(message, 422)
  }
})
