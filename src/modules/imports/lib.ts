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

export type ImportFileKind = 'pdf' | 'csv' | 'xlsx' | 'xls'

export function validateImportFile(file: File, kinds: ImportFileKind[]): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > MAX_FILE_BYTES) {
    return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB. Export a shorter period and try again.`
  }
  const ext = fileExtension(file.name)
  if (!kinds.includes(ext as ImportFileKind)) {
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

/** A period cash movement from the Epworth workbook, ready for a bank-statement CSV. */
export interface EpworthCashRow {
  date: string // ISO
  amount: number // signed, money-in positive
  description: string
  reference: string
}

/**
 * Epworth workbook context stored alongside the holdings in
 * epworth_imports.parsed. cumulative_gains lets the *next* import compute the
 * month's unrealised movement as a delta; gains_note explains the basis used.
 */
export interface EpworthImportMeta {
  source?: 'workbook' | 'ai'
  /** holding_ref → cumulative gain/loss since Epworth inception (Gains sheet) */
  cumulative_gains?: Record<string, number>
  /** basis of the unrealised_gain figures — delta vs prior import, or catch-up */
  gains_note?: string
  /** period of the prior import the gains delta was computed against */
  prior_period?: string
  /** capital movements (transfers in/out, redemptions) excluded from income */
  excluded_cash?: Array<{ account_ref: string; date: string; narrative: string; amount: number }>
  /** the period's actual cash movements, for the cash-account CSV export */
  cash_rows?: EpworthCashRow[]
  /** account ref → portfolio market value at the period end (gains sheet Close) */
  closing_values?: Record<string, number>
  /** Cash Plus account ref → balance at the period end (active accounts only) */
  cash_values?: Record<string, number>
}

export interface ParseImportResponse {
  rows?: BankImportRow[]
  opening_balance?: number
  closing_balance?: number
  statement_start?: string
  statement_end?: string
  holdings?: ParsedHolding[]
  period?: string
  meta?: EpworthImportMeta
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
  parsed: { holdings: ParsedHolding[]; meta?: EpworthImportMeta }
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

/** Extract the workbook meta from an epworth_imports row (jsonb, defensive). */
export function metaOf(imp: EpworthImport): EpworthImportMeta {
  const raw = imp.parsed as { meta?: unknown } | null
  const meta = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { meta?: unknown }).meta : null
  return meta && typeof meta === 'object' ? (meta as EpworthImportMeta) : {}
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

// ── Saved journal export mappings (epworth_journal_settings, single row) ─────

export interface EpworthJournalSaved {
  tracking_category_name: string | null
  asset_account_code: string | null
  income_account_codes: Partial<Record<IncomeType, string>>
}

export async function fetchJournalSettings(): Promise<EpworthJournalSaved | null> {
  const { data, error } = await supabase
    .from('epworth_journal_settings')
    .select('tracking_category_name, asset_account_code, income_account_codes')
    .eq('key', 'default')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as {
    tracking_category_name: string | null
    asset_account_code: string | null
    income_account_codes: unknown
  }
  const codes: Partial<Record<IncomeType, string>> = {}
  if (row.income_account_codes && typeof row.income_account_codes === 'object') {
    for (const [k, v] of Object.entries(row.income_account_codes as Record<string, unknown>)) {
      if (typeof v === 'string' && (INCOME_TYPES as string[]).includes(k)) codes[k as IncomeType] = v
    }
  }
  return {
    tracking_category_name: row.tracking_category_name,
    asset_account_code: row.asset_account_code,
    income_account_codes: codes,
  }
}

export async function saveJournalSettings(values: EpworthJournalSaved, userId: string): Promise<void> {
  const { error } = await supabase.from('epworth_journal_settings').upsert(
    {
      key: 'default',
      tracking_category_name: values.tracking_category_name,
      asset_account_code: values.asset_account_code,
      income_account_codes: values.income_account_codes,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  )
  if (error) throw new Error(error.message)
}

/**
 * Name of the Xero tracking category the funds live under (category 1 on the
 * journal CSV). Resolved via any fund's tracking option; null when Xero has
 * not been synced yet — the caller falls back to a sensible default.
 */
export async function fetchFundTrackingCategoryName(): Promise<string | null> {
  const { data: fund } = await supabase
    .from('funds')
    .select('tracking_option_id')
    .not('tracking_option_id', 'is', null)
    .limit(1)
    .maybeSingle()
  if (!fund?.tracking_option_id) return null
  const { data: opt } = await supabase
    .from('xero_tracking_options')
    .select('tracking_category_id')
    .eq('tracking_option_id', fund.tracking_option_id)
    .maybeSingle()
  if (!opt?.tracking_category_id) return null
  const { data: cat } = await supabase
    .from('xero_tracking_categories')
    .select('name')
    .eq('tracking_category_id', opt.tracking_category_id)
    .maybeSingle()
  return cat?.name ?? null
}

// ── Income types ─────────────────────────────────────────────────────────────

export const INCOME_TYPES: IncomeType[] = [
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
  fee: 'Management fees',
}

export const INCOME_TYPE_SHORT: Record<IncomeType, string> = {
  dividend: 'Dividends',
  interest: 'Interest',
  realised_gain: 'Realised',
  unrealised_gain: 'Unrealised',
  fee: 'Fees',
}

/** Coerce whatever the parser called the income type onto the enum. */
export function coerceIncomeType(raw: string): IncomeType {
  const s = raw.toLowerCase().trim()
  if ((INCOME_TYPES as string[]).includes(s)) return s as IncomeType
  if (s.includes('fee') || s.includes('charge')) return 'fee'
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
