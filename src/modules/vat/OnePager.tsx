/**
 * Printable one-pager for board packs — hidden on screen, shown by print CSS.
 * High-end annual report styling: white paper, Fraunces headings, hairline
 * rules, mono figures. The rest of the app carries print:hidden / .no-print.
 */
import { formatDate, formatMoney } from '@/lib/format'
import type { VatPeriod } from '@/types/db'
import { testRows, WorkingTable } from './components'
import {
  periodLabel,
  REGISTRATION_THRESHOLD,
  type AnnualAdjustment,
  type VatCalcResult,
} from './vatCalc'

export default function OnePager({
  period,
  result,
  yearRows,
  yearAdjustment,
  turnover,
  narrative,
}: {
  period: VatPeriod
  result: VatCalcResult
  yearRows: Array<{ period: string; result: VatCalcResult }>
  yearAdjustment: AnnualAdjustment | null
  turnover: number | null
  narrative: string
}) {
  const tests = testRows(result)
  return (
    <div className="hidden print:block bg-white text-ink">
      {/* Masthead */}
      <div className="border-b border-stone-300 pb-4 mb-5">
        <div className="text-[10px] uppercase tracking-[.18em] text-stone-500">
          General Assembly of Unitarian and Free Christian Churches
        </div>
        <h1 className="font-display text-[28px] font-normal mt-1">VAT partial exemption — {periodLabel(period.period)}</h1>
        <div className="text-[10.5px] text-stone-500 mt-1">
          Prepared by Pulse Accountants · printed {formatDate(new Date())} · VAT Notice 706 standard method
        </div>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-3 gap-4 mb-5">
        <div className="border border-stone-150 rounded-card p-4">
          <div className="text-[9.5px] uppercase tracking-[.14em] text-stone-500">Recoverable input VAT</div>
          <div className="font-mono text-[20px] mt-1">{formatMoney(result.recoverable)}</div>
        </div>
        <div className="border border-stone-150 rounded-card p-4">
          <div className="text-[9.5px] uppercase tracking-[.14em] text-stone-500">Irrecoverable input VAT</div>
          <div className="font-mono text-[20px] mt-1">{formatMoney(result.irrecoverable)}</div>
        </div>
        <div className="border border-stone-150 rounded-card p-4">
          <div className="text-[9.5px] uppercase tracking-[.14em] text-stone-500">De minimis</div>
          <div className="font-display text-[18px] mt-1">{result.de_minimis_met ? 'Met' : 'Not met'}</div>
        </div>
      </div>

      {/* Narrative */}
      {narrative ? (
        <div className="mb-5">
          <h2 className="font-display text-[16px] mb-1.5">In plain English</h2>
          <p className="text-[11.5px] leading-relaxed whitespace-pre-wrap">{narrative}</p>
        </div>
      ) : null}

      {/* Tests */}
      <div className="mb-5">
        <h2 className="font-display text-[16px] mb-1.5">De minimis tests — one pass is enough</h2>
        <table className="w-full text-[10.5px]">
          <tbody>
            {tests.map((t) => (
              <tr key={t.name} className="border-t border-stone-150">
                <td className="py-1.5 pr-3 font-medium whitespace-nowrap align-top">{t.name}</td>
                <td className="py-1.5 pr-3 align-top">{t.line}</td>
                <td className="py-1.5 text-right font-mono whitespace-nowrap align-top">{t.pass ? 'Pass' : 'Not met'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Working */}
      <div className="mb-5">
        <h2 className="font-display text-[16px] mb-1.5">Standard method working</h2>
        <WorkingTable result={result} compact />
      </div>

      {/* Year view */}
      {yearRows.length > 1 ? (
        <div className="mb-5">
          <h2 className="font-display text-[16px] mb-1.5">The year so far</h2>
          <table className="w-full text-[10.5px]">
            <thead>
              <tr className="border-b border-stone-300 text-left text-stone-500 uppercase tracking-[.1em] text-[8.5px]">
                <th className="py-1 pr-3">Period</th>
                <th className="py-1 pr-3 text-right">Input VAT</th>
                <th className="py-1 pr-3 text-right">Exempt input VAT</th>
                <th className="py-1 pr-3 text-right">Recoverable</th>
                <th className="py-1 text-right">De minimis</th>
              </tr>
            </thead>
            <tbody>
              {yearRows.map((r) => (
                <tr key={r.period} className="border-t border-stone-150">
                  <td className="py-1.5 pr-3">{periodLabel(r.period)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{formatMoney(r.result.total_input_vat)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{formatMoney(r.result.exempt_input_vat)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{formatMoney(r.result.recoverable)}</td>
                  <td className="py-1.5 text-right">{r.result.de_minimis_met ? 'Met' : 'Not met'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {yearAdjustment ? (
            <p className="text-[10px] text-stone-500 mt-2">
              Annual adjustment: recalculating the year as one period gives recoverable VAT of{' '}
              {formatMoney(yearAdjustment.annual.recoverable)} against {formatMoney(yearAdjustment.periodsRecoverable)}{' '}
              claimed period by period — an adjustment of {formatMoney(yearAdjustment.adjustment)}.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Registration footnote */}
      <div className="border-t border-stone-300 pt-3 text-[10px] text-stone-500">
        Registration threshold monitor: rolling 12-month taxable turnover{' '}
        {turnover != null ? (
          <span className="font-mono text-ink">{formatMoney(turnover, { whole: true })}</span>
        ) : (
          'not yet computable from Xero'
        )}{' '}
        against the {formatMoney(REGISTRATION_THRESHOLD, { whole: true })} threshold. GAUFCC is not currently VAT
        registered; these figures show what registration would mean. Prepared for discussion, not filed with HMRC.
      </div>
    </div>
  )
}
