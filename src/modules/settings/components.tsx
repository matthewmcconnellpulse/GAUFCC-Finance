/**
 * Settings module components — tab pills, modal, toggle switch, role chip and
 * the before/after diff used by the audit viewer. Module-owned.
 */
import { useEffect, type ReactNode } from 'react'
import { Card, StatusChip, cx } from '@/components/ui'
import type { Role } from '@/types/db'
import { ROLE_LABELS } from './lib'

// ── Tab pills ────────────────────────────────────────────────────────────────

export function TabPills<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: Array<{ key: T; label: string }>
  active: T
  onSelect: (key: T) => void
}) {
  return (
    <div className="inline-flex flex-wrap bg-white border border-stone-300 rounded-full p-[3px]" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={t.key === active}
          onClick={() => onSelect(t.key)}
          className={cx(
            'rounded-full px-4 py-1.5 text-[12px] font-medium transition-colors whitespace-nowrap',
            t.key === active ? 'bg-indigo text-paper' : 'text-stone-500 hover:text-indigo',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
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
      <Card className="relative w-full max-w-md shadow-panel max-h-[90vh] overflow-y-auto">
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

// ── Toggle switch ────────────────────────────────────────────────────────────

export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx(
        'relative inline-flex w-9 h-5 rounded-full transition-colors shrink-0',
        on ? 'bg-indigo' : 'bg-stone-300',
        disabled && 'opacity-45 cursor-not-allowed',
      )}
    >
      <span
        className={cx(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
          on ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  )
}

// ── Role chip ────────────────────────────────────────────────────────────────

const ROLE_TONES: Record<Role, 'indigo' | 'neutral' | 'good' | 'warn'> = {
  pulse_admin: 'indigo',
  pulse_bookkeeper: 'indigo',
  pulse_payroll: 'indigo',
  ceo: 'good',
  trustee: 'neutral',
  submitter: 'neutral',
}

export function RoleChip({ role }: { role: Role }) {
  return <StatusChip tone={ROLE_TONES[role]}>{ROLE_LABELS[role]}</StatusChip>
}

// ── Section card ─────────────────────────────────────────────────────────────

export function SectionCard({
  title,
  hint,
  children,
  actions,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-3.5 border-b border-stone-150 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-display text-[16px] text-ink">{title}</div>
          {hint ? <div className="text-[11px] text-stone-500 mt-0.5">{hint}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </Card>
  )
}

// ── Before/after diff (audit viewer) ────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function renderValue(v: unknown): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/**
 * Key-by-key comparison of the before/after snapshots. Changed keys are
 * highlighted amber; unchanged keys render quietly so the change stands out.
 */
export function BeforeAfterDiff({ before, after }: { before: unknown; after: unknown }) {
  const b = asRecord(before)
  const a = asRecord(after)
  if (!b && !a) return <div className="text-[11px] text-stone-500 px-4 py-3">No snapshot recorded.</div>

  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].sort()
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] min-w-[560px]">
        <thead>
          <tr>
            <th className="th-register">Field</th>
            <th className="th-register">Before</th>
            <th className="th-register">After</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const bv = b?.[k]
            const av = a?.[k]
            const changed = JSON.stringify(bv) !== JSON.stringify(av)
            return (
              <tr key={k} className={cx(changed && 'bg-warn/5')}>
                <td className={cx('td-register font-mono whitespace-nowrap', changed ? 'text-warn-ink font-medium' : 'text-stone-500')}>
                  {k}
                </td>
                <td className="td-register font-mono break-all max-w-[240px]">{renderValue(bv)}</td>
                <td className={cx('td-register font-mono break-all max-w-[240px]', changed && 'font-medium')}>
                  {renderValue(av)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
