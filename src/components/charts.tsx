/**
 * Hand-rolled SVG chart primitives (Investments, Cashflow) — stacked columns
 * (mixed-sign: positives stack up, negatives hang below the baseline),
 * multi-series lines with a crosshair tooltip, legend chips that toggle
 * series, and a data-table view for accessibility. No chart library.
 *
 * Colour discipline (docs: dataviz skill): the categorical palette below is
 * validated for adjacent-pair CVD separation in this order — series take
 * slots in FIXED order keyed to the entity, never re-flowed when a filter
 * hides some of them. Values/labels wear ink colours, never series colours.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { cx } from '@/components/ui'

const gbp0 = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
})

export function money0(v: number): string {
  return gbp0.format(v).replace('-', '−')
}

/** £1.02m / £480k / £312 — axis-friendly compact money. */
export function compactMoney(v: number): string {
  const abs = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 2)}m`
  if (abs >= 1_000) return `${sign}£${Math.round(abs / 1_000)}k`
  return `${sign}£${Math.round(abs)}`
}

/** Validated categorical order — do not shuffle (adjacent CVD ΔE ≥ 8). */
export const SERIES_COLORS = [
  '#2a78d6', // blue
  '#008300', // green
  '#e87ba4', // magenta
  '#eda100', // yellow
  '#1baf7a', // aqua
  '#eb6834', // orange
  '#4a3aa7', // violet
  '#e34948', // red
] as const

export function seriesColor(slot: number): string {
  return SERIES_COLORS[slot % SERIES_COLORS.length]
}

export interface ChartSeries {
  key: string
  label: string
  /** fixed colour slot — keyed to the entity so filtering never repaints */
  slot: number
  values: number[] // one per x label; may contain 0
}

const GRID = '#211951' // gridlines at 12% opacity — app idiom
const MUTED = '#807c70'
const MONO = "'JetBrains Mono', monospace"

function niceStep(range: number): number {
  const raw = range / 4 || 1
  const pow = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / pow
  if (norm >= 5) return 10 * pow
  if (norm >= 2) return 5 * pow
  if (norm >= 1) return 2 * pow
  return pow
}

function ticksFor(min: number, max: number): number[] {
  const step = niceStep(max - min)
  const out: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(round(t))
  return out
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Legend chips (toggle series on/off) ──────────────────────────────────────

export function LegendChips({
  series,
  hidden,
  onToggle,
}: {
  series: Array<{ key: string; label: string; slot: number }>
  hidden: Set<string>
  onToggle: (key: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {series.map((s) => {
        const off = hidden.has(s.key)
        return (
          <button
            key={s.key}
            onClick={() => onToggle(s.key)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
              off
                ? 'border-stone-200 text-stone-400 bg-paper-2'
                : 'border-stone-300 text-stone-700 hover:bg-paper-2',
            )}
            aria-pressed={!off}
            title={off ? `Show ${s.label}` : `Hide ${s.label}`}
          >
            <span
              className={cx('w-2.5 h-2.5 rounded-[3px]', off && 'opacity-30')}
              style={{ background: seriesColor(s.slot) }}
              aria-hidden
            />
            <span className={cx(off && 'line-through')}>{s.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Tooltip plumbing ─────────────────────────────────────────────────────────

interface TooltipState {
  index: number
  xPct: number // 0..1 across the inner plot, for positioning
}

function TooltipCard({
  title,
  rows,
}: {
  title: string
  rows: Array<{ label: string; value: number; slot: number }>
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white shadow-panel px-3 py-2 text-[11px] min-w-[170px]">
      <div className="font-medium text-ink mb-1">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 py-0.5">
          <span className="inline-flex items-center gap-1.5 text-stone-500">
            <span className="w-2 h-2 rounded-[2px]" style={{ background: seriesColor(r.slot) }} aria-hidden />
            {r.label}
          </span>
          <span className="figure font-medium text-ink whitespace-nowrap">{money0(r.value)}</span>
        </div>
      ))}
    </div>
  )
}

/** Shared frame: relative container, tooltip overlay near the hovered column. */
function ChartFrame({
  tooltip,
  tooltipCard,
  children,
}: {
  tooltip: TooltipState | null
  tooltipCard: ReactNode
  children: ReactNode
}) {
  return (
    <div className="relative">
      {children}
      {tooltip ? (
        <div
          className="absolute top-2 z-10 pointer-events-none"
          style={
            tooltip.xPct > 0.55
              ? { right: `${(1 - tooltip.xPct) * 100}%`, marginRight: 12 }
              : { left: `${tooltip.xPct * 100}%`, marginLeft: 12 }
          }
        >
          {tooltipCard}
        </div>
      ) : null}
    </div>
  )
}

// ── Data-table view (the accessibility alternative to every chart) ───────────

export function ChartTable({
  labels,
  series,
}: {
  labels: string[]
  series: ChartSeries[]
}) {
  return (
    <div className="overflow-x-auto mt-2">
      <table className="w-full text-[11px]">
        <thead>
          <tr>
            <th className="th-register">Series</th>
            {labels.map((l) => (
              <th key={l} className="th-register text-right whitespace-nowrap">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.key}>
              <td className="td-register whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-[2px]" style={{ background: seriesColor(s.slot) }} aria-hidden />
                  {s.label}
                </span>
              </td>
              {s.values.map((v, i) => (
                <td key={i} className="td-register figure text-right whitespace-nowrap">
                  {v === 0 ? '—' : money0(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Stacked columns (mixed sign) ─────────────────────────────────────────────

const W = 680
const H = 240
const PAD_L = 56
const PAD_R = 12
const PAD_T = 12
const PAD_B = 26

export function StackedColumnChart({
  labels,
  series,
  ariaLabel,
}: {
  labels: string[]
  series: ChartSeries[]
  ariaLabel: string
}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const { min, max } = useMemo(() => {
    let lo = 0
    let hi = 0
    for (let i = 0; i < labels.length; i++) {
      let up = 0
      let down = 0
      for (const s of series) {
        const v = s.values[i] ?? 0
        if (v >= 0) up += v
        else down += v
      }
      hi = Math.max(hi, up)
      lo = Math.min(lo, down)
    }
    if (hi === 0 && lo === 0) hi = 1
    const pad = (hi - lo) * 0.08
    return { min: lo < 0 ? lo - pad : 0, max: hi + pad }
  }, [labels, series])

  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const y = (v: number) => PAD_T + (1 - (v - min) / (max - min)) * innerH
  const slotW = innerW / Math.max(labels.length, 1)
  const barW = Math.min(56, slotW * 0.55)
  const xCentre = (i: number) => PAD_L + slotW * i + slotW / 2

  const ticks = ticksFor(min, max)


  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.max(0, Math.min(labels.length - 1, Math.floor((px - PAD_L) / slotW)))
    setTooltip({ index: i, xPct: (xCentre(i) - PAD_L) / innerW })
  }

  const tooltipRows = tooltip
    ? series
        .map((s) => ({ label: s.label, value: s.values[tooltip.index] ?? 0, slot: s.slot }))
        .filter((r) => r.value !== 0)
    : []

  return (
    <ChartFrame
      tooltip={tooltip && tooltipRows.length > 0 ? tooltip : null}
      tooltipCard={tooltip ? <TooltipCard title={labels[tooltip.index]} rows={tooltipRows} /> : null}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setTooltip(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke={GRID}
              strokeOpacity={t === 0 ? 0.3 : 0.12}
              strokeWidth="1"
            />
            <text x={PAD_L - 8} y={y(t) + 3} textAnchor="end" fontFamily={MONO} fontSize="9.5" fill={MUTED}>
              {compactMoney(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => (
          <text key={l + i} x={xCentre(i)} y={H - 8} textAnchor="middle" fontFamily={MONO} fontSize="9.5" fill={MUTED}>
            {l}
          </text>
        ))}
        {labels.map((_, i) => {
          let up = 0
          let down = 0
          const rects: ReactNode[] = []
          for (const s of series) {
            const v = s.values[i] ?? 0
            if (v === 0) continue
            const from = v >= 0 ? up : down
            const to = from + v
            if (v >= 0) up = to
            else down = to
            const y0 = y(Math.max(from, to))
            const h = Math.max(Math.abs(y(from) - y(to)) - 2, 1) // 2px surface gap between segments
            rects.push(
              <rect
                key={s.key}
                x={xCentre(i) - barW / 2}
                y={y0 + 1}
                width={barW}
                height={h}
                rx="2"
                fill={seriesColor(s.slot)}
                opacity={tooltip && tooltip.index !== i ? 0.45 : 1}
              />,
            )
          }
          return <g key={i}>{rects}</g>
        })}
      </svg>
    </ChartFrame>
  )
}

// ── Multi-series line with crosshair ─────────────────────────────────────────

export function MultiLineChart({
  labels,
  tickLabels,
  series,
  ariaLabel,
  markerIndex,
}: {
  /** One per point. Used in the tooltip, and on the axis unless tickLabels is given. */
  labels: string[]
  /** Shorter axis-only labels — the full `labels` still show in the tooltip. */
  tickLabels?: string[]
  series: ChartSeries[]
  ariaLabel: string
  /** Draws a vertical rule at this point — 'you are here' on a forecast. */
  markerIndex?: number
}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const { min, max } = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const s of series) {
      for (const v of s.values) {
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0
      hi = 1
    }
    if (lo === hi) {
      lo -= Math.max(1, Math.abs(lo) * 0.05)
      hi += Math.max(1, Math.abs(hi) * 0.05)
    }
    const pad = (hi - lo) * 0.08
    return { min: Math.min(lo - pad, 0 < lo ? lo - pad : 0), max: hi + pad }
  }, [series])

  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const n = Math.max(labels.length, 1)
  const x = (i: number) => (n === 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW)
  const y = (v: number) => PAD_T + (1 - (v - min) / (max - min)) * innerH
  const ticks = ticksFor(min, max)

  // Axis labels are thinned so they never collide: on the fixed 680px canvas
  // with ~9.5px mono text there is only so much room, and 19 weekly columns of
  // 'W/C 02 Mar' is what made the old axis unreadable. The first and last are
  // always drawn; the stride is chosen so the last label never lands next to a
  // thinned neighbour. Every point still names itself in full on hover.
  const axisLabels = tickLabels ?? labels
  const widest = axisLabels.reduce((w, l) => Math.max(w, l.length), 0)
  const perLabel = Math.max(34, widest * 5.9 + 12)
  const stride = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / perLabel))))

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    setTooltip({ index: best, xPct: (x(best) - PAD_L) / innerW })
  }

  return (
    <ChartFrame
      tooltip={tooltip}
      tooltipCard={
        tooltip ? (
          <TooltipCard
            title={labels[tooltip.index]}
            rows={series.map((s) => ({ label: s.label, value: s.values[tooltip.index] ?? 0, slot: s.slot }))}
          />
        ) : null
      }
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={onMove}
        onMouseLeave={() => setTooltip(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke={GRID}
              strokeOpacity={t === 0 ? 0.3 : 0.12}
              strokeWidth="1"
            />
            <text x={PAD_L - 8} y={y(t) + 3} textAnchor="end" fontFamily={MONO} fontSize="9.5" fill={MUTED}>
              {compactMoney(t)}
            </text>
          </g>
        ))}
        {axisLabels.map((l, i) =>
          i === 0 || i === n - 1 || (i % stride === 0 && i <= n - 1 - stride) ? (
            <text
              key={l + i}
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontFamily={MONO}
              fontSize="9.5"
              fill={MUTED}
            >
              {l}
            </text>
          ) : null,
        )}
        {markerIndex !== undefined && markerIndex >= 0 && markerIndex < n ? (
          <g>
            <line
              x1={x(markerIndex)}
              x2={x(markerIndex)}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke={MUTED}
              strokeOpacity="0.5"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text
              x={x(markerIndex) + (markerIndex > n * 0.8 ? -4 : 4)}
              y={PAD_T + 9}
              fontFamily={MONO}
              fontSize="8.5"
              fill={MUTED}
              textAnchor={markerIndex > n * 0.8 ? 'end' : 'start'}
            >
              now
            </text>
          </g>
        ) : null}
        {tooltip ? (
          <line
            x1={x(tooltip.index)}
            x2={x(tooltip.index)}
            y1={PAD_T}
            y2={H - PAD_B}
            stroke={GRID}
            strokeOpacity="0.25"
            strokeWidth="1"
          />
        ) : null}
        {series.map((s) => {
          const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
          return (
            <g key={s.key}>
              {s.values.length > 1 ? (
                <polyline
                  points={pts}
                  fill="none"
                  stroke={seriesColor(s.slot)}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null}
              {s.values.map((v, i) =>
                s.values.length === 1 || (tooltip && tooltip.index === i) || i === s.values.length - 1 ? (
                  // 2px surface ring so overlapping markers stay separable
                  <circle key={i} cx={x(i)} cy={y(v)} r="4" fill={seriesColor(s.slot)} stroke="#ffffff" strokeWidth="2" />
                ) : null,
              )}
            </g>
          )
        })}
      </svg>
    </ChartFrame>
  )
}
