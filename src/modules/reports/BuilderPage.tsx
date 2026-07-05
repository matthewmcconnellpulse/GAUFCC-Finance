/**
 * Report builder — period + scope controls over live ledger data, rendering
 * the five builder views: SOFA-style income & expenditure by fund, fund
 * balance movements (table + waterfall), restricted vs unrestricted split,
 * top movements, and the open warning summary.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  PageHeader,
  StatusChip,
  WarningBadge,
  cx,
} from '@/components/ui'
import { formatDate, formatMoney, formatMovement } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { BalanceWaterfall, SplitBar } from './charts'
import { PeriodControls, ReportSectionCard, ScopeControls } from './components'
import {
  FUND_TYPE_LABELS,
  buildReportModel,
  compactMoney,
  fetchReportSources,
  fetchTopMovements,
  periodLabel,
  scopeDescription,
  trackingIdsForFunds,
  type BuilderState,
  type MovementRow,
  type ReportModel,
} from './lib'

const GROUP_HEAD_TEXT: Record<string, string> = {
  restricted: 'text-indigo',
  designated: 'text-cyan-800',
  general: 'text-mint-900',
  dormant: 'text-stone-500',
}

export default function BuilderPage({
  state,
  onChange,
}: {
  state: BuilderState
  onChange: (next: BuilderState) => void
}) {
  const navigate = useNavigate()
  const { isPulse, isCeo } = usePermissions()
  const canBuildPacks = isPulse || isCeo

  const sources = useSupabaseQuery(fetchReportSources, [])
  const model = useMemo(
    () => (sources.data ? buildReportModel(sources.data, state) : null),
    [sources.data, state],
  )

  const movements = useSupabaseQuery<MovementRow[] | null>(async () => {
    if (!sources.data || !model) return null
    const src = sources.data
    const trackingIds =
      state.scope === 'whole_charity' ? null : trackingIdsForFunds(src.tracking, model.scopedFundIds)
    const fundNames = new Map(src.funds.map((f) => [f.id, f.name]))
    return fetchTopMovements(state.period, trackingIds, src.tracking.fundByOption, fundNames)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.data, model, state.period.start, state.period.end, state.scope, state.groupType, state.fundId])

  const subtitle = 'Live views from the ledger — assemble, then take them to a board pack'

  if (sources.loading) {
    return (
      <div>
        <PageHeader title="Report builder" subtitle={subtitle} />
        <Card>
          <LoadingRows cols={5} rows={10} />
        </Card>
      </div>
    )
  }
  if (sources.error) {
    return (
      <div>
        <PageHeader title="Report builder" subtitle={subtitle} />
        <ErrorNotice message={`Report data could not be loaded — ${sources.error}`} />
      </div>
    )
  }
  if (!sources.data || sources.data.balances.length === 0) {
    return (
      <div>
        <PageHeader title="Report builder" subtitle={subtitle} />
        <Card>
          <EmptyState
            title="No funds to report on yet"
            hint="Once the Xero sync has run and Pulse has classified the tracking options, reports build themselves from the live ledger."
          />
        </Card>
      </div>
    )
  }

  const src = sources.data
  const m = model as ReportModel
  const label = periodLabel(state.period)
  const scopeLabel = scopeDescription(state, src.balances.find((b) => b.fund_id === state.fundId)?.name)
  const scopedWarnings = src.warnings.filter((w) => m.scopedFundIds.includes(w.fund_id))

  return (
    <div>
      <PageHeader
        title="Report builder"
        subtitle={subtitle}
        actions={
          canBuildPacks ? (
            <Button variant="primary" onClick={() => navigate('/reports/pack')}>
              Build board pack
            </Button>
          ) : undefined
        }
      />

      {/* Controls */}
      <Card className="px-5 py-4 mb-6">
        <div className="flex flex-col gap-3">
          <PeriodControls value={state.period} onChange={(period) => onChange({ ...state, period })} />
          <ScopeControls state={state} funds={src.balances} onChange={onChange} />
          <p className="text-[11px] text-stone-500">
            Showing {scopeLabel.toLowerCase()} for {label}. Figures are measured on the whole months the period
            touches; transfers between funds are not yet recorded and show as nil.
          </p>
        </div>
      </Card>

      {m.rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing in this scope"
            hint="No funds match the selected scope — widen it or pick another fund group."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryTile label="Opening" value={m.totals.opening} />
            <SummaryTile label="Income" value={m.totals.income} accent="#04b894" />
            <SummaryTile label="Expenditure" value={m.totals.expenditure} accent="#f25cce" />
            <SummaryTile label="Closing" value={m.totals.closing} accent="#211951" strong />
          </div>

          {/* (a) SOFA-style income & expenditure by fund */}
          <ReportSectionCard
            label="View A"
            title="Income & expenditure by fund"
            aside={<span className="text-[11px] text-stone-500 font-mono">{m.fundCount} funds</span>}
          >
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr>
                    <th className="th-register">Fund</th>
                    <th className="th-register text-right">Income</th>
                    <th className="th-register text-right">Expenditure</th>
                    <th className="th-register text-right">Transfers</th>
                    <th className="th-register text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {m.groups.map((g) => (
                    <GroupRows key={g.type} group={g} mode="sofa" />
                  ))}
                  <tr>
                    <td className="td-register border-t-2 border-ink font-semibold text-[12.5px]">Total funds</td>
                    <Num value={m.totals.income} strong />
                    <Num value={-m.totals.expenditure} strong paren />
                    <td className="td-register border-t-2 border-ink text-right font-mono text-[11px] text-stone-400">—</td>
                    <NumSigned value={m.totals.net} strong />
                  </tr>
                </tbody>
              </table>
            </div>
          </ReportSectionCard>

          {/* (b) Fund balance movements — table + waterfall */}
          <ReportSectionCard label="View B" title="Fund balance movements">
            <div className="mb-6 max-w-[720px]">
              <BalanceWaterfall
                data={{
                  opening: m.totals.opening,
                  income: m.totals.income,
                  expenditure: m.totals.expenditure,
                  closing: m.totals.closing,
                }}
              />
            </div>
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr>
                    <th className="th-register">Fund</th>
                    <th className="th-register text-right">Opening</th>
                    <th className="th-register text-right">Income</th>
                    <th className="th-register text-right">Expenditure</th>
                    <th className="th-register text-right">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {m.groups.map((g) => (
                    <GroupRows key={g.type} group={g} mode="movement" />
                  ))}
                  <tr>
                    <td className="td-register border-t-2 border-ink font-semibold text-[12.5px]">Total funds</td>
                    <Num value={m.totals.opening} strong />
                    <Num value={m.totals.income} strong />
                    <Num value={-m.totals.expenditure} strong paren />
                    <Num value={m.totals.closing} strong />
                  </tr>
                </tbody>
              </table>
            </div>
          </ReportSectionCard>

          {/* (c) split + (e) warnings */}
          <div className="grid lg:grid-cols-2 gap-6 items-start">
            <ReportSectionCard label="View C" title="Restricted vs unrestricted">
              <SplitBar restricted={m.split.restricted} unrestricted={m.split.unrestricted} />
              {Math.round(m.split.dormant) !== 0 ? (
                <p className="text-[11px] text-stone-500 mt-3">
                  Dormant funds of <span className="font-mono">{formatMoney(m.split.dormant)}</span> sit outside
                  the split pending review of their restriction status.
                </p>
              ) : null}
              <p className="text-[11.5px] text-stone-700 mt-3 leading-relaxed">
                Restricted funds may only be applied to their stated purposes. Unrestricted funds comprise general
                free reserves and amounts designated by the Board.
              </p>
            </ReportSectionCard>

            <ReportSectionCard
              label="View E"
              title="Warning summary"
              aside={
                scopedWarnings.length > 0 ? (
                  <WarningBadge>{scopedWarnings.length} open</WarningBadge>
                ) : (
                  <StatusChip tone="good">All clear</StatusChip>
                )
              }
            >
              {scopedWarnings.length === 0 ? (
                <EmptyState
                  title="No open warnings"
                  hint="Warning rules are evaluated on every sync — deficits, minimum balances, unusual movements and dormancy."
                />
              ) : (
                <ul className="divide-y divide-stone-150">
                  {scopedWarnings.slice(0, 8).map((w) => (
                    <li key={w.id} className="py-2.5 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[12.5px] text-ink">{w.funds?.name ?? 'Fund'}</div>
                        <div className="text-[11.5px] text-stone-500 mt-0.5">{w.message}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <WarningBadge breached={w.severity === 'red'}>{w.rule.replace(/_/g, ' ')}</WarningBadge>
                        <span className="text-[10px] text-stone-400 font-mono">{formatDate(w.as_of)}</span>
                      </div>
                    </li>
                  ))}
                  {scopedWarnings.length > 8 ? (
                    <li className="py-2.5 text-[11.5px] text-stone-500">
                      and {scopedWarnings.length - 8} more — the full register goes into the pack appendix.
                    </li>
                  ) : null}
                </ul>
              )}
            </ReportSectionCard>
          </div>

          {/* (d) top movements */}
          <ReportSectionCard label="View D" title="Top movements" aside={<span className="text-[11px] text-stone-500">10 largest lines by size</span>}>
            {movements.loading ? (
              <LoadingRows cols={4} rows={5} />
            ) : movements.error ? (
              <ErrorNotice message={`Top movements could not be loaded — ${movements.error}`} />
            ) : !movements.data || movements.data.length === 0 ? (
              <EmptyState title="No transactions in this period" hint="Widen the period, or check the sync has run." />
            ) : (
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr>
                      <th className="th-register">Date</th>
                      <th className="th-register">Detail</th>
                      <th className="th-register">Fund</th>
                      <th className="th-register text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.data.map((mv) => (
                      <tr key={mv.id}>
                        <td className="td-register font-mono text-[11px] text-stone-500 whitespace-nowrap">
                          {formatDate(mv.date)}
                        </td>
                        <td className="td-register text-[12.5px]">
                          {mv.description || mv.contact_name || 'Unnamed line'}
                          {mv.contact_name && mv.description ? (
                            <span className="text-stone-500"> · {mv.contact_name}</span>
                          ) : null}
                        </td>
                        <td className="td-register text-[12px] text-stone-700">{mv.fund_name ?? '—'}</td>
                        <td
                          className={cx(
                            'td-register text-right font-mono text-[11.5px] whitespace-nowrap',
                            mv.net >= 0 ? 'text-mint-900' : 'text-ink',
                          )}
                        >
                          {formatMovement(mv.net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportSectionCard>
        </div>
      )}
    </div>
  )
}

// ── Table pieces ─────────────────────────────────────────────────────────────

function SummaryTile({
  label,
  value,
  accent,
  strong,
}: {
  label: string
  value: number
  accent?: string
  strong?: boolean
}) {
  return (
    <div
      className="bg-white rounded-card px-4 py-3.5 border border-stone-150 shadow-card"
      style={accent ? { borderTop: `2px solid ${accent}` } : undefined}
    >
      <div className="text-[9.5px] font-medium uppercase tracking-[.13em] text-stone-500">{label}</div>
      <div className={cx('font-mono mt-1.5', strong ? 'text-[17px] font-semibold text-ink' : 'text-[16px] text-ink')}>
        {compactMoney(value)}
      </div>
      <div className="font-mono text-[10px] text-stone-400 mt-0.5">{formatMoney(value)}</div>
    </div>
  )
}

function Num({
  value,
  strong,
  paren,
  sub,
}: {
  value: number
  strong?: boolean
  /** always parenthesise (expenditure columns, SOFA convention) */
  paren?: boolean
  /** group subtotal styling */
  sub?: boolean
}) {
  const abs = formatMoney(Math.abs(value))
  const text = (paren && value !== 0) || value < 0 ? `(${abs})` : abs
  return (
    <td
      className={cx(
        'td-register text-right font-mono text-[11px] whitespace-nowrap',
        strong && 'border-t-2 border-ink font-semibold text-ink',
        sub && 'border-t border-indigo/60 font-medium text-indigo',
      )}
    >
      {value === 0 ? '—' : text}
    </td>
  )
}

function NumSigned({ value, strong, sub }: { value: number; strong?: boolean; sub?: boolean }) {
  return (
    <td
      className={cx(
        'td-register text-right font-mono text-[11px] whitespace-nowrap',
        value > 0 ? 'text-mint-900' : value < 0 ? 'text-ink' : 'text-stone-400',
        strong && 'border-t-2 border-ink font-semibold',
        sub && 'border-t border-indigo/60 font-medium',
      )}
    >
      {value === 0 ? '—' : formatMovement(value)}
    </td>
  )
}

function GroupRows({
  group,
  mode,
}: {
  group: ReportModel['groups'][number]
  mode: 'sofa' | 'movement'
}) {
  return (
    <>
      <tr>
        <td
          colSpan={mode === 'sofa' ? 5 : 5}
          className={cx(
            'pt-4 pb-1 px-4 text-[10px] font-medium uppercase tracking-[.13em]',
            GROUP_HEAD_TEXT[group.type],
          )}
        >
          {FUND_TYPE_LABELS[group.type]} funds
        </td>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.fund_id} className="hover:bg-paper-2/60">
          <td className="td-register text-[12.5px]">
            <span className="inline-flex items-center gap-2">
              {r.name}
              {r.flagged ? <WarningBadge>flagged</WarningBadge> : null}
            </span>
          </td>
          {mode === 'sofa' ? (
            <>
              <Num value={r.income} />
              <Num value={-r.expenditure} paren />
              <td className="td-register text-right font-mono text-[11px] text-stone-400">—</td>
              <NumSigned value={r.net} />
            </>
          ) : (
            <>
              <Num value={r.opening} />
              <Num value={r.income} />
              <Num value={-r.expenditure} paren />
              <Num value={r.closing} />
            </>
          )}
        </tr>
      ))}
      <tr>
        <td className="td-register border-t border-indigo/60 font-medium text-indigo text-[12px]">
          Total {FUND_TYPE_LABELS[group.type].toLowerCase()}
        </td>
        {mode === 'sofa' ? (
          <>
            <Num value={group.income} sub />
            <Num value={-group.expenditure} paren sub />
            <td className="td-register border-t border-indigo/60 text-right font-mono text-[11px] text-stone-400">—</td>
            <NumSigned value={group.net} sub />
          </>
        ) : (
          <>
            <Num value={group.opening} sub />
            <Num value={group.income} sub />
            <Num value={-group.expenditure} paren sub />
            <Num value={group.closing} sub />
          </>
        )}
      </tr>
    </>
  )
}
