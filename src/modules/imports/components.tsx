/**
 * Imports module components — drop zone, tab pills, sense-check panel with
 * drill-down, status chips and a small modal. Module-owned; shared primitives
 * come from src/components/ui.tsx.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Card, StatusChip, cx } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import type { BankImportRow, ImportStatus } from '@/types/db'
import {
  IMPORT_STATUS_LABELS,
  IMPORT_STATUS_TONES,
  PHASE_LABELS,
  isoToUk,
  type UploadPhase,
} from './lib'
import { CHECK_TITLES, type CheckOutcome } from './senseChecks'

// ── Icons (inline SVG, per the design mock) ──────────────────────────────────

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
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
      strokeWidth="2"
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

function UploadIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#211951"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mx-auto block"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  )
}

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
    <div className="inline-flex bg-white border border-stone-300 rounded-full p-[3px]" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={t.key === active}
          onClick={() => onSelect(t.key)}
          className={cx(
            'rounded-full px-4 py-1.5 text-[12px] font-medium transition-colors',
            t.key === active ? 'bg-indigo text-paper' : 'text-stone-500 hover:text-indigo',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Upload phases ────────────────────────────────────────────────────────────

export function PhaseSteps({ phases, current }: { phases: UploadPhase[]; current: UploadPhase }) {
  const currentIdx = phases.indexOf(current)
  return (
    <ol className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-3" aria-live="polite">
      {phases.map((p, i) => {
        const state = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'todo'
        return (
          <li key={p} className="flex items-center gap-1.5 text-[11px]">
            <span
              className={cx(
                'w-1.5 h-1.5 rounded-full',
                state === 'done' && 'bg-mint-700',
                state === 'active' && 'bg-mint animate-syncPulse',
                state === 'todo' && 'bg-stone-300',
              )}
              aria-hidden
            />
            <span className={state === 'active' ? 'text-indigo font-medium' : 'text-stone-500'}>
              {PHASE_LABELS[p]}
              {state === 'active' ? '…' : ''}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ── File drop zone ───────────────────────────────────────────────────────────

export function FileDrop({
  title,
  hint,
  accept,
  busyPhase,
  phases,
  disabled,
  onFile,
}: {
  title: string
  hint: string
  /** input accept attribute, e.g. '.pdf,.csv' */
  accept: string
  busyPhase: UploadPhase | null
  phases: UploadPhase[]
  disabled?: boolean
  onFile: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const busy = busyPhase != null

  function pick(files: FileList | null) {
    const file = files?.[0]
    if (file && !busy && !disabled) onFile(file)
  }

  return (
    <div
      className={cx(
        'border-2 border-dashed rounded-[14px] bg-white p-6 text-center transition-colors',
        dragging ? 'border-mint-700 bg-mint/5' : 'border-stone-400',
        (busy || disabled) && 'opacity-80',
      )}
      onDragOver={(e) => {
        e.preventDefault()
        if (!busy && !disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        pick(e.dataTransfer.files)
      }}
    >
      <UploadIcon />
      <div className="text-[13.5px] font-medium text-ink mt-2.5">{title}</div>
      <div className="text-[11.5px] leading-relaxed text-stone-500 mt-1 max-w-xs mx-auto">{hint}</div>
      {busyPhase ? (
        <PhaseSteps phases={phases} current={busyPhase} />
      ) : (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            className="mt-3.5 inline-flex items-center rounded-full border border-stone-300 px-4 py-1.5 text-[11.5px] font-medium text-indigo hover:bg-paper-2 disabled:opacity-45"
          >
            Choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="sr-only"
            onChange={(e) => {
              pick(e.target.files)
              e.target.value = ''
            }}
          />
        </>
      )}
    </div>
  )
}

// ── Status chip ──────────────────────────────────────────────────────────────

export function ImportStatusChip({ status }: { status: ImportStatus }) {
  return <StatusChip tone={IMPORT_STATUS_TONES[status]}>{IMPORT_STATUS_LABELS[status]}</StatusChip>
}

/** '4 of 4' checks badge for the register. */
export function ChecksBadge({ passed, total }: { passed: number; total: number }) {
  if (total === 0) return <span className="text-stone-400 text-[11px]">—</span>
  const allPass = passed === total
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 font-mono text-[10.5px] px-2 py-0.5 rounded-full',
        allPass ? 'bg-mint-700/15 text-mint-900' : 'bg-warn/15 text-warn-ink',
      )}
    >
      {passed} of {total}
    </span>
  )
}

// ── Sense-check panel with drill-down ────────────────────────────────────────

function OffendingRows({ rows }: { rows: BankImportRow[] }) {
  const shown = rows.slice(0, 25)
  return (
    <div className="mx-4 mb-3 rounded-control border border-warn/40 bg-warn/5 overflow-x-auto">
      <table className="w-full text-[11px] min-w-[420px]">
        <thead>
          <tr>
            <th className="th-register">Date</th>
            <th className="th-register">Description</th>
            <th className="th-register text-right">Amount</th>
            <th className="th-register text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              <td className="td-register figure whitespace-nowrap">{isoToUk(r.date)}</td>
              <td className="td-register max-w-[280px] truncate" title={r.description}>
                {r.description || '—'}
              </td>
              <td className="td-register figure text-right whitespace-nowrap">{formatMoney(r.amount)}</td>
              <td className="td-register figure text-right whitespace-nowrap">
                {r.balance != null ? formatMoney(r.balance) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length ? (
        <div className="px-4 py-2 text-[10.5px] text-stone-500 border-t border-stone-150">
          and {rows.length - shown.length} more rows
        </div>
      ) : null}
    </div>
  )
}

export function SenseCheckPanel({ outcomes, footer }: { outcomes: CheckOutcome[]; footer?: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null)
  const clear = outcomes.filter((o) => o.pass).length
  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-3.5 border-b border-stone-150 font-display text-[16px] text-ink">
        Sense checks — {clear} of {outcomes.length} clear
      </div>
      {outcomes.map((o) => {
        const expandable = !o.pass && (o.offending?.length ?? 0) > 0
        const expanded = open === o.check
        return (
          <div key={o.check} className={cx('border-b border-paper-3 last:border-b-0', !o.pass && 'bg-warn/5')}>
            <button
              type="button"
              disabled={!expandable}
              onClick={() => setOpen(expanded ? null : o.check)}
              className={cx(
                'w-full grid grid-cols-[26px_1fr_auto] gap-x-3 items-center px-5 py-3 text-left',
                expandable && 'hover:bg-warn/10 cursor-pointer',
              )}
              aria-expanded={expandable ? expanded : undefined}
            >
              {o.pass ? <CheckIcon /> : <WarnIcon />}
              <span className="text-[12.5px] text-ink">
                {CHECK_TITLES[o.check]}
                <span className={cx('block text-[11px] mt-0.5', o.pass ? 'text-stone-500' : 'text-warn-ink')}>
                  {o.detail}
                  {expandable ? (expanded ? ' — hide rows' : ' — show rows') : ''}
                </span>
              </span>
              <span
                className={cx(
                  'text-[10px] font-medium px-2.5 py-0.5 rounded-full whitespace-nowrap',
                  o.pass ? 'bg-mint-700/15 text-mint-900' : 'bg-warn/15 text-warn-ink',
                )}
              >
                {o.pass ? 'Pass' : 'Review'}
              </span>
            </button>
            {expanded && o.offending ? <OffendingRows rows={o.offending} /> : null}
          </div>
        )
      })}
      {footer ? <div className="px-5 py-3.5 bg-paper border-t border-stone-150">{footer}</div> : null}
    </Card>
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
      <Card className="relative w-full max-w-md shadow-panel">
        <div className="px-5 py-4 border-b border-stone-150 flex items-center justify-between">
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
