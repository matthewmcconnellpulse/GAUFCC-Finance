/**
 * The general management reports — the whole-charity pages that sit above the
 * individual fund reports in a board pack.
 *
 * Everything here serialises to standalone HTML (outerHTML → generate-pack),
 * so styling is pk-* classes and inline styles only, never Tailwind.
 *
 * The profit and loss is presented as a statement of financial activities on
 * SORP headings rather than replaying Xero's trading layout, which is both
 * what a charity's trustees should be reading and how gross profit and its
 * margin stay off the page. Debtor days and creditor days are likewise absent
 * by design: the ageing pages show the actual balances and how overdue they
 * are, which is what a decision gets made on.
 *
 * Any page whose source could not be read says so on the page. A board pack
 * that silently omits the debtors is worse than one that states it could not
 * reach Xero.
 */
import type { ReactNode } from 'react'
import { formatDate } from '@/lib/format'
import { BalanceWaterfall } from './charts'
import { compactMoney, sofaFigure, type Period } from './lib'
import type {
  AgedAnalysis,
  AgedBucketKey,
  AgedSide,
  BalanceSheetHeadlines,
  BudgetComparison,
  ReserveCoverage,
} from './management'
import type { WholeBusinessPl } from '@/modules/recon/lib'
import type { PackForecast } from '@/modules/cashflow/lib'
import type { XeroReport, XeroReportRow } from '@/modules/financials/lib'

// ── Shared formatting (SOFA conventions: whole £, brackets for negatives) ───

function fig(v: number): string {
  if (Math.round(Math.abs(v)) === 0) return '—'
  return v < 0 ? `(${sofaFigure(v)})` : sofaFigure(v)
}

function expFig(v: number): string {
  if (Math.round(Math.abs(v)) === 0) return '—'
  return v < 0 ? sofaFigure(Math.abs(v)) : `(${sofaFigure(v)})`
}

function PageHead({ title, pageNum, kicker }: { title: string; pageNum: number; kicker?: string }) {
  return (
    <div className="pk-head">
      <div>
        <div className="pk-h1">{title}</div>
        {kicker ? (
          <div className="pk-kicker" style={{ marginTop: 4 }}>
            {kicker}
          </div>
        ) : null}
      </div>
      <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
    </div>
  )
}

/** Stated on the page when a live source could not be read. */
function SourceUnavailable({ what, reason }: { what: string; reason: string }) {
  return (
    <div className="pk-note" style={{ borderLeft: '2px solid #b86e02', marginTop: 20 }}>
      <b style={{ color: '#8a5200' }}>{what} could not be included</b> — {reason} The rest of this pack is
      unaffected; this page is deliberately left showing the gap rather than omitted.
    </div>
  )
}

export interface ManagementData {
  pl: WholeBusinessPl | null
  plError: string | null
  balanceSheetReport: XeroReport | null
  balanceSheetHeadlines: BalanceSheetHeadlines
  balanceSheetError: string | null
  aged: AgedAnalysis | null
  agedError: string | null
  budget: BudgetComparison | null
  budgetLabel: string | null
  priorBudgetLabel: string | null
  budgetError: string | null
  coverage: ReserveCoverage | null
  forecast: PackForecast | null
  forecastError: string | null
}

// ── Whole-charity statement of financial activities ─────────────────────────

export function ManagementPlPage({
  data,
  period,
  periodLabel,
  pageNum,
  footer,
}: {
  data: ManagementData
  period: Period
  periodLabel: string
  pageNum: number
  footer: ReactNode
}) {
  const pl = data.pl
  return (
    <div className="pk-page">
      <PageHead
        title="Income and expenditure"
        kicker={`Whole charity · ${periodLabel}`}
        pageNum={pageNum}
      />
      {!pl ? (
        <SourceUnavailable
          what="The whole-charity income and expenditure"
          reason={data.plError ?? 'the ledger could not be read.'}
        />
      ) : (
        <>
          <div className="pk-tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="pk-tile" style={{ borderTopColor: '#04b894' }}>
              <div className="pk-tile-label">Total income</div>
              <div className="pk-tile-value">{fig(pl.totalIncome)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#f25cce' }}>
              <div className="pk-tile-label">Total expenditure</div>
              <div className="pk-tile-value">{expFig(pl.totalExpenditure)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#211951' }}>
              <div className="pk-tile-label">{pl.net >= 0 ? 'Surplus' : 'Deficit'}</div>
              <div className="pk-tile-value">{fig(pl.net)}</div>
            </div>
          </div>

          <table className="pk-table" style={{ marginTop: 22 }}>
            <thead>
              <tr>
                <th>Account</th>
                <th className="pk-num" style={{ width: 110 }}>
                  {periodLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="pk-group-head">
                <td colSpan={2} style={{ color: '#036c57' }}>
                  Income
                </td>
              </tr>
              {pl.income.map((group) => (
                <PlGroupRows key={group.key} label={group.label} rows={group.rows} total={group.total} />
              ))}
              <tr className="pk-subtotal">
                <td>Total income</td>
                <td className="pk-num">{fig(pl.totalIncome)}</td>
              </tr>

              <tr className="pk-group-head">
                <td colSpan={2} style={{ color: '#a3348f' }}>
                  Expenditure
                </td>
              </tr>
              {pl.expenditure.map((group) => (
                <PlGroupRows
                  key={group.key}
                  label={group.label}
                  rows={group.rows}
                  total={group.total}
                  expenditure
                />
              ))}
              <tr className="pk-subtotal">
                <td>Total expenditure</td>
                <td className="pk-num">{expFig(pl.totalExpenditure)}</td>
              </tr>

              <tr className="pk-grand">
                <td>Net {pl.net >= 0 ? 'income' : 'expenditure'} for the period</td>
                <td className="pk-num">{fig(pl.net)}</td>
              </tr>
            </tbody>
          </table>

          <div className="pk-footnote" style={{ maxWidth: 560, marginTop: 'auto' }}>
            All figures £, unaudited, on Charities SORP (FRS 102) headings, for the whole charity across all
            funds — {formatDate(period.start)} to {formatDate(period.end)}.{' '}
            {pl.unallocatedNet === 0
              ? 'Every line carries a fund.'
              : `${sofaFigure(Math.abs(pl.unallocatedNet))} of this result carries no fund and is listed on the reconciliation.`}
          </div>
        </>
      )}
      {footer}
    </div>
  )
}

function PlGroupRows({
  label,
  rows,
  total,
  expenditure,
}: {
  label: string
  rows: Array<{ code: string; name: string; amount: number }>
  total: number
  expenditure?: boolean
}) {
  const format = expenditure ? expFig : fig
  return (
    <>
      <tr>
        <td colSpan={2} className="pk-kicker" style={{ paddingTop: 12, paddingBottom: 2, borderBottom: 0 }}>
          {label}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.code}>
          <td style={{ paddingLeft: 16 }}>
            <span className="pk-mono pk-muted" style={{ fontSize: 9.5, marginRight: 8 }}>
              {row.code}
            </span>
            {row.name}
          </td>
          <td className="pk-num">{format(row.amount)}</td>
        </tr>
      ))}
      <tr>
        <td style={{ paddingLeft: 16, fontWeight: 500, color: '#211951' }}>{label} total</td>
        <td className="pk-num pk-strong">{format(total)}</td>
      </tr>
    </>
  )
}

// ── Whole-charity balance sheet (Xero's own layout) ─────────────────────────

export function ManagementBalanceSheetPage({
  data,
  asAt,
  pageNum,
  footer,
}: {
  data: ManagementData
  asAt: string
  pageNum: number
  footer: ReactNode
}) {
  const rows = flattenReportRows(data.balanceSheetReport)
  const h = data.balanceSheetHeadlines
  return (
    <div className="pk-page">
      <PageHead title="Balance sheet" kicker={`Whole charity · as at ${formatDate(asAt)}`} pageNum={pageNum} />
      {rows.length === 0 ? (
        <SourceUnavailable
          what="The balance sheet"
          reason={
            data.balanceSheetError ??
            'Xero returned no balance sheet. The connection needs the accounting.reports.read scope.'
          }
        />
      ) : (
        <>
          <div className="pk-tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="pk-tile" style={{ borderTopColor: '#0d0a26' }}>
              <div className="pk-tile-label">Total assets</div>
              <div className="pk-tile-value">{h.totalAssets === null ? '—' : fig(h.totalAssets)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#f25cce' }}>
              <div className="pk-tile-label">Total liabilities</div>
              <div className="pk-tile-value">{h.totalLiabilities === null ? '—' : expFig(h.totalLiabilities)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#211951' }}>
              <div className="pk-tile-label">Net assets</div>
              <div className="pk-tile-value">{h.netAssets === null ? '—' : fig(h.netAssets)}</div>
            </div>
          </div>
          <table className="pk-table" style={{ marginTop: 22 }}>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className={row.summary ? 'pk-subtotal' : undefined}>
                  <td style={{ paddingLeft: 4 + row.depth * 14, fontWeight: row.section ? 500 : undefined }}>
                    {row.section ? (
                      <span className="pk-kicker">{row.label}</span>
                    ) : (
                      row.label
                    )}
                  </td>
                  <td className="pk-num">{row.value === null ? '' : fig(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pk-footnote" style={{ marginTop: 'auto' }}>
            Rendered as Xero reports it, unaudited. The transaction mirror holds no journal-level data, so the
            balance sheet is read live rather than re-derived — it therefore always agrees with Xero.
          </div>
        </>
      )}
      {footer}
    </div>
  )
}

interface FlatRow {
  label: string
  value: number | null
  depth: number
  summary: boolean
  section: boolean
}

function parseFigure(value: string | undefined): number | null {
  if (!value) return null
  let s = value.trim().replace(/[£,\s]/g, '').replace(/−/g, '-')
  if (!s) return null
  let sign = 1
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1
    s = s.slice(1, -1)
  }
  const n = Number(s)
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null
}

/** Xero's row tree flattened for the printed page, headers dropped. */
function flattenReportRows(report: XeroReport | null, limit = 48): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (rows: XeroReportRow[] | undefined, depth: number) => {
    for (const row of rows ?? []) {
      if (out.length >= limit) return
      if (row.RowType === 'Header') continue
      if (row.RowType === 'Section') {
        if (row.Title) out.push({ label: row.Title, value: null, depth, summary: false, section: true })
        walk(row.Rows, row.Title ? depth + 1 : depth)
        continue
      }
      const label = row.Cells?.[0]?.Value
      if (!label) continue
      out.push({
        label,
        value: parseFigure(row.Cells?.[1]?.Value),
        depth,
        summary: row.RowType === 'SummaryRow',
        section: false,
      })
      if (row.Rows) walk(row.Rows, depth + 1)
    }
  }
  walk(report?.Rows, 0)
  return out
}

// ── Debtors and creditors ───────────────────────────────────────────────────

export function AgedPage({
  data,
  side,
  pageNum,
  footer,
}: {
  data: ManagementData
  side: 'receivables' | 'payables'
  pageNum: number
  footer: ReactNode
}) {
  const aged = data.aged
  const isDebtors = side === 'receivables'
  const title = isDebtors ? 'Debtors' : 'Creditors'
  const analysis: AgedSide | null = aged ? aged[side] : null

  return (
    <div className="pk-page">
      <PageHead
        title={title}
        kicker={aged ? `Outstanding as at ${formatDate(aged.as_at)}` : 'Outstanding'}
        pageNum={pageNum}
      />
      {!analysis ? (
        <SourceUnavailable
          what={`The ${title.toLowerCase()}`}
          reason={data.agedError ?? 'the outstanding invoices could not be read from Xero.'}
        />
      ) : analysis.invoice_count === 0 ? (
        <div className="pk-lede" style={{ marginTop: 18 }}>
          Nothing is outstanding. {isDebtors ? 'No sales invoices are' : 'No bills are'} unpaid at this date.
        </div>
      ) : (
        <>
          <div className="pk-lede" style={{ marginTop: 14, maxWidth: 560 }}>
            {compactMoney(analysis.total)} outstanding across {analysis.invoice_count} invoice
            {analysis.invoice_count === 1 ? '' : 's'} and {analysis.contact_count}{' '}
            {isDebtors ? 'customer' : 'supplier'}
            {analysis.contact_count === 1 ? '' : 's'}
            {analysis.oldest_days > 0
              ? `, the oldest ${analysis.oldest_days} day${analysis.oldest_days === 1 ? '' : 's'} past its due date`
              : ', none of it past its due date'}
            .
          </div>

          <table className="pk-table" style={{ marginTop: 20 }}>
            <thead>
              <tr>
                <th>{isDebtors ? 'Customer' : 'Supplier'}</th>
                {(aged?.buckets ?? []).map((b) => (
                  <th key={b.key} className="pk-num">
                    {b.label}
                  </th>
                ))}
                <th className="pk-num">Total</th>
              </tr>
            </thead>
            <tbody>
              {analysis.contacts.slice(0, 16).map((contact) => (
                <tr key={contact.name}>
                  <td>{contact.name}</td>
                  {(aged?.buckets ?? []).map((b) => (
                    <td key={b.key} className="pk-num">
                      {fig(contact.buckets[b.key as AgedBucketKey] ?? 0)}
                    </td>
                  ))}
                  <td className="pk-num pk-strong">{fig(contact.total)}</td>
                </tr>
              ))}
              {analysis.contacts.length > 16 ? (
                <tr className="pk-subtotal">
                  <td>
                    {analysis.contacts.length - 16} further{' '}
                    {isDebtors ? 'customers' : 'suppliers'}
                  </td>
                  {(aged?.buckets ?? []).map((b) => (
                    <td key={b.key} className="pk-num" style={{ color: '#b3afa3' }}>
                      —
                    </td>
                  ))}
                  <td className="pk-num">
                    {fig(
                      analysis.contacts.slice(16).reduce((s, c) => s + c.total, 0),
                    )}
                  </td>
                </tr>
              ) : null}
              <tr className="pk-grand">
                <td>Total {title.toLowerCase()}</td>
                {(aged?.buckets ?? []).map((b) => (
                  <td key={b.key} className="pk-num">
                    {fig(analysis.buckets[b.key as AgedBucketKey] ?? 0)}
                  </td>
                ))}
                <td className="pk-num">{fig(analysis.total)}</td>
              </tr>
            </tbody>
          </table>

          <div className="pk-footnote" style={{ maxWidth: 560, marginTop: 'auto' }}>
            Read live from Xero at the time this pack was prepared, so it reflects the position on the day
            rather than the last overnight sync. Buckets are days past the invoice due date. Ageing is shown as
            balances rather than as {isDebtors ? 'debtor' : 'creditor'} days, which is what a chase or a payment
            run is actually decided on.
          </div>
        </>
      )}
      {footer}
    </div>
  )
}

// ── Budget tracking ─────────────────────────────────────────────────────────

export function BudgetPage({
  data,
  periodLabel,
  pageNum,
  footer,
}: {
  data: ManagementData
  periodLabel: string
  pageNum: number
  footer: ReactNode
}) {
  const budget = data.budget
  return (
    <div className="pk-page">
      <PageHead
        title="Against budget"
        kicker={`${periodLabel}${data.budgetLabel ? ` · ${data.budgetLabel}` : ''}`}
        pageNum={pageNum}
      />
      {!budget || budget.rows.length === 0 ? (
        <SourceUnavailable
          what="Budget tracking"
          reason={
            data.budgetError ??
            'no budget has been chosen to track against. Pick one under Settings once the figures are in Xero.'
          }
        />
      ) : (
        <>
          <div className="pk-tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="pk-tile" style={{ borderTopColor: '#0d0a26' }}>
              <div className="pk-tile-label">Actual</div>
              <div className="pk-tile-value">{fig(budget.actualTotal)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#16b6ce' }}>
              <div className="pk-tile-label">Budget</div>
              <div className="pk-tile-value">{fig(budget.budgetTotal)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: budget.variance >= 0 ? '#04b894' : '#f25cce' }}>
              <div className="pk-tile-label">Variance</div>
              <div className="pk-tile-value">{fig(budget.variance)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#807c70' }}>
              <div className="pk-tile-label">Last year’s budget</div>
              <div className="pk-tile-value">
                {budget.priorBudgetTotal === null ? '—' : fig(budget.priorBudgetTotal)}
              </div>
            </div>
          </div>

          <table className="pk-table" style={{ marginTop: 22 }}>
            <thead>
              <tr>
                <th>Account</th>
                <th className="pk-num">Actual</th>
                <th className="pk-num">Budget</th>
                <th className="pk-num">Variance</th>
                <th className="pk-num">%</th>
                <th className="pk-num">Last year</th>
              </tr>
            </thead>
            <tbody>
              {budget.rows.slice(0, 22).map((row) => (
                <tr key={row.code}>
                  <td>
                    <span className="pk-mono pk-muted" style={{ fontSize: 9.5, marginRight: 8 }}>
                      {row.code}
                    </span>
                    {row.name}
                  </td>
                  <td className="pk-num">{fig(row.actual)}</td>
                  <td className="pk-num">{fig(row.budget)}</td>
                  <td className="pk-num pk-strong">{fig(row.variance)}</td>
                  <td className="pk-num pk-muted">
                    {row.variancePct === null ? '—' : `${row.variancePct >= 0 ? '+' : '−'}${Math.abs(Math.round(row.variancePct))}%`}
                  </td>
                  <td className="pk-num pk-muted">{row.priorBudget === null ? '—' : fig(row.priorBudget)}</td>
                </tr>
              ))}
              <tr className="pk-grand">
                <td>Total</td>
                <td className="pk-num">{fig(budget.actualTotal)}</td>
                <td className="pk-num">{fig(budget.budgetTotal)}</td>
                <td className="pk-num">{fig(budget.variance)}</td>
                <td className="pk-num"></td>
                <td className="pk-num">
                  {budget.priorBudgetTotal === null ? '—' : fig(budget.priorBudgetTotal)}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="pk-footnote" style={{ maxWidth: 560, marginTop: 'auto' }}>
            Largest variances first.{' '}
            {budget.priorBudgetTotal === null
              ? 'No prior-year budget is set to compare against.'
              : `Last year’s column is ${data.priorBudgetLabel ?? 'the prior budget'}.`}{' '}
            {budget.unbudgeted.length > 0
              ? `${budget.unbudgeted.length} account${budget.unbudgeted.length === 1 ? '' : 's'} carry spend with no budget line at all (${budget.unbudgeted.slice(0, 4).join(', ')}${budget.unbudgeted.length > 4 ? ', …' : ''}) — a gap in the budget rather than a variance.`
              : ''}
          </div>
        </>
      )}
      {footer}
    </div>
  )
}

// ── Reserves, coverage and charts ───────────────────────────────────────────

export function ReservesPage({
  data,
  totals,
  pageNum,
  footer,
}: {
  data: ManagementData
  totals: { opening: number; income: number; expenditure: number; closing: number }
  pageNum: number
  footer: ReactNode
}) {
  const c = data.coverage
  return (
    <div className="pk-page">
      <PageHead title="Reserves and coverage" kicker="Whole charity" pageNum={pageNum} />

      <div className="pk-tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="pk-tile" style={{ borderTopColor: '#036c57' }}>
          <div className="pk-tile-label">General funds</div>
          <div className="pk-tile-value">{c ? fig(c.generalFunds) : '—'}</div>
        </div>
        <div className="pk-tile" style={{ borderTopColor: '#16b6ce' }}>
          <div className="pk-tile-label">Cash at bank</div>
          <div className="pk-tile-value">{c?.cashAtBank === null || !c ? '—' : fig(c.cashAtBank)}</div>
        </div>
        <div className="pk-tile" style={{ borderTopColor: '#211951' }}>
          <div className="pk-tile-label">Reserve coverage</div>
          <div className="pk-tile-value">
            {c?.months === null || !c ? '—' : `${c.months.toFixed(1)} mths`}
          </div>
        </div>
      </div>

      {c && c.ratio !== null && c.numerator !== null && c.annualBudget ? (
        <div className="pk-panel" style={{ marginTop: 20 }}>
          <div className="pk-kicker" style={{ marginBottom: 8 }}>
            How coverage is calculated
          </div>
          <div className="pk-body" style={{ fontSize: 12.5 }}>
            General funds of {sofaFigure(c.generalFunds)} plus cash at bank of{' '}
            {sofaFigure(c.cashAtBank ?? 0)} is {sofaFigure(c.numerator)}, against an annual operating budget of{' '}
            {sofaFigure(c.annualBudget)} — coverage of {c.ratio.toFixed(2)}× annual operating cost, or{' '}
            {(c.months ?? 0).toFixed(1)} months.
          </div>
          <div className="pk-footnote" style={{ marginTop: 8 }}>
            The annual operating budget is{' '}
            {c.budgetSource === 'xero_budget'
              ? 'taken from the budget tracked in Xero'
              : 'the figure recorded on the platform'}
            . General funds means unrestricted general funds only: designated funds are unrestricted but
            earmarked by the Board, and restricted and endowment funds cannot be applied to running costs.
          </div>
        </div>
      ) : (
        <SourceUnavailable
          what="Reserve coverage"
          reason={c?.unavailableReason ?? 'the inputs to the calculation are not all available.'}
        />
      )}

      <div style={{ marginTop: 26 }}>
        <div className="pk-kicker" style={{ marginBottom: 12 }}>
          Where the period moved — whole charity
        </div>
        <BalanceWaterfall
          data={{
            opening: totals.opening,
            income: totals.income,
            expenditure: totals.expenditure,
            closing: totals.closing,
          }}
          width={660}
          responsive={false}
        />
      </div>
      {footer}
    </div>
  )
}

// ── Three-month cash flow forecast ──────────────────────────────────────────

export function ForecastPage({
  data,
  pageNum,
  footer,
}: {
  data: ManagementData
  pageNum: number
  footer: ReactNode
}) {
  const f = data.forecast
  return (
    <div className="pk-page">
      <PageHead
        title="Cash flow forecast"
        kicker={f ? `From the current week · ${f.horizonLabel}` : 'From the current week'}
        pageNum={pageNum}
      />
      {!f ? (
        <SourceUnavailable
          what="The cash flow forecast"
          reason={
            data.forecastError ??
            'the cash flow forecast has not been set up yet. Build it under Financials → Cash flow and it will appear here.'
          }
        />
      ) : (
        <>
          <div className="pk-tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="pk-tile" style={{ borderTopColor: '#0d0a26' }}>
              <div className="pk-tile-label">Opening</div>
              <div className="pk-tile-value">{fig(f.openingBalance)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#04b894' }}>
              <div className="pk-tile-label">Receipts</div>
              <div className="pk-tile-value">{fig(f.totalIncome)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: '#f25cce' }}>
              <div className="pk-tile-label">Payments</div>
              <div className="pk-tile-value">{expFig(f.totalOutgoings)}</div>
            </div>
            <div className="pk-tile" style={{ borderTopColor: f.closingBalance >= 0 ? '#211951' : '#c2185b' }}>
              <div className="pk-tile-label">Closing</div>
              <div className="pk-tile-value">{fig(f.closingBalance)}</div>
            </div>
          </div>

          {f.goesNegativeAt ? (
            <div className="pk-note" style={{ borderLeft: '2px solid #c2185b', marginTop: 18 }}>
              <b style={{ color: '#c2185b' }}>The balance goes negative at {f.goesNegativeAt}</b> — on these
              assumptions the main account runs out during the forecast window. The lowest point is{' '}
              {sofaFigure(f.lowestBalance)}
              {f.lowestAt ? ` at ${f.lowestAt}` : ''}.
            </div>
          ) : (
            <div className="pk-note" style={{ marginTop: 18 }}>
              The main account stays in funds throughout, at its lowest{' '}
              <b>{sofaFigure(f.lowestBalance)}</b>
              {f.lowestAt ? ` at ${f.lowestAt}` : ''}.
            </div>
          )}

          <table className="pk-table" style={{ marginTop: 20 }}>
            <thead>
              <tr>
                <th>Period</th>
                <th className="pk-num">B/fwd</th>
                <th className="pk-num">Receipts</th>
                <th className="pk-num">Payments</th>
                <th className="pk-num">Net</th>
                <th className="pk-num">C/fwd</th>
              </tr>
            </thead>
            <tbody>
              {f.periods.slice(0, 20).map((p, i) => (
                <tr key={`${p.label}-${i}`}>
                  <td className="pk-mono" style={{ fontSize: 10.5 }}>
                    {p.label}
                    {p.kind === 'month' ? <span className="pk-muted"> · month</span> : null}
                  </td>
                  <td className="pk-num pk-muted">{fig(p.balanceBf)}</td>
                  <td className="pk-num">{fig(p.income)}</td>
                  <td className="pk-num">{expFig(p.outgoings)}</td>
                  <td className="pk-num">{fig(p.net)}</td>
                  <td className="pk-num pk-strong" style={{ color: p.balanceCf < 0 ? '#c2185b' : undefined }}>
                    {fig(p.balanceCf)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pk-footnote" style={{ maxWidth: 560, marginTop: 'auto' }}>
            Drawn from the platform's cash flow forecast, which starts at the week in progress and moves with
            the calendar. Completed weeks are excluded but their movements are carried into the opening
            balance. Figures are the accountants' assumptions, not a projection of the ledger.
            {f.topOutgoings.length > 0
              ? ` The largest planned payments are ${f.topOutgoings
                  .slice(0, 3)
                  .map((o) => `${o.name} (${sofaFigure(Math.abs(o.total))})`)
                  .join(', ')}.`
              : ''}
          </div>
        </>
      )}
      {footer}
    </div>
  )
}
