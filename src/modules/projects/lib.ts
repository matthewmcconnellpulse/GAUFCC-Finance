/**
 * Projects module data layer — Karbon-style tracker over `projects` and
 * `project_tasks`. Module-owned helpers only.
 */
import { supabase } from '@/lib/supabase'
import type { Project, ProjectTask, ProjectTaskStatus } from '@/types/db'

// ── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as Project[]
}

export async function fetchTasks(projectId: string): Promise<ProjectTask[]> {
  const { data, error } = await supabase
    .from('project_tasks')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as ProjectTask[]
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface TaskDraft {
  project_id: string
  title: string
  status: ProjectTaskStatus
  assignee: string | null
  start_date: string | null
  due_date: string | null
  depends_on: string[]
  notes: string | null
  sort_order?: number
}

export async function insertTask(draft: TaskDraft): Promise<ProjectTask> {
  const { data, error } = await supabase.from('project_tasks').insert(draft).select().single()
  if (error) throw new Error(error.message)
  return data as ProjectTask
}

export async function updateTask(id: string, patch: Partial<TaskDraft>): Promise<ProjectTask> {
  const { data, error } = await supabase.from('project_tasks').update(patch).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return data as ProjectTask
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.from('project_tasks').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function setTaskStatus(id: string, status: ProjectTaskStatus): Promise<void> {
  const { error } = await supabase.from('project_tasks').update({ status }).eq('id', id)
  if (error) throw new Error(error.message)
}

export interface ProjectDraft {
  name: string
  description: string | null
  status: Project['status']
  sort_order?: number
}

export async function insertProject(draft: ProjectDraft): Promise<Project> {
  const { data, error } = await supabase.from('projects').insert(draft).select().single()
  if (error) throw new Error(error.message)
  return data as Project
}

export async function updateProject(id: string, patch: Partial<ProjectDraft>): Promise<Project> {
  const { data, error } = await supabase.from('projects').update(patch).eq('id', id).select().single()
  if (error) throw new Error(error.message)
  return data as Project
}

// ── Presentation metadata ────────────────────────────────────────────────────

export const TASK_STATUS_ORDER: ProjectTaskStatus[] = ['todo', 'in_progress', 'blocked', 'done']

export const TASK_STATUS_META: Record<
  ProjectTaskStatus,
  { label: string; tone: 'neutral' | 'live' | 'good' | 'warn' | 'danger' | 'indigo'; bar: string }
> = {
  todo: { label: 'To do', tone: 'neutral', bar: '#b3afa3' },
  in_progress: { label: 'In progress', tone: 'indigo', bar: '#16b6ce' },
  blocked: { label: 'Blocked', tone: 'warn', bar: '#f5a524' },
  done: { label: 'Done', tone: 'good', bar: '#04b894' },
}

export const PROJECT_STATUS_META: Record<
  Project['status'],
  { label: string; tone: 'neutral' | 'live' | 'good' | 'warn' | 'danger' | 'indigo' }
> = {
  planned: { label: 'Planned', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'indigo' },
  complete: { label: 'Complete', tone: 'good' },
  parked: { label: 'Parked', tone: 'neutral' },
}
