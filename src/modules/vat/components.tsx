/**
 * VAT module components — trustee-friendly cards, pass/fail chips with plain
 * English, the standard-method working table and small shared bits. Module
 * owned; shared primitives come from src/components/ui.tsx.
 */
import type { ReactNode } from 'react'
import { Card, cx } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import type { VatCalcResult } from './vatCalc'

// ── Stat cards ───────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  accent?: 'mint' | 'stone' | 'warn'
}) {
  return (
    <Card className="px-5 py-4">
      <div className="text-[10px] font-medium uppercase tracking-[.14em] text-stone-500">{label}</div>
      <div
        className={cx(
          'figure text-[22px] mt-1.5 leading-none',
          accent === 'mint' && 'text-mint-900',
          accent === 'warn' && 'text-warn-ink',
          (accent === 'stone' || !accent) && 'text-ink',
        )}
      >
        {value}
      </div>
      {sub ? <div className="text-[11px] text-stone-500 mt-1.5">{sub}</div> : null}
    </Card>
  )
}

// ── Pass/fail chip ───────────────────────────────────────────────────────────

export function PassChip({ pass }: { pass: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 font-medium text-[10.5px] px-2.5 py-0.5 rounded-full whitespace-nowrap',
        pass ? 'bg-mint-700/15 text-mint-900' : 'bg-warn/15 text-warn-ink',
      )}
    >
      {pass ? 'Pass' : 'Not met'}
    </span>
  )
}

/** Deterministic Xero prefills are estimates, not gospel — label them so. */
export function EstimateChip() {
  return (
    <span className="inline-flex items-center font-mono text-[9.5px] px-2 py-0.5 rounded-full border border-warn/50 text-warn-ink bg-warn/10">
      Estimate — confirm before saving
    </span>
  )
}

// ── De minimis tests panel ───────────────────────────────────────────────────

interface TestRow {
  name: string
  pass: boolean
  line: string
}

export function testRows(r: VatCalcResult): TestRow[] {
  const limit = formatMoney(r.de_minimis_limit)
  const avgLine = `£625 a month over ${r.months} ${r.months === 1 ? 'month' : 'months'} = ${limit}`
  return [
    {
      name: 'Simplified test 1',
      pass: r.test1_pass,
      line: `Total input VAT was ${formatMoney(r.total_input_vat)} against a limit of ${avgLine}, and exempt supplies were ${r.exempt_supplies_share_pct.toFixed(1)}% of all supplies (limit 50%).`,
    },
    {
      name: 'Simplified test 2',
      pass: r.test2_pass,
      line: `Input VAT less the part directly attributable to taxable activity was ${formatMoney(round0safe(r.total_input_vat - r.taxable_input_vat + r.residual_taxable))} against the same ${limit} limit, with the same 50% supplies condition.`,
    },
    {
      name: 'Main test',
      pass: r.main_test_pass,
      line: `Exempt input VAT came to ${formatMoney(r.exempt_input_vat)} — the limit is ${limit} and no more than 50% of total input VAT (it was ${r.exempt_share_pct.toFixed(1)}%).`,
    },
  ]
}

function round0safe(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

export function DeMinimisPanel({ result }: { result: VatCalcResult }) {
  const rows = testRows(result)
  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-3.5 border-b border-stone-150 flex flex-wrap items-center justify-between gap-2">
        <div className="font-display text-[16px] text-ink">De minimis tests</div>
        <span
          className={cx(
            'inline-flex items-center font-medium text-[10.5px] px-2.5 py-0.5 rounded-full',
            result.de_minimis_met ? 'bg-mint-700/15 text-mint-900' : 'bg-warn/15 text-warn-ink',
          )}
        >
          {result.de_minimis_met ? 'De minimis — all input VAT recoverable' : 'De minimis not met'}
        </span>
      </div>
      <p className="px-5 pt-3 text-[11.5px] text-stone-500">
        Passing any one of the three routes is enough (VAT Notice 706, section 11).
      </p>
      <div className="px-5 py-3 space-y-2.5">
        {rows.map((t) => (
          <div key={t.name} className="flex items-start gap-3">
            <PassChip pass={t.pass} />
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-ink">{t.name}</div>
              <div className="text-[11.5px] text-stone-500 leading-relaxed">{t.line}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── Standard-method working table ────────────────────────────────────────────

export function WorkingTable({ result, compact }: { result: VatCalcResult; compact?: boolean }) {
  const rows: Array<{ label: string; value: string; strong?: boolean }> = [
    {
      label: 'Taxable supplies ÷ total supplies',
      value:
        result.total_supplies > 0
          ? `${result.recovery_pct}% (rounded up to the whole percent)`
          : '100% — no supplies recorded this period',
    },
    { label: 'Input VAT directly attributable to taxable activity', value: formatMoney(result.taxable_input_vat - result.residual_taxable) },
    { label: 'Input VAT directly attributable to exempt activity', value: formatMoney(result.exempt_input_vat - result.residual_exempt) },
    { label: 'Residual (mixed-use) input VAT', value: formatMoney(result.residual_taxable + result.residual_exempt) },
    { label: `Residual apportioned to taxable (${result.recovery_pct}%)`, value: formatMoney(result.residual_taxable) },
    { label: 'Residual apportioned to exempt', value: formatMoney(result.residual_exempt) },
    { label: 'Total input VAT', value: formatMoney(result.total_input_vat), strong: true },
    { label: 'Exempt input VAT', value: formatMoney(result.exempt_input_vat), strong: true },
    { label: `De minimis limit for the period (${result.months} × £625)`, value: formatMoney(result.de_minimis_limit) },
  ]
  return (
    <div className="overflow-x-auto">
      <table className={cx('w-full', compact ? 'text-[11px]' : 'text-[12px]', 'min-w-[380px]')}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className={cx('td-register', r.strong && 'font-medium text-ink')}>{r.label}</td>
              <td className={cx('td-register figure text-right whitespace-nowrap', r.strong && 'font-semibold')}>
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Threshold meter (registration monitor) ──────────────────────────────────

export function ThresholdMeter({
  value,
  threshold,
}: {
  value: number
  threshold: number
}) {
  const pct = Math.max(0, Math.min(1, value / threshold))
  const over = value > threshold
  const approaching = !over && pct >= 0.85
  return (
    <div>
      <div className="h-2.5 rounded-full bg-stone-150 overflow-hidden" role="presentation">
        <div
          className={cx(
            'h-full rounded-full transition-all',
            over ? 'bg-danger' : approaching ? 'bg-warn' : 'bg-cyan-600',
          )}
          style={{ width: `${Math.max(2, pct * 100)}%` }}
        />
      </div>
      <div className="flex justify-between text-[10.5px] text-stone-500 mt-1.5">
        <span className="figure">{formatMoney(value, { whole: true })}</span>
        <span className="figure">{Math.round(pct * 100)}% of {formatMoney(threshold, { whole: true })}</span>
      </div>
    </div>
  )
}
