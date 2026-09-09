/**
 * Reports module charts — hand-rolled SVG per DESIGN.md. All styling is
 * carried inline (fill/stroke/font attributes) so the markup serialises
 * unchanged into the standalone board-pack HTML.
 *
 * Palette: mint #08f2c7 positive · stone #b3afa3 negative · pink #f25cce the
 * net that matters · indigo #211951 anchors · gridlines indigo at low opacity.
 *
 * Two-series charts use mint #04b894 for income against crimson #c2185b for
 * expenditure. That pair was chosen by running the palette validator rather
 * than by eye: it separates by ΔE 15.4 under deuteranopia, against a target of
 * 8, where the more obvious mint/pink pairing manages only 7.5. Both sit below
 * 3:1 against the paper, which obliges visible labels — so every series is
 * directly labelled and the same figures appear as a table on the facing page.
 *
 * No hover layer here by design: a pack page has to serialise to standalone
 * HTML with no script for generate-pack, and it is read on paper as often as
 * on screen. The interactive charts live in the app's own screens.
 */
import { compactMoney } from './lib'

const MONO = "'JetBrains Mono', ui-monospace, monospace"
const SANS = "'Geist', system-ui, sans-serif"

// ── Horizontal balance waterfall ─────────────────────────────────────────────
// Opening → income → expenditure → net movement → closing, one bar per row.

export interface WaterfallInput {
  opening: number
  income: number
  expenditure: number
  closing: number
}

export function BalanceWaterfall({
  data,
  width = 620,
  responsive = true,
}: {
  data: WaterfallInput
  width?: number
  /** width:100% for screen layouts; fixed for the printed pack */
  responsive?: boolean
}) {
  const { opening, income, expenditure, closing } = data
  const net = income - expenditure
  const afterIncome = opening + income

  // `connector` is the running position handed to the next row (the dashed
  // step line drawn between bars).
  const rows = [
    { label: 'Opening', from: 0, to: opening, color: '#211951', value: opening, signed: false, connector: opening },
    { label: 'Income', from: opening, to: afterIncome, color: '#08f2c7', value: income, signed: true, connector: afterIncome },
    { label: 'Expenditure', from: closing, to: afterIncome, color: '#b3afa3', value: -expenditure, signed: true, connector: closing },
    { label: 'Net movement', from: Math.min(opening, closing), to: Math.max(opening, closing), color: '#f25cce', value: net, signed: true, connector: closing },
    { label: 'Closing', from: 0, to: closing, color: '#0d0a26', value: closing, signed: false, connector: closing },
  ]

  const rowH = 30
  const gap = 12
  const labelW = 96
  const valueW = 84
  const topPad = 8
  const bottomPad = 26
  const height = topPad + rows.length * rowH + (rows.length - 1) * gap + bottomPad
  const plotW = width - labelW - valueW

  const points = [0, opening, afterIncome, closing]
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const range = hi - lo || 1
  // Truncate the axis when everything sits far from zero, so movements read
  const truncated = lo > 0 && lo - range * 0.15 > 0
  const axisMin = truncated ? Math.max(0, lo - range * 0.25) : Math.min(0, lo)
  const axisMax = hi + range * 0.08
  const scale = (v: number) => labelW + ((v - axisMin) / (axisMax - axisMin || 1)) * plotW

  const ticks = niceTicks(axisMin, axisMax, 4)

  return (
    <svg
      width={responsive ? undefined : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={responsive ? { width: '100%', height: 'auto', display: 'block' } : { display: 'block' }}
      role="img"
      aria-label="Fund balance waterfall: opening, income, expenditure, net movement, closing"
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={scale(t)} y1={topPad} x2={scale(t)} y2={height - bottomPad} stroke="#211951" strokeOpacity=".1" />
          <text x={scale(t)} y={height - 10} textAnchor="middle" fontFamily={MONO} fontSize="9" fill="#b3afa3">
            {compactMoney(t)}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = topPad + i * (rowH + gap)
        const x1 = scale(Math.min(r.from, r.to))
        const x2 = scale(Math.max(r.from, r.to))
        const barW = Math.max(x2 - x1, 1.5)
        const valueLabel = r.signed
          ? `${r.value >= 0 ? '+' : '−'}${compactMoney(Math.abs(r.value)).replace('−', '')}`
          : compactMoney(r.value)
        return (
          <g key={r.label}>
            <text x={labelW - 10} y={y + rowH / 2 + 3.5} textAnchor="end" fontFamily={SANS} fontSize="10.5" fill="#4a4740">
              {r.label}
            </text>
            <rect x={x1} y={y} width={barW} height={rowH} fill={r.color} rx="2" />
            <text x={x2 + 8} y={y + rowH / 2 + 3.5} fontFamily={MONO} fontSize="10.5" fontWeight="600" fill={r.color === '#b3afa3' ? '#807c70' : r.color}>
              {valueLabel}
            </text>
            {i < rows.length - 1 ? (
              <line
                x1={scale(r.connector)}
                y1={y + rowH}
                x2={scale(r.connector)}
                y2={y + rowH + gap}
                stroke="#b3afa3"
                strokeDasharray="3 3"
              />
            ) : null}
          </g>
        )
      })}
      {truncated ? (
        <text x={labelW} y={height - 10} textAnchor="start" fontFamily={SANS} fontSize="8.5" fill="#b3afa3">
          Axis truncated
        </text>
      ) : null}
    </svg>
  )
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1
  const rawStep = span / count
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const candidates = [1, 2, 2.5, 5, 10]
  let step = mag
  for (const c of candidates) {
    if (mag * c >= rawStep) {
      step = mag * c
      break
    }
  }
  const ticks: number[] = []
  let t = Math.ceil(min / step) * step
  let guard = 0
  while (t <= max && guard < 20) {
    ticks.push(t)
    t += step
    guard += 1
  }
  return ticks
}

// ── Restricted vs unrestricted split (two-segment bar) ───────────────────────

export function SplitBar({
  restricted,
  unrestricted,
  height = 34,
}: {
  restricted: number
  unrestricted: number
  height?: number
}) {
  const total = Math.abs(restricted) + Math.abs(unrestricted)
  const rPct = total > 0 ? (Math.abs(restricted) / total) * 100 : 50
  return (
    <div>
      <div
        style={{ display: 'flex', height, borderRadius: 6, overflow: 'hidden', background: '#ebe9e3' }}
        role="img"
        aria-label={`Restricted ${rPct.toFixed(1)}%, unrestricted ${(100 - rPct).toFixed(1)}%`}
      >
        <div style={{ width: `${rPct}%`, background: '#211951' }} />
        <div style={{ width: `${100 - rPct}%`, background: '#08f2c7' }} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 28px', marginTop: 12 }}>
        <SplitLegend swatch="#211951" label="Restricted" value={restricted} pct={rPct} />
        <SplitLegend swatch="#08f2c7" label="Unrestricted" value={unrestricted} pct={100 - rPct} />
      </div>
    </div>
  )
}

function SplitLegend({ swatch, label, value, pct }: { swatch: string; label: string; value: number; pct: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: swatch, display: 'inline-block' }} />
      <span style={{ fontFamily: SANS, fontSize: 12, color: '#2b2925' }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 500, color: '#0d0a26' }}>
        {compactMoney(value)} · {pct.toFixed(1)}%
      </span>
    </div>
  )
}

// ── Monthly balance line (per-fund pack pages) ───────────────────────────────

export function BalanceLine({
  values,
  labels,
  width = 620,
  height = 120,
  responsive = true,
}: {
  values: number[]
  labels: string[]
  width?: number
  height?: number
  responsive?: boolean
}) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || Math.abs(max) * 0.1 || 1
  const padY = 8
  const plotH = height - padY * 2
  const x = (i: number) => (i / (values.length - 1)) * width
  const y = (v: number) => padY + (1 - (v - min) / range) * plotH
  const coords = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const gridYs = [padY, padY + plotH / 2, padY + plotH]
  const last = values.length - 1

  return (
    <div>
      <svg
        width={responsive ? undefined : width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={responsive ? { width: '100%', height: 'auto', display: 'block' } : { display: 'block' }}
        role="img"
        aria-label={`Balance from ${compactMoney(min)} to ${compactMoney(max)}`}
      >
        {gridYs.map((gy, i) => (
          <line key={i} x1={0} y1={gy} x2={width} y2={gy} stroke="#211951" strokeOpacity={i === gridYs.length - 1 ? '.22' : '.1'} />
        ))}
        <polyline points={coords} fill="none" stroke="#04b894" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last)} cy={y(values[last])} r="4" fill="#04b894" />
      </svg>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: MONO,
          fontSize: 9,
          color: '#807c70',
          marginTop: 6,
        }}
      >
        {labels.map((l, i) => (
          <span key={`${l}-${i}`}>{l}</span>
        ))}
      </div>
    </div>
  )
}

// ── Grouped monthly bars (income against expenditure) ────────────────────────
// One axis, two series, both in £ — never a second scale. Bars carry a 2px
// surface gap so adjacent marks stay separable for a reader who cannot tell
// the two hues apart, and each series is named at its tallest bar.

const INCOME = '#04b894'
const EXPENDITURE = '#c2185b'

export interface MonthlyBar {
  label: string
  income: number
  expenditure: number
}

export function MonthlyBars({
  data,
  width = 660,
  height = 180,
  responsive = true,
}: {
  data: MonthlyBar[]
  width?: number
  height?: number
  responsive?: boolean
}) {
  if (data.length === 0) return null
  const padL = 46
  const padB = 22
  const padT = 14
  const plotW = width - padL - 8
  const plotH = height - padB - padT
  const max = Math.max(1, ...data.map((d) => Math.max(d.income, d.expenditure)))
  // A tidy top gridline rather than the raw maximum.
  const step = Math.pow(10, Math.floor(Math.log10(max)))
  const top = Math.ceil(max / step) * step
  const slot = plotW / data.length
  const gap = 2 // surface gap between the pair
  const barW = Math.max(3, Math.min(18, (slot - 10 - gap) / 2))
  const y = (v: number) => padT + (1 - v / top) * plotH
  const gridValues = [0, top / 2, top]

  const tallestIncome = data.reduce((best, d, i) => (d.income > data[best].income ? i : best), 0)
  const tallestExpenditure = data.reduce(
    (best, d, i) => (d.expenditure > data[best].expenditure ? i : best),
    0,
  )
  // Labels are placed on the tallest bar of each series, and only where the
  // two would not collide — a number on every bar is noise, two overlapping
  // labels are worse.
  const labelSeparated = Math.abs(tallestIncome - tallestExpenditure) >= 1

  return (
    <svg
      width={responsive ? undefined : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={responsive ? { width: '100%', height: 'auto', display: 'block' } : { display: 'block' }}
      role="img"
      aria-label={`Monthly income and expenditure, ${data.length} months, highest ${compactMoney(max)}`}
    >
      {gridValues.map((v, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={width - 8}
            y1={y(v)}
            y2={y(v)}
            stroke="#211951"
            strokeOpacity={v === 0 ? '.22' : '.1'}
          />
          <text
            x={padL - 8}
            y={y(v) + 3}
            textAnchor="end"
            fontFamily={MONO}
            fontSize="8.5"
            fill="#807c70"
          >
            {compactMoney(v)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const centre = padL + slot * i + slot / 2
        const incomeX = centre - barW - gap / 2
        const expenditureX = centre + gap / 2
        return (
          <g key={`${d.label}-${i}`}>
            <rect
              x={incomeX}
              y={y(Math.max(0, d.income))}
              width={barW}
              height={Math.max(1, Math.abs(y(Math.max(0, d.income)) - y(0)))}
              fill={INCOME}
              rx="3"
            />
            <rect
              x={expenditureX}
              y={y(Math.max(0, d.expenditure))}
              width={barW}
              height={Math.max(1, Math.abs(y(Math.max(0, d.expenditure)) - y(0)))}
              fill={EXPENDITURE}
              rx="3"
            />
            <text
              x={centre}
              y={height - 7}
              textAnchor="middle"
              fontFamily={MONO}
              fontSize="8"
              fill="#807c70"
            >
              {d.label}
            </text>
            {i === tallestIncome ? (
              <text
                x={incomeX + barW / 2}
                y={y(d.income) - 5}
                textAnchor="middle"
                fontFamily={SANS}
                fontSize="8.5"
                fontWeight="500"
                fill="#036c57"
              >
                Income
              </text>
            ) : null}
            {i === tallestExpenditure && labelSeparated ? (
              <text
                x={expenditureX + barW / 2}
                y={y(d.expenditure) - 5}
                textAnchor="middle"
                fontFamily={SANS}
                fontSize="8.5"
                fontWeight="500"
                fill={EXPENDITURE}
              >
                Expenditure
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

/** Legend for MonthlyBars — identity is never carried by colour alone. */
export function IncomeExpenditureLegend() {
  const item = (colour: string, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{ width: 9, height: 9, borderRadius: 2, background: colour, display: 'inline-block' }}
      />
      <span style={{ fontFamily: SANS, fontSize: 10, color: '#4a4740' }}>{label}</span>
    </span>
  )
  return (
    <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
      {item(INCOME, 'Income')}
      {item(EXPENDITURE, 'Expenditure')}
    </div>
  )
}

// ── Ageing bars (one series, ordered buckets) ────────────────────────────────
// Debtors and creditors get a chart each rather than sharing one with two
// scales. Buckets are ordered oldest-last, so the shape reads left to right.

export function AgeBars({
  data,
  tone = 'indigo',
  width = 320,
  height = 120,
  responsive = true,
}: {
  data: Array<{ label: string; value: number }>
  tone?: 'indigo' | 'crimson'
  width?: number
  height?: number
  responsive?: boolean
}) {
  if (data.length === 0) return null
  const fill = tone === 'crimson' ? EXPENDITURE : '#211951'
  const padB = 20
  const padT = 16
  const plotH = height - padB - padT
  const slot = width / data.length
  const barW = Math.min(34, slot - 8)
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)))

  return (
    <svg
      width={responsive ? undefined : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={responsive ? { width: '100%', height: 'auto', display: 'block' } : { display: 'block' }}
      role="img"
      aria-label={`Outstanding by age, largest bucket ${compactMoney(max)}`}
    >
      <line x1={0} x2={width} y1={padT + plotH} y2={padT + plotH} stroke="#211951" strokeOpacity=".22" />
      {data.map((d, i) => {
        const value = Math.abs(d.value)
        const h = value === 0 ? 0 : Math.max(2, (value / max) * plotH)
        const x = slot * i + (slot - barW) / 2
        return (
          <g key={`${d.label}-${i}`}>
            {h > 0 ? <rect x={x} y={padT + plotH - h} width={barW} height={h} fill={fill} rx="3" /> : null}
            {value > 0 ? (
              <text
                x={x + barW / 2}
                y={padT + plotH - h - 5}
                textAnchor="middle"
                fontFamily={MONO}
                fontSize="8.5"
                fill="#4a4740"
              >
                {compactMoney(value)}
              </text>
            ) : null}
            <text
              x={x + barW / 2}
              y={height - 6}
              textAnchor="middle"
              fontFamily={MONO}
              fontSize="7.5"
              fill="#807c70"
            >
              {d.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
