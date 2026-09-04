/**
 * Month end close — the board the accountants work through each month.
 *
 * Every checklist line carries the work itself (a link straight to the screen
 * where it happens, or out to Xero), who owns it, where it has got to, and a
 * sign-off stamp. The CEO and trustees see the same board read-only, and the
 * client sign-off line is the one row the CEO can move — that is the whole
 * point of it. Progress can also be shared as a link for anyone without a
 * login.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Input,
  LoadingRows,
  PageHeader,
  SectionLabel,
  Select,
  StatusChip,
  cx,
} from '@/components/ui'
import { currentPeriod, formatDate, formatDateTime, formatPeriod } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { CloseTask, CloseTaskStatus, Profile } from '@/types/db'
import {
  PERIOD_STATUS_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUS_TONES,
  addCloseTask,
  closeMonth,
  deleteCloseTask,
  fetchCloseTasks,
  fetchCloseTeam,
  fetchClosePeriods,
  groupTasks,
  openClosePeriod,
  progressOf,
  reopenMonth,
  shareUrl,
  updateCloseTask,
  updateClosePeriod,
} from './lib'

const STATUS_ORDER: CloseTaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'not_applicable']

/** The month before this one — the month you are normally closing. */
function lastMonth(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function MonthEndPage() {
  const { profile } = useAuth()
  const { isPulse, isCeo, isTrustee, isAdmin } = usePermissions()
  const [params, setParams] = useSearchParams()
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const periods = useSupabaseQuery(fetchClosePeriods, [])
  const team = useSupabaseQuery(fetchCloseTeam, [])

  const wanted = params.get('period')
  const period = useMemo(() => {
    const rows = periods.data ?? []
    return rows.find((p) => p.period === wanted) ?? rows[0] ?? null
  }, [periods.data, wanted])

  const tasksQ = useSupabaseQuery(
    () => (period ? fetchCloseTasks(period.id) : Promise.resolve([])),
    [period?.id],
  )
  const [tasks, setTasks] = useState<CloseTask[]>([])
  useEffect(() => setTasks(tasksQ.data ?? []), [tasksQ.data])

  const progress = useMemo(() => progressOf(tasks), [tasks])
  const groups = useMemo(() => groupTasks(tasks), [tasks])

  const canManage = isPulse
  const canView = isPulse || isCeo || isTrustee

  const openMonth = async (value: string) => {
    if (!/^\d{4}-\d{2}$/.test(value)) return
    setBusy(true)
    setActionError(null)
    try {
      await openClosePeriod(value)
      await periods.refetch()
      setParams({ period: value }, { replace: true })
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'That month could not be opened')
    } finally {
      setBusy(false)
    }
  }

  const patchTask = async (id: string, patch: Parameters<typeof updateCloseTask>[1]) => {
    // Optimistic, then reconciled with the row the server returns — the
    // sign-off stamp is set by a trigger, so the server's copy is the truth.
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    setActionError(null)
    try {
      const saved = await updateCloseTask(id, patch)
      setTasks((ts) => ts.map((t) => (t.id === saved.id ? saved : t)))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'That change could not be saved')
      tasksQ.refetch()
    }
  }

  if (!canView) {
    return (
      <div>
        <PageHeader title="Month end" subtitle="The monthly close checklist" />
        <Card>
          <EmptyState
            title="Month end is restricted"
            hint="The Pulse team run the close; the CEO and trustees can follow progress."
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <style>{`@media print {
        body * { visibility: hidden; }
        #close-board, #close-board * { visibility: visible; }
        #close-board { position: absolute; left: 0; top: 0; width: 100%; }
        .no-print { display: none !important; }
      }`}</style>

      <div className="no-print">
        <PageHeader
          title="Month end close"
          subtitle="Work the checklist, assign each line, sign it off — and share the progress"
          actions={
            <>
              {periods.data && periods.data.length > 0 ? (
                <Select
                  value={period?.period ?? ''}
                  onChange={(e) => setParams({ period: e.target.value }, { replace: true })}
                  className="!w-auto py-1.5 text-[12px]"
                  aria-label="Month"
                >
                  {periods.data.map((p) => (
                    <option key={p.id} value={p.period}>
                      {formatPeriod(p.period)} · {PERIOD_STATUS_LABELS[p.status]}
                    </option>
                  ))}
                </Select>
              ) : null}
              {canManage ? <OpenMonthButton busy={busy} onOpen={openMonth} /> : null}
              {tasks.length > 0 ? (
                <Button variant="ghost" onClick={() => window.print()}>
                  Print
                </Button>
              ) : null}
            </>
          }
        />
        {actionError ? (
          <div className="mb-4">
            <ErrorNotice message={actionError} />
          </div>
        ) : null}
      </div>

      {periods.loading ? (
        <Card>
          <LoadingRows cols={3} rows={6} />
        </Card>
      ) : periods.error ? (
        <ErrorNotice message={periods.error} />
      ) : !period ? (
        <Card>
          <EmptyState
            title="No month end started yet"
            hint={
              canManage
                ? `Open ${formatPeriod(lastMonth())} to lay out the checklist — every line comes with a link to the work and a sign-off.`
                : 'Pulse will start the checklist for the month.'
            }
            action={
              canManage ? (
                <Button variant="primary" disabled={busy} onClick={() => void openMonth(lastMonth())}>
                  {busy ? 'Opening…' : `Open ${formatPeriod(lastMonth())}`}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div id="close-board" className="space-y-4">
          <ProgressCard
            periodLabel={formatPeriod(period.period)}
            statusLabel={PERIOD_STATUS_LABELS[period.status]}
            progress={progress}
            openedAt={period.opened_at}
            completedAt={period.completed_at}
            note={period.note}
            canManage={canManage}
            busy={busy}
            onNote={(note) => {
              void (async () => {
                try {
                  await updateClosePeriod(period.id, { note })
                  periods.refetch()
                } catch (e) {
                  setActionError(e instanceof Error ? e.message : 'The note could not be saved')
                }
              })()
            }}
            onClose={() => {
              if (!profile) return
              void (async () => {
                setBusy(true)
                try {
                  await closeMonth(period.id, profile.id)
                  await periods.refetch()
                } catch (e) {
                  setActionError(e instanceof Error ? e.message : 'The month could not be closed')
                } finally {
                  setBusy(false)
                }
              })()
            }}
            onReopen={() => {
              void (async () => {
                setBusy(true)
                try {
                  await reopenMonth(period.id)
                  await periods.refetch()
                } catch (e) {
                  setActionError(e instanceof Error ? e.message : 'The month could not be reopened')
                } finally {
                  setBusy(false)
                }
              })()
            }}
          />

          {canManage ? (
            <ShareCard
              enabled={period.share_enabled}
              token={period.share_token}
              busy={busy}
              onToggle={(enabled) => {
                void (async () => {
                  setBusy(true)
                  setActionError(null)
                  try {
                    await updateClosePeriod(period.id, { share_enabled: enabled })
                    await periods.refetch()
                  } catch (e) {
                    setActionError(e instanceof Error ? e.message : 'Sharing could not be changed')
                  } finally {
                    setBusy(false)
                  }
                })()
              }}
            />
          ) : null}

          {tasksQ.loading ? (
            <Card>
              <LoadingRows cols={3} rows={8} />
            </Card>
          ) : tasksQ.error ? (
            <ErrorNotice message={tasksQ.error} />
          ) : (
            groups.map((group) => (
              <Card key={group.label} className="overflow-hidden">
                <div className="px-4 sm:px-5 pt-4 flex items-center justify-between gap-3">
                  <SectionLabel>{group.label}</SectionLabel>
                  <span className="text-[10.5px] text-stone-500 pb-2">
                    {group.tasks.filter((t) => t.status === 'done').length} of {group.tasks.length} signed off
                  </span>
                </div>
                <ul className="divide-y divide-stone-150 border-t border-stone-150">
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      team={team.data ?? []}
                      canManage={canManage}
                      canSignOffAsClient={isCeo && task.is_client_signoff}
                      canRemove={isAdmin && task.template_key == null}
                      onPatch={(patch) => void patchTask(task.id, patch)}
                      onRemove={() => {
                        void (async () => {
                          if (!window.confirm('Remove this line from the month?')) return
                          try {
                            await deleteCloseTask(task.id)
                            setTasks((ts) => ts.filter((t) => t.id !== task.id))
                          } catch (e) {
                            setActionError(e instanceof Error ? e.message : 'It could not be removed')
                          }
                        })()
                      }}
                    />
                  ))}
                </ul>
              </Card>
            ))
          )}

          {canManage && period.status !== 'complete' ? (
            <AddTaskCard
              groups={groups.map((g) => g.label)}
              onAdd={(values) => {
                void (async () => {
                  setActionError(null)
                  try {
                    const nextOrder = Math.max(0, ...tasks.map((t) => t.sort_order)) + 5
                    const created = await addCloseTask(period.id, { ...values, sort_order: nextOrder })
                    setTasks((ts) => [...ts, created])
                  } catch (e) {
                    setActionError(e instanceof Error ? e.message : 'The line could not be added')
                  }
                })()
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function OpenMonthButton({ busy, onOpen }: { busy: boolean; onOpen: (period: string) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(lastMonth())
  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        Open a month…
      </Button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="month"
        value={value}
        max={currentPeriod()}
        onChange={(e) => setValue(e.target.value)}
        className="input-base !w-auto py-1.5 text-[12px]"
        aria-label="Month to open"
      />
      <Button size="sm" variant="primary" disabled={busy} onClick={() => onOpen(value)}>
        {busy ? 'Opening…' : 'Open'}
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  )
}

function ProgressCard({
  periodLabel,
  statusLabel,
  progress,
  openedAt,
  completedAt,
  note,
  canManage,
  busy,
  onNote,
  onClose,
  onReopen,
}: {
  periodLabel: string
  statusLabel: string
  progress: ReturnType<typeof progressOf>
  openedAt: string
  completedAt: string | null
  note: string | null
  canManage: boolean
  busy: boolean
  onNote: (note: string) => void
  onClose: () => void
  onReopen: () => void
}) {
  const [draft, setDraft] = useState(note ?? '')
  useEffect(() => setDraft(note ?? ''), [note])
  const complete = progress.settled === progress.total && progress.total > 0

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[20px] text-ink leading-none">{periodLabel}</h2>
            <StatusChip tone={completedAt ? 'good' : 'indigo'}>{statusLabel}</StatusChip>
          </div>
          <p className="text-[11px] text-stone-500 mt-1.5">
            Started {formatDate(openedAt)}
            {completedAt ? ` · closed ${formatDateTime(completedAt)}` : ''}
            {progress.blocked > 0 ? ` · ${progress.blocked} blocked` : ''}
          </p>
        </div>
        <div className="text-right">
          <div className="font-display font-light text-[30px] text-indigo leading-none figure">
            {progress.percent}%
          </div>
          <div className="text-[10.5px] text-stone-500 mt-1">
            {progress.settled} of {progress.total} done
          </div>
        </div>
      </div>

      <div className="h-2 rounded-full bg-stone-150 mt-4 overflow-hidden">
        <div
          className={cx('h-full rounded-full transition-all', complete ? 'bg-mint-700' : 'bg-indigo')}
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      {canManage ? (
        <div className="mt-4 space-y-2.5">
          <Input
            value={draft}
            placeholder="Note for the client — anything worth saying about this month"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim() !== (note ?? '')) onNote(draft.trim())
            }}
            className="text-[12px]"
          />
          <div className="flex flex-wrap gap-2">
            {completedAt ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onReopen}>
                Reopen the month
              </Button>
            ) : (
              <Button size="sm" variant="money" disabled={busy || !complete} onClick={onClose}>
                {busy ? 'Closing…' : 'Close the month'}
              </Button>
            )}
            {!completedAt && !complete ? (
              <span className="text-[11px] text-stone-500 self-center">
                Every line needs a sign-off (or "not applicable") first.
              </span>
            ) : null}
          </div>
        </div>
      ) : note ? (
        <p className="text-[12px] text-stone-600 mt-4 leading-relaxed border-t border-stone-150 pt-3">
          {note}
        </p>
      ) : null}
    </Card>
  )
}

function ShareCard({
  enabled,
  token,
  busy,
  onToggle,
}: {
  enabled: boolean
  token: string
  busy: boolean
  onToggle: (enabled: boolean) => void
}) {
  const [copied, setCopied] = useState(false)
  const url = shareUrl(token)
  return (
    <Card className="p-4 sm:p-5 no-print">
      <SectionLabel>Share progress</SectionLabel>
      <p className="text-[11.5px] text-stone-600 leading-relaxed">
        The CEO and trustees already see this board when they sign in. A share link is for anyone
        without a login — it shows the checklist, owners and sign-offs, read-only, and nothing else.
      </p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <Button size="sm" variant={enabled ? 'quiet' : 'primary'} disabled={busy} onClick={() => onToggle(!enabled)}>
          {enabled ? 'Stop sharing' : 'Create a share link'}
        </Button>
        {enabled ? (
          <>
            <code className="font-mono text-[10.5px] text-stone-600 bg-paper-2 border border-stone-200 rounded-control px-2 py-1.5 max-w-[320px] truncate">
              {url}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(
                  () => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 2000)
                  },
                  () => setCopied(false),
                )
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </>
        ) : null}
      </div>
      {enabled ? (
        <p className="text-[10.5px] text-stone-500 mt-2">
          Anyone with the link can see it. Stop sharing and it stops working straight away.
        </p>
      ) : null}
    </Card>
  )
}

function TaskRow({
  task,
  team,
  canManage,
  canSignOffAsClient,
  canRemove,
  onPatch,
  onRemove,
}: {
  task: CloseTask
  team: Array<Pick<Profile, 'id' | 'full_name' | 'role'>>
  canManage: boolean
  canSignOffAsClient: boolean
  canRemove: boolean
  onPatch: (patch: Parameters<typeof updateCloseTask>[1]) => void
  onRemove: () => void
}) {
  const [noteDraft, setNoteDraft] = useState(task.note ?? '')
  useEffect(() => setNoteDraft(task.note ?? ''), [task.note])
  const editable = canManage || canSignOffAsClient
  const owner = team.find((p) => p.id === task.assignee_id)

  return (
    <li className={cx('px-4 sm:px-5 py-3.5', task.status === 'done' && 'bg-mint-700/[0.04]')}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2.5">
        <div className="flex-1 min-w-[220px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cx('text-[13px] text-ink', task.status === 'done' && 'text-stone-600')}>
              {task.title}
            </span>
            <StatusChip tone={TASK_STATUS_TONES[task.status]}>{TASK_STATUS_LABELS[task.status]}</StatusChip>
            {task.is_client_signoff ? <StatusChip tone="indigo">CEO</StatusChip> : null}
          </div>
          {task.detail ? (
            <p className="text-[11.5px] text-stone-500 mt-1 leading-relaxed">{task.detail}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 mt-1.5">
            {task.link_to ? (
              <Link
                to={task.link_to}
                className="text-[11.5px] text-indigo underline underline-offset-2 no-print"
              >
                Go to the work →
              </Link>
            ) : null}
            {task.external_url ? (
              <a
                href={task.external_url}
                target="_blank"
                rel="noreferrer"
                className="text-[11.5px] text-indigo underline underline-offset-2 no-print"
              >
                Open in Xero ↗
              </a>
            ) : null}
            {task.signed_off_at ? (
              <span className="text-[10.5px] text-mint-900">
                Signed off {formatDateTime(task.signed_off_at)}
                {team.find((p) => p.id === task.signed_off_by)
                  ? ` by ${team.find((p) => p.id === task.signed_off_by)?.full_name}`
                  : ''}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 no-print">
          {canManage ? (
            <Select
              value={task.assignee_id ?? ''}
              onChange={(e) => onPatch({ assignee_id: e.target.value || null })}
              className="!w-auto py-1 text-[11.5px]"
              aria-label={`Who is doing "${task.title}"`}
            >
              <option value="">Unassigned</option>
              {team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-[11.5px] text-stone-500">{owner?.full_name ?? 'Unassigned'}</span>
          )}

          {editable ? (
            <Select
              value={task.status}
              onChange={(e) => onPatch({ status: e.target.value as CloseTaskStatus })}
              className="!w-auto py-1 text-[11.5px]"
              aria-label={`Status of "${task.title}"`}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          ) : null}

          {editable && task.status !== 'done' ? (
            <Button size="sm" variant="primary" onClick={() => onPatch({ status: 'done' })}>
              Sign off
            </Button>
          ) : null}
          {canRemove ? (
            <Button size="sm" variant="quiet" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      {editable ? (
        <Input
          value={noteDraft}
          placeholder="Note — what you found, what is outstanding"
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => {
            if (noteDraft.trim() !== (task.note ?? '')) onPatch({ note: noteDraft.trim() || null })
          }}
          className="mt-2.5 text-[11.5px] no-print"
        />
      ) : task.note ? (
        <p className="text-[11.5px] text-stone-600 mt-2 leading-relaxed">{task.note}</p>
      ) : null}
      {task.note ? <p className="hidden print:block text-[11px] text-stone-600 mt-1">{task.note}</p> : null}
    </li>
  )
}

function AddTaskCard({
  groups,
  onAdd,
}: {
  groups: string[]
  onAdd: (values: { title: string; group_label: string; detail?: string | null }) => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [group, setGroup] = useState(groups[groups.length - 1] ?? 'Other')

  if (!open) {
    return (
      <div className="no-print">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          Add a line for this month…
        </Button>
      </div>
    )
  }
  return (
    <Card className="p-4 sm:p-5 no-print">
      <SectionLabel>Add a line</SectionLabel>
      <p className="text-[11px] text-stone-500 mb-2.5">
        One-off, for this month only. The standing checklist is unchanged.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          className="flex-1 min-w-[220px] text-[12px]"
        />
        <Select value={group} onChange={(e) => setGroup(e.target.value)} className="!w-auto py-1.5 text-[12px]">
          {[...new Set([...groups, 'Other'])].map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </Select>
        <Button
          variant="primary"
          disabled={!title.trim()}
          onClick={() => {
            onAdd({ title: title.trim(), group_label: group })
            setTitle('')
            setOpen(false)
          }}
        >
          Add
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}
