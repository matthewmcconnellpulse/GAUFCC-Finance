/**
 * The board pack — paginated A4 pages, print-ready, styled by PACK_CSS.
 * 'The Ledger' (docs/design/1a.html) is the default concept; the concept
 * switch changes the cover treatment while interior pages stay Ledger-style.
 *
 * Everything here must serialise cleanly to standalone HTML (outerHTML →
 * generate-pack), so styling is via pk-* classes and inline styles only —
 * no Tailwind utilities inside this tree.
 */
import type { ReactNode } from 'react'
import type { FundType } from '@/types/db'
import { formatDate, formatDateTime } from '@/lib/format'
import { BalanceLine, BalanceWaterfall, SplitBar } from './charts'
import {
  compactMoney,
  monthKeysInPeriod,
  monthShort,
  sofaFigure,
  trailingMonthKeys,
  balanceSeries,
  topFundMovements,
  FUND_TYPE_LABELS,
  type MonthlyIndex,
  type MovementRow,
  type OpenWarningRow,
  type Period,
  type ReportFundRow,
  type ReportGroup,
  type ReportModel,
  type ReportTotals,
  type SettingsSnapshot,
  type StampInfo,
} from './lib'

import {
  AgedPage,
  BudgetPage,
  ChartsPage,
  ForecastPage,
  ManagementBalanceSheetPage,
  ManagementPlPage,
  ReservesPage,
  type ManagementData,
} from './ManagementPages'

export type PackConcept = 'ledger' | 'waveform' | 'minute'

export const PACK_CONCEPTS: Array<{ value: PackConcept; label: string }> = [
  { value: 'ledger', label: 'The Ledger' },
  { value: 'waveform', label: 'The Waveform' },
  { value: 'minute', label: 'The Minute Book' },
]

export type CommentarySectionKey = 'executive_summary' | 'financials' | 'reserves'

export interface CommentaryState {
  text: string
  /**
   * Always 'human' now — commentary is written by the accountant preparing
   * the pack. The older values are kept in the type only so packs saved
   * before AI drafting was removed still parse.
   */
  source: 'ai' | 'ai_edited' | 'human'
}

export type PackCommentary = Record<CommentarySectionKey, CommentaryState>

export const EMPTY_COMMENTARY: PackCommentary = {
  executive_summary: { text: '', source: 'human' },
  financials: { text: '', source: 'human' },
  reserves: { text: '', source: 'human' },
}

/**
 * Trustee-facing note against one fund, keyed by fund id. Typed by the
 * preparer; AI may be asked to polish what they typed (never to write it from
 * nothing), so `source` records which happened for the builder's benefit. The
 * printed page carries the note plainly either way — by the time a pack is
 * issued a human has read and accepted every word of it.
 */
export type PackFundNotes = Record<string, CommentaryState>

export interface PackInputs {
  title: string
  concept: PackConcept
  period: Period
  periodLabel: string
  scopeLabel: string
  model: ReportModel
  monthlyIndex: MonthlyIndex
  fundPages: ReportFundRow[]
  topMovements: MovementRow[]
  warnings: OpenWarningRow[]
  stamps: StampInfo[]
  settings: SettingsSnapshot
  preparedBy: string
  commentary: PackCommentary
  fundNotes: PackFundNotes
  /**
   * The whole-charity reports that sit above the fund pages. Each field is
   * independently nullable: a pack still assembles when one live source is
   * unreachable, and the page in question says so rather than vanishing.
   */
  management: ManagementData
}

// ── Formatting helpers (SOFA conventions: whole £, expenditure in brackets) ──

function fig(v: number): string {
  if (Math.round(Math.abs(v)) === 0) return '—'
  return v < 0 ? `(${sofaFigure(v)})` : sofaFigure(v)
}

function expFig(v: number): string {
  return Math.round(Math.abs(v)) === 0 ? '—' : `(${sofaFigure(v)})`
}

const CHIP_STYLES: Record<FundType, { background: string; color: string }> = {
  restricted: { background: 'rgba(33,25,81,.09)', color: '#211951' },
  designated: { background: 'rgba(22,182,206,.13)', color: '#0e7c8c' },
  endowment: { background: 'rgba(151,71,255,.12)', color: '#6b2fbf' },
  general: { background: 'rgba(4,184,148,.13)', color: '#036c57' },
  dormant: { background: '#ebe9e3', color: '#807c70' },
}

const GROUP_HEAD_COLOURS: Record<FundType, string> = {
  restricted: '#211951',
  designated: '#0e7c8c',
  endowment: '#6b2fbf',
  general: '#036c57',
  dormant: '#807c70',
}

// ── Pagination plan ──────────────────────────────────────────────────────────

type SofaEntry =
  | { kind: 'group'; type: FundType }
  | { kind: 'fund'; row: ReportFundRow }
  | { kind: 'subtotal'; group: ReportGroup }
  | { kind: 'grand'; totals: ReportTotals }

const SOFA_ROWS_PER_PAGE = 26

function sofaEntries(model: ReportModel): SofaEntry[] {
  const entries: SofaEntry[] = []
  for (const group of model.groups) {
    entries.push({ kind: 'group', type: group.type })
    for (const row of group.rows) entries.push({ kind: 'fund', row })
    entries.push({ kind: 'subtotal', group })
  }
  entries.push({ kind: 'grand', totals: model.totals })
  return entries
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out.length > 0 ? out : [[]]
}

interface TocEntry {
  title: string
  sub?: string
  page: number
}

export default function PackDocument(props: PackInputs) {
  const { model } = props
  const sofaPages = chunk(sofaEntries(model), SOFA_ROWS_PER_PAGE)

  // Page numbering: cover 1 · contents 2 · exec 3 · the whole-charity
  // management reports · then the fund-level pages · integrity · appendix.
  // The management reports come first deliberately: trustees should read the
  // charity's own position before the fund-by-fund detail.
  let page = 3
  const execPage = page
  page += 1
  const managementPlPage = page
  page += 1
  const balanceSheetPage = page
  page += 1
  const debtorsPage = page
  page += 1
  const creditorsPage = page
  page += 1
  const budgetPage = page
  page += 1
  const forecastPage = page
  page += 1
  const reservesPage = page
  page += 1
  const chartsPage = page
  page += 1
  const sofaStart = page
  page += sofaPages.length
  const movementPage = page
  page += 1
  const topMovementPage = page
  page += 1
  const fundStart = page
  page += props.fundPages.length
  const integrityPage = page
  page += 1
  const appendixPage = page
  const totalPages = page

  const toc: TocEntry[] = [
    { title: 'Executive summary', sub: 'The period in brief, with commentary', page: execPage },
    { title: 'Income and expenditure', sub: 'Whole charity, on SORP headings', page: managementPlPage },
    { title: 'Balance sheet', sub: 'Whole charity, as reported by Xero', page: balanceSheetPage },
    { title: 'Debtors', sub: 'Outstanding sales invoices by age', page: debtorsPage },
    { title: 'Creditors', sub: 'Outstanding bills by age', page: creditorsPage },
    { title: 'Against budget', sub: 'This year and last year’s budget', page: budgetPage },
    { title: 'Cash flow forecast', sub: 'From the current week forward', page: forecastPage },
    { title: 'Reserves and coverage', sub: 'Free reserves against annual operating cost', page: reservesPage },
    { title: 'The period in charts', sub: 'Monthly movement, fund split, ageing', page: chartsPage },
    { title: 'Movements by fund', sub: 'SOFA-style income and expenditure', page: sofaStart },
    { title: 'Where the period moved', sub: 'Balance waterfall and reserves split', page: movementPage },
    { title: 'Top ten movements in funds', sub: 'Largest net movements, whichever direction', page: topMovementPage },
    ...props.fundPages.map((f, i) => ({
      title: f.name,
      sub: `${FUND_TYPE_LABELS[f.fund_type]} fund${f.flagged ? ' · flagged this period' : ''}`,
      page: fundStart + i,
    })),
    { title: 'Data integrity', sub: 'Checks and period stamps', page: integrityPage },
    { title: 'Appendix', sub: 'Warnings register and platform settings', page: appendixPage },
  ]

  const footer = (n: number) => (
    <div className="pk-footer">
      <span>GAUFCC · {props.title} · {props.periodLabel}</span>
      <span className="pk-mono">Pulse · p.{String(n).padStart(2, '0')} / {String(totalPages).padStart(2, '0')}</span>
    </div>
  )

  return (
    <div className="pk-root">
      <CoverPage {...props} />
      <ContentsPage toc={toc} footer={footer(2)} />
      <ExecutiveSummaryPage {...props} pageNum={execPage} footer={footer(execPage)} />

      {/* Whole-charity management reports, above the fund reports */}
      <ManagementPlPage
        data={props.management}
        period={props.period}
        periodLabel={props.periodLabel}
        pageNum={managementPlPage}
        footer={footer(managementPlPage)}
      />
      <ManagementBalanceSheetPage
        data={props.management}
        asAt={props.period.end}
        pageNum={balanceSheetPage}
        footer={footer(balanceSheetPage)}
      />
      <AgedPage
        data={props.management}
        side="receivables"
        pageNum={debtorsPage}
        footer={footer(debtorsPage)}
      />
      <AgedPage
        data={props.management}
        side="payables"
        pageNum={creditorsPage}
        footer={footer(creditorsPage)}
      />
      <BudgetPage
        data={props.management}
        periodLabel={props.periodLabel}
        pageNum={budgetPage}
        footer={footer(budgetPage)}
      />
      <ForecastPage data={props.management} pageNum={forecastPage} footer={footer(forecastPage)} />
      <ReservesPage
        data={props.management}
        totals={props.model.totals}
        pageNum={reservesPage}
        footer={footer(reservesPage)}
      />
      <ChartsPage
        data={props.management}
        model={props.model}
        periodLabel={props.periodLabel}
        pageNum={chartsPage}
        footer={footer(chartsPage)}
      />

      {sofaPages.map((entries, i) => (
        <SofaPage
          key={i}
          entries={entries}
          continued={i > 0}
          pageNum={sofaStart + i}
          footer={footer(sofaStart + i)}
        />
      ))}
      <MovementPage {...props} pageNum={movementPage} footer={footer(movementPage)} />
      <TopMovementsPage {...props} pageNum={topMovementPage} footer={footer(topMovementPage)} />
      {props.fundPages.map((f, i) => (
        <FundPage
          key={f.fund_id}
          fund={f}
          inputs={props}
          pageNum={fundStart + i}
          footer={footer(fundStart + i)}
        />
      ))}
      <IntegrityPage {...props} pageNum={integrityPage} footer={footer(integrityPage)} />
      <AppendixPage {...props} pageNum={appendixPage} footer={footer(appendixPage)} />
    </div>
  )
}

// ── Cover (concept switch) ───────────────────────────────────────────────────

function CoverPage(props: PackInputs) {
  const closing = compactMoney(props.model.totals.closing)
  if (props.concept === 'waveform') {
    return (
      <div className="pk-page pk-page--indigo">
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: 'linear-gradient(90deg,#08f2c7,#1de4ff,#ff80e3)' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: "500 13px 'Geist',sans-serif", letterSpacing: '.2em', color: '#fbfaf7' }}>PULSE</span>
          <span className="pk-mono" style={{ fontSize: 10, letterSpacing: '.14em', color: 'rgba(251,250,247,.55)' }}>PRIVATE &amp; CONFIDENTIAL</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div className="pk-mono pk-kicker--mint" style={{ fontSize: 11, letterSpacing: '.2em', marginBottom: 24, color: '#08f2c7' }}>
            BOARD FINANCE PACK
          </div>
          <div className="pk-cover-title">{props.periodLabel}</div>
          <div style={{ font: "400 15px/1.55 'Geist',sans-serif", color: 'rgba(251,250,247,.65)', marginTop: 26, maxWidth: 380 }}>
            General Assembly of Unitarian and Free Christian Churches — fund reporting from the live ledger.
          </div>
        </div>
        <div className="pk-ghost-numeral">{closing.replace('£', '')}</div>
        <div className="pk-cover-grid" style={{ gridTemplateColumns: '1fr auto' }}>
          <div style={{ font: "400 12px/1.6 'Geist',sans-serif", color: 'rgba(251,250,247,.6)' }}>
            Prepared by Pulse Accountants &amp; Tax Advisors<br />for the Board of Trustees
          </div>
          <div className="pk-mono" style={{ fontSize: 12, fontWeight: 500, color: '#08f2c7', alignSelf: 'end' }}>
            {closing} net funds
          </div>
        </div>
      </div>
    )
  }
  if (props.concept === 'minute') {
    return (
      <div className="pk-page pk-page--paper" style={{ padding: 0 }}>
        <div className="pk-frame" />
        <div className="pk-frame-inner" />
        <div style={{ position: 'absolute', inset: '11mm', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '52px 60px', boxSizing: 'border-box' }}>
          <div className="pk-minute-caps">The General Assembly of</div>
          <div className="pk-minute-caps" style={{ color: '#211951', fontSize: 13, marginTop: 8 }}>Unitarian &amp; Free Christian Churches</div>
          <div className="pk-minute-rule" />
          <div style={{ font: "400 44px/1.15 'Fraunces',Georgia,serif", color: '#0d0a26' }}>{props.title}</div>
          <div style={{ font: "italic 400 19px 'Fraunces',Georgia,serif", color: '#4a4740', marginTop: 16 }}>{props.periodLabel}</div>
          <div className="pk-minute-rule" />
          <div style={{ font: "400 12.5px/1.9 'Geist',sans-serif", color: '#4a4740' }}>
            Presented to the Board of Trustees<br />{props.scopeLabel}
          </div>
          <div style={{ marginTop: 'auto' }}>
            <div className="pk-kicker" style={{ letterSpacing: '.22em' }}>Prepared from the ledger by</div>
            <div style={{ font: "500 15px 'Geist',sans-serif", letterSpacing: '.18em', color: '#211951', marginTop: 10 }}>PULSE</div>
            <div className="pk-mono" style={{ fontSize: 10, color: '#807c70', marginTop: 8 }}>Unaudited · Private &amp; confidential</div>
          </div>
        </div>
      </div>
    )
  }
  // The Ledger — default
  return (
    <div className="pk-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 18, borderBottom: '1px solid #211951' }}>
        <span style={{ font: "500 13px 'Geist',sans-serif", letterSpacing: '.2em', color: '#211951' }}>PULSE</span>
        <span className="pk-kicker">Private &amp; confidential</span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div className="pk-kicker pk-kicker--mint" style={{ letterSpacing: '.18em', fontSize: 12, marginBottom: 20 }}>{props.title}</div>
        <div className="pk-cover-title">General Assembly of Unitarian and Free Christian Churches</div>
        <div className="pk-cover-sub" style={{ marginTop: 22 }}>{props.periodLabel}</div>
        <div className="pk-thread" style={{ marginTop: 30 }} />
      </div>
      <div className="pk-cover-grid">
        <div className="pk-cover-cell">
          <div className="pk-kicker">Prepared for</div>
          <div>The Board of Trustees</div>
        </div>
        <div className="pk-cover-cell">
          <div className="pk-kicker">Prepared by</div>
          <div>Pulse Accountants &amp;<br />Tax Advisors Limited</div>
        </div>
        <div className="pk-cover-cell">
          <div className="pk-kicker">Scope</div>
          <div>
            {props.scopeLabel}
            <br />
            <span className="pk-mono" style={{ fontSize: 11 }}>
              {formatDate(props.period.start)} – {formatDate(props.period.end)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Contents ─────────────────────────────────────────────────────────────────

function ContentsPage({ toc, footer }: { toc: TocEntry[]; footer: ReactNode }) {
  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-h1">Contents</div>
        <div className="pk-pagenum">02</div>
      </div>
      <div style={{ marginTop: 18 }}>
        {toc.map((entry, i) => (
          <div key={i} className="pk-toc-row">
            <div>
              <div className="pk-toc-title">{entry.title}</div>
              {entry.sub ? <div className="pk-toc-sub">{entry.sub}</div> : null}
            </div>
            <div className="pk-toc-leader" />
            <div className="pk-toc-page">{String(entry.page).padStart(2, '0')}</div>
          </div>
        ))}
      </div>
      {footer}
    </div>
  )
}

// ── Executive summary ────────────────────────────────────────────────────────

function ExecutiveSummaryPage({
  pageNum,
  footer,
  ...props
}: PackInputs & { pageNum: number; footer: ReactNode }) {
  const t = props.model.totals
  const highlights = props.topMovements.slice(0, 3)
  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-h1">Executive summary</div>
        <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
      </div>
      <div className="pk-kpis">
        <div className="pk-kpi">
          <div className="pk-kpi-label">Net funds</div>
          <div className="pk-kpi-value">{compactMoney(t.closing)}</div>
          <div className={`pk-kpi-sub ${t.net >= 0 ? 'pk-kpi-sub--up' : 'pk-kpi-sub--down'}`}>
            {t.net >= 0 ? '+' : '−'}{compactMoney(Math.abs(t.net)).replace('−', '')} in period
          </div>
        </div>
        <div className="pk-kpi">
          <div className="pk-kpi-label">Income</div>
          <div className="pk-kpi-value">{compactMoney(t.income)}</div>
          <div className="pk-kpi-sub">{props.periodLabel}</div>
        </div>
        <div className="pk-kpi">
          <div className="pk-kpi-label">Expenditure</div>
          <div className="pk-kpi-value">{compactMoney(t.expenditure)}</div>
          <div className="pk-kpi-sub">{props.model.fundCount} funds in scope</div>
        </div>
        <div className="pk-kpi">
          <div className="pk-kpi-label">Funds flagged</div>
          <div className="pk-kpi-value">
            {props.model.flaggedCount}
            <span style={{ fontSize: 18, color: '#807c70' }}> / {props.model.fundCount}</span>
          </div>
          <div className={`pk-kpi-sub ${props.model.flaggedCount > 0 ? 'pk-kpi-sub--down' : ''}`}>
            {props.model.flaggedCount > 0 ? 'itemised in this pack' : 'nothing flagged'}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 30, marginTop: 22, flex: 1, minHeight: 0 }}>
        <div>
          {props.commentary.executive_summary.text ? (
            <>
              <div className="pk-body">{props.commentary.executive_summary.text}</div>
            </>
          ) : (
            <div className="pk-lede">
              Net funds {t.net >= 0 ? 'rose' : 'fell'} {compactMoney(Math.abs(t.net))} over {props.periodLabel},
              from {compactMoney(t.opening)} to {compactMoney(t.closing)}. Income of {compactMoney(t.income)} was
              set against expenditure of {compactMoney(t.expenditure)} across {props.model.fundCount} funds.
            </div>
          )}
        </div>
        <div className="pk-highlights" style={{ alignSelf: 'start' }}>
          <div className="pk-kicker" style={{ marginBottom: 10 }}>Largest movements</div>
          {highlights.length === 0 ? (
            <div className="pk-highlight">No transactions recorded in the period.</div>
          ) : (
            highlights.map((m) => (
              <div key={m.id} className="pk-highlight">
                {m.description || m.contact_name || 'Unnamed line'}
                {m.fund_name ? <span className="pk-muted"> — {m.fund_name}</span> : null}{' '}
                <span className="pk-mono" style={{ fontWeight: 600, fontSize: 11.5, color: m.net >= 0 ? '#036c57' : '#0d0a26' }}>
                  {m.net >= 0 ? '' : '('}{sofaFigure(m.net)}{m.net >= 0 ? '' : ')'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
      {footer}
    </div>
  )
}

// ── SOFA-style movements by fund ─────────────────────────────────────────────

function SofaPage({
  entries,
  continued,
  pageNum,
  footer,
}: {
  entries: SofaEntry[]
  continued: boolean
  pageNum: number
  footer: ReactNode
}) {
  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-h1">Movements by fund{continued ? ' — continued' : ''}</div>
        <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
      </div>
      <table className="pk-table" style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>Fund</th>
            <th className="pk-num">Opening</th>
            <th className="pk-num">Income</th>
            <th className="pk-num">Expenditure</th>
            <th className="pk-num">Transfers</th>
            <th className="pk-num">Net</th>
            <th className="pk-num">Closing</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => {
            if (entry.kind === 'group') {
              return (
                <tr key={i} className="pk-group-head">
                  <td colSpan={7} style={{ color: GROUP_HEAD_COLOURS[entry.type] }}>
                    {FUND_TYPE_LABELS[entry.type]} funds
                  </td>
                </tr>
              )
            }
            if (entry.kind === 'fund') {
              const r = entry.row
              return (
                <tr key={r.fund_id}>
                  <td>{r.name}{r.flagged ? <span style={{ color: '#b86e02' }} title="Flagged this period"> ⚑</span> : null}</td>
                  <td className="pk-num">{fig(r.opening)}</td>
                  <td className="pk-num">{fig(r.income)}</td>
                  <td className="pk-num">{expFig(r.expenditure)}</td>
                  <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
                  <td className="pk-num">{fig(r.net)}</td>
                  <td className="pk-num pk-strong">{fig(r.closing)}</td>
                </tr>
              )
            }
            if (entry.kind === 'subtotal') {
              const g = entry.group
              return (
                <tr key={`sub-${g.type}`} className="pk-subtotal">
                  <td>Total {FUND_TYPE_LABELS[g.type].toLowerCase()}</td>
                  <td className="pk-num">{fig(g.opening)}</td>
                  <td className="pk-num">{fig(g.income)}</td>
                  <td className="pk-num">{expFig(g.expenditure)}</td>
                  <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
                  <td className="pk-num">{fig(g.net)}</td>
                  <td className="pk-num">{fig(g.closing)}</td>
                </tr>
              )
            }
            const t = entry.totals
            return (
              <tr key="grand" className="pk-grand">
                <td>Total funds</td>
                <td className="pk-num">{fig(t.opening)}</td>
                <td className="pk-num">{fig(t.income)}</td>
                <td className="pk-num">{expFig(t.expenditure)}</td>
                <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
                <td className="pk-num">{fig(t.net)}</td>
                <td className="pk-num">{fig(t.closing)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="pk-footnote">
        All figures £, unaudited, drawn from the Xero ledger via the platform's nightly sync. Transfers between
        funds are not yet recorded on the platform and are shown as nil.
      </div>
      {footer}
    </div>
  )
}

// ── Movements & reserves (waterfall + split) ─────────────────────────────────

function MovementPage({
  pageNum,
  footer,
  ...props
}: PackInputs & { pageNum: number; footer: ReactNode }) {
  const t = props.model.totals
  const split = props.model.split
  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-h1">Where the period moved</div>
        <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
      </div>
      <div className="pk-lede" style={{ marginTop: 14, maxWidth: 520 }}>
        Funds in scope moved from {compactMoney(t.opening)} to {compactMoney(t.closing)} over {props.periodLabel} —
        income of {compactMoney(t.income)} against expenditure of {compactMoney(t.expenditure)}.
      </div>
      <div style={{ marginTop: 24 }}>
        <BalanceWaterfall
          data={{ opening: t.opening, income: t.income, expenditure: t.expenditure, closing: t.closing }}
          width={660}
          responsive={false}
        />
      </div>
      <div style={{ marginTop: 30 }}>
        <div className="pk-kicker" style={{ marginBottom: 12 }}>Closing funds — restricted vs unrestricted</div>
        <SplitBar restricted={split.restricted} unrestricted={split.unrestricted} />
        {Math.round(split.dormant) !== 0 ? (
          <div className="pk-footnote">
            Dormant funds of {compactMoney(split.dormant)} are held outside the split above pending review of
            their restriction status.
          </div>
        ) : null}
      </div>
      {props.commentary.reserves.text ? (
        <div style={{ marginTop: 24 }}>
          <div className="pk-body">{props.commentary.reserves.text}</div>
        </div>
      ) : (
        <div className="pk-footnote" style={{ maxWidth: 540 }}>
          Restricted funds may only be applied to their stated purposes. Unrestricted funds comprise general free
          reserves and amounts designated by the Board.
        </div>
      )}
      {props.commentary.financials.text ? (
        <div className="pk-note" style={{ marginTop: 'auto' }}>
          <b style={{ color: '#211951' }}>Note on the figures</b> — {props.commentary.financials.text}
        </div>
      ) : null}
      {footer}
    </div>
  )
}

// ── Top ten movements by fund ────────────────────────────────────────────────

/**
 * The ten funds that moved most this period. Ranked on the absolute net
 * movement so a fund that spent heavily is as prominent as one that took money
 * in — which is the point of the page: it is where the trustees' attention goes
 * first, ahead of the fund-by-fund detail.
 */
function TopMovementsPage({
  pageNum,
  footer,
  ...props
}: PackInputs & { pageNum: number; footer: ReactNode }) {
  const top = topFundMovements(props.model, 10)
  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-h1">Top ten movements in funds</div>
        <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
      </div>
      <div className="pk-lede" style={{ marginTop: 14, maxWidth: 560 }}>
        {top.rows.length === 0
          ? `No fund moved over ${props.periodLabel}.`
          : `The ${top.rows.length} fund${top.rows.length === 1 ? '' : 's'} with the largest net movement over ${props.periodLabel}, ranked by size of movement regardless of direction.`}
      </div>
      <table className="pk-table" style={{ marginTop: 20 }}>
        <thead>
          <tr>
            <th style={{ width: 26 }} className="pk-num">#</th>
            <th>Fund</th>
            <th className="pk-num">Opening</th>
            <th className="pk-num">Income</th>
            <th className="pk-num">Expenditure</th>
            <th className="pk-num">Net</th>
            <th className="pk-num">Closing</th>
            <th className="pk-num">On opening</th>
          </tr>
        </thead>
        <tbody>
          {top.rows.map((r, i) => (
            <tr key={r.fund_id}>
              <td className="pk-num pk-muted">{i + 1}</td>
              <td>
                {r.name}
                {r.flagged ? <span style={{ color: '#b86e02' }} title="Flagged this period"> ⚑</span> : null}
                <span className="pk-chip" style={{ ...CHIP_STYLES[r.fund_type], marginLeft: 8, fontSize: 8.5, padding: '2px 7px', verticalAlign: 1 }}>
                  {FUND_TYPE_LABELS[r.fund_type]}
                </span>
              </td>
              <td className="pk-num">{fig(r.opening)}</td>
              <td className="pk-num">{fig(r.income)}</td>
              <td className="pk-num">{expFig(r.expenditure)}</td>
              <td className="pk-num pk-strong" style={{ color: r.net >= 0 ? '#036c57' : '#0d0a26' }}>{fig(r.net)}</td>
              <td className="pk-num">{fig(r.closing)}</td>
              <td className="pk-num pk-muted">
                {r.pctOfOpening === null ? '—' : `${r.pctOfOpening >= 0 ? '+' : '−'}${Math.abs(Math.round(r.pctOfOpening))}%`}
              </td>
            </tr>
          ))}
          {top.restCount > 0 ? (
            <tr className="pk-subtotal">
              <td className="pk-num pk-muted"></td>
              <td>
                {top.restCount} further fund{top.restCount === 1 ? '' : 's'} with movement in the period
              </td>
              <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
              <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
              <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
              <td className="pk-num">{fig(top.restNet)}</td>
              <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
              <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
            </tr>
          ) : null}
          <tr className="pk-grand">
            <td className="pk-num"></td>
            <td>Net movement, all funds</td>
            <td className="pk-num" style={{ color: '#b3afa3' }}>—</td>
            <td className="pk-num">{fig(props.model.totals.income)}</td>
            <td className="pk-num">{expFig(props.model.totals.expenditure)}</td>
            <td className="pk-num">{fig(top.totalNet)}</td>
            <td className="pk-num">{fig(props.model.totals.closing)}</td>
            <td className="pk-num"></td>
          </tr>
        </tbody>
      </table>
      <div className="pk-footnote" style={{ maxWidth: 560 }}>
        Funds with no movement in the period are excluded from this ranking; they carry forward unchanged and
        appear in full on the movements pages. &quot;On opening&quot; is the net movement as a share of the fund&apos;s
        opening balance, and is shown as — where the fund opened at nil. The ranked rows and the further funds
        together reconcile to the net movement on all funds.
      </div>
      {footer}
    </div>
  )
}

// ── Per-fund pages ───────────────────────────────────────────────────────────

function FundPage({
  fund,
  inputs,
  pageNum,
  footer,
}: {
  fund: ReportFundRow
  inputs: PackInputs
  pageNum: number
  footer: ReactNode
}) {
  const endKey = inputs.period.end.slice(0, 7)
  const startKey = inputs.period.start.slice(0, 7)
  const windowKeys = trailingMonthKeys(endKey, 12)
  const series = balanceSeries(fund, inputs.monthlyIndex, startKey, windowKeys)
  const labels = windowKeys.map((k) => monthShort(k).toUpperCase())
  const fundMonths = inputs.monthlyIndex.get(fund.fund_id)
  const periodKeys = monthKeysInPeriod(inputs.period)
  const recentKeys = periodKeys.slice(-6)
  const fundWarnings = inputs.warnings.filter((w) => w.fund_id === fund.fund_id)
  const chip = CHIP_STYLES[fund.fund_type]
  const lo = Math.min(...series)
  const hi = Math.max(...series)
  const note = inputs.fundNotes[fund.fund_id]?.text.trim() ?? ''

  return (
    <div className="pk-page">
      <div className="pk-head">
        <div>
          <span className="pk-h1">{fund.name}</span>
          <span className="pk-chip" style={chip}>{FUND_TYPE_LABELS[fund.fund_type]}</span>
        </div>
        <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
      </div>
      {fund.purpose || fund.description ? (
        <div className="pk-purpose">{fund.purpose ?? fund.description}</div>
      ) : null}
      <div className="pk-tiles">
        <div className="pk-tile" style={{ borderTopColor: '#0d0a26' }}>
          <div className="pk-tile-label">Opening</div>
          <div className="pk-tile-value">{fig(fund.opening)}</div>
        </div>
        <div className="pk-tile" style={{ borderTopColor: '#04b894' }}>
          <div className="pk-tile-label">Income</div>
          <div className="pk-tile-value">{fig(fund.income)}</div>
        </div>
        <div className="pk-tile" style={{ borderTopColor: '#f25cce' }}>
          <div className="pk-tile-label">Expenditure</div>
          <div className="pk-tile-value">{expFig(fund.expenditure)}</div>
        </div>
        <div className="pk-tile" style={{ borderTopColor: '#211951' }}>
          <div className="pk-tile-label">Closing</div>
          <div className="pk-tile-value">{fig(fund.closing)}</div>
        </div>
      </div>
      {series.length >= 2 ? (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div className="pk-kicker">Balance, trailing twelve months</div>
            <div className="pk-mono" style={{ fontSize: 10, color: '#807c70' }}>
              {compactMoney(lo)} – {compactMoney(hi)}
            </div>
          </div>
          <BalanceLine values={series} labels={labels} width={660} height={120} responsive={false} />
        </div>
      ) : null}
      <div style={{ marginTop: 22, flex: 1, minHeight: 0 }}>
        <div className="pk-kicker" style={{ paddingBottom: 8, borderBottom: '1px solid #211951' }}>
          Movement by month — most recent
        </div>
        <table className="pk-table">
          <tbody>
            {recentKeys.map((key) => {
              const m = fundMonths?.get(key)
              const income = m?.income ?? 0
              const expenditure = m?.expenditure ?? 0
              return (
                <tr key={key}>
                  <td style={{ width: 90 }} className="pk-mono pk-muted" >{monthShort(key)}</td>
                  <td className="pk-num">{fig(income)}</td>
                  <td className="pk-num">{expFig(expenditure)}</td>
                  <td className="pk-num pk-strong">{fig(income - expenditure)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {fundWarnings.length > 0 ? (
          <div className="pk-note">
            <b style={{ color: '#8a5200' }}>Flagged this period</b> —{' '}
            {fundWarnings.map((w) => w.message).join('; ')}
          </div>
        ) : null}
        {note ? (
          <div className="pk-note" style={{ borderLeft: '2px solid #211951' }}>
            <b style={{ color: '#211951' }}>Note on this fund</b> — {note}
          </div>
        ) : null}
      </div>
      {footer}
    </div>
  )
}

// ── Data integrity ───────────────────────────────────────────────────────────

function IntegrityPage({
  pageNum,
  footer,
  ...props
}: PackInputs & { pageNum: number; footer: ReactNode }) {
  const flagged = props.model.rows.filter((r) => r.flagged)
  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-h1">Data integrity</div>
        <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
      </div>
      <div className="pk-lede" style={{ marginTop: 14 }}>
        Every figure in this pack is drawn from Xero via the platform's nightly sync. Before a period is released
        to trustees, four automated checks must pass and a member of the Pulse team stamps the month complete.
      </div>
      <div style={{ marginTop: 20 }}>
        <div className="pk-check-row" style={{ borderBottom: '1px solid #211951', paddingBottom: 8 }}>
          <div />
          <div className="pk-kicker" style={{ letterSpacing: '.12em', fontSize: 9 }}>Month</div>
          <div className="pk-kicker pk-check-status" style={{ letterSpacing: '.12em', fontSize: 9 }}>Status</div>
        </div>
        {props.stamps.map((s) => (
          <div key={s.period} className="pk-check-row">
            {s.stamped ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#04b894" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b86e02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </svg>
            )}
            <div>
              <div style={{ font: "400 13px 'Geist',sans-serif", color: '#2b2925' }}>{monthShort(s.period)}</div>
              {s.stamped ? (
                <div style={{ font: "400 10.5px 'Geist',sans-serif", color: '#807c70', marginTop: 2 }}>
                  Checks complete — stamped by {s.stampedByName} · <span className="pk-mono">{formatDateTime(s.stampedAt)}</span>
                </div>
              ) : (
                <div style={{ font: "400 10.5px 'Geist',sans-serif", color: '#8a5200', marginTop: 2 }}>
                  Not yet stamped — figures for this month may still move.
                </div>
              )}
            </div>
            <div className="pk-check-status" style={{ color: s.stamped ? '#036c57' : '#b86e02' }}>
              {s.stamped ? 'Complete' : 'Open'}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, display: 'flex', gap: 14 }}>
        <div className="pk-panel" style={{ flex: 1 }}>
          <div className="pk-kicker">Prepared by</div>
          <div style={{ font: "400 13px 'Geist',sans-serif", color: '#0d0a26', marginTop: 8 }}>{props.preparedBy}</div>
          <div style={{ font: "400 11px 'Geist',sans-serif", color: '#4a4740', marginTop: 2 }}>Pulse Accountants &amp; Tax Advisors</div>
        </div>
        <div className="pk-panel" style={{ flex: 1 }}>
          <div className="pk-kicker">Flagged funds this period</div>
          <div style={{ font: "400 11.5px/1.7 'Geist',sans-serif", color: '#2b2925', marginTop: 8 }}>
            {flagged.length === 0
              ? 'No funds carry open warnings.'
              : flagged.slice(0, 6).map((f) => <div key={f.fund_id}>{f.name}</div>)}
            {flagged.length > 6 ? <div className="pk-muted">and {flagged.length - 6} more — see the appendix.</div> : null}
          </div>
        </div>
      </div>
      {footer}
    </div>
  )
}

// ── Appendix ─────────────────────────────────────────────────────────────────

function AppendixPage({
  pageNum,
  footer,
  ...props
}: PackInputs & { pageNum: number; footer: ReactNode }) {
  const warnings = props.warnings
    .filter((w) => props.model.scopedFundIds.includes(w.fund_id))
    .slice(0, 14)
  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-h1">Appendix</div>
        <div className="pk-pagenum">{String(pageNum).padStart(2, '0')}</div>
      </div>
      <div style={{ marginTop: 18 }}>
        <div className="pk-kicker" style={{ paddingBottom: 8, borderBottom: '1px solid #211951' }}>
          Open warnings register
        </div>
        {warnings.length === 0 ? (
          <div className="pk-lede" style={{ marginTop: 12 }}>No open warnings for the funds in scope.</div>
        ) : (
          <table className="pk-table">
            <tbody>
              {warnings.map((w) => (
                <tr key={w.id}>
                  <td style={{ width: 170 }}>{w.funds?.name ?? 'Fund'}</td>
                  <td className="pk-muted" style={{ width: 110, textTransform: 'capitalize' }}>{w.rule.replace(/_/g, ' ')}</td>
                  <td>{w.message}</td>
                  <td className="pk-mono pk-muted" style={{ width: 80, textAlign: 'right', fontSize: 10 }}>{formatDate(w.as_of)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ marginTop: 28 }}>
        <div className="pk-kicker" style={{ paddingBottom: 8, borderBottom: '1px solid #211951' }}>
          Platform settings at time of issue
        </div>
        <table className="pk-table">
          <tbody>
            <tr>
              <td>Expense approval deadline</td>
              <td className="pk-num pk-strong">day {props.settings.approvalDay} of the month</td>
            </tr>
            <tr>
              <td>Payment run</td>
              <td className="pk-num pk-strong">day {props.settings.paymentRunDay} of the month</td>
            </tr>
            <tr>
              <td>Ledger sync</td>
              <td className="pk-num pk-strong">nightly, 04:00 UK</td>
            </tr>
            <tr>
              <td>Scope of this pack</td>
              <td className="pk-num pk-strong">{props.scopeLabel}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="pk-footnote" style={{ marginTop: 24 }}>
        This pack was assembled on the GAUFCC Finance Platform by Pulse Accountants &amp; Tax Advisors Limited.
        Figures are unaudited and drawn from the live Xero ledger. The commentary was written and reviewed by
        a named member of staff before issue.
      </div>
      {footer}
    </div>
  )
}
