/**
 * parse-cashflow — read an uploaded cashflow spreadsheet and propose figures
 * for the forecast grid.
 *
 * JWT-verified; pulse_* roles only (the 'imports' bucket is Pulse-only).
 * Body { storage_path, lines, periods } where `lines` and `periods` describe
 * the grid as it currently stands, so the model maps INTO the existing shape
 * rather than inventing one.
 *
 * xlsx/xls are read deterministically with SheetJS and CSV with a plain
 * parser; the resulting cell grid is what Claude sees. The model's whole job is
 * the mapping problem — which sheet row is which forecast line, which column
 * is which week — not arithmetic. Amounts come back exactly as they appear in
 * the sheet and are re-signed here against the line's section, so a spend
 * typed positive in the client's workbook cannot land as income.
 *
 * Returns { cells: [{ line_id, period_start, amount, source_row, source_col }],
 * unmatched_rows, unmatched_columns, notes }. Nothing is written — the caller
 * previews the proposal and applies it.
 */

import * as XLSX from 'npm:xlsx@0.18.5'
import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { callClaude, extractJson } from '../_shared/ai.ts'

const MAX_GRID_ROWS = 400
const MAX_GRID_COLS = 80
const MAX_PROMPT_CHARS = 180_000

interface LineIn {
  id: string
  name: string
  section: 'income' | 'outgoing'
}

interface PeriodIn {
  start: string
  label: string
  kind: 'week' | 'month'
}

interface ProposedCell {
  line_id: string
  period_start: string
  amount: number
  source_row?: string
  source_col?: string
}

interface ModelResult {
  cells?: Array<{
    line_id?: unknown
    period_start?: unknown
    amount?: unknown
    source_row?: unknown
    source_col?: unknown
  }>
  unmatched_rows?: unknown
  unmatched_columns?: unknown
  notes?: unknown
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

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
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/**
 * Every sheet in the workbook, flattened to a cell grid with Excel-style
 * addresses. Addresses are what the model quotes back in source_row and
 * source_col, so a proposal can be traced to the cell it came from.
 */
function workbookGrid(bytes: Uint8Array): { sheets: Array<{ name: string; rows: string[][] }> } {
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
  const sheets: Array<{ name: string; rows: string[][] }> = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    }) as unknown as string[][]
    if (rows.length === 0) continue
    sheets.push({
      name,
      rows: rows.slice(0, MAX_GRID_ROWS).map((r) => (r ?? []).slice(0, MAX_GRID_COLS).map((c) => String(c ?? '').trim())),
    })
  }
  return { sheets }
}

function colLetter(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** The grid as pipe-delimited text with row numbers and column letters. */
function renderGrid(sheets: Array<{ name: string; rows: string[][] }>): string {
  const parts: string[] = []
  for (const sheet of sheets) {
    const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0)
    const header = Array.from({ length: width }, (_, i) => colLetter(i)).join(' | ')
    parts.push(`### Sheet: ${sheet.name}\n     | ${header}`)
    sheet.rows.forEach((row, i) => {
      const cells = Array.from({ length: width }, (_, c) => row[c] ?? '')
      parts.push(`${String(i + 1).padStart(4, ' ')} | ${cells.join(' | ')}`)
    })
    parts.push('')
  }
  return parts.join('\n')
}

const SYSTEM = `You map figures from a charity's cashflow spreadsheet onto an existing forecast grid.

You are solving a MAPPING problem, not an accounting one:
- Match each spreadsheet row to one of the given forecast lines by meaning, not by exact wording ("Salaries & wages" matches "Salaries"; "PAYE/NIC" matches "HMRC PAYE / NI").
- Match each spreadsheet column to one of the given forecast periods by the date it represents. A column headed with a date inside a period belongs to that period. Weekly periods are named by the Monday they commence.
- Return the amount EXACTLY as it appears in the sheet, as a plain number: strip currency symbols, thousands separators and spaces; read (1,234) and -1,234 as -1234. Do not re-sign, scale, round or total anything.
- NEVER invent a figure. Only return a cell where the spreadsheet actually holds a value for that row and column.
- Ignore the spreadsheet's own total, subtotal, balance brought/carried forward and net movement rows — the grid computes those itself. Ignore blank and zero cells.
- If a row or column cannot be matched with confidence, leave it out and name it in unmatched_rows / unmatched_columns instead of guessing.

Respond with JSON only, no prose, in exactly this shape:
{
  "cells": [{ "line_id": "<id from the lines list>", "period_start": "<YYYY-MM-DD from the periods list>", "amount": 1234.56, "source_row": "12", "source_col": "D" }],
  "unmatched_rows": ["<row label the sheet used>"],
  "unmatched_columns": ["<column heading the sheet used>"],
  "notes": "<one or two sentences on anything the reviewer should check, or empty>"
}`

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as
    | { storage_path?: unknown; lines?: unknown; periods?: unknown }
    | null

  const storagePath = typeof body?.storage_path === 'string' ? body.storage_path.trim() : ''
  if (!storagePath) return errorResponse('storage_path is required')

  const lines = Array.isArray(body?.lines)
    ? (body.lines as unknown[]).filter(
        (l): l is LineIn =>
          typeof l === 'object' &&
          l !== null &&
          typeof (l as LineIn).id === 'string' &&
          typeof (l as LineIn).name === 'string' &&
          ((l as LineIn).section === 'income' || (l as LineIn).section === 'outgoing'),
      )
    : []
  if (lines.length === 0) return errorResponse('lines is required — the forecast has no lines to map onto')

  const periods = Array.isArray(body?.periods)
    ? (body.periods as unknown[]).filter(
        (p): p is PeriodIn =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as PeriodIn).start === 'string' &&
          typeof (p as PeriodIn).label === 'string',
      )
    : []
  if (periods.length === 0) return errorResponse('periods is required')

  const svc = serviceClient()
  const { data: blob, error: downloadError } = await svc.storage.from('imports').download(storagePath)
  if (downloadError || !blob) return errorResponse('Import file not found', 404)

  let grid: string
  try {
    const lower = storagePath.toLowerCase()
    if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
      const text = await blob.text()
      const rows = parseCsv(lower.endsWith('.tsv') ? text.replace(/\t/g, ',') : text)
      if (rows.length === 0) return errorResponse('The file has no readable rows')
      grid = renderGrid([
        {
          name: 'CSV',
          rows: rows.slice(0, MAX_GRID_ROWS).map((r) => r.slice(0, MAX_GRID_COLS).map((c) => c.trim())),
        },
      ])
    } else {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const { sheets } = workbookGrid(bytes)
      if (sheets.length === 0) return errorResponse('The workbook has no readable sheets')
      grid = renderGrid(sheets)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The file could not be read'
    return errorResponse(`The spreadsheet could not be read: ${message}`)
  }

  if (grid.length > MAX_PROMPT_CHARS) {
    return errorResponse(
      'The spreadsheet is too large to read in one go — cut it down to the forecast rows and columns and try again',
    )
  }

  const lineList = lines.map((l) => `- ${l.id} · ${l.section === 'income' ? 'INCOME' : 'OUTGOINGS'} · ${l.name}`).join('\n')
  const periodList = periods
    .map((p) => `- ${p.start} · ${p.label}${p.kind === 'month' ? ' (whole month)' : ' (week commencing)'}`)
    .join('\n')

  const prompt = `Forecast lines to map onto (id · section · name):
${lineList}

Forecast periods to map onto (period_start · label):
${periodList}

The uploaded spreadsheet, as a cell grid (row numbers down the side, column letters across the top):
${grid}

Return the JSON mapping now.`

  let result: ModelResult
  try {
    const text = await callClaude({ system: SYSTEM, maxTokens: 8000, messages: [{ role: 'user', content: prompt }] })
    result = extractJson<ModelResult>(text)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The spreadsheet could not be parsed'
    console.error('[parse-cashflow]', message)
    return errorResponse(message, 502)
  }

  // Validate every proposed cell against the grid we sent. An id or date the
  // model did not get from our lists is dropped rather than trusted.
  const lineById = new Map(lines.map((l) => [l.id, l]))
  const periodStarts = new Set(periods.map((p) => p.start))
  const seen = new Set<string>()
  const cells: ProposedCell[] = []
  let dropped = 0

  for (const raw of result.cells ?? []) {
    const lineId = typeof raw.line_id === 'string' ? raw.line_id : ''
    const periodStart = typeof raw.period_start === 'string' ? raw.period_start : ''
    const line = lineById.get(lineId)
    const amountRaw = typeof raw.amount === 'number' ? raw.amount : Number(raw.amount)
    if (!line || !periodStarts.has(periodStart) || !Number.isFinite(amountRaw)) {
      dropped += 1
      continue
    }
    if (Math.round(amountRaw * 100) === 0) continue
    const key = `${lineId}|${periodStart}`
    if (seen.has(key)) continue
    seen.add(key)
    // The grid stores outgoings negative, and a workbook may write spend
    // either way round. Re-signing follows exactly what typing into a cell
    // does: a positive figure on an outgoings line is money out, and an
    // explicitly negative one is left alone so a refund in survives the
    // import. Magnitude is always the sheet's.
    const amount = round2(amountRaw)
    cells.push({
      line_id: lineId,
      period_start: periodStart,
      amount: line.section === 'outgoing' && amount > 0 ? -amount : amount,
      source_row: typeof raw.source_row === 'string' ? raw.source_row : undefined,
      source_col: typeof raw.source_col === 'string' ? raw.source_col : undefined,
    })
  }

  const stringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 60) : []

  return json({
    cells,
    unmatched_rows: stringList(result.unmatched_rows),
    unmatched_columns: stringList(result.unmatched_columns),
    notes: typeof result.notes === 'string' ? result.notes.trim() : '',
    dropped,
  })
})
