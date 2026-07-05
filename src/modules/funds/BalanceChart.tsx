/**
 * Hand-rolled SVG balance history line, per docs/DESIGN.md:
 * mint-700 line · indigo gridlines at 12% opacity · figures in mono.
 */
import { compactMoney, monthShort, type BalancePoint } from './lib'

const W = 640
const H = 220
const PAD_LEFT = 58
const PAD_RIGHT = 14
const PAD_TOP = 14
const PAD_BOTTOM = 28

function niceStep(range: number): number {
  const raw = range / 4 || 1
  const pow = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / pow
  if (norm >= 5) return 10 * pow
  if (norm >= 2) return 5 * pow
  if (norm >= 1) return 2 * pow
  return pow
}

export default function BalanceChart({ series }: { series: BalancePoint[] }) {
  if (series.length < 2) return null

  const values = series.map((p) => p.balance)
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    min -= Math.max(1, Math.abs(min) * 0.05)
    max += Math.max(1, Math.abs(max) * 0.05)
  }
  const pad = (max - min) * 0.08
  min -= pad
  max += pad

  const step = niceStep(max - min)
  const ticks: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t)

  const innerW = W - PAD_LEFT - PAD_RIGHT
  const innerH = H - PAD_TOP - PAD_BOTTOM
  const x = (i: number) => PAD_LEFT + (i / (series.length - 1)) * innerW
  const y = (v: number) => PAD_TOP + (1 - (v - min) / (max - min)) * innerH

  const linePoints = series.map((p, i) => `${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ')
  const last = series[series.length - 1]

  // Up to six x labels, always including first and last
  const labelStride = Math.max(1, Math.ceil(series.length / 6))
  const xLabels = series
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % labelStride === 0 || i === series.length - 1)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img"
      aria-label={`Balance history from ${monthShort(series[0].month)} to ${monthShort(last.month)}`}
    >
      {/* gridlines — indigo at 12% */}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD_LEFT}
            x2={W - PAD_RIGHT}
            y1={y(t)}
            y2={y(t)}
            stroke="#211951"
            strokeOpacity="0.12"
            strokeWidth="1"
          />
          <text
            x={PAD_LEFT - 8}
            y={y(t) + 3}
            textAnchor="end"
            fontFamily="'JetBrains Mono', monospace"
            fontSize="9.5"
            fill="#807c70"
          >
            {compactMoney(t)}
          </text>
        </g>
      ))}
      {/* x labels */}
      {xLabels.map(({ p, i }) => (
        <text
          key={p.month}
          x={x(i)}
          y={H - 8}
          textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}
          fontFamily="'JetBrains Mono', monospace"
          fontSize="9.5"
          fill="#807c70"
        >
          {monthShort(p.month)}
        </text>
      ))}
      {/* the series — mint-700 */}
      <polyline
        points={linePoints}
        fill="none"
        stroke="#04b894"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={x(series.length - 1)} cy={y(last.balance)} r="3" fill="#04b894" />
    </svg>
  )
}
