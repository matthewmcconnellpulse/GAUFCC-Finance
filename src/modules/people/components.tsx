/**
 * People module — shared presentational pieces: type/status chips, a modal
 * and a copy-to-clipboard field. Module-owned; nothing here is imported by
 * other modules.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, cx } from '@/components/ui'
import type { OnboardingStatus, PersonType } from '@/types/db'
import { STAGE_LABELS } from './lib'

// ── Chips ────────────────────────────────────────────────────────────────────

const personTypeStyles: Record<PersonType, { bg: string; fg: string; label: string }> = {
  employee: { bg: 'rgba(33,25,81,.09)', fg: '#211951', label: 'Employee' },
  volunteer: { bg: 'rgba(22,182,206,.13)', fg: '#0e7c8c', label: 'Volunteer' },
}

export function PersonTypeChip({ type, className }: { type: PersonType; className?: string }) {
  const s = personTypeStyles[type]
  return (
    <span
      className={cx(
        'inline-flex items-center font-medium text-[10.5px] px-2.5 py-0.5 rounded-full whitespace-nowrap',
        className,
      )}
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  )
}

/**
 * Onboarding status chip. Quiet palette: attention states lean indigo/cyan,
 * good states use the mint tint already established by StatusChip's 'good'
 * tone; terminal 'complete' is deliberately calm.
 */
const stageChipClasses: Record<OnboardingStatus, string> = {
  invited: 'bg-stone-150 text-stone-500',
  in_progress: 'bg-cyan-600/15 text-cyan-800',
  submitted: 'bg-indigo/10 text-indigo',
  verified: 'bg-mint-700/15 text-mint-900',
  complete: 'bg-stone-150 text-stone-700',
}

export function OnboardingStatusChip({
  status,
  className,
}: {
  status: OnboardingStatus
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 font-medium text-[10.5px] px-2.5 py-0.5 rounded-full whitespace-nowrap',
        stageChipClasses[status],
        className,
      )}
    >
      {status === 'complete' ? <span aria-hidden>✓</span> : null}
      {STAGE_LABELS[status]}
    </span>
  )
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div
        className={cx(
          'relative bg-white rounded-t-card sm:rounded-card shadow-panel w-full max-h-[90vh] overflow-y-auto',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-4 border-b border-stone-150">
          <h2 className="font-display text-[19px] text-ink leading-tight">{title}</h2>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-ink text-[20px] leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  )
}

// ── Copy field ───────────────────────────────────────────────────────────────

export function CopyField({ value, ariaLabel }: { value: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the input still
      // selects on focus so the user can copy manually.
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={value}
        aria-label={ariaLabel ?? 'Copy value'}
        onFocus={(e) => e.currentTarget.select()}
        className="input-base font-mono text-[11.5px] flex-1 min-w-0"
      />
      <Button variant="ghost" size="sm" onClick={() => void copy()} className="shrink-0">
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
