/**
 * CSV generation — Xero bank statement CSV, Epworth manual-journal CSV and
 * the plain posting summary. All client-side; files are downloaded as Blobs
 * and (for the bank CSV) stored back to the imports bucket.
 *
 * Xero bank statement columns, exactly: Date, Amount, Payee, Description,
 * Reference. Dates dd/mm/yyyy; amounts signed with money in positive.
 */
import type { BankImportRow, IncomeType } from '@/types/db'
import { INCOME_TYPES, INCOME_TYPE_LABELS, isoToUk, round2 } from './lib'

// ── Primitive CSV plumbing ───────────────────────────────────────────────────

export function csvField(value: string | number | null | undefined): string {
  if (value == null) return ''
  const s = typeof value === 'number' ? formatCsvAmount(value) : String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Machine-readable signed amount: plain minus, two decimals, no thousands separators. */
export function formatCsvAmount(v: number): string {
  return round2(v).toFixed(2)
}

export function buildCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [headers.map(csvField).join(',')]
  for (const row of rows) lines.push(row.map(csvField).join(','))
  return lines.join('\r\n') + '\r\n'
}

/** Client-side Blob download. */
export function downloadTextFile(fileName: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── HSBC → Xero bank statement CSV ───────────────────────────────────────────

export const XERO_BANK_HEADERS = ['Date', 'Amount', 'Payee', 'Description', 'Reference']

/**
 * Payee is left blank deliberately — HSBC narrative lines do not separate the
 * counterparty reliably, and a wrong payee is worse than none on bank rec.
 */
export function buildXeroBankCsv(rows: BankImportRow[]): string {
  return buildCsv(
    XERO_BANK_HEADERS,
    rows.map((r) => [isoToUk(r.date), r.amount, '', r.description, r.reference ?? '']),
  )
}

export function xeroBankCsvFileName(start: string | null, end: string | null): string {
  if (start && end) return `xero-bank-import-${start}-to-${end}.csv`
  return `xero-bank-import-${new Date().toISOString().slice(0, 10)}.csv`
}

// ── Epworth → manual journal CSV & posting summary ──────────────────────────

/** One fund's totals across the four income types. */
export interface FundTotalsRow {
  /** null for the unmapped bucket */
  fund_id: string | null
  label: string
  amounts: Record<IncomeType, number>
  total: number
}

export interface JournalSettings {
  narration: string
  /** journal date, ISO — usually the last day of the period */
  dateIso: string
  /** debit side — investment asset account; blank = bookkeeper fills in */
  assetAccountCode: string
  /** credit side per income type; blank = bookkeeper fills in */
  incomeAccountCodes: Record<IncomeType, string>
}

export const EPWORTH_JOURNAL_HEADERS = [
  'Narration',
  'Date',
  'Description',
  'AccountCode',
  'TrackingName1',
  'Amount',
]

/**
 * Pragmatic posting summary the bookkeeper can adapt: for every fund × income
 * type a signed pair — debit the investment asset (+), credit the income
 * account (−). Pairs sum to zero; account codes default blank for editing.
 */
export function buildEpworthJournalCsv(funds: FundTotalsRow[], settings: JournalSettings): string {
  const date = isoToUk(settings.dateIso)
  const rows: Array<Array<string | number>> = []
  for (const fund of funds) {
    if (fund.fund_id == null) continue // unmapped lines never reach the journal
    for (const type of INCOME_TYPES) {
      const amount = round2(fund.amounts[type])
      if (amount === 0) continue
      const description = `${fund.label} — ${INCOME_TYPE_LABELS[type]}`
      rows.push([settings.narration, date, description, settings.assetAccountCode, fund.label, amount])
      rows.push([
        settings.narration,
        date,
        description,
        settings.incomeAccountCodes[type],
        fund.label,
        round2(-amount),
      ])
    }
  }
  return buildCsv(EPWORTH_JOURNAL_HEADERS, rows)
}

export const POSTING_SUMMARY_HEADERS = ['Period', 'Fund', 'Income type', 'Amount']

/** Simple flat summary — every fund × income type with a non-zero total. */
export function buildPostingSummaryCsv(period: string, funds: FundTotalsRow[]): string {
  const rows: Array<Array<string | number>> = []
  let grand = 0
  for (const fund of funds) {
    for (const type of INCOME_TYPES) {
      const amount = round2(fund.amounts[type])
      if (amount === 0) continue
      rows.push([period, fund.label, INCOME_TYPE_LABELS[type], amount])
      grand = round2(grand + amount)
    }
  }
  rows.push([period, 'Total', '', grand])
  return buildCsv(POSTING_SUMMARY_HEADERS, rows)
}
