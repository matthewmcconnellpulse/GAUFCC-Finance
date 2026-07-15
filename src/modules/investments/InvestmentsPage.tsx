/**
 * Financials → Investments — the Epworth portfolios and Cash Plus accounts,
 * charted from the monthly import history: value over time, monthly income by
 * type (fees hang below the baseline), and cumulative gain/loss per account.
 * Account chips filter every chart; colours are keyed to the account, so
 * filtering never repaints the survivors. Each chart has a data-table view.
 *
 * One import = one month of history — the picture builds as each Epworth
 * monthly report is imported (Imports → Epworth).
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, EmptyState, ErrorNotice, LoadingRows, SectionLabel, cx } from '@/components/ui'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { usePermissions } from '@/auth/AuthProvider'
import type { IncomeType } from '@/types/db'
import {
  INCOME_TYPE_LABELS,
  INCOME_TYPE_ORDER,
  fetchInvestmentSeries,
  periodShort,
  round2,
  type InvestmentAccount,
  type InvestmentSeries,
} from './lib'
import {
  ChartTable,
  LegendChips,
  MultiLineChart,
  StackedColumnChart,
  money0,
  seriesColor,
  type ChartSeries,
} from '@/components/charts'

// ── KPI tiles ────────────────────────────────────────────────────────────────

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10.5px] font-medium uppercase tracking-[.08em] text-stone-500">{label}</div>
      <div className="figure text-[22px] font-semibold text-ink mt-1 whitespace-nowrap">{value}</div>
      {hint ? <div className="text-[11px] text-stone-500 mt-0.5">{hint}</div> : null}
    </Card>
  )
}

// ── Chart card (title + legend + chart + table toggle) ───────────────────────

function ChartCard({
  title,
  note,
  labels,
  series,
  kind,
}: {
  title: string
  note?: string
  labels: string[]
  series: ChartSeries[]
  kind: 'columns' | 'lines'
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showTable, setShowTable] = useState(false)
  const visible = series.filter((s) => !hidden.has(s.key))
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="text-[13px] font-medium text-ink">{title}</h3>
          {note ? <p className="text-[11px] text-stone-500 mt-0.5">{note}</p> : null}
        </div>
        <button
          onClick={() => setShowTable((v) => !v)}
          className="text-[11px] text-indigo hover:underline underline-offset-2"
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {series.length > 1 ? (
        <div className="mb-3">
          <LegendChips
            series={series}
            hidden={hidden}
            onToggle={(key) =>
              setHidden((prev) => {
                const next = new Set(prev)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
          />
        </div>
      ) : null}
      {showTable ? (
        <ChartTable labels={labels} series={visible} />
      ) : visible.length === 0 ? (
        <p className="text-[12px] text-stone-500 py-8 text-center">Every series is hidden — toggle one back on.</p>
      ) : kind === 'columns' ? (
        <StackedColumnChart labels={labels} series={visible} ariaLabel={title} />
      ) : (
        <MultiLineChart labels={labels} series={visible} ariaLabel={title} />
      )}
    </Card>
  )
}

// ── The page ─────────────────────────────────────────────────────────────────

export default function InvestmentsPage() {
  const { isPulse } = usePermissions()
  const q = useSupabaseQuery(fetchInvestmentSeries)
  const [hiddenAccounts, setHiddenAccounts] = useState<Set<string>>(new Set())

  const series: InvestmentSeries = q.data ?? { periods: [], accounts: [] }
  const { periods, accounts } = series
  const labels = periods.map((p) => periodShort(p.period))
  const latest = periods[periods.length - 1] ?? null

  const activeAccounts = accounts.filter((a) => !hiddenAccounts.has(a.ref))

  // KPI figures — latest period, filtered accounts.
  const kpis = useMemo(() => {
    if (!latest) return null
    const refs = new Set(activeAccounts.map((a) => a.ref))
    const portfolio = round2(
      Object.entries(latest.closingByRef).reduce((s, [ref, v]) => (refs.has(ref) ? s + v : s), 0),
    )
    const cash = round2(Object.entries(latest.cashByRef).reduce((s, [ref, v]) => (refs.has(ref) ? s + v : s), 0))
    const cumGain = round2(
      Object.entries(latest.cumGainByRef).reduce((s, [ref, v]) => (refs.has(ref) ? s + v : s), 0),
    )
    let monthIncome = 0
    for (const [key, v] of Object.entries(latest.incomeByRefType)) {
      const [ref, type] = key.split('|')
      if (refs.has(ref) && type !== 'unrealised_gain') monthIncome += v
    }
    return { portfolio, cash, cumGain, monthIncome: round2(monthIncome), period: latest.period }
  }, [latest, activeAccounts])

  // Chart 1 — monthly income stacked by type (fees negative, below baseline).
  const incomeSeries: ChartSeries[] = useMemo(() => {
    const refs = new Set(activeAccounts.map((a) => a.ref))
    return INCOME_TYPE_ORDER.map((type, slot) => ({
      key: type,
      label: INCOME_TYPE_LABELS[type],
      slot,
      values: periods.map((p) =>
        round2(
          Object.entries(p.incomeByRefType).reduce((s, [key, v]) => {
            const [ref, t] = key.split('|')
            return refs.has(ref) && t === type ? s + v : s
          }, 0),
        ),
      ),
    })).filter((s) => s.values.some((v) => v !== 0))
  }, [periods, activeAccounts])

  // Chart 2 — cumulative gain/loss per portfolio account.
  const gainSeries: ChartSeries[] = useMemo(
    () =>
      accounts
        .map((a, slot) => ({ account: a, slot }))
        .filter(({ account }) => account.kind === 'portfolio' && !hiddenAccounts.has(account.ref))
        .map(({ account, slot }) => ({
          key: account.ref,
          label: account.name,
          slot,
          values: periods.map((p) => p.cumGainByRef[account.ref] ?? 0),
        }))
        .filter((s) => s.values.some((v) => v !== 0)),
    [accounts, periods, hiddenAccounts],
  )

  // Chart 3 — value over time: portfolio close + cash balance per account.
  const valueSeries: ChartSeries[] = useMemo(
    () =>
      accounts
        .map((a, slot) => ({ account: a, slot }))
        .filter(({ account }) => !hiddenAccounts.has(account.ref))
        .map(({ account, slot }) => ({
          key: account.ref,
          label: account.kind === 'cash' ? `${account.name} (cash)` : account.name,
          slot,
          values: periods.map((p) =>
            account.kind === 'cash' ? (p.cashByRef[account.ref] ?? 0) : (p.closingByRef[account.ref] ?? 0),
          ),
        }))
        .filter((s) => s.values.some((v) => v !== 0)),
    [accounts, periods, hiddenAccounts],
  )

  if (q.loading && !q.data) {
    return (
      <Card>
        <LoadingRows cols={4} rows={8} />
      </Card>
    )
  }
  if (q.error) {
    return <ErrorNotice message={`Investments could not be loaded — ${q.error}`} />
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[26px] text-ink">Investments</h1>
        <p className="text-[12.5px] text-stone-500 mt-1">
          Epworth discretionary portfolios and Cash Plus deposit accounts, built from each month's imported
          report{latest ? ` — latest: ${periodShort(latest.period)}` : ''}.
        </p>
      </div>

      {periods.length === 0 ? (
        <Card>
          <EmptyState
            title="No Epworth reports imported yet"
            hint={
              isPulse
                ? 'Upload the monthly Epworth workbook under Imports → Epworth — each import adds a month to these charts.'
                : 'Once Pulse import the monthly Epworth report, portfolio values, income and gains appear here.'
            }
          />
          {isPulse ? (
            <div className="text-center pb-6 -mt-2">
              <Link to="/imports" className="text-[12px] text-indigo hover:underline underline-offset-2">
                Go to Imports →
              </Link>
            </div>
          ) : null}
        </Card>
      ) : (
        <>
          {/* Account filter — colours keyed to the account, fixed order */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-stone-500 mr-1">Accounts</span>
            {accounts.map((a: InvestmentAccount, slot) => {
              const off = hiddenAccounts.has(a.ref)
              return (
                <button
                  key={a.ref}
                  onClick={() =>
                    setHiddenAccounts((prev) => {
                      const next = new Set(prev)
                      if (next.has(a.ref)) next.delete(a.ref)
                      else next.add(a.ref)
                      return next
                    })
                  }
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    off
                      ? 'border-stone-200 text-stone-400 bg-paper-2'
                      : 'border-stone-300 text-stone-700 hover:bg-paper-2',
                  )}
                  aria-pressed={!off}
                >
                  <span
                    className={cx('w-2.5 h-2.5 rounded-full', off && 'opacity-30')}
                    style={{ background: seriesColor(slot) }}
                    aria-hidden
                  />
                  <span className={cx(off && 'line-through')}>{a.name}</span>
                  {a.kind === 'cash' ? <span className="text-stone-400">· cash</span> : null}
                </button>
              )
            })}
          </div>

          {kpis ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Portfolio value"
                value={money0(kpis.portfolio)}
                hint={`at ${periodShort(kpis.period)} month end`}
              />
              <StatTile label="Cash Plus balance" value={money0(kpis.cash)} hint="deposit accounts" />
              <StatTile
                label="Cumulative gain / loss"
                value={money0(kpis.cumGain)}
                hint="since Epworth's opening valuation"
              />
              <StatTile
                label={`${periodShort(kpis.period)} income`}
                value={money0(kpis.monthIncome)}
                hint="dividends + interest, net of fees"
              />
            </div>
          ) : null}

          <SectionLabel>Charts — all figures £, hover for detail</SectionLabel>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard
              title="Value over time"
              note="Portfolio market value per account, plus Cash Plus balances, at each month end."
              labels={labels}
              series={valueSeries}
              kind="columns"
            />
            <ChartCard
              title="Monthly income by type"
              note="Dividends, interest and gains stack up; management/platform fees hang below the line."
              labels={labels}
              series={incomeSeries}
              kind="columns"
            />
          </div>
          <ChartCard
            title="Cumulative gain / loss per portfolio"
            note="Epworth's running gain/loss since the opening valuation (24 Oct 25) — market movement plus retained income, net of fees."
            labels={labels}
            series={gainSeries}
            kind="lines"
          />

          {periods.length === 1 ? (
            <p className="text-[11.5px] text-stone-500">
              One month imported so far — the trends build automatically as each Epworth monthly report is
              imported{isPulse ? ' under Imports → Epworth' : ''}.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
