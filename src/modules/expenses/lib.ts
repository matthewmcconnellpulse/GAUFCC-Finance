/**
 * Expenses module — data contracts, fetch helpers, deadline logic and
 * mutations. Module-owned; other modules should not import from here.
 *
 * Table/column names mirror src/types/db.ts exactly. The approval/payment
 * deadline is read from the `settings` table (keys `expense_approval_day`,
 * `payment_run_day`) and computed dynamically — never hard-coded.
 */
import { invokeFunction, supabase } from '@/lib/supabase'
import { currentPeriod } from '@/lib/format'
import { SETTING_KEYS } from '@/types/db'
import type {
  AiExtraction,
  ClaimStatus,
  ExpenseClaim,
  ExpenseLine,
  FundType,
} from '@/types/db'

// ── Confidence & AI extraction ───────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.8

/**
 * The jsonb `ai_extraction` column also carries the submitter's explicit
 * "looks right" confirmation for low-confidence reads, so a reopened draft
 * remembers what has already been checked.
 */
export type StoredExtraction = AiExtraction & { user_confirmed?: boolean }

export function isLowConfidence(line: Pick<ExpenseLine, 'ai_confidence'>): boolean {
  return line.ai_confidence != null && line.ai_confidence < CONFIDENCE_THRESHOLD
}

export function needsConfirmation(line: Pick<ExpenseLine, 'ai_confidence' | 'ai_extraction'>): boolean {
  if (!isLowConfidence(line)) return false
  const ex = line.ai_extraction as StoredExtraction | null
  return !ex?.user_confirmed
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toIsoDate(value: string | undefined): string | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
}

// ── Deadline logic (settings-driven) ─────────────────────────────────────────

export const DEFAULT_APPROVAL_DAY = 10
export const DEFAULT_PAYMENT_DAY = 17

export interface DeadlineInfo {
  approvalDay: number
  paymentDay: number
  /** next approval deadline (rolls to next month once this month's has passed) */
  approvalDate: Date
  /** the payment run that approval deadline feeds */
  paymentDate: Date
  /** whole days until the approval deadline; 0 = today */
  daysLeft: number
  /** true when this month's deadline has already passed */
  rolled: boolean
}

function coerceDay(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return clampDay(value)
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10)
    if (Number.isFinite(n)) return clampDay(n)
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('value' in obj) return coerceDay(obj.value, fallback)
    if ('day' in obj) return coerceDay(obj.day, fallback)
  }
  return fallback
}

function clampDay(n: number): number {
  return Math.min(31, Math.max(1, Math.round(n)))
}

/**
 * Reads `expense_approval_day` / `payment_run_day` from the settings table.
 * Falls back to the documented defaults (10 / 17) when the row is missing or
 * unreadable — the banner is informational and must never block a page.
 */
export async function fetchDeadlineDays(): Promise<{ approvalDay: number; paymentDay: number }> {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', [SETTING_KEYS.expenseApprovalDay, SETTING_KEYS.paymentRunDay])
    if (error) throw new Error(error.message)
    const byKey = new Map<string, unknown>()
    for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
      byKey.set(row.key, row.value)
    }
    return {
      approvalDay: coerceDay(byKey.get(SETTING_KEYS.expenseApprovalDay), DEFAULT_APPROVAL_DAY),
      paymentDay: coerceDay(byKey.get(SETTING_KEYS.paymentRunDay), DEFAULT_PAYMENT_DAY),
    }
  } catch {
    return { approvalDay: DEFAULT_APPROVAL_DAY, paymentDay: DEFAULT_PAYMENT_DAY }
  }
}

function dayInMonth(year: number, monthIndex: number, day: number): Date {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate()
  return new Date(year, monthIndex, Math.min(day, lastDay))
}

/**
 * 'Submit by 10 July to be paid on 17 July' — if today is past this month's
 * approval day the whole cycle rolls to next month. If the payment day falls
 * before the approval day it lands in the month after the deadline.
 */
export function computeDeadline(approvalDay: number, paymentDay: number, today = new Date()): DeadlineInfo {
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let approvalDate = dayInMonth(today.getFullYear(), today.getMonth(), approvalDay)
  let rolled = false
  if (todayMid.getTime() > approvalDate.getTime()) {
    approvalDate = dayInMonth(today.getFullYear(), today.getMonth() + 1, approvalDay)
    rolled = true
  }
  let paymentDate = dayInMonth(approvalDate.getFullYear(), approvalDate.getMonth(), paymentDay)
  if (paymentDate.getTime() < approvalDate.getTime()) {
    paymentDate = dayInMonth(approvalDate.getFullYear(), approvalDate.getMonth() + 1, paymentDay)
  }
  const daysLeft = Math.round((approvalDate.getTime() - todayMid.getTime()) / 86_400_000)
  return { approvalDay, paymentDay, approvalDate, paymentDate, daysLeft, rolled }
}

/** '10 July' — day + month, no year, for banner copy */
export function formatDayMonth(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft <= 0) return 'today'
  if (daysLeft === 1) return '1 day left'
  return `${daysLeft} days left`
}

// ── Claims ───────────────────────────────────────────────────────────────────

export interface SubmitterInfo {
  full_name: string
  email: string | null
}

export type ClaimWithSubmitter = ExpenseClaim & {
  submitter: SubmitterInfo | null
  /** Whoever approved or rejected (ceo_approved_by), when known. */
  approver: SubmitterInfo | null
  /** Whoever returned the claim for amendment (returned_by), when known. */
  returner: SubmitterInfo | null
}

/**
 * Names are attached with a second profiles query rather than an embedded
 * resource so we never depend on the migrations agent's FK naming. RLS may
 * hide profiles from some viewers — names degrade to a dash, never an error.
 */
async function attachSubmitters(claims: ExpenseClaim[]): Promise<ClaimWithSubmitter[]> {
  const ids = [
    ...new Set(
      claims
        .flatMap((c) => [c.submitter_id, c.ceo_approved_by, c.returned_by])
        .filter((v): v is string => Boolean(v)),
    ),
  ]
  const map = new Map<string, SubmitterInfo>()
  if (ids.length > 0) {
    try {
      const { data } = await supabase.from('profiles').select('id, full_name, email').in('id', ids)
      for (const row of (data ?? []) as Array<{ id: string; full_name: string; email: string | null }>) {
        map.set(row.id, { full_name: row.full_name, email: row.email })
      }
    } catch {
      // tolerated — the claim list still renders
    }
  }
  return claims.map((c) => ({
    ...c,
    submitter: map.get(c.submitter_id) ?? null,
    approver: c.ceo_approved_by ? (map.get(c.ceo_approved_by) ?? null) : null,
    returner: c.returned_by ? (map.get(c.returned_by) ?? null) : null,
  }))
}

export interface ClaimFilters {
  submitterId?: string
  statuses?: ClaimStatus[]
  period?: string
  /** Archived claims are out of the working lists unless asked for. */
  archived?: 'exclude' | 'include' | 'only'
}

export async function fetchClaims(filters: ClaimFilters = {}): Promise<ClaimWithSubmitter[]> {
  let q = supabase.from('expense_claims').select('*').order('created_at', { ascending: false })
  if (filters.submitterId) q = q.eq('submitter_id', filters.submitterId)
  if (filters.statuses && filters.statuses.length > 0) q = q.in('status', filters.statuses)
  if (filters.period) q = q.eq('period', filters.period)
  const archived = filters.archived ?? 'exclude'
  if (archived === 'exclude') q = q.is('archived_at', null)
  if (archived === 'only') q = q.not('archived_at', 'is', null)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return attachSubmitters((data ?? []) as ExpenseClaim[])
}

export async function fetchClaim(id: string): Promise<ClaimWithSubmitter | null> {
  const { data, error } = await supabase.from('expense_claims').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const [claim] = await attachSubmitters([data as ExpenseClaim])
  return claim
}

export async function countSubmittedClaims(): Promise<number> {
  const { count, error } = await supabase
    .from('expense_claims')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'submitted')
    .is('archived_at', null)
  if (error) throw new Error(error.message)
  return count ?? 0
}

// ── Review actions ───────────────────────────────────────────────────────────

/**
 * Hand a claim back to the claimant with a note. The guard trigger stamps
 * returned_by/returned_at and clears any CEO approval; the claimant amends
 * and resubmits.
 */
export async function returnClaim(id: string, note: string): Promise<void> {
  await updateClaim(id, { status: 'draft', review_note: note.trim() })
}

/** Hide a claim from the working lists without losing anything. */
export async function archiveClaim(id: string, byProfileId: string): Promise<void> {
  await updateClaim(id, { archived_at: new Date().toISOString(), archived_by: byProfileId })
}

export async function unarchiveClaim(id: string): Promise<void> {
  await updateClaim(id, { archived_at: null, archived_by: null })
}

// ── Mileage ──────────────────────────────────────────────────────────────────

export const DEFAULT_MILEAGE_RATE_PENCE = 45

/** Company pence-per-mile rate from settings (HMRC's 45p unless overridden). */
export async function fetchMileageRatePence(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', SETTING_KEYS.mileageRatePence)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const v = Number((data as { value: unknown } | null)?.value)
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MILEAGE_RATE_PENCE
  } catch {
    return DEFAULT_MILEAGE_RATE_PENCE
  }
}

export function mileageAmount(miles: number, ratePence: number): number {
  return round2((miles * ratePence) / 100)
}

/**
 * The line description for a mileage claim, built from the journey log so the
 * bill in Xero reads the way the log does: "Mileage — Manchester to London
 * (return), 42 miles @ 45p". Where the journey has not been filled in yet it
 * degrades to just the miles and rate.
 */
export function mileageDescription(
  miles: number,
  ratePence: number,
  journey?: Pick<ExpenseLine, 'journey_from' | 'journey_to' | 'is_return_journey'>,
): string {
  const rate = Number.isInteger(ratePence) ? String(ratePence) : ratePence.toFixed(2)
  const from = journey?.journey_from?.trim()
  const to = journey?.journey_to?.trim()
  const leg = from && to ? `${from} to ${to}` : from || to || null
  const route = leg ? `${leg}${journey?.is_return_journey ? ' (return)' : ''}, ` : ''
  return `Mileage — ${route}${miles} ${miles === 1 ? 'mile' : 'miles'} @ ${rate}p`
}

/** A mileage line is only a valid HMRC record with the journey written down. */
export function mileageLogGaps(
  line: Pick<ExpenseLine, 'is_mileage' | 'miles' | 'journey_from' | 'journey_to' | 'journey_purpose'>,
): string[] {
  if (!line.is_mileage) return []
  const gaps: string[] = []
  if (!line.miles || line.miles <= 0) gaps.push('the miles')
  if (!line.journey_from?.trim()) gaps.push('where you started')
  if (!line.journey_to?.trim()) gaps.push('where you went')
  if (!line.journey_purpose?.trim()) gaps.push('the reason for the journey')
  return gaps
}

// ── CEO report ───────────────────────────────────────────────────────────────

export interface ReportLine extends Pick<
  ExpenseLine,
  | 'id'
  | 'claim_id'
  | 'date'
  | 'description'
  | 'category'
  | 'fund_id'
  | 'net'
  | 'vat'
  | 'gross'
  | 'is_mileage'
  | 'miles'
  | 'mileage_rate_pence'
  | 'journey_from'
  | 'journey_to'
  | 'journey_purpose'
  | 'is_return_journey'
> {}

/**
 * Every non-archived claim whose month falls in [from, to] (inclusive,
 * 'YYYY-MM'), with its lines — the raw material for the on-request report.
 */
export async function fetchClaimsReport(
  from: string,
  to: string,
): Promise<{ claims: ClaimWithSubmitter[]; lines: ReportLine[] }> {
  const { data, error } = await supabase
    .from('expense_claims')
    .select('*')
    .gte('period', from)
    .lte('period', to)
    .is('archived_at', null)
    .order('period', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  const claims = await attachSubmitters((data ?? []) as ExpenseClaim[])
  if (claims.length === 0) return { claims, lines: [] }

  const lines: ReportLine[] = []
  const ids = claims.map((c) => c.id)
  // PostgREST's URL length is the binding limit — chunk the id list.
  for (let i = 0; i < ids.length; i += 100) {
    const { data: rows, error: lineError } = await supabase
      .from('expense_lines')
      .select(
        'id, claim_id, date, description, category, fund_id, net, vat, gross, is_mileage, miles, mileage_rate_pence, journey_from, journey_to, journey_purpose, is_return_journey',
      )
      .in('claim_id', ids.slice(i, i + 100))
      .order('date', { ascending: true })
    if (lineError) throw new Error(lineError.message)
    lines.push(...((rows ?? []) as ReportLine[]))
  }
  return { claims, lines }
}

/** Active users a Pulse admin/bookkeeper can raise a claim for. */
export async function fetchActiveProfiles(): Promise<
  Array<{ id: string; full_name: string; role: string }>
> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('active', true)
    .order('full_name', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<{ id: string; full_name: string; role: string }>
}

export async function createClaim(submitterId: string, period?: string): Promise<ExpenseClaim> {
  const { data, error } = await supabase
    .from('expense_claims')
    .insert({
      submitter_id: submitterId,
      status: 'draft',
      period: period && /^\d{4}-\d{2}$/.test(period) ? period : currentPeriod(),
      total: 0,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as ExpenseClaim
}

/**
 * Email a nudge to everyone who plausibly has expenses for the period and
 * hasn't submitted yet (active submitters + recent claimants; draft holders
 * are told to finish the draft). Admin/CEO only — enforced server-side.
 */
export async function sendExpenseReminders(period: string): Promise<{ sent: number; skipped: number }> {
  return invokeFunction<{ sent: number; skipped: number }>('expense-reminders', { period })
}

export interface ReminderPreview {
  period: string
  would_send: number
  skipped: number
  /** Whether Resend actually accepts the key and the sending domain is verified. */
  email_ready: boolean
  email_detail: string
  recipients: Array<{ name: string; email: string; has_draft: boolean }>
}

/**
 * Who would be emailed, and whether email is genuinely configured — checked
 * against Resend rather than just "a key is present". Sends nothing.
 */
export async function previewExpenseReminders(period: string): Promise<ReminderPreview> {
  return invokeFunction<ReminderPreview>('expense-reminders', { period, dry_run: true })
}

export async function updateClaim(id: string, patch: Partial<ExpenseClaim>): Promise<void> {
  const { error } = await supabase.from('expense_claims').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteClaim(id: string): Promise<void> {
  const { error } = await supabase.from('expense_claims').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function submitClaim(id: string, total: number): Promise<void> {
  await updateClaim(id, {
    status: 'submitted',
    submitted_at: new Date().toISOString(),
    total: round2(total),
  })
}

export async function approveClaim(id: string, approverId: string, comment?: string): Promise<void> {
  await updateClaim(id, {
    status: 'approved',
    ceo_approved_by: approverId,
    ceo_approved_at: new Date().toISOString(),
    ceo_comment: comment && comment.trim() !== '' ? comment.trim() : null,
  })
}

export async function rejectClaim(id: string, approverId: string, comment: string): Promise<void> {
  await updateClaim(id, {
    status: 'rejected',
    ceo_approved_by: approverId,
    ceo_approved_at: new Date().toISOString(),
    ceo_comment: comment.trim(),
  })
}

/** Human Pulse trigger only — CEO approval never auto-pushes. */
export async function pushClaimToXero(claimId: string): Promise<{
  xero_bill_id: string
  receipts_attached?: number
  receipts_failed?: string[]
}> {
  return invokeFunction<{ xero_bill_id: string }>('xero-push-bill', { claim_id: claimId })
}

// ── Lines ────────────────────────────────────────────────────────────────────

export async function fetchLines(claimId: string): Promise<ExpenseLine[]> {
  const { data, error } = await supabase
    .from('expense_lines')
    .select('*')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as ExpenseLine[]
}

export async function fetchLinesForClaims(claimIds: string[]): Promise<Map<string, ExpenseLine[]>> {
  const map = new Map<string, ExpenseLine[]>()
  if (claimIds.length === 0) return map
  const { data, error } = await supabase
    .from('expense_lines')
    .select('*')
    .in('claim_id', claimIds)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  for (const line of (data ?? []) as ExpenseLine[]) {
    const list = map.get(line.claim_id) ?? []
    list.push(line)
    map.set(line.claim_id, list)
  }
  return map
}

export type NewLineValues = Pick<ExpenseLine, 'date' | 'description' | 'net' | 'vat' | 'gross'> &
  Partial<
    Pick<
      ExpenseLine,
      | 'category'
      | 'fund_id'
      | 'receipt_storage_path'
      | 'receipt_sha256'
      | 'ai_extraction'
      | 'ai_confidence'
      | 'is_mileage'
      | 'miles'
      | 'mileage_rate_pence'
      | 'journey_from'
      | 'journey_to'
      | 'journey_purpose'
      | 'is_return_journey'
    >
  >

export async function insertLine(claimId: string, values: NewLineValues): Promise<ExpenseLine> {
  const { data, error } = await supabase
    .from('expense_lines')
    .insert({ claim_id: claimId, ...values })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as ExpenseLine
}

export async function updateLine(id: string, patch: Partial<ExpenseLine>): Promise<void> {
  const { error } = await supabase.from('expense_lines').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteLine(id: string): Promise<void> {
  const { error } = await supabase.from('expense_lines').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export function sumGross(lines: Array<Pick<ExpenseLine, 'gross'>>): number {
  return round2(lines.reduce((s, l) => s + (l.gross || 0), 0))
}

// ── Receipts (storage + AI extraction) ───────────────────────────────────────

/** Submitters write to their own folder: <auth.uid()>/<claim_id>/<filename> */
export function receiptPath(uid: string, claimId: string, fileName: string): string {
  const safe = fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'receipt'
  return `${uid}/${claimId}/${Date.now()}-${safe}`
}

export async function uploadReceipt(path: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from('receipts').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(error.message)
}

export interface ExtractReceiptResponse {
  extraction: AiExtraction
  confidence: number
}

export async function extractReceipt(storagePath: string): Promise<ExtractReceiptResponse> {
  return invokeFunction<ExtractReceiptResponse>('extract-receipt', { storage_path: storagePath })
}

const signedUrlCache = new Map<string, { url: string; expires: number }>()

export async function signedReceiptUrl(path: string): Promise<string> {
  const hit = signedUrlCache.get(path)
  if (hit && hit.expires > Date.now()) return hit.url
  const { data, error } = await supabase.storage.from('receipts').createSignedUrl(path, 3600)
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'Could not load the receipt')
  signedUrlCache.set(path, { url: data.signedUrl, expires: Date.now() + 55 * 60_000 })
  return data.signedUrl
}

export function isPdfPath(path: string): boolean {
  return /\.pdf($|\?)/i.test(path)
}

// ── Category & fund options ──────────────────────────────────────────────────

export interface CategoryOption {
  code: string
  name: string
}

/** Xero expense accounts when synced; the UI falls back to a free-text code. */
export async function fetchExpenseCategories(): Promise<CategoryOption[]> {
  const { data, error } = await supabase
    .from('xero_accounts')
    .select('code, name, class')
    .eq('class', 'EXPENSE')
    .order('code', { ascending: true })
  if (error) throw new Error(error.message)
  const seen = new Set<string>()
  const out: CategoryOption[] = []
  for (const row of (data ?? []) as Array<{ code: string | null; name: string }>) {
    if (row.code && !seen.has(row.code)) {
      seen.add(row.code)
      out.push({ code: row.code, name: row.name })
    }
  }
  return out
}

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

/** Map the AI's suggested category onto a real account: code, then name. */
export function matchCategory(suggested: string | undefined, categories: CategoryOption[]): string | null {
  if (!suggested || categories.length === 0) return null
  const s = suggested.trim().toLowerCase()
  if (s === '') return null
  const byCode = categories.find((c) => c.code.toLowerCase() === s)
  if (byCode) return byCode.code
  const byName = categories.find((c) => c.name.toLowerCase() === s)
  if (byName) return byName.code
  const partial = categories.find(
    (c) => c.name.toLowerCase().includes(s) || s.includes(c.name.toLowerCase()),
  )
  return partial ? partial.code : null
}

/** Pre-fill a claim line from a receipt extraction. */
export function prefillFromExtraction(
  extraction: AiExtraction,
  confidence: number,
  fileName: string,
  categories: CategoryOption[],
): Omit<NewLineValues, 'receipt_storage_path'> {
  const vat = round2(extraction.vat ?? 0)
  const net = round2(extraction.net ?? (extraction.gross != null ? extraction.gross - vat : 0))
  const gross = round2(net + vat)
  const merchant = extraction.merchant?.trim()
  const detail = extraction.description?.trim()
  let description: string
  if (merchant && detail && detail.toLowerCase() !== merchant.toLowerCase()) {
    description = `${merchant} — ${detail}`
  } else {
    description = merchant || detail || fileName
  }
  return {
    date: toIsoDate(extraction.date) ?? todayIso(),
    description,
    category: matchCategory(extraction.suggested_category, categories),
    net,
    vat,
    gross,
    ai_extraction: extraction,
    ai_confidence: confidence,
  }
}

// ── People (for EML nudges) ──────────────────────────────────────────────────

export async function fetchCeoProfile(): Promise<SubmitterInfo | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('role', 'ceo')
    .eq('active', true)
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as SubmitterInfo | null) ?? null
}

// ── Status presentation ──────────────────────────────────────────────────────

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  pushed_to_xero: 'Pushed to Xero',
  paid: 'Paid',
}

/** Rejection is a decision, not a breached policy — amber, never red. */
export const CLAIM_STATUS_TONES: Record<ClaimStatus, 'neutral' | 'indigo' | 'good' | 'warn' | 'live'> = {
  draft: 'neutral',
  submitted: 'indigo',
  approved: 'good',
  rejected: 'warn',
  pushed_to_xero: 'live',
  paid: 'good',
}

export const ALL_STATUSES: ClaimStatus[] = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'pushed_to_xero',
  'paid',
]

/** Distinct periods present in a claim list, newest first. */
export function periodOptions(claims: Array<Pick<ExpenseClaim, 'period'>>): string[] {
  return [...new Set(claims.map((c) => c.period))].sort((a, b) => b.localeCompare(a))
}

// ── Duplicate receipts ───────────────────────────────────────────────────────

/**
 * SHA-256 of the file, hex. Computed in the browser before upload so the same
 * photo re-submitted later is recognised byte-for-byte, whoever claims it.
 * Returns null where SubtleCrypto is unavailable (http:// origins) — the
 * date-and-amount check still applies, so detection degrades rather than
 * breaking the upload.
 */
export async function fileSha256(file: File): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

export type DuplicateMatchType = 'exact_file' | 'same_date_amount'

export interface DuplicateWarning {
  lineId: string
  matchType: DuplicateMatchType
  otherClaimId: string
  otherClaimStatus: ClaimStatus
  otherSubmitter: string
  otherDate: string
  otherGross: number
  otherIsMine: boolean
}

/**
 * Duplicate warnings for one claim, via the claim_duplicate_warnings RPC.
 * The RPC looks across everyone's claims (a receipt claimed twice by two
 * people is exactly what needs catching) and returns only a summary of the
 * earlier claim. Exact file matches are reported ahead of date-and-amount
 * coincidences, which are a prompt to check rather than proof.
 */
export async function fetchDuplicateWarnings(claimId: string): Promise<Map<string, DuplicateWarning[]>> {
  const { data, error } = await supabase.rpc('claim_duplicate_warnings', { p_claim_id: claimId })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{
    line_id: string
    match_type: DuplicateMatchType
    other_claim_id: string
    other_claim_status: ClaimStatus
    other_submitter: string
    other_date: string
    other_gross: number | string
    other_is_mine: boolean
  }>
  const byLine = new Map<string, DuplicateWarning[]>()
  for (const r of rows) {
    const list = byLine.get(r.line_id) ?? []
    list.push({
      lineId: r.line_id,
      matchType: r.match_type,
      otherClaimId: r.other_claim_id,
      otherClaimStatus: r.other_claim_status,
      otherSubmitter: r.other_submitter,
      otherDate: r.other_date,
      otherGross: Number(r.other_gross),
      otherIsMine: r.other_is_mine,
    })
    byLine.set(r.line_id, list)
  }
  for (const list of byLine.values()) {
    list.sort((a, b) => (a.matchType === b.matchType ? 0 : a.matchType === 'exact_file' ? -1 : 1))
  }
  return byLine
}
