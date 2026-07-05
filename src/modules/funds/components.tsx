/**
 * Presentational components shared by the dashboard + funds slice.
 * Module-owned — shared primitives live in src/components/ui.tsx.
 */
import { useId, type ReactNode } from 'react'
import { cx, Input } from '@/components/ui'
import { fyLabel, presetRange, type Period, type PeriodPreset } from './lib'

// ── Stat tiles ───────────────────────────────────────────────────────────────

export function StatTile({
  label,
  value,
  sub,
  tone = 'plain',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'hero' | 'plain' | 'warn'
}) {
  if (tone === 'hero') {
    return (
      <div className="bg-indigo rounded-card px-[18px] py-4 shadow-card">
        <div className="text-[9.5px] font-medium uppercase tracking-[.13em] text-mint">{label}</div>
        <div className="font-display text-[26px] font-normal text-paper mt-1.5 leading-none">{value}</div>
        {sub ? <div className="font-mono text-[10.5px] text-paper/55 mt-1.5">{sub}</div> : null}
      </div>
    )
  }
  return (
    <div
      className={cx(
        'bg-white rounded-card px-[18px] py-4 border shadow-card',
        tone === 'warn' ? 'border-warn' : 'border-stone-150',
      )}
    >
      <div
        className={cx(
          'text-[9.5px] font-medium uppercase tracking-[.13em]',
          tone === 'warn' ? 'text-warn-ink' : 'text-stone-500',
        )}
      >
        {label}
      </div>
      <div className="font-display text-[26px] font-normal text-ink mt-1.5 leading-none">{value}</div>
      {sub ? (
        <div className={cx('font-mono text-[10.5px] mt-1.5', tone === 'warn' ? 'text-warn-ink' : 'text-stone-500')}>
          {sub}
        </div>
      ) : null}
    </div>
  )
}

// ── Segmented control ────────────────────────────────────────────────────────

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div
      className={cx('inline-flex flex-wrap bg-white border border-stone-300 rounded-full p-[3px] gap-0.5', className)}
      role="tablist"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={opt.value === value}
          onClick={() => onChange(opt.value)}
          className={cx(
            'px-3 py-[5px] rounded-full text-[11px] font-medium whitespace-nowrap transition-colors',
            opt.value === value ? 'bg-indigo text-paper' : 'text-stone-500 hover:text-indigo',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ── Period selector (fund detail) ────────────────────────────────────────────

export function PeriodSelect({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const startId = useId()
  const endId = useId()
  const presets: Array<{ value: PeriodPreset; label: string }> = [
    { value: 'month', label: 'This month' },
    { value: 'quarter', label: 'This quarter' },
    { value: 'year', label: 'This year' },
    { value: 'fy', label: fyLabel() },
    { value: 'custom', label: 'Custom' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        options={presets}
        value={value.preset}
        onChange={(preset) => {
          if (preset === 'custom') {
            onChange({ preset, start: value.start, end: value.end })
          } else {
            onChange({ preset, ...presetRange(preset) })
          }
        }}
      />
      {value.preset === 'custom' ? (
        <div className="flex items-center gap-2">
          <label htmlFor={startId} className="text-[11px] text-stone-500">
            From
          </label>
          <Input
            id={startId}
            type="date"
            value={value.start}
            max={value.end}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
            className="!w-auto py-1.5 text-[12px]"
          />
          <label htmlFor={endId} className="text-[11px] text-stone-500">
            to
          </label>
          <Input
            id={endId}
            type="date"
            value={value.end}
            min={value.start}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
            className="!w-auto py-1.5 text-[12px]"
          />
        </div>
      ) : null}
    </div>
  )
}

// ── Access denial (integrity screen guard) ───────────────────────────────────

export function AccessDenied({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="bg-white border border-stone-150 rounded-card shadow-card text-center py-16 px-6">
      <div className="font-display text-xl text-ink">{title}</div>
      <p className="text-stone-500 text-[12.5px] mt-2 max-w-md mx-auto">{hint}</p>
    </div>
  )
}

// ── Small icons (inline SVG, no dependencies) ────────────────────────────────

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#04b894"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

export function WarnIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#b86e02"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  )
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#807c70"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('transition-transform', open && 'rotate-180')}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
