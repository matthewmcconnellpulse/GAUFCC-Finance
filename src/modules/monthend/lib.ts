/**
 * Month end close — data contracts and helpers.
 *
 * A close is one row in close_periods per month plus a copy of the checklist
 * in close_tasks. The copy matters: editing the master template later must not
 * rewrite what a signed-off month actually said. Sign-off stamps (who, when)
 * are set by a database trigger, never by the client, and clearing a 'done'
 * status clears the stamp with it.
 */
import { supabase } from '@/lib/supabase'
import type {
  ClosePeriod,
  ClosePeriodStatus,
  ClosePeriodType,
  CloseTask,
  CloseTaskStatus,
  Profile,
} from '@/types/db'

export const TASK_STATUS_LABELS: Record<CloseTaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Signed off',
  not_applicable: 'Not applicable',
}

export const TASK_STATUS_TONES: Record<CloseTaskStatus, 'neutral' | 'indigo' | 'good' | 'warn'> = {
  todo: 'neutral',
  in_progress: 'indigo',
  blocked: 'warn',
  done: 'good',
  not_applicable: 'neutral',
}

export const PERIOD_STATUS_LABELS: Record<ClosePeriodStatus, string> = {
  in_progress: 'In progress',
  complete: 'Closed',
  reopened: 'Reopened',
}

// ── Period labels ────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** '2026-09' → 'September 2026'; '2026-Q3' → 'Q3 2026 (Jul–Sep)'. */
export function formatClosePeriod(period: string): string {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period)
  if (quarter) {
    const q = Number(quarter[2])
    const first = MONTHS[(q - 1) * 3].slice(0, 3)
    const last = MONTHS[(q - 1) * 3 + 2].slice(0, 3)
    return `Q${q} ${quarter[1]} (${first}–${last})`
  }
  const month = /^(\d{4})-(\d{2})$/.exec(period)
  if (month) return `${MONTHS[Number(month[2]) - 1]} ${month[1]}`
  return period
}

/** The month just gone — the one you would normally be closing. */
export function previousMonth(today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** The quarter just gone. */
export function previousQuarter(today = new Date()): string {
  const q = Math.floor(today.getMonth() / 3)
  const year = q === 0 ? today.getFullYear() - 1 : today.getFullYear()
  const quarter = q === 0 ? 4 : q
  return `${year}-Q${quarter}`
}

/** Statuses that count as finished when measuring progress. */
export function isSettled(status: CloseTaskStatus): boolean {
  return status === 'done' || status === 'not_applicable'
}

export interface CloseProgress {
  total: number
  settled: number
  done: number
  blocked: number
  /** 0–100, rounded — 100 only when every task is settled. */
  percent: number
}

export function progressOf(tasks: Array<Pick<CloseTask, 'status'>>): CloseProgress {
  const total = tasks.length
  const settled = tasks.filter((t) => isSettled(t.status)).length
  return {
    total,
    settled,
    done: tasks.filter((t) => t.status === 'done').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    percent: total === 0 ? 0 : Math.round((settled / total) * 100),
  }
}

/** Checklist groups in the order the template defines them. */
export function groupTasks(tasks: CloseTask[]): Array<{ label: string; tasks: CloseTask[] }> {
  const groups: Array<{ label: string; tasks: CloseTask[] }> = []
  for (const task of [...tasks].sort((a, b) => a.sort_order - b.sort_order)) {
    const last = groups[groups.length - 1]
    if (last && last.label === task.group_label) last.tasks.push(task)
    else groups.push({ label: task.group_label, tasks: [task] })
  }
  return groups
}

// ── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchClosePeriods(): Promise<ClosePeriod[]> {
  const { data, error } = await supabase
    .from('close_periods')
    .select('*')
    .order('period', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as ClosePeriod[]
}

export async function fetchCloseTasks(periodId: string): Promise<CloseTask[]> {
  const { data, error } = await supabase
    .from('close_tasks')
    .select('*')
    .eq('period_id', periodId)
    .order('sort_order', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as CloseTask[]
}

/** Everyone who can own a close task: the Pulse team plus the CEO. */
export async function fetchCloseTeam(): Promise<Array<Pick<Profile, 'id' | 'full_name' | 'role'>>> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('active', true)
    .in('role', ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo'])
    .order('full_name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<Pick<Profile, 'id' | 'full_name' | 'role'>>
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Open a month, or return the existing one. The checklist is copied from the
 * active templates server-side, so two people opening the same month race to
 * the same row rather than duplicating it.
 */
export async function openClosePeriod(
  period: string,
  periodType: ClosePeriodType = 'month',
): Promise<string> {
  const { data, error } = await supabase.rpc('open_close_period', {
    p_period: period,
    p_period_type: periodType,
  })
  if (error) throw new Error(error.message)
  return data as string
}

export type CloseTaskPatch = Partial<
  Pick<CloseTask, 'assignee_id' | 'status' | 'note' | 'title' | 'detail'>
>

export async function updateCloseTask(id: string, patch: CloseTaskPatch): Promise<CloseTask> {
  const { data, error } = await supabase
    .from('close_tasks')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as CloseTask
}

export async function updateClosePeriod(
  id: string,
  patch: Partial<Pick<ClosePeriod, 'status' | 'note' | 'share_enabled'>> & {
    completed_by?: string | null
    completed_at?: string | null
  },
): Promise<ClosePeriod> {
  const { data, error } = await supabase
    .from('close_periods')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as ClosePeriod
}

export async function closeMonth(id: string, byProfileId: string): Promise<ClosePeriod> {
  return updateClosePeriod(id, {
    status: 'complete',
    completed_by: byProfileId,
    completed_at: new Date().toISOString(),
  })
}

export async function reopenMonth(id: string): Promise<ClosePeriod> {
  return updateClosePeriod(id, { status: 'reopened', completed_by: null, completed_at: null })
}

/** Add a one-off task to this month only — it never touches the template. */
export async function addCloseTask(
  periodId: string,
  values: { title: string; group_label: string; detail?: string | null; sort_order: number },
): Promise<CloseTask> {
  const { data, error } = await supabase
    .from('close_tasks')
    .insert({
      period_id: periodId,
      title: values.title,
      group_label: values.group_label,
      detail: values.detail ?? null,
      sort_order: values.sort_order,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as CloseTask
}

export async function deleteCloseTask(id: string): Promise<void> {
  const { error } = await supabase.from('close_tasks').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Shared (read-only, by token) ─────────────────────────────────────────────

export interface SharedTask {
  group_label: string
  title: string
  detail: string | null
  status: CloseTaskStatus
  note: string | null
  owner: string | null
  signed_off_at: string | null
  signed_off_by: string | null
  is_client_signoff: boolean
}

export interface SharedProgress {
  period: string
  period_type: ClosePeriodType
  status: ClosePeriodStatus
  note: string | null
  opened_at: string
  completed_at: string | null
  tasks: SharedTask[]
}

/**
 * The shared view. Runs as anon against close_share_progress, which returns
 * null unless sharing is switched on for that token — so a revoked link stops
 * working immediately without the token changing.
 */
export async function fetchSharedProgress(token: string): Promise<SharedProgress | null> {
  const { data, error } = await supabase.rpc('close_share_progress', { p_token: token })
  if (error) throw new Error(error.message)
  return (data as SharedProgress | null) ?? null
}

export function shareUrl(token: string): string {
  return `${window.location.origin}/close/${token}`
}
