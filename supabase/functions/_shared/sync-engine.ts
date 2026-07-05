/**
 * Xero → Supabase sync engine, shared by the `sync-xero` (cron) and
 * `sync-now` (manual) edge functions.
 *
 * Conventions this module establishes (the mirror's contract):
 *
 * ── Natural keys ─────────────────────────────────────────────────────────────
 * All mirror tables are upserted on their Xero natural key, never the uuid pk:
 *   xero_accounts.account_id · xero_contacts.contact_id ·
 *   xero_tracking_categories.tracking_category_id ·
 *   xero_tracking_options.tracking_option_id · xero_transactions.line_id.
 * `xero_transactions.tracking_option_1_id / _2_id` and
 * `funds.tracking_option_id` hold the **Xero TrackingOptionID** string so the
 * mirror joins on natural keys throughout.
 *
 * ── Line flattening ──────────────────────────────────────────────────────────
 * Every Xero document (invoice, bill, bank transaction, credit note) is
 * flattened to one row per line item. `line_id` is the Xero LineItemID, or
 * `<documentId>-<index>` when Xero omits it. Documents with no line items
 * (e.g. bank transfers) produce a single synthetic row from document totals so
 * they remain visible to the integrity screens.
 *
 * ── Sign convention (money) ──────────────────────────────────────────────────
 * net/vat/gross are stored DOCUMENT-NATURAL — this is the contract the
 * deployed views (0005/0012) rely on: invoices and bank lines are stored
 * POSITIVE, and income vs expenditure is decided downstream by the account's
 * class (REVENUE → income, EXPENSE → expenditure). Credit notes are stored
 * NEGATIVE so they reduce the movement on their account's class.
 *   fund balance = opening_balance + Σ(REVENUE net) − Σ(EXPENSE net).
 *   ACCREC +  · ACCPAY +  · RECEIVE + · SPEND + · transfers + ·
 *   ACCRECCREDIT − (reduces income) · ACCPAYCREDIT − (reduces expenditure,
 *   because the view subtracts EXPENSE net and −(−x) adds it back).
 * Worked example: a £100 bill (ACCPAY, EXPENSE) stores net +100 → balance
 * −100; a £100 supplier credit (ACCPAYCREDIT, EXPENSE) stores net −100 →
 * balance −(−100) = +100; a £200 sales invoice (ACCREC, REVENUE) stores +200
 * → balance +200. All consistent with v_fund_balances.
 *
 * ── source_type mapping ──────────────────────────────────────────────────────
 *   Invoices Type ACCREC → 'ACCREC', ACCPAY → 'ACCPAY'.
 *   BankTransactions SPEND → 'SPEND', RECEIVE → 'RECEIVE',
 *     SPEND-TRANSFER / RECEIVE-TRANSFER → 'BANK_TRANSFER',
 *     *-PREPAYMENT → 'PREPAYMENT', *-OVERPAYMENT → 'OVERPAYMENT'.
 *   CreditNotes (both ACCRECCREDIT and ACCPAYCREDIT) → 'CREDIT_NOTE'.
 *
 * ── Incremental sync ─────────────────────────────────────────────────────────
 * If-Modified-Since is taken from the last *successful* run's started_at.
 * TrackingCategories does not support If-Modified-Since and is always fetched
 * in full (it is tiny). Endpoints are paged 100/page until a short page.
 * Endpoint loops are strictly sequential to respect Xero's 60 calls/minute
 * limit (429 backoff itself lives in `xeroFetch`).
 *
 * ── Warning engine ───────────────────────────────────────────────────────────
 * Evaluated for every active, classified fund after each sync, reading the
 * same views the dashboard renders (v_fund_balances, v_fund_monthly) so badge
 * and figure can never disagree. v_fund_monthly income/expenditure are read as
 * positive magnitudes; monthly net = income − expenditure.
 * Severity: amber everywhere except a deficit on a *restricted* fund, which is
 * red (spending restricted money you do not hold is a breached policy).
 * Per-fund warning_rules are merged over the `warning_defaults` settings row.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { serviceClient } from './auth.ts'
import { xeroFetch, parseXeroDate } from './xero.ts'

const PAGE_SIZE = 100
const UPSERT_BATCH = 500

// ── Types ────────────────────────────────────────────────────────────────────

export type SyncTrigger = 'cron' | 'manual'

export interface SyncResult {
  runId: string | null
  status: 'success' | 'error'
  recordsUpserted: number
  errors: string[]
}

type SourceType =
  | 'ACCREC'
  | 'ACCPAY'
  | 'RECEIVE'
  | 'SPEND'
  | 'BANK_TRANSFER'
  | 'CREDIT_NOTE'
  | 'PREPAYMENT'
  | 'OVERPAYMENT'

interface TransactionRow {
  xero_id: string
  line_id: string
  source_type: SourceType
  date: string
  account_code: string | null
  contact_id: string | null
  contact_name: string | null
  description: string | null
  net: number
  vat: number
  gross: number
  tracking_option_1_id: string | null
  tracking_option_2_id: string | null
  status: string | null
  updated_date_utc: string
}

interface WarningRules {
  min_balance?: number | null
  flag_deficit?: boolean
  unusual_movement_factor?: number | null
  dormancy_months?: number | null
}

type WarningRule = 'deficit' | 'min_balance' | 'unusual_movement' | 'dormancy'

interface FiringWarning {
  fund_id: string
  rule: WarningRule
  message: string
  severity: 'amber' | 'red'
}

// Xero API response shapes (only the fields we read).

interface XeroAccountApi {
  AccountID: string
  Code?: string
  Name: string
  Type: string
  Class?: string
  ReportingCode?: string
  Status?: string
  UpdatedDateUTC?: string
}

interface XeroContactApi {
  ContactID: string
  Name: string
  EmailAddress?: string
  IsSupplier?: boolean
  IsCustomer?: boolean
  ContactStatus?: string
  UpdatedDateUTC?: string
}

interface XeroTrackingOptionApi {
  TrackingOptionID: string
  Name: string
  Status?: string
}

interface XeroTrackingCategoryApi {
  TrackingCategoryID: string
  Name: string
  Status?: string
  Options?: XeroTrackingOptionApi[]
}

interface XeroLineTrackingApi {
  TrackingCategoryID?: string
  TrackingOptionID?: string
  Name?: string
  Option?: string
}

interface XeroLineItemApi {
  LineItemID?: string
  Description?: string
  Quantity?: number
  UnitAmount?: number
  LineAmount?: number
  TaxAmount?: number
  AccountCode?: string
  Tracking?: XeroLineTrackingApi[]
}

interface XeroContactRefApi {
  ContactID?: string
  Name?: string
}

interface XeroDocumentApi {
  Status?: string
  Date?: string
  DateString?: string
  UpdatedDateUTC?: string
  Reference?: string
  Contact?: XeroContactRefApi
  LineItems?: XeroLineItemApi[]
  SubTotal?: number
  TotalTax?: number
  Total?: number
}

interface XeroInvoiceApi extends XeroDocumentApi {
  InvoiceID: string
  Type: 'ACCREC' | 'ACCPAY'
}

interface XeroBankTransactionApi extends XeroDocumentApi {
  BankTransactionID: string
  Type: string
}

interface XeroCreditNoteApi extends XeroDocumentApi {
  CreditNoteID: string
  Type: 'ACCRECCREDIT' | 'ACCPAYCREDIT'
}

// ── Small helpers ────────────────────────────────────────────────────────────

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function nowIso(): string {
  return new Date().toISOString()
}

const gbp = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
})

/** £1,250.00 with a true minus sign — UK conventions in warning copy. */
function money(n: number): string {
  return gbp.format(n).replace('-', '−')
}

function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const map = new Map<string, T>()
  for (const row of rows) map.set(key(row), row)
  return [...map.values()]
}

function firstOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

async function upsertBatches<T extends object>(
  svc: SupabaseClient,
  table: string,
  rows: T[],
  onConflict: string,
): Promise<number> {
  let written = 0
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH)
    const { error } = await svc.from(table).upsert(batch, { onConflict })
    if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`)
    written += batch.length
  }
  return written
}

/** Page through a Xero collection endpoint (100/page) until a short page. */
async function fetchAllPages<T>(
  path: string,
  collectionKey: string,
  params: Record<string, string>,
  modifiedSince?: string,
): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const { status, data } = await xeroFetch<Record<string, unknown>>(path, {
      params: { ...params, page: String(page) },
      modifiedSince,
    })
    if (status === 304 || !data) break
    const docs = (data[collectionKey] ?? []) as T[]
    all.push(...docs)
    if (docs.length < PAGE_SIZE) break
  }
  return all
}

// ── xero_connections singleton ───────────────────────────────────────────────

export async function touchConnection(
  svc: SupabaseClient,
  patch: {
    status: 'connected' | 'disconnected' | 'error'
    last_error?: string | null
    last_sync_at?: string | null
    tenant_id?: string | null
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    status: patch.status,
    last_error: patch.last_error ?? null,
  }
  if (patch.last_sync_at !== undefined) row.last_sync_at = patch.last_sync_at
  if (patch.tenant_id !== undefined && patch.tenant_id !== null) {
    row.tenant_id = patch.tenant_id
  }
  const { data: existing, error } = await svc
    .from('xero_connections')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`Could not read xero_connections: ${error.message}`)
  if (existing && existing.length > 0) {
    const { error: updateError } = await svc
      .from('xero_connections')
      .update(row)
      .eq('id', (existing[0] as { id: string }).id)
    if (updateError) {
      throw new Error(`Could not update xero_connections: ${updateError.message}`)
    }
  } else {
    const { error: insertError } = await svc
      .from('xero_connections')
      .insert({ connection_type: 'custom_connection', ...row })
    if (insertError) {
      throw new Error(`Could not insert xero_connections: ${insertError.message}`)
    }
  }
}

// ── Sync stages ──────────────────────────────────────────────────────────────

async function lastSuccessfulRunStart(svc: SupabaseClient): Promise<string | undefined> {
  const { data, error } = await svc
    .from('sync_runs')
    .select('started_at')
    .eq('status', 'success')
    .order('started_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`Could not read sync_runs: ${error.message}`)
  const last = data?.[0]?.started_at as string | undefined
  // Xero expects If-Modified-Since as ISO 8601 UTC without a zone suffix
  // (e.g. 2026-06-01T09:30:00) — RFC 1123 strings are silently ignored,
  // which would turn every sync into a full pull.
  return last ? new Date(last).toISOString().slice(0, 19) : undefined
}

async function syncAccounts(svc: SupabaseClient, modifiedSince?: string): Promise<number> {
  const { status, data } = await xeroFetch<{ Accounts?: XeroAccountApi[] }>('Accounts', {
    modifiedSince,
  })
  if (status === 304 || !data?.Accounts?.length) return 0
  const rows = dedupeBy(data.Accounts, (a) => a.AccountID).map((a) => ({
    account_id: a.AccountID,
    code: a.Code ?? null,
    name: a.Name,
    type: a.Type,
    class: a.Class ?? null,
    reporting_code: a.ReportingCode ?? null,
    status: a.Status ?? null,
    updated_at: parseXeroDate(a.UpdatedDateUTC) ?? nowIso(),
  }))
  return upsertBatches(svc, 'xero_accounts', rows, 'account_id')
}

async function syncContacts(svc: SupabaseClient, modifiedSince?: string): Promise<number> {
  const contacts = await fetchAllPages<XeroContactApi>('Contacts', 'Contacts', {}, modifiedSince)
  if (!contacts.length) return 0
  const rows = dedupeBy(contacts, (c) => c.ContactID).map((c) => ({
    contact_id: c.ContactID,
    name: c.Name,
    email: c.EmailAddress ?? null,
    is_supplier: c.IsSupplier ?? false,
    is_customer: c.IsCustomer ?? false,
    status: c.ContactStatus ?? null,
    updated_at: parseXeroDate(c.UpdatedDateUTC) ?? nowIso(),
  }))
  return upsertBatches(svc, 'xero_contacts', rows, 'contact_id')
}

/**
 * Always a full fetch (endpoint does not support If-Modified-Since; two
 * categories at most). Populates `categoryPosition` (TrackingCategoryID →
 * 1 | 2 by array order) for line flattening.
 */
async function syncTrackingCategories(
  svc: SupabaseClient,
  categoryPosition: Map<string, 1 | 2>,
): Promise<number> {
  const { data } = await xeroFetch<{ TrackingCategories?: XeroTrackingCategoryApi[] }>(
    'TrackingCategories',
    { params: { includeArchived: 'true' } },
  )
  const categories = data?.TrackingCategories ?? []
  if (!categories.length) return 0

  const categoryRows: Record<string, unknown>[] = []
  const optionRows: Record<string, unknown>[] = []
  categories.slice(0, 2).forEach((cat, index) => {
    const position = (index + 1) as 1 | 2
    categoryPosition.set(cat.TrackingCategoryID, position)
    categoryRows.push({
      tracking_category_id: cat.TrackingCategoryID,
      name: cat.Name,
      status: cat.Status ?? null,
      position,
      updated_at: nowIso(),
    })
    for (const opt of cat.Options ?? []) {
      optionRows.push({
        tracking_option_id: opt.TrackingOptionID,
        tracking_category_id: cat.TrackingCategoryID,
        name: opt.Name,
        status: opt.Status ?? null,
        updated_at: nowIso(),
      })
    }
  })

  let written = await upsertBatches(
    svc,
    'xero_tracking_categories',
    categoryRows,
    'tracking_category_id',
  )
  written += await upsertBatches(
    svc,
    'xero_tracking_options',
    dedupeBy(optionRows, (o) => o.tracking_option_id as string),
    'tracking_option_id',
  )
  return written
}

/** Flatten one Xero document into line-level xero_transactions rows. */
function flattenDocument(opts: {
  docId: string
  sourceType: SourceType
  sign: 1 | -1
  doc: XeroDocumentApi
  categoryPosition: Map<string, 1 | 2>
  errors: string[]
  docLabel: string
}): TransactionRow[] {
  const { docId, sourceType, sign, doc, categoryPosition, errors, docLabel } = opts
  const dateIso = parseXeroDate(doc.DateString ?? doc.Date)
  if (!dateIso) {
    errors.push(`Skipped ${docLabel} ${docId} — document has no parseable date`)
    return []
  }
  const date = dateIso.slice(0, 10)
  const updatedDateUtc = parseXeroDate(doc.UpdatedDateUTC) ?? nowIso()
  const contactId = doc.Contact?.ContactID ?? null
  const contactName = doc.Contact?.Name ?? null
  const status = doc.Status ?? null
  const lines = doc.LineItems ?? []

  const base = {
    xero_id: docId,
    source_type: sourceType,
    date,
    contact_id: contactId,
    contact_name: contactName,
    status,
    updated_date_utc: updatedDateUtc,
  }

  if (lines.length === 0) {
    // Bank transfers and some system documents carry no line items — keep one
    // row from the document totals so integrity screens still see them.
    const net = round2(sign * (doc.SubTotal ?? doc.Total ?? 0))
    const vat = round2(sign * (doc.TotalTax ?? 0))
    return [
      {
        ...base,
        line_id: `${docId}-0`,
        account_code: null,
        description: doc.Reference ?? null,
        net,
        vat,
        gross: round2(net + vat),
        tracking_option_1_id: null,
        tracking_option_2_id: null,
      },
    ]
  }

  return lines.map((li, index) => {
    const rawNet =
      li.UnitAmount !== undefined && li.UnitAmount !== null
        ? round2(li.UnitAmount * (li.Quantity ?? 1))
        : (li.LineAmount ?? 0)
    const net = round2(sign * rawNet)
    const vat = round2(sign * (li.TaxAmount ?? 0))
    let tracking1: string | null = null
    let tracking2: string | null = null
    for (const t of li.Tracking ?? []) {
      const position = t.TrackingCategoryID
        ? categoryPosition.get(t.TrackingCategoryID)
        : undefined
      if (position === 1) tracking1 = t.TrackingOptionID ?? null
      else if (position === 2) tracking2 = t.TrackingOptionID ?? null
    }
    return {
      ...base,
      line_id: li.LineItemID || `${docId}-${index}`,
      account_code: li.AccountCode ?? null,
      description: li.Description ?? doc.Reference ?? null,
      net,
      vat,
      gross: round2(net + vat),
      tracking_option_1_id: tracking1,
      tracking_option_2_id: tracking2,
    }
  })
}

async function syncInvoices(
  svc: SupabaseClient,
  categoryPosition: Map<string, 1 | 2>,
  errors: string[],
  modifiedSince?: string,
): Promise<number> {
  const invoices = await fetchAllPages<XeroInvoiceApi>(
    'Invoices',
    'Invoices',
    // VOIDED must be excluded too: a voided bill still passes a DELETED-only
    // filter and would wrongly move fund balances in the mirror.
    { where: 'Status!="DELETED"&&Status!="VOIDED"' },
    modifiedSince,
  )
  const rows: TransactionRow[] = []
  for (const inv of invoices) {
    // Document-natural: both sales invoices (ACCREC/REVENUE) and bills
    // (ACCPAY/EXPENSE) store positive; the view separates them by account class.
    const sign: 1 | -1 = 1
    rows.push(
      ...flattenDocument({
        docId: inv.InvoiceID,
        sourceType: inv.Type,
        sign,
        doc: inv,
        categoryPosition,
        errors,
        docLabel: 'invoice',
      }),
    )
  }
  if (!rows.length) return 0
  return upsertBatches(
    svc,
    'xero_transactions',
    dedupeBy(rows, (r) => r.line_id),
    'line_id',
  )
}

function mapBankTransactionType(type: string): { source: SourceType; sign: 1 | -1 } | null {
  // Document-natural sign: bank lines store positive; the view's account-class
  // filter (EXPENSE vs REVENUE) decides whether a line reduces or grows the
  // fund balance. SPEND lines are almost always coded to EXPENSE accounts and
  // are therefore subtracted by v_fund_balances.
  switch (type) {
    case 'SPEND':
      return { source: 'SPEND', sign: 1 }
    case 'RECEIVE':
      return { source: 'RECEIVE', sign: 1 }
    case 'SPEND-TRANSFER':
      return { source: 'BANK_TRANSFER', sign: 1 }
    case 'RECEIVE-TRANSFER':
      return { source: 'BANK_TRANSFER', sign: 1 }
    case 'SPEND-PREPAYMENT':
      return { source: 'PREPAYMENT', sign: 1 }
    case 'RECEIVE-PREPAYMENT':
      return { source: 'PREPAYMENT', sign: 1 }
    case 'SPEND-OVERPAYMENT':
      return { source: 'OVERPAYMENT', sign: 1 }
    case 'RECEIVE-OVERPAYMENT':
      return { source: 'OVERPAYMENT', sign: 1 }
    default:
      return null
  }
}

async function syncBankTransactions(
  svc: SupabaseClient,
  categoryPosition: Map<string, 1 | 2>,
  errors: string[],
  modifiedSince?: string,
): Promise<number> {
  const transactions = await fetchAllPages<XeroBankTransactionApi>(
    'BankTransactions',
    'BankTransactions',
    { where: 'Status!="DELETED"' },
    modifiedSince,
  )
  const rows: TransactionRow[] = []
  for (const tx of transactions) {
    const mapped = mapBankTransactionType(tx.Type)
    if (!mapped) {
      errors.push(`Skipped bank transaction ${tx.BankTransactionID} — unknown type ${tx.Type}`)
      continue
    }
    rows.push(
      ...flattenDocument({
        docId: tx.BankTransactionID,
        sourceType: mapped.source,
        sign: mapped.sign,
        doc: tx,
        categoryPosition,
        errors,
        docLabel: 'bank transaction',
      }),
    )
  }
  if (!rows.length) return 0
  return upsertBatches(
    svc,
    'xero_transactions',
    dedupeBy(rows, (r) => r.line_id),
    'line_id',
  )
}

async function syncCreditNotes(
  svc: SupabaseClient,
  categoryPosition: Map<string, 1 | 2>,
  errors: string[],
  modifiedSince?: string,
): Promise<number> {
  const creditNotes = await fetchAllPages<XeroCreditNoteApi>(
    'CreditNotes',
    'CreditNotes',
    { where: 'Status!="DELETED"&&Status!="VOIDED"' },
    modifiedSince,
  )
  const rows: TransactionRow[] = []
  for (const cn of creditNotes) {
    // Both credit-note types store NEGATIVE: a sales credit (ACCRECCREDIT,
    // REVENUE account) reduces income; a supplier credit (ACCPAYCREDIT,
    // EXPENSE account) reduces expenditure because the view subtracts EXPENSE
    // net and −(−x) adds it back to the balance.
    const sign: 1 | -1 = -1
    rows.push(
      ...flattenDocument({
        docId: cn.CreditNoteID,
        sourceType: 'CREDIT_NOTE',
        sign,
        doc: cn,
        categoryPosition,
        errors,
        docLabel: 'credit note',
      }),
    )
  }
  if (!rows.length) return 0
  return upsertBatches(
    svc,
    'xero_transactions',
    dedupeBy(rows, (r) => r.line_id),
    'line_id',
  )
}

/**
 * Create a funds row for any tracking option of the position-1 category that
 * lacks one. New funds arrive unclassified (classified_at null, fund_type
 * 'general') and surface in Settings → fund classification queue for Pulse.
 */
async function autoCreateFunds(svc: SupabaseClient): Promise<number> {
  const { data: categories, error: catError } = await svc
    .from('xero_tracking_categories')
    .select('tracking_category_id')
    .eq('position', 1)
    .limit(1)
  if (catError) throw new Error(`Could not read tracking categories: ${catError.message}`)
  const category1 = categories?.[0] as { tracking_category_id: string } | undefined
  if (!category1) return 0

  const { data: options, error: optError } = await svc
    .from('xero_tracking_options')
    .select('tracking_option_id, name')
    .eq('tracking_category_id', category1.tracking_category_id)
    .limit(5000)
  if (optError) throw new Error(`Could not read tracking options: ${optError.message}`)

  const { data: funds, error: fundError } = await svc
    .from('funds')
    .select('tracking_option_id')
    .limit(5000)
  if (fundError) throw new Error(`Could not read funds: ${fundError.message}`)

  const existing = new Set(
    ((funds ?? []) as { tracking_option_id: string | null }[])
      .map((f) => f.tracking_option_id)
      .filter((id): id is string => Boolean(id)),
  )
  const missing = ((options ?? []) as { tracking_option_id: string; name: string }[]).filter(
    (o) => !existing.has(o.tracking_option_id),
  )
  if (!missing.length) return 0

  const rows = missing.map((o) => ({
    tracking_option_id: o.tracking_option_id,
    name: o.name,
    fund_type: 'general',
    opening_balance: 0,
    opening_balance_date: null,
    warning_rules: {},
    classified_at: null,
    active: true,
  }))
  const { error } = await svc.from('funds').insert(rows)
  if (error) throw new Error(`Could not auto-create funds: ${error.message}`)
  return rows.length
}

// ── Warning engine ───────────────────────────────────────────────────────────

interface FundForWarnings {
  id: string
  name: string
  fund_type: 'restricted' | 'designated' | 'general' | 'dormant'
  opening_balance: number
  warning_rules: WarningRules | null
}

interface FundMonthlyRow {
  fund_id: string
  month: string
  income: number
  expenditure: number
}

function evaluateFund(
  fund: FundForWarnings,
  rules: WarningRules,
  balance: number,
  monthly: FundMonthlyRow[],
  now: Date,
): FiringWarning[] {
  const firing: FiringWarning[] = []

  if (rules.flag_deficit && balance < 0) {
    firing.push({
      fund_id: fund.id,
      rule: 'deficit',
      message: `Fund balance is in deficit at ${money(balance)}`,
      severity: fund.fund_type === 'restricted' ? 'red' : 'amber',
    })
  }

  if (rules.min_balance !== null && rules.min_balance !== undefined && balance < rules.min_balance) {
    firing.push({
      fund_id: fund.id,
      rule: 'min_balance',
      message: `Balance ${money(balance)} is below the minimum of ${money(rules.min_balance)}`,
      severity: 'amber',
    })
  }

  const netByMonth = new Map<string, number>()
  let hasAnyActivity = false
  let lastActivity: string | null = null
  for (const row of monthly) {
    const key = row.month.slice(0, 10)
    const net = round2((row.income ?? 0) - (row.expenditure ?? 0))
    netByMonth.set(key, net)
    if ((row.income ?? 0) !== 0 || (row.expenditure ?? 0) !== 0) {
      hasAnyActivity = true
      if (!lastActivity || key > lastActivity) lastActivity = key
    }
  }

  const currentMonth = firstOfMonthUtc(now)
  const factor = rules.unusual_movement_factor
  if (factor !== null && factor !== undefined && factor > 0) {
    const currentNet = netByMonth.get(monthKey(currentMonth)) ?? 0
    let trailingTotal = 0
    for (let i = 1; i <= 12; i++) {
      trailingTotal += Math.abs(netByMonth.get(monthKey(addMonthsUtc(currentMonth, -i))) ?? 0)
    }
    const trailingAverage = trailingTotal / 12
    if (trailingAverage > 0 && Math.abs(currentNet) > factor * trailingAverage) {
      const multiple = (Math.abs(currentNet) / trailingAverage).toFixed(1)
      firing.push({
        fund_id: fund.id,
        rule: 'unusual_movement',
        message: `Movement of ${money(currentNet)} this month is ${multiple}× the trailing 12-month average`,
        severity: 'amber',
      })
    }
  }

  const dormancyMonths = rules.dormancy_months
  if (dormancyMonths !== null && dormancyMonths !== undefined && dormancyMonths > 0) {
    // Only meaningful for funds that have ever moved or hold a balance —
    // avoids flagging a brand-new fund the day it is created.
    const established = hasAnyActivity || fund.opening_balance !== 0
    const cutoff = monthKey(addMonthsUtc(currentMonth, -dormancyMonths))
    const activeRecently = lastActivity !== null && lastActivity >= cutoff
    if (established && !activeRecently) {
      firing.push({
        fund_id: fund.id,
        rule: 'dormancy',
        message: `No transactions recorded for ${dormancyMonths} months or more`,
        severity: 'amber',
      })
    }
  }

  return firing
}

async function runWarningEngine(svc: SupabaseClient): Promise<void> {
  const { data: fundsData, error: fundsError } = await svc
    .from('funds')
    .select('id, name, fund_type, opening_balance, warning_rules')
    .eq('active', true)
    .not('classified_at', 'is', null)
    .limit(5000)
  if (fundsError) throw new Error(`Warning engine could not read funds: ${fundsError.message}`)
  const funds = (fundsData ?? []) as FundForWarnings[]

  const { data: defaultsRow } = await svc
    .from('settings')
    .select('value')
    .eq('key', 'warning_defaults')
    .maybeSingle()
  const defaults: WarningRules =
    defaultsRow && typeof defaultsRow.value === 'object' && defaultsRow.value !== null
      ? (defaultsRow.value as WarningRules)
      : { flag_deficit: true }

  const { data: balancesData, error: balancesError } = await svc
    .from('v_fund_balances')
    .select('fund_id, balance')
    .limit(5000)
  if (balancesError) {
    throw new Error(`Warning engine could not read v_fund_balances: ${balancesError.message}`)
  }
  const balanceByFund = new Map(
    ((balancesData ?? []) as { fund_id: string; balance: number }[]).map((b) => [
      b.fund_id,
      b.balance ?? 0,
    ]),
  )

  const { data: monthlyData, error: monthlyError } = await svc
    .from('v_fund_monthly')
    .select('fund_id, month, income, expenditure')
    .limit(10000)
  if (monthlyError) {
    throw new Error(`Warning engine could not read v_fund_monthly: ${monthlyError.message}`)
  }
  const monthlyByFund = new Map<string, FundMonthlyRow[]>()
  for (const row of (monthlyData ?? []) as FundMonthlyRow[]) {
    const list = monthlyByFund.get(row.fund_id)
    if (list) list.push(row)
    else monthlyByFund.set(row.fund_id, [row])
  }

  const now = new Date()
  const firing: FiringWarning[] = []
  for (const fund of funds) {
    const rules: WarningRules = { ...defaults, ...(fund.warning_rules ?? {}) }
    firing.push(
      ...evaluateFund(
        fund,
        rules,
        balanceByFund.get(fund.id) ?? fund.opening_balance ?? 0,
        monthlyByFund.get(fund.id) ?? [],
        now,
      ),
    )
  }

  const { data: openData, error: openError } = await svc
    .from('fund_warnings')
    .select('id, fund_id, rule, message, severity')
    .is('resolved_at', null)
    .limit(5000)
  if (openError) {
    throw new Error(`Warning engine could not read fund_warnings: ${openError.message}`)
  }
  const open = (openData ?? []) as {
    id: string
    fund_id: string
    rule: WarningRule
    message: string
    severity: 'amber' | 'red'
  }[]

  const keyOf = (w: { fund_id: string; rule: WarningRule }) => `${w.fund_id}:${w.rule}`
  const openByKey = new Map(open.map((w) => [keyOf(w), w]))
  const firingKeys = new Set(firing.map(keyOf))
  const today = nowIso().slice(0, 10)

  const toInsert = firing
    .filter((f) => !openByKey.has(keyOf(f)))
    .map((f) => ({
      fund_id: f.fund_id,
      rule: f.rule,
      message: f.message,
      severity: f.severity,
      as_of: today,
      resolved_at: null,
    }))
  if (toInsert.length) {
    const { error } = await svc.from('fund_warnings').insert(toInsert)
    if (error) throw new Error(`Could not insert fund_warnings: ${error.message}`)
  }

  const toResolve = open.filter((w) => !firingKeys.has(keyOf(w))).map((w) => w.id)
  if (toResolve.length) {
    const { error } = await svc
      .from('fund_warnings')
      .update({ resolved_at: nowIso() })
      .in('id', toResolve)
    if (error) throw new Error(`Could not resolve fund_warnings: ${error.message}`)
  }

  // Keep the message and as-of date fresh on warnings that are still firing.
  for (const f of firing) {
    const existing = openByKey.get(keyOf(f))
    if (existing && (existing.message !== f.message || existing.severity !== f.severity)) {
      const { error } = await svc
        .from('fund_warnings')
        .update({ message: f.message, severity: f.severity, as_of: today })
        .eq('id', existing.id)
      if (error) throw new Error(`Could not refresh fund_warnings: ${error.message}`)
    }
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * Run a full incremental sync. Never throws — any failure marks the
 * sync_runs row status 'error' with the message and flags the connection.
 */
export async function runSync(
  trigger: SyncTrigger,
  triggeredBy: string | null,
): Promise<SyncResult> {
  const svc = serviceClient()
  const errors: string[] = []
  let runId: string | null = null
  let total = 0

  try {
    const { data: run, error: runError } = await svc
      .from('sync_runs')
      .insert({
        trigger,
        status: 'running',
        started_at: nowIso(),
        records_upserted: 0,
        triggered_by: triggeredBy,
      })
      .select('id')
      .single()
    if (runError || !run) {
      throw new Error(`Could not create sync_runs row: ${runError?.message ?? 'no row returned'}`)
    }
    runId = (run as { id: string }).id

    const modifiedSince = await lastSuccessfulRunStart(svc)
    const categoryPosition = new Map<string, 1 | 2>()

    // Strictly sequential — Xero allows 60 calls/minute per connection.
    total += await syncAccounts(svc, modifiedSince)
    total += await syncContacts(svc, modifiedSince)
    total += await syncTrackingCategories(svc, categoryPosition)
    total += await syncInvoices(svc, categoryPosition, errors, modifiedSince)
    total += await syncBankTransactions(svc, categoryPosition, errors, modifiedSince)
    total += await syncCreditNotes(svc, categoryPosition, errors, modifiedSince)
    total += await autoCreateFunds(svc)
    await runWarningEngine(svc)

    const finishedAt = nowIso()
    const { error: finishError } = await svc
      .from('sync_runs')
      .update({
        finished_at: finishedAt,
        status: 'success',
        records_upserted: total,
        errors,
      })
      .eq('id', runId)
    if (finishError) {
      throw new Error(`Could not finalise sync_runs row: ${finishError.message}`)
    }
    await touchConnection(svc, {
      status: 'connected',
      last_sync_at: finishedAt,
      last_error: null,
    })
    return { runId, status: 'success', recordsUpserted: total, errors }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    errors.push(message)
    console.error(`[sync-engine] run failed: ${message}`)
    try {
      if (runId) {
        await svc
          .from('sync_runs')
          .update({
            finished_at: nowIso(),
            status: 'error',
            records_upserted: total,
            errors,
          })
          .eq('id', runId)
      }
      await touchConnection(svc, { status: 'error', last_error: message })
    } catch (persistError) {
      console.error(`[sync-engine] could not persist failure: ${String(persistError)}`)
    }
    return { runId, status: 'error', recordsUpserted: total, errors }
  }
}
