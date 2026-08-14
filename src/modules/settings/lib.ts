/**
 * Settings module data layer — settings key/values, Xero connection status,
 * sync runs, user administration, fund-manager assignments, the fund
 * classification queue and the audit log. Module-owned.
 */
import { invokeFunction, supabase } from '@/lib/supabase'
import type { AuditLogEntry,
  Fund,
  FundManager,
  Profile,
  Role,
  Setting,
  SyncRun,
  WarningRules,
  XeroConnection, UserActivityRow } from '@/types/db'

// ── Settings ─────────────────────────────────────────────────────────────────

export async function fetchSettings(): Promise<Setting[]> {
  const { data, error } = await supabase.from('settings').select('*').order('key')
  if (error) throw new Error(error.message)
  return (data ?? []) as Setting[]
}

export function settingValue<T>(settings: Setting[] | null, key: string, fallback: T): T {
  const row = settings?.find((s) => s.key === key)
  return row ? (row.value as T) : fallback
}

/**
 * Update a setting value. Uses UPDATE (not upsert) because the settings guard
 * trigger allows the CEO to update exactly two keys but never to insert;
 * every known key is seeded by the migrations so the row always exists. If a
 * brand-new key is ever needed, pulse_admin can insert via `insertSetting`.
 */
export async function updateSettingValue(key: string, value: unknown): Promise<void> {
  const { data, error } = await supabase.from('settings').update({ value }).eq('key', key).select('key')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) throw new Error(`Setting ${key} does not exist yet — ask a Pulse admin to seed it.`)
}

export async function insertSetting(key: string, value: unknown, description: string): Promise<void> {
  const { error } = await supabase.from('settings').insert({ key, value, description })
  if (error) throw new Error(error.message)
}

// ── Xero connection & sync runs ──────────────────────────────────────────────

export async function fetchXeroConnection(): Promise<XeroConnection | null> {
  const { data, error } = await supabase
    .from('xero_connections')
    .select('id, tenant_id, connection_type, status, last_sync_at, last_error, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as XeroConnection | null) ?? null
}

export async function fetchSyncRuns(limit = 30): Promise<SyncRun[]> {
  const { data, error } = await supabase
    .from('sync_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as SyncRun[]
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function fetchProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('organisation')
    .order('full_name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Profile[]
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<Profile, 'full_name' | 'role' | 'organisation'>>,
): Promise<void> {
  const { error } = await supabase.from('profiles').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Last N days of the page-view trail, newest first. Admin-only via RLS. */
export async function fetchUserActivity(days: number): Promise<UserActivityRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('user_activity')
    .select('*')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(10000)
  if (error) throw new Error(error.message)
  return (data ?? []) as UserActivityRow[]
}

export async function setProfileActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('profiles').update({ active }).eq('id', id)
  if (error) throw new Error(error.message)
}

/**
 * Permanently remove a login. The server refuses (409 with an explanation)
 * when the user has financial history — archive via setProfileActive instead.
 */
export async function deleteUser(id: string): Promise<void> {
  await invokeFunction('delete-user', { user_id: id })
}

export const ROLE_LABELS: Record<Role, string> = {
  pulse_admin: 'Pulse admin',
  pulse_bookkeeper: 'Pulse bookkeeper',
  pulse_payroll: 'Pulse payroll',
  ceo: 'CEO',
  trustee: 'Trustee',
  submitter: 'Submitter',
}

export const ALL_ROLES: Role[] = [
  'pulse_admin',
  'pulse_bookkeeper',
  'pulse_payroll',
  'ceo',
  'trustee',
  'submitter',
]

// ── Fund-manager assignments ─────────────────────────────────────────────────

export async function fetchFundManagers(): Promise<FundManager[]> {
  const { data, error } = await supabase.from('fund_managers').select('*')
  if (error) throw new Error(error.message)
  return (data ?? []) as FundManager[]
}

/**
 * Replace a trustee's assignments: delete their rows, then insert the new
 * set. whole_board is stored per-row (the schema's shape); when the flag is
 * on with no specific funds we still need at least one row to carry it, so
 * the caller passes the funds to keep (possibly all-board with a single
 * representative fund).
 */
export async function saveFundManagerAssignments(
  profileId: string,
  fundIds: string[],
  wholeBoard: boolean,
): Promise<void> {
  const { error: delError } = await supabase.from('fund_managers').delete().eq('profile_id', profileId)
  if (delError) throw new Error(delError.message)
  if (fundIds.length === 0) return
  const rows = fundIds.map((fund_id) => ({ profile_id: profileId, fund_id, whole_board: wholeBoard }))
  const { error } = await supabase.from('fund_managers').insert(rows)
  if (error) throw new Error(error.message)
}

// ── Funds (classification queue + assignment picker) ─────────────────────────

export async function fetchAllFunds(): Promise<Fund[]> {
  const { data, error } = await supabase.from('funds').select('*').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Fund[]
}

export interface ClassificationPatch {
  fund_type: Fund['fund_type']
  opening_balance: number
  opening_balance_date: string | null
  purpose: string | null
  warning_rules: WarningRules
}

export async function classifyFund(id: string, patch: ClassificationPatch): Promise<void> {
  const { error } = await supabase
    .from('funds')
    .update({ ...patch, classified_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Audit log ────────────────────────────────────────────────────────────────

export interface AuditFilter {
  entity?: string
  action?: string
  search?: string
  limit: number
}

export async function fetchAuditLog(filter: AuditFilter): Promise<AuditLogEntry[]> {
  let q = supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(filter.limit)
  if (filter.entity) q = q.eq('entity', filter.entity)
  if (filter.action) q = q.eq('action', filter.action)
  if (filter.search) q = q.or(`entity_id.ilike.%${filter.search}%,entity.ilike.%${filter.search}%,action.ilike.%${filter.search}%`)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as AuditLogEntry[]
}

/** Distinct entities present in the trail, for the filter dropdown. */
export async function fetchAuditEntities(): Promise<string[]> {
  // No distinct() in PostgREST — pull a recent window and dedupe client-side.
  const { data, error } = await supabase
    .from('audit_log')
    .select('entity')
    .order('created_at', { ascending: false })
    .limit(1000)
  if (error) throw new Error(error.message)
  return [...new Set(((data ?? []) as Array<{ entity: string }>).map((r) => r.entity))].sort()
}
