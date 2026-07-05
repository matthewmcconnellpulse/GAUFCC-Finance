/**
 * Hand-rolled SVG Gantt (no chart library, per docs/DESIGN.md).
 * Rows are tasks, bars run start_date → due_date, dependency arrows join
 * depends_on edges, and today is the one pink line that matters. Indigo
 * gridlines at 12% opacity on month boundaries. Tasks without dates are
 * listed under the timeline rather than being guessed onto it.
 */
import { useMemo } from 'react'
import { StatusChip, cx } from '@/components/ui'
import { formatDate } from '@/lib/format'
import type { ProjectTask } from '@/types/db'
import { TASK_STATUS_META } from './lib'

const DAY_MS = 86_400_000
const LABEL_W = 200
const ROW_H = 34
const HEADER_H = 26
const BAR_H = 14
const RIGHT_PAD = 24

interface Bar {
  task: ProjectTask
  start: Date
  end: Date
  row: number
}

function parseDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export default function GanttChart({
  tasks,
  onSelect,
  canEdit,
}: {
  tasks: ProjectTask[]
  onSelect: (task: ProjectTask) => void
  canEdit: boolean
}) {
  const { bars, unscheduled, domainStart, days, pxPerDay, months, today } = useMemo(() => {
    const scheduled = tasks.filter((t) => t.start_date || t.due_date)
    const unscheduledTasks = tasks.filter((t) => !t.start_date && !t.due_date)

    const todayDate = parseDay(new Date().toISOString().slice(0, 10))
    let min = todayDate
    let max = todayDate
    const barList: Bar[] = scheduled.map((t, i) => {
      let start = parseDay((t.start_date ?? t.due_date) as string)
      let end = parseDay((t.due_date ?? t.start_date) as string)
      if (end < start) [start, end] = [end, start]
      if (start < min) min = start
      if (end > max) max = end
      return { task: t, start, end, row: i }
    })

    // pad a week either side so bars never touch the frame
    const start = new Date(min.getFullYear(), min.getMonth(), min.getDate() - 7)
    const end = new Date(max.getFullYear(), max.getMonth(), max.getDate() + 7)
    const totalDays = Math.max(14, Math.round((end.getTime() - start.getTime()) / DAY_MS))
    const px = totalDays > 240 ? 3 : totalDays > 120 ? 5 : totalDays > 60 ? 9 : 14

    // month boundaries inside the domain, for gridlines + labels
    const monthTicks: Array<{ x: number; label: string }> = []
    const cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    while (cursor <= end) {
      const dayIdx = Math.round((cursor.getTime() - start.getTime()) / DAY_MS)
      monthTicks.push({
        x: LABEL_W + dayIdx * px,
        label: `${cursor.toLocaleDateString('en-GB', { month: 'short' })} ${String(cursor.getFullYear() % 100).padStart(2, '0')}`,
      })
      cursor.setMonth(cursor.getMonth() + 1)
    }

    return {
      bars: barList,
      unscheduled: unscheduledTasks,
      domainStart: start,
      days: totalDays,
      pxPerDay: px,
      months: monthTicks,
      today: todayDate,
    }
  }, [tasks])

  const width = LABEL_W + days * pxPerDay + RIGHT_PAD
  const height = HEADER_H + bars.length * ROW_H + 8
  const x = (d: Date) => LABEL_W + Math.round((d.getTime() - domainStart.getTime()) / DAY_MS) * pxPerDay
  const rowMid = (row: number) => HEADER_H + row * ROW_H + ROW_H / 2
  const barIndex = new Map(bars.map((b) => [b.task.id, b]))
  const todayX = x(today)

  if (tasks.length === 0) return null

  return (
    <div>
      {bars.length > 0 ? (
        <div className="overflow-x-auto">
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Project timeline"
            className="block"
          >
            <defs>
              <marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 z" fill="rgba(33,25,81,.45)" />
              </marker>
            </defs>

            {/* month gridlines — indigo at 12% */}
            {months.map((m) => (
              <g key={m.x}>
                <line x1={m.x} y1={HEADER_H - 6} x2={m.x} y2={height - 4} stroke="rgba(33,25,81,.12)" strokeWidth="1" />
                <text x={m.x + 4} y={HEADER_H - 10} fontSize="9" fill="#807c70" fontFamily="'JetBrains Mono', monospace">
                  {m.label}
                </text>
              </g>
            ))}

            {/* row separators + labels */}
            {bars.map((b) => (
              <g key={b.task.id}>
                <line
                  x1={0}
                  y1={HEADER_H + (b.row + 1) * ROW_H}
                  x2={width}
                  y2={HEADER_H + (b.row + 1) * ROW_H}
                  stroke="#f3f1ea"
                  strokeWidth="1"
                />
                <text
                  x={8}
                  y={rowMid(b.row) + 3.5}
                  fontSize="11"
                  fill="#0d0a26"
                  fontFamily="Geist, system-ui, sans-serif"
                  className={cx(canEdit && 'cursor-pointer')}
                  onClick={() => canEdit && onSelect(b.task)}
                >
                  {truncate(b.task.title, 30)}
                </text>
              </g>
            ))}

            {/* dependency arrows: predecessor bar end → dependent bar start */}
            {bars.map((b) =>
              b.task.depends_on.map((depId) => {
                const pred = barIndex.get(depId)
                if (!pred) return null
                const x1 = x(pred.end) + pxPerDay // end of predecessor's last day
                const y1 = rowMid(pred.row)
                const x2 = x(b.start)
                const y2 = rowMid(b.row)
                const elbowX = Math.max(x1 + 6, x2 - 8)
                return (
                  <path
                    key={`${b.task.id}-${depId}`}
                    d={`M ${x1} ${y1} H ${elbowX} V ${y2} H ${x2 - 2}`}
                    fill="none"
                    stroke="rgba(33,25,81,.35)"
                    strokeWidth="1.2"
                    markerEnd="url(#gantt-arrow)"
                  />
                )
              }),
            )}

            {/* bars */}
            {bars.map((b) => {
              const bx = x(b.start)
              const bw = Math.max(8, x(b.end) + pxPerDay - bx)
              const meta = TASK_STATUS_META[b.task.status]
              return (
                <g
                  key={b.task.id}
                  className={cx(canEdit && 'cursor-pointer')}
                  onClick={() => canEdit && onSelect(b.task)}
                >
                  <title>
                    {b.task.title} · {meta.label} · {formatDate(b.start)} – {formatDate(b.end)}
                  </title>
                  <rect
                    x={bx}
                    y={rowMid(b.row) - BAR_H / 2}
                    width={bw}
                    height={BAR_H}
                    rx={BAR_H / 2}
                    fill={meta.bar}
                    opacity={b.task.status === 'done' ? 0.55 : 0.9}
                  />
                </g>
              )
            })}

            {/* today — the one pink line */}
            {todayX > LABEL_W && todayX < width - 4 ? (
              <g>
                <line x1={todayX} y1={HEADER_H - 6} x2={todayX} y2={height - 4} stroke="#f25cce" strokeWidth="1.5" />
                <text
                  x={todayX + 4}
                  y={HEADER_H + 4}
                  fontSize="8.5"
                  fill="#f25cce"
                  fontFamily="'JetBrains Mono', monospace"
                >
                  today
                </text>
              </g>
            ) : null}
          </svg>
        </div>
      ) : (
        <div className="text-center text-[12px] text-stone-500 py-8 px-6">
          None of these tasks has a start or due date yet — add dates to draw the timeline.
        </div>
      )}

      {unscheduled.length > 0 && bars.length > 0 ? (
        <div className="border-t border-stone-150 mt-2 pt-3 px-1">
          <div className="text-[10px] font-medium uppercase tracking-[.14em] text-stone-500 mb-2">
            Unscheduled — no dates yet
          </div>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={!canEdit}
                onClick={() => onSelect(t)}
                className={cx(
                  'inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-[11.5px] text-stone-700',
                  canEdit && 'hover:border-indigo hover:text-indigo',
                )}
              >
                {truncate(t.title, 40)}
                <StatusChip tone={TASK_STATUS_META[t.status].tone}>{TASK_STATUS_META[t.status].label}</StatusChip>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
