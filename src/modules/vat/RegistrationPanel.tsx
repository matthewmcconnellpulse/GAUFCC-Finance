/**
 * The case for and against VAT registration — rolling 12-month taxable
 * turnover against the £90,000 threshold (computed from the Xero mirror where
 * possible, manual figure as fallback), plus a plain-English for/against
 * panel seasoned with this year's calculated numbers. The turnover query is
 * owned by VatPage so the printable one-pager can share it.
 */
import { Card, ErrorNotice, Input, Skeleton, StatusChip } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import type { RollingTurnover } from './lib'
import { ThresholdMeter } from './components'
import { DEREGISTRATION_THRESHOLD, REGISTRATION_THRESHOLD, type VatCalcResult } from './vatCalc'

export default function RegistrationPanel({
  annualResult,
  turnoverData,
  turnoverLoading,
  turnoverError,
  manual,
  onManualChange,
  effectiveTurnover,
}: {
  /** the latest year's aggregate calculation, if one exists */
  annualResult: VatCalcResult | null
  turnoverData: RollingTurnover | null
  turnoverLoading: boolean
  turnoverError: string | null
  manual: string
  onManualChange: (v: string) => void
  /** manual override if valid, otherwise the Xero figure, otherwise null */
  effectiveTurnover: number | null
}) {
  const turnover = effectiveTurnover
  const usingXero = turnover != null && turnover === turnoverData?.total

  const over = turnover != null && turnover > REGISTRATION_THRESHOLD
  const approaching = turnover != null && !over && turnover >= REGISTRATION_THRESHOLD * 0.85

  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-3.5 border-b border-stone-150 flex flex-wrap items-center justify-between gap-2">
        <div className="font-display text-[16px] text-ink">The case for and against VAT registration</div>
        {turnover != null ? (
          over ? (
            <StatusChip tone="danger">Over the threshold — registration is required</StatusChip>
          ) : approaching ? (
            <StatusChip tone="warn">Approaching the threshold</StatusChip>
          ) : (
            <StatusChip tone="neutral">Registration is voluntary</StatusChip>
          )
        ) : null}
      </div>

      <div className="p-5 space-y-4">
        {/* Threshold monitor */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <div className="text-[11px] font-medium uppercase tracking-[.12em] text-stone-500">
              Rolling 12-month taxable turnover
            </div>
            {usingXero ? (
              <span className="text-[10.5px] text-stone-500">
                From the Xero mirror — treats all income as taxable, a deliberately cautious over-count
              </span>
            ) : null}
          </div>
          {turnoverLoading ? (
            <Skeleton className="h-8" />
          ) : turnoverError ? (
            <ErrorNotice message={turnoverError} />
          ) : turnover != null ? (
            <ThresholdMeter value={turnover} threshold={REGISTRATION_THRESHOLD} />
          ) : (
            <p className="text-[12px] text-stone-500">
              No income lines in the Xero mirror for the last 12 months — enter a figure below to monitor the threshold.
            </p>
          )}
          <div className="mt-3 max-w-xs">
            <label className="block">
              <span className="label-base">Manual turnover figure (£) — optional override</span>
              <Input
                inputMode="decimal"
                placeholder="e.g. 45000"
                value={manual}
                onChange={(e) => onManualChange(e.target.value)}
                className="font-mono"
              />
            </label>
          </div>
        </div>

        {/* For / against */}
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-card border border-stone-150 bg-paper p-4">
            <div className="text-[11px] font-medium uppercase tracking-[.12em] text-mint-900 mb-2">The case for registering</div>
            <ul className="space-y-1.5 text-[12px] text-stone-700 leading-relaxed list-disc pl-4">
              {annualResult ? (
                <li>
                  On this year's figures, registration would let the charity recover{' '}
                  <span className="figure font-medium">{formatMoney(annualResult.recoverable)}</span> of input VAT
                  {annualResult.de_minimis_met ? ' — the de minimis tests pass, so all input VAT would come back.' : '.'}
                </li>
              ) : (
                <li>Input VAT on costs becomes recoverable to the extent it supports taxable activity.</li>
              )}
              <li>Zero-rated income (if any) still counts as taxable, so recovery can arise without charging members anything.</li>
              <li>Registering ahead of the threshold avoids a forced, hurried registration later.</li>
              {over ? <li className="text-danger-ink">Turnover is over {formatMoney(REGISTRATION_THRESHOLD, { whole: true })} — registration is a legal requirement, not a choice.</li> : null}
            </ul>
          </div>
          <div className="rounded-card border border-stone-150 bg-paper p-4">
            <div className="text-[11px] font-medium uppercase tracking-[.12em] text-stone-500 mb-2">The case against</div>
            <ul className="space-y-1.5 text-[12px] text-stone-700 leading-relaxed list-disc pl-4">
              <li>VAT would have to be charged on standard-rated income, which may fall on members and hirers.</li>
              {annualResult && !annualResult.de_minimis_met ? (
                <li>
                  The de minimis tests do not pass this year, so{' '}
                  <span className="figure font-medium">{formatMoney(annualResult.irrecoverable)}</span> of input VAT would
                  still be irrecoverable against exempt activity.
                </li>
              ) : null}
              <li>Quarterly returns, partial exemption records and the annual adjustment add a real administrative burden.</li>
              <li>
                Once registered, deregistration is only available if taxable turnover is expected to stay under{' '}
                {formatMoney(DEREGISTRATION_THRESHOLD, { whole: true })}.
              </li>
            </ul>
          </div>
        </div>

        <p className="text-[10.5px] text-stone-500">
          The registration threshold is {formatMoney(REGISTRATION_THRESHOLD, { whole: true })} of taxable turnover in any
          rolling 12-month period (from 1 April 2024). Exempt income does not count towards it. This panel is a monitoring
          aid, not advice — Pulse will confirm the position before any decision goes to the board.
        </p>
      </div>
    </Card>
  )
}
