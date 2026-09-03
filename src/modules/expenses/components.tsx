/**
 * Presentational components owned by the expenses module.
 * Shared primitives live in src/components/ui.tsx (read-only).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { StatusChip, Skeleton, cx } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { ClaimStatus, ExpenseClaim } from '@/types/db'
import {
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_TONES,
  computeDeadline,
  daysLeftLabel,
  fetchDeadlineDays,
  formatDayMonth,
  isPdfPath,
  signedReceiptUrl,
  type ClaimWithSubmitter,
  type DeadlineInfo,
} from './lib'

// ── Deadline banner ──────────────────────────────────────────────────────────

export function useDeadline(): DeadlineInfo | null {
  const q = useSupabaseQuery(fetchDeadlineDays, [])
  return useMemo(
    () => (q.data ? computeDeadline(q.data.approvalDay, q.data.paymentDay) : null),
    [q.data],
  )
}

/**
 * 'Submit by 10 July to be paid on 17 July' — computed from settings, rolls
 * to next month automatically once the approval day has passed.
 */
export function DeadlineBanner({ mode, deadline }: { mode: 'submit' | 'approve'; deadline: DeadlineInfo | null }) {
  if (!deadline) {
    return <Skeleton className="h-12 mb-5" />
  }
  const approvalLabel = formatDayMonth(deadline.approvalDate)
  const paymentLabel = formatDayMonth(deadline.paymentDate)
  return (
    <div className="bg-indigo rounded-card px-4 sm:px-5 py-3 flex items-center justify-between gap-3 mb-5">
      <div className="flex items-center gap-2.5 min-w-0">
        <ClockIcon className="shrink-0" />
        <span className="text-paper text-[12.5px] leading-snug">
          {mode === 'submit' ? (
            <>
              Submit by <b className="font-medium">{approvalLabel}</b> to be paid on{' '}
              <b className="font-medium">{paymentLabel}</b>
            </>
          ) : (
            <>
              Approve by <b className="font-medium">{approvalLabel}</b> for the{' '}
              <b className="font-medium">{paymentLabel}</b> payment run
            </>
          )}
          <span className="text-paper/55"> — late claims roll to the next run automatically.</span>
        </span>
      </div>
      <span className="font-mono text-[11px] text-mint whitespace-nowrap">{daysLeftLabel(deadline.daysLeft)}</span>
    </div>
  )
}

// ── Status chip ──────────────────────────────────────────────────────────────

export function ClaimStatusChip({ status, className }: { status: ClaimStatus; className?: string }) {
  return (
    <StatusChip tone={CLAIM_STATUS_TONES[status]} className={className}>
      {CLAIM_STATUS_LABELS[status]}
    </StatusChip>
  )
}

// ── Avatar ───────────────────────────────────────────────────────────────────

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#1de4ff,#ff80e3)',
  'linear-gradient(135deg,#211951,#16b6ce)',
  'linear-gradient(135deg,#04b894,#1de4ff)',
  'linear-gradient(135deg,#f25cce,#211951)',
]

export function Avatar({ name, size = 32 }: { name: string | null | undefined; size?: number }) {
  const label = name?.trim() || '—'
  const initials = label
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  let hash = 0
  for (const ch of label) hash = (hash + ch.charCodeAt(0)) % 997
  return (
    <span
      className="inline-grid place-items-center rounded-full text-paper font-semibold shrink-0"
      style={{
        width: size,
        height: size,
        background: AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length],
        fontSize: Math.max(10, Math.round(size * 0.34)),
      }}
      aria-hidden
    >
      {initials}
    </span>
  )
}

// ── Receipt thumbnail (signed URL) ───────────────────────────────────────────

export function ReceiptThumb({
  path,
  className,
  alt = 'Receipt',
}: {
  path: string
  className?: string
  alt?: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setFailed(false)
    signedReceiptUrl(path)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const open = () => {
    if (url) window.open(url, '_blank', 'noopener')
  }

  const frame = cx(
    'relative overflow-hidden rounded-control border border-stone-150 bg-paper-2 focus:outline-none focus:ring-2 focus:ring-mint/60',
    url ? 'cursor-zoom-in' : 'cursor-default',
    className,
  )

  if (failed) {
    return (
      <span className={cx(frame, 'grid place-items-center text-[9px] text-stone-400 px-1 text-center')}>
        receipt unavailable
      </span>
    )
  }
  if (!url) {
    return <Skeleton className={className} />
  }
  if (isPdfPath(path)) {
    return (
      <button type="button" onClick={open} className={cx(frame, 'grid place-items-center')} title={alt}>
        <span className="font-mono text-[9.5px] text-stone-500 border border-dashed border-stone-300 rounded px-1.5 py-0.5">
          PDF
        </span>
      </button>
    )
  }
  return (
    <button type="button" onClick={open} className={frame} title={alt}>
      <img src={url} alt={alt} className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
    </button>
  )
}

// ── Small chips per the 1f design ────────────────────────────────────────────

export function FundChip({ name }: { name: string }) {
  return (
    <span
      className="inline-flex items-center font-medium text-[9.5px] px-2 py-0.5 rounded-full whitespace-nowrap max-w-[180px] truncate"
      style={{ background: 'rgba(33,25,81,.07)', color: '#211951' }}
    >
      {name}
    </span>
  )
}

export function CategoryChip({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center font-medium text-[9.5px] px-2 py-0.5 rounded-full whitespace-nowrap max-w-[180px] truncate"
      style={{ background: '#f3f1ea', color: '#4a4740' }}
    >
      {label}
    </span>
  )
}

// ── Segmented control (module copy — ui.tsx is read-only) ───────────────────

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

// ── Access denial ────────────────────────────────────────────────────────────

export function AccessDenied({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="bg-white border border-stone-150 rounded-card shadow-card text-center py-16 px-6">
      <div className="font-display text-xl text-ink">{title}</div>
      <p className="text-stone-500 text-[12.5px] mt-2 max-w-md mx-auto">{hint}</p>
    </div>
  )
}

// ── Notices ──────────────────────────────────────────────────────────────────

export function InfoNotice({ tone, children }: { tone: 'mint' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-card border px-4 py-3 text-[12.5px] leading-relaxed',
        tone === 'mint' ? 'bg-mint/10 border-mint/50 text-mint-900' : 'bg-warn/10 border-warn/40 text-warn-ink',
      )}
    >
      {children}
    </div>
  )
}

// ── Claim status timeline ────────────────────────────────────────────────────

interface TimelineStep {
  key: string
  label: string
  detail: ReactNode
  state: 'done' | 'warn' | 'todo'
}

/** A timestamp with the person who did it underneath, when we know them. */
function stamp(at: string, who: { full_name: string } | null | undefined): ReactNode {
  return (
    <>
      {formatDateTime(at)}
      {who ? <span className="block text-ink">by {who.full_name}</span> : null}
    </>
  )
}

export function ClaimTimeline({
  claim,
}: {
  claim: ExpenseClaim & Partial<Pick<ClaimWithSubmitter, 'approver' | 'returner'>>
}) {
  const s = claim.status
  const steps: TimelineStep[] = [
    { key: 'created', label: 'Created', detail: formatDateTime(claim.created_at), state: 'done' },
    {
      key: 'submitted',
      label: 'Submitted',
      detail: claim.submitted_at ? formatDateTime(claim.submitted_at) : 'not yet',
      state: claim.submitted_at ? 'done' : 'todo',
    },
  ]
  if (s === 'draft' && claim.returned_at) {
    steps.push({
      key: 'returned',
      label: 'Returned for amendment',
      detail: stamp(claim.returned_at, claim.returner),
      state: 'warn',
    })
  }
  if (s === 'rejected') {
    steps.push({
      key: 'rejected',
      label: 'Rejected',
      detail: claim.ceo_approved_at ? stamp(claim.ceo_approved_at, claim.approver) : '—',
      state: 'warn',
    })
  } else {
    const approved = s === 'approved' || s === 'pushed_to_xero' || s === 'paid'
    steps.push({
      key: 'approved',
      label: 'Approved',
      detail:
        approved && claim.ceo_approved_at ? stamp(claim.ceo_approved_at, claim.approver) : 'awaiting the CEO',
      state: approved ? 'done' : 'todo',
    })
    const pushed = s === 'pushed_to_xero' || s === 'paid'
    steps.push({
      key: 'pushed',
      label: 'Pushed to Xero',
      detail: pushed ? (
        claim.xero_bill_id ? (
          <span className="font-mono text-[10.5px]">bill {claim.xero_bill_id}</span>
        ) : (
          'draft bill created'
        )
      ) : (
        'after approval, Pulse pushes the bill'
      ),
      state: pushed ? 'done' : 'todo',
    })
    steps.push({
      key: 'paid',
      label: 'Paid',
      detail: s === 'paid' ? 'paid in the monthly run' : 'in the next payment run',
      state: s === 'paid' ? 'done' : 'todo',
    })
  }

  return (
    <ol className="space-y-0">
      {steps.map((step, i) => (
        <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 ? (
            <span className="absolute left-[5px] top-4 bottom-0 w-px bg-stone-150" aria-hidden />
          ) : null}
          <span
            className={cx(
              'relative mt-1 w-[11px] h-[11px] rounded-full shrink-0 border',
              step.state === 'done' && 'bg-mint-700 border-mint-700',
              step.state === 'warn' && 'bg-warn border-warn',
              step.state === 'todo' && 'bg-white border-stone-300',
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <div
              className={cx(
                'text-[12.5px] font-medium',
                step.state === 'todo' ? 'text-stone-400' : 'text-ink',
              )}
            >
              {step.label}
            </div>
            <div className="text-[11px] text-stone-500 mt-0.5">{step.detail}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

// ── Icons (inline SVG, no dependencies) ──────────────────────────────────────

export function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#08f2c7"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  )
}

export function CheckIcon({ className, stroke = 'currentColor' }: { className?: string; stroke?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

export function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#04b894"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  )
}

export function XIcon({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  )
}

export function ChevronRightIcon({ className }: { className?: string }) {
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
      className={className}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}
