/**
 * Shared UI primitives — the design system in code.
 * Rules of the product (from docs/DESIGN.md):
 *  · Mint is spent only on money moments — approve, submit, live sync.
 *  · Warnings are amber and quiet; red is reserved for a breached policy.
 *  · Radii 8–12px, hairline borders, indigo-tinted soft shadows.
 *  · Figures always render in JetBrains Mono (`figure` class).
 *
 * Module builders: treat this file as READ-ONLY. Module-specific components
 * belong inside your module directory.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { forwardRef } from 'react'
import type { FundType } from '@/types/db'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ── Buttons ──────────────────────────────────────────────────────────────────

type ButtonVariant = 'money' | 'primary' | 'ghost' | 'reject' | 'quiet'

const buttonStyles: Record<ButtonVariant, string> = {
  // mint — money moments only (approve, submit, sync)
  money: 'bg-mint text-indigo font-semibold hover:brightness-95',
  primary: 'bg-indigo text-paper font-medium hover:bg-indigo-soft',
  ghost: 'bg-transparent text-indigo font-medium border border-stone-300 hover:bg-paper-2',
  reject: 'bg-transparent text-danger-ink font-medium border border-stone-300 hover:bg-danger/5',
  quiet: 'bg-transparent text-stone-500 font-medium hover:text-indigo hover:bg-paper-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full transition-colors disabled:opacity-45 disabled:cursor-not-allowed',
        size === 'md' ? 'px-5 py-2.5 text-[12.5px]' : 'px-3.5 py-1.5 text-[11.5px]',
        buttonStyles[variant],
        className,
      )}
      {...rest}
    />
  )
})

// ── Cards & panels ───────────────────────────────────────────────────────────

export function Card({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cx('bg-white border border-stone-150 rounded-card shadow-card', className)}>
      {children}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="font-display text-[26px] font-normal text-ink leading-tight">{title}</h1>
        {subtitle ? <p className="text-stone-500 text-[12.5px] mt-1">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-[.14em] text-stone-500 mb-2.5">
      {children}
    </div>
  )
}

// ── Chips & badges ───────────────────────────────────────────────────────────

const fundTypeChipStyles: Record<FundType, { bg: string; fg: string; label: string }> = {
  restricted: { bg: 'rgba(33,25,81,.09)', fg: '#211951', label: 'Restricted' },
  designated: { bg: 'rgba(22,182,206,.13)', fg: '#0e7c8c', label: 'Designated' },
  general: { bg: 'rgba(4,184,148,.13)', fg: '#036c57', label: 'General' },
  dormant: { bg: '#ebe9e3', fg: '#807c70', label: 'Dormant' },
}

export function FundTypeChip({ type, className }: { type: FundType; className?: string }) {
  const s = fundTypeChipStyles[type]
  return (
    <span
      className={cx('inline-flex items-center font-medium text-[10.5px] px-2.5 py-0.5 rounded-full whitespace-nowrap', className)}
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  )
}

/** Amber, never red unless a policy is actually breached */
export function WarningBadge({
  children,
  breached = false,
  className,
}: {
  children: ReactNode
  breached?: boolean
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 font-medium text-[10.5px] px-2.5 py-0.5 rounded-full whitespace-nowrap',
        breached ? 'bg-danger/10 text-danger-ink' : 'bg-warn/15 text-warn-ink',
        className,
      )}
    >
      <span aria-hidden>⚠</span>
      {children}
    </span>
  )
}

export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: 'neutral' | 'live' | 'good' | 'warn' | 'danger' | 'indigo'
  children: ReactNode
  className?: string
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-stone-150 text-stone-500',
    live: 'bg-mint/20 text-mint-900',
    good: 'bg-mint-700/15 text-mint-900',
    warn: 'bg-warn/15 text-warn-ink',
    danger: 'bg-danger/10 text-danger-ink',
    indigo: 'bg-indigo/10 text-indigo',
  }
  return (
    <span
      className={cx(
        'inline-flex items-center font-medium text-[10.5px] px-2.5 py-0.5 rounded-full whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** AI output is always labelled */
export function AiBadge({ confidence, className }: { confidence?: number | null; className?: string }) {
  const low = confidence != null && confidence < 0.8
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 font-mono text-[9.5px] px-2 py-0.5 rounded-full border',
        low ? 'border-warn/50 text-warn-ink bg-warn/10' : 'border-stone-300 text-stone-500 bg-paper-2',
        className,
      )}
      title="Generated by AI — always check before it ships"
    >
      AI{confidence != null ? ` · ${Math.round(confidence * 100)}%` : ''}
    </span>
  )
}

// ── Forms ────────────────────────────────────────────────────────────────────

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx('input-base', className)} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx('input-base min-h-24', className)} {...rest} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cx('input-base', className)} {...rest} />
  },
)

export function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string
  children: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <label className={cx('block', className)}>
      <span className="label-base">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-stone-500 mt-1">{hint}</span> : null}
    </label>
  )
}

// ── States ───────────────────────────────────────────────────────────────────

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="text-center py-14 px-6">
      <div className="font-display text-lg text-stone-700">{title}</div>
      {hint ? <div className="text-stone-500 text-[12.5px] mt-1.5 max-w-md mx-auto">{hint}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-control bg-stone-150', className)} />
}

export function LoadingRows({ cols = 4, rows = 6 }: { cols?: number; rows?: number }) {
  return (
    <div className="p-4 space-y-2.5">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="rounded-card border border-danger/30 bg-danger/5 text-danger-ink text-[12.5px] px-4 py-3">
      {message}
    </div>
  )
}

// ── Charts (hand-rolled SVG, per the design) ────────────────────────────────
// mint-700 primary series · cyan-600 secondary · pink highlights the one
// point that matters · indigo gridlines at 12% opacity

export function Sparkline({
  points,
  width = 96,
  height = 28,
  up,
}: {
  /** y values, oldest → newest */
  points: number[]
  width?: number
  height?: number
  /** trend colouring: true = improving (mint), false = declining (stone) */
  up?: boolean
}) {
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const pad = 3
  const coords = points
    .map((v, i) => {
      const x = pad + (i / (points.length - 1)) * (width - pad * 2)
      const y = pad + (1 - (v - min) / range) * (height - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline
        points={coords}
        fill="none"
        stroke={up === false ? '#b3afa3' : '#04b894'}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export { cx }
