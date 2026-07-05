/**
 * Imports module — data contracts, fetch helpers and shared utilities for the
 * HSBC statement drop-in and the Epworth investment report mapping.
 *
 * Module-owned: other modules should not import from here. Table/column names
 * mirror src/types/db.ts exactly. CSVs are generated for manual import into
 * Xero — nothing in this module pushes to the Xero API.
 */
import { invokeFunction, supabase } from '@/lib/supabase'
import { currentPeriod } from '@/lib/format'
import type {
  BankImport,
  BankImportRow,
  EpworthFundMapping,
  EpworthImport,
  FundType,
  ImportStatus,
  IncomeType,
  SenseCheckResult,
} from '@/types/db'

// ── Constants ────────────────────────────────────────────────────────────────

/** File-size guard — statements and valuations are small; ~10 MB is generous. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024

export type UploadPhase = 'uploading' | 'parsing' | 'checking' | 'saving'

export const PHASE_LABELS: Record<UploadPhase, string> = {
  uploading: 'Uploading',
  parsing: 'Parsing',
  checking: 'Sense checks',
  saving: 'Saving',
}

// ── Small helpers ────────────────────────────────────────────────────────────

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** 'yyyy-mm-dd' → 'dd/mm/yyyy' (Xero bank statement CSV date format) */
export function isoToUk(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${m[3]}/${m[2]}/${m[1]}`
}

/** Add n days to an ISO date (date-only, no timezone drift). */
export function addDays(iso: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function normaliseDescription(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Duplicate-row identity: date + amount + normalised description. */
export function rowKey(row: Pick<BankImportRow, 'date' | 'amount' | 'description'>): string {
  return `${row.date}|${row.amount.toFixed(2)}|${normaliseDescription(row.description)}`
}

export function validateImportFile(file: File, kinds: Array<'pdf' | 'csv'>): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > MAX_FILE_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB. Export a shorter period and try again.`
  }
  const ext = fileExtension(file.name)
  if (!kinds.includes(ext as 'pdf' | 'csv')) {
    return `Only ${kinds.map((k) => k.toUpperCase()).join(' or ')} files can be imported here.`
  }
  return null
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Ensure a usable 'YYYY-MM' period, falling back to the current month. */
export function coercePeriod(raw: string | null | undefined): string {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw
  if (raw) {
    const m = /^(\d{4})-(\d{2})-\d{2}/.exec(raw)
    if (m) return `${m[1]}-${m[2]}`
  }
  return currentPeriod()
}

/** Last day of a 'YYYY-MM' period as an ISO date. */
export function periodEndIso(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m) return period
  const d = new Date(Number(m[1]), Number(m[2]), 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Storage ('imports' bucket, Pulse-only) ───────────────────────────────────

function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'import'
}

export function importFilePath(prefix: 'hsbc' | 'epworth', fileName: string): string {
  return `${prefix}/${Date.now()}-${safeFileName(fileName)}`
}

export async function uploadImportFile(path: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from('imports').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(error.message)
}

/** Store a generated CSV alongside the source file (re-generation overwrites). */
export async function uploadGeneratedCsv(path: string, csv: string): Promise<void> {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const { error } = await supabase.storage.from('imports').upload(path, blob, {
    contentType: 'text/csv',
    upsert: true,
  })
  if (error) throw new Error(error.message)
}

// ── parse-import edge function ───────────────────────────────────────────────

export interface ParsedHolding {
  holding_ref: string
  holding_name: string
  income_type: string
  amount: number
}

export interface ParseImportResponse {
  rows?: BankImportRow[]
  opening_balance?: number
  closing_balance?: number
  statement_start?: string
  statement_end?: string
  holdings?: ParsedHolding[]
  period?: string
}

export async function parseImport(
  kind: 'hsbc_pdf' | 'hsbc_csv' | 'epworth',
  storagePath: string,
): Promise<ParseImportResponse> {
  return invokeFunction<ParseImportResponse>('parse-import', { kind, storage_path: storagePath })
}

// ── bank_imports ─────────────────────────────────────────────────────────────

export async function fetchBankImports(): Promise<BankImport[]> {
  const { data, error } = await supabase
    .from('bank_imports')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as BankImport[]
}

export interface NewBankImport {
  file_path: string
  file_name: string
  statement_start: string | null
  statement_end: string | null
  opening_balance: number | null
  closing_balance: number | null
  parsed_rows: BankImportRow[]
  sense_check_results: SenseCheckResult[]
  status: ImportStatus
  uploaded_by: string
}

export async function insertBankImport(values: NewBankImport): Promise<BankImport> {
  const { data, error } = await supabase.from('bank_imports').insert(values).select().single()
  if (error) throw new Error(error.message)
  return data as BankImport
}

export async function updateBankImport(id: string, patch: Partial<BankImport>): Promise<void> {
  const { error } = await supabase.from('bank_imports').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── epworth_imports & mappings ───────────────────────────────────────────────

export async function fetchEpworthImports(): Promise<EpworthImport[]> {
  const { data, error } = await supabase
    .from('epworth_imports')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as EpworthImport[]
}

export interface NewEpworthImport {
  file_path: string
  file_name: string
  period: string
  parsed: { holdings: ParsedHolding[] }
  uploaded_by: string
}

export async function insertEpworthImport(values: NewEpworthImport): Promise<EpworthImport> {
  const { data, error } = await supabase
    .from('epworth_imports')
    .insert({ ...values, status: 'parsed' satisfies ImportStatus })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as EpworthImport
}

export async function updateEpworthImport(id: string, patch: Partial<EpworthImport>): Promise<void> {
  const { error } = await supabase.from('epworth_imports').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function fetchMappings(): Promise<EpworthFundMapping[]> {
  const { data, error } = await supabase.from('epworth_fund_mappings').select('*')
  if (error) throw new Error(error.message)
  return (data ?? []) as EpworthFundMapping[]
}

export async function insertMappings(
  values: Array<{ epworth_holding_ref: string; fund_id: string; income_type: IncomeType; created_by: string }>,
): Promise<void> {
  if (values.length === 0) return
  const { error } = await supabase.from('epworth_fund_mappings').insert(values)
  if (error) throw new Error(error.message)
}

export async function deleteMappingsForHolding(holdingRef: string): Promise<void> {
  const { error } = await supabase
    .from('epworth_fund_mappings')
    .delete()
    .eq('epworth_holding_ref', holdingRef)
  if (error) throw new Error(error.message)
}

/** Extract the parsed holdings from an epworth_imports row (jsonb, defensive). */
export function holdingsOf(imp: EpworthImport): ParsedHolding[] {
  const raw = imp.parsed as { holdings?: unknown } | unknown[] | null
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { holdings?: unknown }).holdings)
      ? ((raw as { holdings: unknown[] }).holdings)
      : []
  const out: ParsedHolding[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const h = item as Record<string, unknown>
    const amount = typeof h.amount === 'number' ? h.amount : Number(h.amount)
    if (!Number.isFinite(amount)) continue
    out.push({
      holding_ref: String(h.holding_ref ?? h.ref ?? '—'),
      holding_name: String(h.holding_name ?? h.name ?? ''),
      income_type: String(h.income_type ?? ''),
      amount: round2(amount),
    })
  }
  return out
}

// ── Fund options (from v_fund_balances) ──────────────────────────────────────

export interface FundOption {
  fund_id: string
  name: string
  fund_type: FundType
}

export async function fetchFundOptions(): Promise<FundOption[]> {
  const { data, error } = await supabase
    .from('v_fund_balances')
    .select('fund_id, name, fund_type, active')
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<FundOption & { active: boolean }>)
    .filter((f) => f.active)
    .map(({ fund_id, name, fund_type }) => ({ fund_id, name, fund_type }))
}

// ── Income types ─────────────────────────────────────────────────────────────

export const INCOME_TYPES: IncomeType[] = ['dividend', 'interest', 'realised_gain', 'unrealised_gain']

export const INCOME_TYPE_LABELS: Record<IncomeType, string> = {
  dividend: 'Dividends',
  interest: 'Interest',
  realised_gain: 'Realised gains',
  unrealised_gain: 'Unrealised gains',
}

export const INCOME_TYPE_SHORT: Record<IncomeType, string> = {
  dividend: 'Dividends',
  interest: 'Interest',
  realised_gain: 'Realised',
  unrealised_gain: 'Unrealised',
}

/** Coerce whatever the parser called the income type onto the enum. */
export function coerceIncomeType(raw: string): IncomeType {
  const s = raw.toLowerCase().trim()
  if ((INCOME_TYPES as string[]).includes(s)) return s as IncomeType
  if (s.includes('unreal')) return 'unrealised_gain'
  if (s.includes('real')) return 'realised_gain'
  if (s.includes('int')) return 'interest'
  return 'dividend'
}

// ── Status presentation ──────────────────────────────────────────────────────

export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  uploaded: 'Uploaded',
  parsed: 'Parsed',
  checks_failed: 'Checks failed',
  ready: 'Ready',
  exported: 'Exported',
  overridden: 'Overridden',
}

export const IMPORT_STATUS_TONES: Record<
  ImportStatus,
  'neutral' | 'live' | 'good' | 'warn' | 'danger' | 'indigo'
> = {
  uploaded: 'neutral',
  parsed: 'indigo',
  checks_failed: 'warn',
  ready: 'good',
  exported: 'live', // the money moment — the CSV has reached the books
  overridden: 'warn',
}
