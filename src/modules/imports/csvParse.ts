/**
 * Deterministic client-side parser for HSBC business banking CSV exports.
 *
 * Handles: quoted fields (embedded commas/newlines/escaped quotes), BOM,
 * dd/mm/yyyy dates, signed single-amount layouts, separate paid-in/paid-out
 * (credit/debit) columns, an optional running-balance column, headerless
 * exports, statements listed newest-first, £/comma/CR/DR amount decorations
 * and balance-brought/carried-forward rows.
 *
 * Returns null when the layout cannot be recognised — the caller falls back
 * to the parse-import edge function (Claude extraction).
 */
import type { BankImportRow } from '@/types/db'
import { round2, type ParseImportResponse } from './lib'

export interface HsbcParseResult {
  rows: BankImportRow[]
  opening_balance: number | null
  closing_balance: number | null
  statement_start: string | null
  statement_end: string | null
  /** short human note about the layout that was recognised */
  layout: string
}

// ── Low-level CSV ────────────────────────────────────────────────────────────

/** RFC-4180-ish parse: quoted fields, "" escapes, CR/LF/CRLF row endings. */
export function parseCsvText(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      if (ch === '\r' && src[i + 1] === '\n') i += 2
      else i += 1
      continue
    }
    field += ch
    i += 1
  }
  row.push(field)
  rows.push(row)
  // drop rows that are entirely empty
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

// ── Dates & amounts ──────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(y, m, 0).getDate()
}

/** UK-convention date → ISO 'yyyy-mm-dd', or null. Accepts dd/mm/yyyy, dd-mm-yy, dd MMM yyyy, yyyy-mm-dd. */
export function parseUkDate(raw: string): string | null {
  const s = raw.trim()
  if (s === '') return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return validDate(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null
  }
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s)
  if (m) {
    const d = Number(m[1])
    const mo = Number(m[2])
    let y = Number(m[3])
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900
    return validDate(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{2,4})$/.exec(s)
  if (m) {
    const d = Number(m[1])
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]
    let y = Number(m[3])
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900
    if (!mo) return null
    return validDate(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null
  }
  return null
}

/**
 * Money cell → signed number, or null. Strips £/commas/spaces, understands
 * parentheses and trailing/leading CR/DR markers and the unicode minus.
 */
export function parseAmount(raw: string): number | null {
  if (raw == null) return null
  let s = raw.trim()
  if (s === '' || s === '-' || s === '–' || s === '—') return null
  let sign = 1
  if (/^\(.*\)$/.test(s)) {
    sign = -1
    s = s.slice(1, -1)
  }
  const upper = s.toUpperCase()
  if (/(^|\s)DR\.?$/.test(upper) || /^DR(\s|\d)/.test(upper)) sign = -1
  s = s.replace(/\b(CR|DR)\b\.?/gi, '')
  s = s.replace(/[£$€\s,']/g, '').replace(/−/g, '-').replace(/–/g, '-')
  if (s.startsWith('+')) s = s.slice(1)
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  const v = Number.parseFloat(s)
  if (!Number.isFinite(v)) return null
  return round2(sign * v)
}

// ── Layout detection ─────────────────────────────────────────────────────────

interface ColumnMap {
  date: number
  description: number[]
  amount: number | null
  paidIn: number | null
  paidOut: number | null
  balance: number | null
  reference: number | null
  layout: string
}

function findIndex(headers: string[], test: RegExp, exclude?: RegExp): number | null {
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i]
    if (test.test(h) && !(exclude && exclude.test(h))) return i
  }
  return null
}

/** Map header cells onto columns for the known HSBC layouts. */
function mapHeaderColumns(header: string[]): ColumnMap | null {
  const hs = header.map((h) => h.trim().toLowerCase())
  const date = findIndex(hs, /\bdate\b/, /update|effective from/)
  if (date == null) return null
  const balance = findIndex(hs, /balance/)
  const paidOut = findIndex(hs, /paid\s*out|debit|money\s*out|withdraw/, /balance/)
  const paidIn = findIndex(hs, /paid\s*in|credit|money\s*in|deposit/, /balance|card/)
  const amount = findIndex(hs, /amount|value$/, /balance/)
  if (amount == null && (paidIn == null || paidOut == null)) return null
  const description: number[] = []
  for (let i = 0; i < hs.length; i += 1) {
    if (/description|narrative|details|memo|transaction|payee|name/.test(hs[i]) && !/date|amount/.test(hs[i])) {
      description.push(i)
    }
  }
  if (description.length === 0) {
    const type = findIndex(hs, /^type$/)
    if (type != null) description.push(type)
  }
  const reference = findIndex(hs, /\bref/, /description/)
  const usePair = paidIn != null && paidOut != null
  return {
    date,
    description,
    amount: usePair ? null : amount,
    paidIn: usePair ? paidIn : null,
    paidOut: usePair ? paidOut : null,
    balance,
    reference,
    layout: usePair
      ? 'paid in / paid out columns'
      : balance != null
        ? 'signed amount with running balance'
        : 'signed amount column',
  }
}

/**
 * Headerless HSBC export: first field is a date; infer the amount/balance
 * columns from which fields consistently parse as numbers.
 */
function mapHeaderlessColumns(dataRows: string[][]): ColumnMap | null {
  const sample = dataRows.slice(0, Math.min(dataRows.length, 20))
  if (sample.length === 0) return null
  const width = Math.max(...sample.map((r) => r.length))
  if (width < 2) return null
  const numericVotes = new Array<number>(width).fill(0)
  for (const r of sample) {
    for (let i = 1; i < width; i += 1) {
      const cell = (r[i] ?? '').trim()
      if (cell !== '' && parseUkDate(cell) == null && parseAmount(cell) != null) numericVotes[i] += 1
    }
  }
  const numericCols = numericVotes
    .map((votes, i) => ({ votes, i }))
    .filter((c) => c.i > 0 && c.votes >= sample.length * 0.6)
    .map((c) => c.i)
  if (numericCols.length === 0) return null
  let amount: number | null = null
  let paidIn: number | null = null
  let paidOut: number | null = null
  let balance: number | null = null
  if (numericCols.length === 1) {
    amount = numericCols[0]
  } else if (numericCols.length === 2) {
    amount = numericCols[0]
    balance = numericCols[1]
  } else {
    // out / in / balance — HSBC lists money out before money in
    paidOut = numericCols[numericCols.length - 3]
    paidIn = numericCols[numericCols.length - 2]
    balance = numericCols[numericCols.length - 1]
  }
  const numericSet = new Set(numericCols)
  const description: number[] = []
  for (let i = 1; i < width; i += 1) {
    if (!numericSet.has(i)) description.push(i)
  }
  return {
    date: 0,
    description,
    amount,
    paidIn,
    paidOut,
    balance,
    reference: null,
    layout: 'headerless export',
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export function parseHsbcCsv(text: string): HsbcParseResult | null {
  const all = parseCsvText(text)
  if (all.length === 0) return null

  // Find the header row within the first 30 lines (exports often carry
  // account-name preamble above the table).
  let cols: ColumnMap | null = null
  let dataStart = 0
  for (let i = 0; i < Math.min(all.length, 30); i += 1) {
    const mapped = mapHeaderColumns(all[i])
    if (mapped) {
      cols = mapped
      dataStart = i + 1
      break
    }
  }
  if (!cols) {
    const dataRows = all.filter((r) => parseUkDate((r[0] ?? '').trim()) != null)
    cols = mapHeaderlessColumns(dataRows)
    if (!cols) return null
    dataStart = 0
  }

  let openingFromRow: number | null = null
  let closingFromRow: number | null = null
  const rows: BankImportRow[] = []
  let candidateRows = 0

  for (let i = dataStart; i < all.length; i += 1) {
    const r = all[i]
    const date = parseUkDate((r[cols.date] ?? '').trim())
    if (date == null) continue
    candidateRows += 1
    const descParts = cols.description
      .map((idx) => (r[idx] ?? '').trim())
      .filter((p) => p !== '')
    const description = descParts.join(' · ')
    const balance = cols.balance != null ? parseAmount(r[cols.balance] ?? '') : null

    let amount: number | null = null
    if (cols.amount != null) {
      amount = parseAmount(r[cols.amount] ?? '')
    } else if (cols.paidIn != null && cols.paidOut != null) {
      const paidIn = parseAmount(r[cols.paidIn] ?? '')
      const paidOut = parseAmount(r[cols.paidOut] ?? '')
      if (paidIn != null || paidOut != null) {
        // paid-out columns list money out as a positive figure
        amount = round2((paidIn ?? 0) - Math.abs(paidOut ?? 0))
      }
    }

    if (amount == null) {
      // Balance brought/carried forward marker rows — recognised markers are
      // not counted as failed candidates.
      const lower = description.toLowerCase()
      if (balance != null && /brought forward|opening balance|balance b\/?f/.test(lower)) {
        openingFromRow = balance
        candidateRows -= 1
      } else if (balance != null && /carried forward|closing balance|balance c\/?f/.test(lower)) {
        closingFromRow = balance
        candidateRows -= 1
      }
      continue
    }

    const reference = cols.reference != null ? (r[cols.reference] ?? '').trim() || null : null
    rows.push({ date, description, amount, balance, reference })
  }

  if (rows.length === 0) return null
  // Too many unreadable candidate lines → let the edge function have a go.
  if (rows.length < candidateRows * 0.7) return null

  // Statements are often exported newest-first — flip to chronological order.
  if (rows[0].date > rows[rows.length - 1].date) rows.reverse()

  const first = rows[0]
  const last = rows[rows.length - 1]
  let opening = openingFromRow
  if (opening == null && first.balance != null) opening = round2(first.balance - first.amount)
  let closing = closingFromRow
  if (closing == null && last.balance != null) closing = last.balance
  if (closing == null && opening != null) {
    closing = round2(opening + rows.reduce((s, r) => s + r.amount, 0))
  }

  return {
    rows,
    opening_balance: opening,
    closing_balance: closing,
    statement_start: first.date,
    statement_end: last.date,
    layout: cols.layout,
  }
}

// ── Edge-function response normalisation ─────────────────────────────────────

/**
 * Bring a parse-import response (PDF/CSV via Claude) onto the same shape the
 * deterministic parser produces: ISO dates, rounded amounts, chronological
 * order and derived opening/closing/statement dates where missing.
 */
export function normaliseParsedStatement(resp: ParseImportResponse, layout: string): HsbcParseResult {
  const rows: BankImportRow[] = []
  for (const r of resp.rows ?? []) {
    const date = parseUkDate(String(r.date ?? ''))
    const amount = typeof r.amount === 'number' ? r.amount : parseAmount(String(r.amount ?? ''))
    if (date == null || amount == null) continue
    const balance =
      typeof r.balance === 'number' ? round2(r.balance) : r.balance != null ? parseAmount(String(r.balance)) : null
    rows.push({
      date,
      description: r.description ?? '',
      amount: round2(amount),
      balance,
      reference: r.reference ?? null,
    })
  }
  if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) rows.reverse()

  const first = rows[0]
  const last = rows[rows.length - 1]
  let opening = resp.opening_balance != null ? round2(resp.opening_balance) : null
  if (opening == null && first?.balance != null) opening = round2(first.balance - first.amount)
  let closing = resp.closing_balance != null ? round2(resp.closing_balance) : null
  if (closing == null && last?.balance != null) closing = last.balance
  if (closing == null && opening != null) {
    closing = round2(opening + rows.reduce((s, r) => s + r.amount, 0))
  }

  return {
    rows,
    opening_balance: opening,
    closing_balance: closing,
    statement_start: parseUkDate(String(resp.statement_start ?? '')) ?? first?.date ?? null,
    statement_end: parseUkDate(String(resp.statement_end ?? '')) ?? last?.date ?? null,
    layout,
  }
}
