/**
 * Presentational components owned by the reports module. Shared primitives
 * live in src/components/ui.tsx — these are module-local by the build rules.
 */
import { useId, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { cx, Input, Select } from '@/components/ui'
import type { FundType } from '@/types/db'
import {
  FUND_TYPE_LABELS,
  fyLabel,
  presetRange,
  SCOPE_LABELS,
  type BuilderState,
  type Period,
  type PeriodPreset,
  type ReportScope,
  type VFundBalance,
} from './lib'

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
          type="button"
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

// ── Reports tab bar ──────────────────────────────────────────────────────────

export function ReportTabs({ canBuildPacks }: { canBuildPacks: boolean }) {
  const tabs = [
    { to: '/reports', end: true, label: 'Report builder', show: true },
    { to: '/reports/pack', end: false, label: 'Board pack', show: canBuildPacks },
    { to: '/reports/library', end: false, label: 'Pack library', show: true },
  ].filter((t) => t.show)
  return (
    <div className="flex flex-wrap gap-1.5 mb-6 border-b border-stone-200 pb-3">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cx(
              'rounded-full px-4 py-1.5 text-[12px] font-medium transition-colors',
              isActive ? 'bg-indigo text-paper' : 'text-stone-500 hover:text-indigo hover:bg-paper-2',
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  )
}

// ── Period + scope controls (the report builder header) ──────────────────────

export function PeriodControls({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
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
          if (preset === 'custom') onChange({ ...value, preset })
          else onChange({ preset, ...presetRange(preset) })
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

export function ScopeControls({
  state,
  funds,
  onChange,
}: {
  state: BuilderState
  funds: VFundBalance[]
  onChange: (next: BuilderState) => void
}) {
  const scopeOptions = (Object.keys(SCOPE_LABELS) as ReportScope[]).map((value) => ({
    value,
    label: SCOPE_LABELS[value],
  }))
  const typeOptions = (Object.keys(FUND_TYPE_LABELS) as FundType[]).map((value) => ({
    value,
    label: FUND_TYPE_LABELS[value],
  }))
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        options={scopeOptions}
        value={state.scope}
        onChange={(scope) => {
          const next: BuilderState = { ...state, scope }
          if (scope === 'single_fund' && !next.fundId && funds.length > 0) next.fundId = funds[0].fund_id
          onChange(next)
        }}
      />
      {state.scope === 'fund_group' ? (
        <Segmented
          options={typeOptions}
          value={state.groupType}
          onChange={(groupType) => onChange({ ...state, groupType })}
        />
      ) : null}
      {state.scope === 'single_fund' ? (
        <Select
          value={state.fundId ?? ''}
          onChange={(e) => onChange({ ...state, fundId: e.target.value || null })}
          className="!w-auto min-w-52 py-1.5 text-[12px]"
          aria-label="Fund"
        >
          {funds.map((f) => (
            <option key={f.fund_id} value={f.fund_id}>
              {f.name}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

export function ReportSectionCard({
  label,
  title,
  aside,
  children,
}: {
  label: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="bg-white border border-stone-150 rounded-card shadow-card">
      <div className="flex flex-wrap items-end justify-between gap-2 px-5 pt-4 pb-3 border-b border-stone-150">
        <div>
          <div className="text-[9.5px] font-medium uppercase tracking-[.14em] text-stone-500">{label}</div>
          <h2 className="font-display text-[19px] text-ink mt-0.5">{title}</h2>
        </div>
        {aside ? <div>{aside}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  )
}

export function VersionBadge({ version }: { version: number }) {
  return (
    <span className="inline-flex items-center font-mono text-[10px] px-2 py-0.5 rounded-full border border-stone-300 text-stone-500 bg-paper-2 whitespace-nowrap">
      v{version}
    </span>
  )
}

export function CheckGlyph({ pass }: { pass: boolean }) {
  return pass ? (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#04b894" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b86e02" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  )
}
