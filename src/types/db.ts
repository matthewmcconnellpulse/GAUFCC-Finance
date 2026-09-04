/**
 * Domain types — the contract between the Supabase schema
 * (supabase/migrations) and the frontend modules.
 *
 * Table/column names mirror the database exactly (snake_case).
 * If you change the schema, change this file in the same commit.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

export type Role =
  | 'pulse_admin'
  | 'pulse_bookkeeper'
  | 'pulse_payroll'
  | 'ceo'
  | 'trustee'
  | 'submitter'

export type Organisation = 'pulse' | 'gaufcc'

export type FundType = 'restricted' | 'designated' | 'endowment' | 'general' | 'dormant'

export type ClaimStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'pushed_to_xero'
  | 'paid'

export type PersonType = 'employee' | 'volunteer'

export type OnboardingStatus =
  | 'invited'
  | 'in_progress'
  | 'submitted'
  | 'verified'
  | 'complete'

export type ImportStatus =
  | 'uploaded'
  | 'parsed'
  | 'checks_failed'
  | 'ready'
  | 'exported'
  | 'overridden'

export type IncomeType = 'realised_gain' | 'unrealised_gain' | 'interest' | 'dividend' | 'fee'

export type SyncTrigger = 'cron' | 'manual'

export type ProjectTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done'

// ── Identity & access ────────────────────────────────────────────────────────

export interface Profile {
  id: string // = auth.users.id
  full_name: string
  email: string
  role: Role
  organisation: Organisation
  active: boolean
  created_at: string
  updated_at: string
}

export interface FundManager {
  id: string
  profile_id: string
  fund_id: string
  whole_board: boolean // true = sees all funds in packs
  created_at: string
}

// ── Xero mirror (read model) ─────────────────────────────────────────────────

export interface XeroConnection {
  id: string
  tenant_id: string | null
  connection_type: 'custom_connection' | 'oauth2'
  status: 'connected' | 'disconnected' | 'error'
  last_sync_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

/** Charities SORP (FRS 102) SOFA headings — accounts map onto these. */
export type SorpCategory =
  | 'donations_legacies'
  | 'charitable_activities_income'
  | 'other_trading'
  | 'investments_income'
  | 'other_income'
  | 'raising_funds'
  | 'charitable_activities_expenditure'
  | 'other_expenditure'

export interface XeroAccount {
  id: string
  account_id: string // Xero AccountID
  code: string | null
  name: string
  type: string
  class: string | null
  reporting_code: string | null
  status: string | null
  /** SOFA heading; null = not yet mapped (Settings → SORP mapping) */
  sorp_category: SorpCategory | null
  updated_at: string
}

export interface XeroContact {
  id: string
  contact_id: string // Xero ContactID
  name: string
  email: string | null
  is_supplier: boolean
  is_customer: boolean
  status: string | null
  updated_at: string
}

export interface XeroTrackingCategory {
  id: string
  tracking_category_id: string
  name: string
  status: string | null
  position: 1 | 2 // which of the two category slots
  updated_at: string
}

export interface XeroTrackingOption {
  id: string
  tracking_option_id: string
  tracking_category_id: string
  name: string
  status: string | null
  updated_at: string
}

export interface XeroTransaction {
  id: string
  xero_id: string // source document id
  line_id: string // unique per line
  source_type:
    | 'ACCREC' // sales invoice
    | 'ACCPAY' // bill
    | 'RECEIVE' // bank receive
    | 'SPEND' // bank spend
    | 'BANK_TRANSFER'
    | 'CREDIT_NOTE'
    | 'PREPAYMENT'
    | 'OVERPAYMENT'
    | 'MANJOURNAL' // manual journal (payroll etc.)
  date: string // ISO date
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
  created_at: string
}

export interface SyncRun {
  id: string
  started_at: string
  finished_at: string | null
  trigger: SyncTrigger
  status: 'running' | 'success' | 'error'
  records_upserted: number
  errors: unknown[] | null
  triggered_by: string | null
}

// ── Funds ────────────────────────────────────────────────────────────────────

export interface WarningRules {
  min_balance?: number | null
  flag_deficit?: boolean
  /** flag when |period movement| exceeds this multiple of trailing 12-mo average */
  unusual_movement_factor?: number | null
  /** months without movement before the fund is flagged dormant */
  dormancy_months?: number | null
}

export interface Fund {
  id: string
  tracking_option_id: string | null // 1:1 with xero_tracking_options
  name: string
  fund_type: FundType
  opening_balance: number
  opening_balance_date: string | null
  description: string | null
  purpose: string | null
  warning_rules: WarningRules
  /** null until Pulse classifies a newly-synced tracking option */
  classified_at: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface FundNote {
  id: string
  fund_id: string
  body: string
  /** "For the attention of" — profile id, optional */
  attention_of: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface FundWarning {
  id: string
  fund_id: string
  rule: 'deficit' | 'min_balance' | 'unusual_movement' | 'dormancy'
  message: string
  severity: 'amber' | 'red'
  as_of: string
  resolved_at: string | null
  created_at: string
}

export interface IntegrityStamp {
  id: string
  period: string // e.g. '2026-06'
  stamped_by: string
  stamped_at: string
  results: unknown
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export interface ExpenseClaim {
  id: string
  submitter_id: string
  status: ClaimStatus
  period: string // e.g. '2026-06'
  total: number
  ceo_approved_by: string | null
  ceo_approved_at: string | null
  ceo_comment: string | null
  xero_bill_id: string | null
  submitted_at: string | null
  /** Set when a reviewer hands the claim back for amendment (status → draft). */
  review_note: string | null
  returned_by: string | null
  returned_at: string | null
  /** Archived claims are hidden from the working lists; fully reversible. */
  archived_at: string | null
  archived_by: string | null
  created_at: string
  updated_at: string
}

export interface AiExtraction {
  date?: string
  merchant?: string
  description?: string
  net?: number
  vat?: number
  gross?: number
  suggested_category?: string
  currency?: string
}

export interface ExpenseLine {
  id: string
  claim_id: string
  date: string
  description: string
  category: string | null // Xero account code
  fund_id: string | null
  net: number
  vat: number
  gross: number
  receipt_storage_path: string | null
  ai_extraction: AiExtraction | null
  ai_confidence: number | null // 0–1
  /** SHA-256 of the uploaded receipt file — powers duplicate detection. */
  receipt_sha256: string | null
  /** Mileage lines: amount = miles × rate; the rate is frozen on the line. */
  is_mileage: boolean
  miles: number | null
  mileage_rate_pence: number | null
  /** The mileage log HMRC expects behind an AMAP claim. */
  journey_from: string | null
  journey_to: string | null
  journey_purpose: string | null
  /** Descriptive: `miles` is always the total claimed, there and back. */
  is_return_journey: boolean
  created_at: string
  updated_at: string
}

// ── People ───────────────────────────────────────────────────────────────────

export interface Person {
  id: string
  type: PersonType
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  address: string | null
  date_of_birth: string | null
  ni_number_masked: string | null // server-masked; raw is encrypted
  bank_name: string | null
  bank_account_masked: string | null // e.g. '••••1234' — raw encrypted
  bank_sort_code_masked: string | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  role_title: string | null
  volunteer_capacity: string | null
  start_date: string | null
  /** Leavers: last working day, plus an archive stamp that hides the record. */
  end_date: string | null
  leaver_note: string | null
  archived_at: string | null
  archived_by: string | null
  onboarding_status: OnboardingStatus
  profile_id: string | null
  created_at: string
  updated_at: string
}

export interface OnboardingSubmission {
  id: string
  person_id: string
  payload: unknown
  submitted_at: string
}

export interface OnboardingToken {
  id: string
  token: string
  person_id: string | null
  person_type: PersonType
  email: string
  expires_at: string
  used_at: string | null
  created_by: string
  created_at: string
}

// ── Imports ──────────────────────────────────────────────────────────────────

export interface BankImportRow {
  date: string
  description: string
  amount: number
  balance: number | null
  reference?: string | null
}

export interface SenseCheckResult {
  check:
    | 'opening_matches_prior_closing'
    | 'running_balance_recomputes'
    | 'no_date_gaps_or_overlaps'
    | 'no_duplicates'
  pass: boolean
  detail: string
}

export interface BankImport {
  id: string
  file_path: string
  file_name: string
  statement_start: string | null
  statement_end: string | null
  opening_balance: number | null
  closing_balance: number | null
  parsed_rows: BankImportRow[] | null
  sense_check_results: SenseCheckResult[] | null
  status: ImportStatus
  override_reason: string | null
  overridden_by: string | null
  generated_csv_path: string | null
  uploaded_by: string
  created_at: string
  updated_at: string
}

export interface EpworthImport {
  id: string
  file_path: string
  file_name: string
  period: string // e.g. '2026-06'
  parsed: unknown
  mapping_results: unknown
  status: ImportStatus
  uploaded_by: string
  created_at: string
  updated_at: string
}

export interface EpworthFundMapping {
  id: string
  epworth_holding_ref: string
  fund_id: string
  income_type: IncomeType
  created_by: string
  created_at: string
}

// ── Cashflow forecast (mirrors the weekly Excel template) ────────────────────

export interface CashflowConfig {
  key: 'default'
  opening_balance: number
  opening_date: string // ISO date — the Monday the first week column starts
  weekly_weeks: number
  monthly_months: number
  updated_by: string | null
  updated_at: string
}

export interface CashflowLine {
  id: string
  section: 'income' | 'outgoing'
  name: string
  sort_order: number
  /** Xero account codes this line maps to, for one-click actuals */
  account_codes: string[]
  active: boolean
  created_at: string
}

export interface CashflowCell {
  id: string
  line_id: string
  period_start: string // ISO date, the column's first day
  amount: number // signed as typed — income positive, outgoings negative
  note: string | null
  updated_by: string | null
  updated_at: string
}

// ── VAT ──────────────────────────────────────────────────────────────────────

export interface DeMinimisResult {
  test1_pass: boolean
  test2_pass: boolean
  monthly_average_input_vat: number
  exempt_input_vat: number
  exempt_share_pct: number
  recoverable: number
  irrecoverable: number
  narrative?: string
}

export interface VatPeriod {
  id: string
  period: string // e.g. '2026-Q2' or '2026-06'
  taxable_supplies: number
  exempt_supplies: number
  residual_input_vat: number
  directly_attributable: { taxable: number; exempt: number }
  de_minimis_result: DeMinimisResult | null
  narrative: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

// ── Platform ─────────────────────────────────────────────────────────────────

export interface Setting {
  key: string
  value: unknown
  description: string | null
  updated_by: string | null
  updated_at: string
}

/** Known settings keys */
export const SETTING_KEYS = {
  expenseApprovalDay: 'expense_approval_day', // default 10
  paymentRunDay: 'payment_run_day', // default 17
  syncHour: 'sync_hour', // default 4 (Europe/London)
  warningDefaults: 'warning_defaults',
  mileageRatePence: 'mileage_rate_pence', // default 45 (HMRC approved rate)
} as const

export interface UserActivityRow {
  id: number
  profile_id: string
  path: string
  page: string
  occurred_at: string
}

export interface AuditLogEntry {
  id: string
  actor_id: string | null
  action: string
  entity: string
  entity_id: string | null
  before: unknown
  after: unknown
  ip: string | null
  created_at: string
}

export interface Project {
  id: string
  name: string
  description: string | null
  status: 'planned' | 'in_progress' | 'complete' | 'parked'
  sort_order: number
  created_at: string
  updated_at: string
}

export interface ProjectTask {
  id: string
  project_id: string
  title: string
  status: ProjectTaskStatus
  assignee: string | null
  start_date: string | null
  due_date: string | null
  depends_on: string[] // task ids, for Gantt rendering
  notes: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

// ── Reports ──────────────────────────────────────────────────────────────────

export interface BoardPack {
  id: string
  title: string
  period_start: string
  period_end: string
  scope: 'whole_charity' | 'fund_group' | 'single_fund'
  scope_fund_ids: string[] | null
  storage_path: string | null
  status: 'draft' | 'final'
  version: number
  commentary: unknown
  created_by: string
  created_at: string
  updated_at: string
}

// ── Month end close ──────────────────────────────────────────────────────────

export type CloseTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'not_applicable'
export type ClosePeriodStatus = 'in_progress' | 'complete' | 'reopened'

/** A close runs monthly, or quarterly where the management accounts do. */
export type ClosePeriodType = 'month' | 'quarter'

export interface ClosePeriod {
  id: string
  /** 'YYYY-MM' for a month, 'YYYY-Qn' for a quarter. */
  period: string
  period_type: ClosePeriodType
  status: ClosePeriodStatus
  note: string | null
  share_token: string
  share_enabled: boolean
  opened_by: string | null
  opened_at: string
  completed_by: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface CloseTask {
  id: string
  period_id: string
  template_key: string | null
  group_label: string
  title: string
  detail: string | null
  /** In-app route for the work itself, e.g. '/imports/hsbc'. */
  link_to: string | null
  /** Work that happens outside the platform, e.g. Xero bank reconciliation. */
  external_url: string | null
  sort_order: number
  is_client_signoff: boolean
  assignee_id: string | null
  status: CloseTaskStatus
  note: string | null
  signed_off_by: string | null
  signed_off_at: string | null
  created_at: string
  updated_at: string
}
