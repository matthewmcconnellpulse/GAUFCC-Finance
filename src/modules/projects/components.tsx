/**
 * Projects module components — board view, task cards, the task editor modal
 * and small shared bits. Module-owned; shared primitives from
 * src/components/ui.tsx.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Card, ErrorNotice, Field, Input, Select, StatusChip, Textarea, cx } from '@/components/ui'
import { formatDate } from '@/lib/format'
import type { ProjectTask, ProjectTaskStatus } from '@/types/db'
import {
  deleteTask,
  insertTask,
  updateTask,
  TASK_STATUS_META,
  TASK_STATUS_ORDER,
  type TaskDraft,
} from './lib'

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <Card className={cx('relative w-full shadow-panel max-h-[90vh] overflow-y-auto', wide ? 'max-w-xl' : 'max-w-md')}>
        <div className="px-5 py-4 border-b border-stone-150 flex items-center justify-between sticky top-0 bg-white rounded-t-card">
          <div className="font-display text-[17px] text-ink">{title}</div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-indigo text-[16px] leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </Card>
    </div>
  )
}

// ── Task card ────────────────────────────────────────────────────────────────

export function TaskCard({
  task,
  canEdit,
  onEdit,
  onStatusChange,
}: {
  task: ProjectTask
  canEdit: boolean
  onEdit: () => void
  onStatusChange: (status: ProjectTaskStatus) => void
}) {
  const overdue =
    task.status !== 'done' && task.due_date != null && new Date(task.due_date) < new Date(new Date().toDateString())
  return (
    <div className="bg-white border border-stone-150 rounded-card shadow-card p-3.5">
      <button
        type="button"
        onClick={onEdit}
        disabled={!canEdit}
        className={cx('text-left text-[12.5px] font-medium text-ink leading-snug w-full', canEdit && 'hover:text-indigo')}
      >
        {task.title}
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10.5px] text-stone-500">
        {task.assignee ? <span>{task.assignee}</span> : null}
        {task.due_date ? (
          <span className={cx('figure', overdue && 'text-warn-ink font-medium')}>
            due {formatDate(task.due_date)}
          </span>
        ) : null}
        {task.depends_on.length > 0 ? (
          <span title="Waits on other tasks">⇢ {task.depends_on.length} dependenc{task.depends_on.length === 1 ? 'y' : 'ies'}</span>
        ) : null}
      </div>
      {task.notes ? <p className="text-[10.5px] text-stone-500 mt-1.5 line-clamp-2">{task.notes}</p> : null}
      {canEdit ? (
        <div className="mt-2.5">
          <Select
            value={task.status}
            onChange={(e) => onStatusChange(e.target.value as ProjectTaskStatus)}
            className="!py-1 !px-2 text-[11px] !w-auto"
            aria-label={`Status of ${task.title}`}
          >
            {TASK_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_META[s].label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  )
}

// ── Board view ───────────────────────────────────────────────────────────────

export function BoardView({
  tasks,
  canEdit,
  onEdit,
  onStatusChange,
}: {
  tasks: ProjectTask[]
  canEdit: boolean
  onEdit: (task: ProjectTask) => void
  onStatusChange: (task: ProjectTask, status: ProjectTaskStatus) => void
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {TASK_STATUS_ORDER.map((status) => {
        const column = tasks.filter((t) => t.status === status)
        const meta = TASK_STATUS_META[status]
        return (
          <div key={status} className="rounded-card bg-paper-2 border border-stone-150 p-3 min-h-[120px]">
            <div className="flex items-center justify-between mb-2.5 px-0.5">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: meta.bar }} aria-hidden />
                <span className="text-[10.5px] font-medium uppercase tracking-[.12em] text-stone-500">{meta.label}</span>
              </div>
              <span className="figure text-[10.5px] text-stone-400">{column.length}</span>
            </div>
            <div className="space-y-2.5">
              {column.length === 0 ? (
                <div className="text-[11px] text-stone-400 text-center py-4">Nothing here</div>
              ) : (
                column.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    canEdit={canEdit}
                    onEdit={() => onEdit(t)}
                    onStatusChange={(s) => onStatusChange(t, s)}
                  />
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Task editor modal ────────────────────────────────────────────────────────

export function TaskModal({
  projectId,
  existing,
  allTasks,
  onClose,
  onSaved,
  onDeleted,
}: {
  projectId: string
  existing: ProjectTask | null
  /** every task in the project, for the dependencies multi-select */
  allTasks: ProjectTask[]
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const [title, setTitle] = useState(existing?.title ?? '')
  const [status, setStatus] = useState<ProjectTaskStatus>(existing?.status ?? 'todo')
  const [assignee, setAssignee] = useState(existing?.assignee ?? '')
  const [startDate, setStartDate] = useState(existing?.start_date ?? '')
  const [dueDate, setDueDate] = useState(existing?.due_date ?? '')
  const [dependsOn, setDependsOn] = useState<string[]>(existing?.depends_on ?? [])
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dependencyOptions = allTasks.filter((t) => t.id !== existing?.id)

  async function save() {
    if (!title.trim()) {
      setError('Give the task a title')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const draft: TaskDraft = {
        project_id: projectId,
        title: title.trim(),
        status,
        assignee: assignee.trim() || null,
        start_date: startDate || null,
        due_date: dueDate || null,
        depends_on: dependsOn,
        notes: notes.trim() || null,
      }
      if (existing) await updateTask(existing.id, draft)
      else await insertTask({ ...draft, sort_order: allTasks.length })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The task could not be saved')
      setBusy(false)
    }
  }

  async function remove() {
    if (!existing) return
    if (!window.confirm(`Delete "${existing.title}"?`)) return
    setBusy(true)
    setError(null)
    try {
      await deleteTask(existing.id)
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The task could not be deleted')
      setBusy(false)
    }
  }

  return (
    <Modal title={existing ? 'Edit task' : 'New task'} onClose={onClose} wide>
      <div className="space-y-3.5">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectTaskStatus)}>
              {TASK_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_META[s].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assignee" hint="Free text — a name or a team">
            <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="e.g. Pulse dev" />
          </Field>
          <Field label="Start date">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="font-mono" />
          </Field>
        </div>
        <div>
          <span className="label-base">Depends on</span>
          {dependencyOptions.length === 0 ? (
            <p className="text-[11.5px] text-stone-500">No other tasks in this project yet.</p>
          ) : (
            <div className="max-h-44 overflow-y-auto rounded-control border border-stone-300 bg-white divide-y divide-paper-3">
              {dependencyOptions.map((t) => {
                const checked = dependsOn.includes(t.id)
                return (
                  <label key={t.id} className="flex items-center gap-2.5 px-3 py-2 text-[12px] cursor-pointer hover:bg-paper-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setDependsOn((d) => (checked ? d.filter((id) => id !== t.id) : [...d, t.id]))
                      }
                      className="accent-[#211951]"
                    />
                    <span className="truncate">{t.title}</span>
                    <StatusChip tone={TASK_STATUS_META[t.status].tone} className="ml-auto shrink-0">
                      {TASK_STATUS_META[t.status].label}
                    </StatusChip>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the next person should know" />
        </Field>
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex items-center justify-between gap-2 pt-1">
          {existing ? (
            <Button variant="reject" size="sm" onClick={() => void remove()} disabled={busy}>
              Delete task
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="quiet" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save task'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
