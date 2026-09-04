/**
 * Shared month end progress — the read-only view behind a share link, for a
 * client, CEO or trustee without a login. No sign-in, no navigation into the
 * platform, and only what close_share_progress returns: the checklist, who
 * owns each line, where it has got to and when it was signed off.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Card, EmptyState, LoadingRows } from '@/components/ui'
import { formatDate, formatDateTime } from '@/lib/format'
import {
  PERIOD_STATUS_LABELS,
  TASK_STATUS_LABELS,
  fetchSharedProgress,
  formatClosePeriod,
  isSettled,
  type SharedProgress,
  type SharedTask,
} from './lib'

export default function CloseSharePage() {
  const { token = '' } = useParams()
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [data, setData] = useState<SharedProgress | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchSharedProgress(token)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setState(result ? 'ready' : 'missing')
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const groups: Array<{ label: string; tasks: SharedTask[] }> = []
  for (const task of data?.tasks ?? []) {
    const last = groups[groups.length - 1]
    if (last && last.label === task.group_label) last.tasks.push(task)
    else groups.push({ label: task.group_label, tasks: [task] })
  }
  const total = data?.tasks.length ?? 0
  const settled = (data?.tasks ?? []).filter((t) => isSettled(t.status)).length
  const percent = total === 0 ? 0 : Math.round((settled / total) * 100)

  return (
    <div className="min-h-screen bg-paper-3 px-4 py-10">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <div className="font-display text-[20px] text-indigo leading-none">GAUFCC Finance</div>
          <div className="text-[11px] text-stone-500 mt-1">Close progress · prepared by Pulse</div>
        </div>

        {state === 'loading' ? (
          <Card>
            <LoadingRows cols={2} rows={6} />
          </Card>
        ) : state === 'error' ? (
          <Card>
            <EmptyState
              title="This could not be loaded"
              hint="Try the link again in a moment, or ask Pulse for a fresh one."
            />
          </Card>
        ) : state === 'missing' || !data ? (
          <Card>
            <EmptyState
              title="This link is no longer active"
              hint="Sharing may have been switched off, or the link may be out of date. Ask Pulse to send a new one."
            />
          </Card>
        ) : (
          <>
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="font-display text-[24px] text-ink leading-tight">
                    {formatClosePeriod(data.period)}
                  </h1>
                  <p className="text-[11.5px] text-stone-500 mt-1">
                    {data.period_type === 'quarter' ? 'Quarterly close · ' : ''}
                    {PERIOD_STATUS_LABELS[data.status]} · started {formatDate(data.opened_at)}
                    {data.completed_at ? ` · closed ${formatDate(data.completed_at)}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <div className="font-display font-light text-[32px] text-indigo leading-none figure">
                    {percent}%
                  </div>
                  <div className="text-[10.5px] text-stone-500 mt-1">
                    {settled} of {total} complete
                  </div>
                </div>
              </div>
              <div className="h-2 rounded-full bg-stone-150 mt-4 overflow-hidden">
                <div
                  className={`h-full rounded-full ${percent === 100 ? 'bg-mint-700' : 'bg-indigo'}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              {data.note ? (
                <p className="text-[12.5px] text-stone-700 mt-4 leading-relaxed border-t border-stone-150 pt-3">
                  {data.note}
                </p>
              ) : null}
            </Card>

            <div className="space-y-4 mt-4">
              {groups.map((group) => (
                <Card key={group.label} className="overflow-hidden">
                  <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3">
                    <span className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">
                      {group.label}
                    </span>
                    <span className="text-[10.5px] text-stone-500">
                      {group.tasks.filter((t) => isSettled(t.status)).length} of {group.tasks.length}
                    </span>
                  </div>
                  <ul className="divide-y divide-stone-150 border-t border-stone-150">
                    {group.tasks.map((task) => (
                      <li key={`${group.label}-${task.title}`} className="px-5 py-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className="text-[12.5px] text-ink">{task.title}</span>
                          <span
                            className={`text-[10.5px] font-medium ${
                              task.status === 'done'
                                ? 'text-mint-900'
                                : task.status === 'blocked'
                                  ? 'text-warn-ink'
                                  : 'text-stone-500'
                            }`}
                          >
                            {TASK_STATUS_LABELS[task.status]}
                          </span>
                        </div>
                        <div className="text-[10.5px] text-stone-500 mt-0.5">
                          {task.owner ? `${task.owner}` : 'Unassigned'}
                          {task.signed_off_at
                            ? ` · signed off ${formatDateTime(task.signed_off_at)}${task.signed_off_by ? ` by ${task.signed_off_by}` : ''}`
                            : ''}
                        </div>
                        {task.note ? (
                          <p className="text-[11.5px] text-stone-600 mt-1 leading-relaxed">{task.note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </div>

            <p className="text-[10.5px] text-stone-500 mt-5 leading-relaxed">
              A read-only view of the close as it stands. Figures and records live in the platform —
              ask Pulse if you need anything explained.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
