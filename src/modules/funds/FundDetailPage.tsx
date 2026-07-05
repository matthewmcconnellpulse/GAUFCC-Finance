/**
 * Fund detail — period P&L, balance history, transaction drill-down,
 * warnings and notes for a single fund.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  FundTypeChip,
  LoadingRows,
  SectionLabel,
  Skeleton,
  StatusChip,
  Textarea,
  WarningBadge,
} from '@/components/ui'
import { formatDate, formatMoney, formatMovement } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { Fund, XeroTransaction } from '@/types/db'
import BalanceChart from './BalanceChart'
import { PeriodSelect } from './components'
import {
  buildPl,
  cumulativeBalances,
  fetchAccountMap,
  fetchFund,
  fetchFundMonthly,
  fetchOpenWarnings,
  presetRange,
  resolveTrackingOptionIds,
  sourceTypeLabel,
  type FundManagerRow,
  type Period,
  type VFundBalance,
} from './lib'

const PAGE_SIZE = 25

async function fetchBalanceRow(fundId: string): Promise<VFundBalance | null> {
  const { data, error } = await supabase.from('v_fund_balances').select('*').eq('fund_id', fundId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as VFundBalance | null) ?? null
}

async function fetchManagers(fundId: string): Promise<FundManagerRow[]> {
  try {
    const { data, error } = await supabase
      .from('fund_managers')
      .select('profile_id, whole_board, profiles(full_name, email)')
      .eq('fund_id', fundId)
    if (error) return []
    return (data ?? []) as unknown as FundManagerRow[]
  } catch {
    return [] // some roles cannot read the junction — degrade quietly
  }
}

async function fetchTrackingIds(fundId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('funds')
    .select('tracking_option_id')
    .eq('id', fundId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const trackingId = (data as { tracking_option_id: string | null } | null)?.tracking_option_id ?? null
  return resolveTrackingOptionIds(trackingId)
}

export default function FundDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { isPulse } = usePermissions()
  const [period, setPeriod] = useState<Period>(() => ({ preset: 'fy', ...presetRange('fy') }))
  const [page, setPage] = useState(0)

  useEffect(() => {
    setPage(0)
  }, [period.start, period.end])

  const core = useSupabaseQuery(async () => {
    if (!id) return null
    const fund = await fetchFund(id)
    if (!fund) return { fund: null as Fund | null, balanceRow: null, managers: [], warnings: [], monthly: [] }
    const [balanceRow, managers, warnings, monthly] = await Promise.all([
      fetchBalanceRow(id),
      fetchManagers(id),
      fetchOpenWarnings({ fundId: id }),
      fetchFundMonthly({ fundId: id }),
    ])
    return { fund, balanceRow, managers, warnings, monthly }
  }, [id])

  const accounts = useSupabaseQuery(fetchAccountMap, [])

  const plRows = useSupabaseQuery(async () => {
    if (!id) return null
    const ids = await fetchTrackingIds(id)
    if (ids.length === 0) return { rows: [] as Array<Pick<XeroTransaction, 'account_code' | 'net' | 'source_type'>>, unlinked: true }
    const { data, error } = await supabase
      .from('xero_transactions')
      .select('account_code, net, source_type')
      .in('tracking_option_1_id', ids)
      .gte('date', period.start)
      .lte('date', period.end)
    if (error) throw new Error(error.message)
    return {
      rows: (data ?? []) as Array<Pick<XeroTransaction, 'account_code' | 'net' | 'source_type'>>,
      unlinked: false,
    }
  }, [id, period.start, period.end])

  const txns = useSupabaseQuery(async () => {
    if (!id) return null
    const ids = await fetchTrackingIds(id)
    if (ids.length === 0) return { rows: [] as XeroTransaction[], count: 0 }
    const { data, error, count } = await supabase
      .from('xero_transactions')
      .select('*', { count: 'exact' })
      .in('tracking_option_1_id', ids)
      .gte('date', period.start)
      .lte('date', period.end)
      .order('date', { ascending: false })
      .order('line_id', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    return { rows: (data ?? []) as XeroTransaction[], count: count ?? 0 }
  }, [id, period.start, period.end, page])

  const pl = useMemo(() => {
    if (!plRows.data || plRows.data.unlinked) return null
    return buildPl(plRows.data.rows, accounts.data ?? new Map())
  }, [plRows.data, accounts.data])

  const balanceSeries = useMemo(() => {
    if (!core.data?.fund) return []
    return cumulativeBalances(core.data.monthly, core.data.fund.opening_balance).slice(-36)
  }, [core.data])

  // Notes (funds.description) — editable by Pulse only
  const [notes, setNotes] = useState('')
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [notesError, setNotesError] = useState<string | null>(null)
  const description = core.data?.fund?.description ?? ''
  useEffect(() => {
    setNotes(description)
    setNotesState('idle')
  }, [description])

  async function saveNotes() {
    if (!id) return
    setNotesState('saving')
    setNotesError(null)
    const { error } = await supabase
      .from('funds')
      .update({ description: notes.trim() === '' ? null : notes.trim() })
      .eq('id', id)
    if (error) {
      setNotesState('error')
      setNotesError(error.message)
    } else {
      setNotesState('saved')
      core.refetch()
    }
  }

  if (core.loading) {
    return (
      <div>
        <BackLink />
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-10 w-2/3" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      </div>
    )
  }

  if (core.error) {
    return (
      <div>
        <BackLink />
        <ErrorNotice message={`This fund could not be loaded — ${core.error}`} />
      </div>
    )
  }

  const fund = core.data?.fund
  if (!fund) {
    return (
      <div>
        <BackLink />
        <Card>
          <EmptyState
            title="Fund not found"
            hint="This fund does not exist or is not visible to you. Head back to the funds register."
          />
        </Card>
      </div>
    )
  }

  const balanceRow = core.data?.balanceRow ?? null
  const managers = core.data?.managers ?? []
  const warnings = core.data?.warnings ?? []
  const managerNames = managers
    .map((m) => m.profiles?.full_name)
    .filter((n): n is string => Boolean(n))

  return (
    <div>
      <BackLink />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 mb-6">
        <div className="min-w-0 max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <FundTypeChip type={fund.fund_type} />
            {!fund.active ? <StatusChip tone="neutral">Inactive</StatusChip> : null}
            {isPulse && fund.classified_at === null ? <StatusChip tone="warn">Unclassified</StatusChip> : null}
          </div>
          <h1 className="font-display text-[28px] leading-tight text-ink mt-2">{fund.name}</h1>
          {fund.purpose ? <p className="text-[12.5px] text-stone-700 mt-2 leading-relaxed">{fund.purpose}</p> : null}
          <p className="text-[11px] text-stone-500 mt-2">
            {managerNames.length > 0 ? `Fund contact — ${managerNames.join(', ')}` : 'No fund manager linked'}
          </p>
        </div>
        <div className="text-left sm:text-right">
          <div className="font-display font-light text-[36px] text-indigo leading-none figure">
            {balanceRow ? formatMoney(balanceRow.balance) : formatMoney(fund.opening_balance)}
          </div>
          <div className="text-[10.5px] text-stone-500 mt-1">balance at last sync</div>
          <div className="font-mono text-[10.5px] text-stone-500 mt-2">
            opening {formatMoney(fund.opening_balance)}
            {fund.opening_balance_date ? ` at ${formatDate(fund.opening_balance_date)}` : ''}
          </div>
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 ? (
        <Card className="mb-5 !border-warn/50">
          <div className="px-5 py-4">
            <SectionLabel>Open warnings</SectionLabel>
            <ul className="space-y-2">
              {warnings.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-2 text-[12.5px] text-stone-700">
                  <WarningBadge breached={w.severity === 'red'}>{w.rule.replace(/_/g, ' ')}</WarningBadge>
                  <span>{w.message}</span>
                  <span className="text-[11px] text-stone-500">as of {formatDate(w.as_of)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      {/* Period selector */}
      <div className="mb-5">
        <PeriodSelect value={period} onChange={setPeriod} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mb-5">
        {/* P&L */}
        <Card>
          <div className="px-5 py-4">
            <SectionLabel>Income and expenditure</SectionLabel>
            {plRows.loading || accounts.loading ? (
              <LoadingRows cols={2} rows={5} />
            ) : plRows.error ? (
              <ErrorNotice message={`The period figures could not be loaded — ${plRows.error}`} />
            ) : plRows.data?.unlinked ? (
              <EmptyState
                title="Not linked to Xero yet"
                hint="This fund has no tracking option linked, so no transactions can be shown. Pulse can link it from the classification queue."
              />
            ) : pl && (pl.income.length > 0 || pl.expenditure.length > 0) ? (
              <PlTable pl={pl} />
            ) : (
              <EmptyState title="No transactions in this period" hint="Try a wider period." />
            )}
          </div>
        </Card>

        {/* Balance history */}
        <Card>
          <div className="px-5 py-4">
            <SectionLabel>Balance history</SectionLabel>
            {balanceSeries.length >= 2 ? (
              <BalanceChart series={balanceSeries} />
            ) : (
              <EmptyState
                title="Not enough history yet"
                hint="The balance line appears once the fund has movements in at least two months."
              />
            )}
          </div>
        </Card>
      </div>

      {/* Transactions */}
      <Card className="mb-5 overflow-hidden">
        <div className="px-5 pt-4">
          <SectionLabel>Transactions</SectionLabel>
        </div>
        {txns.loading ? (
          <LoadingRows cols={6} rows={8} />
        ) : txns.error ? (
          <div className="px-5 pb-4">
            <ErrorNotice message={`Transactions could not be loaded — ${txns.error}`} />
          </div>
        ) : !txns.data || txns.data.count === 0 ? (
          <EmptyState title="No transactions in this period" hint="Transactions appear here after each Xero sync." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[820px]">
                <thead>
                  <tr>
                    <th className="th-register">Date</th>
                    <th className="th-register">Description</th>
                    <th className="th-register">Contact</th>
                    <th className="th-register">Account</th>
                    <th className="th-register text-right">Net</th>
                    <th className="th-register text-right">VAT</th>
                    <th className="th-register text-right">Gross</th>
                    <th className="th-register">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {txns.data.rows.map((t) => (
                    <tr key={`${t.xero_id}-${t.line_id}`}>
                      <td className="td-register figure text-[11.5px] whitespace-nowrap">{formatDate(t.date)}</td>
                      <td className="td-register text-[12px] text-ink max-w-[280px]">
                        <span className="line-clamp-2">{t.description ?? '—'}</span>
                      </td>
                      <td className="td-register text-[12px] text-stone-700 whitespace-nowrap">
                        {t.contact_name ?? '—'}
                      </td>
                      <td className="td-register text-[12px] text-stone-700 whitespace-nowrap">
                        {accountLabel(t.account_code, accounts.data ?? null)}
                      </td>
                      <td className="td-register text-right figure text-[11.5px]">{formatMoney(t.net)}</td>
                      <td className="td-register text-right figure text-[11.5px] text-stone-500">
                        {formatMoney(t.vat)}
                      </td>
                      <td className="td-register text-right figure text-[11.5px] font-medium">
                        {formatMoney(t.gross)}
                      </td>
                      <td className="td-register">
                        <StatusChip tone="neutral">{sourceTypeLabel(t.source_type)}</StatusChip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t border-stone-150">
              <span className="text-[11px] text-stone-500 figure">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, txns.data.count)} of {txns.data.count}
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={(page + 1) * PAGE_SIZE >= txns.data.count}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Notes */}
      <Card>
        <div className="px-5 py-4">
          <SectionLabel>Notes</SectionLabel>
          {isPulse ? (
            <>
              <Textarea
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value)
                  setNotesState('idle')
                }}
                placeholder="Background, restrictions, correspondence — visible to everyone who can see this fund"
              />
              <div className="flex items-center gap-3 mt-3">
                <Button
                  size="sm"
                  onClick={() => void saveNotes()}
                  disabled={notesState === 'saving' || notes === description}
                >
                  {notesState === 'saving' ? 'Saving…' : 'Save notes'}
                </Button>
                {notesState === 'saved' ? <span className="text-[11.5px] text-mint-900">Saved</span> : null}
                {notesState === 'error' && notesError ? (
                  <span className="text-[11.5px] text-danger-ink">{notesError}</span>
                ) : null}
              </div>
            </>
          ) : description ? (
            <p className="text-[12.5px] text-stone-700 leading-relaxed whitespace-pre-wrap">{description}</p>
          ) : (
            <p className="text-[12px] text-stone-500">No notes have been added for this fund.</p>
          )}
        </div>
      </Card>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/funds"
      className="inline-flex items-center gap-1.5 text-[12px] text-stone-500 hover:text-indigo mb-4"
    >
      <span aria-hidden>←</span> All funds
    </Link>
  )
}

function accountLabel(code: string | null, accounts: Map<string, { name: string; class: string | null }> | null): string {
  if (!code) return '—'
  const name = accounts?.get(code)?.name
  return name ? `${code} · ${name}` : code
}

function PlTable({ pl }: { pl: ReturnType<typeof buildPl> }) {
  const net = pl.totalIncome - pl.totalExpenditure
  return (
    <div className="text-[12.5px]">
      <PlSection label="Income" rows={pl.income} total={pl.totalIncome} positive />
      <PlSection label="Expenditure" rows={pl.expenditure} total={pl.totalExpenditure} />
      <div className="flex justify-between items-center pt-3 mt-3 border-t border-stone-300">
        <span className="font-medium text-ink">Net movement</span>
        <span className={`figure font-medium ${net >= 0 ? 'text-mint-900' : 'text-stone-900'}`}>
          {formatMovement(net)}
        </span>
      </div>
    </div>
  )
}

function PlSection({
  label,
  rows,
  total,
  positive = false,
}: {
  label: string
  rows: ReturnType<typeof buildPl>['income']
  total: number
  positive?: boolean
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500 pb-1.5 border-b border-stone-150">
        {label}
      </div>
      {rows.length === 0 ? (
        <div className="py-2 text-[11.5px] text-stone-500">None in this period</div>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.account_code} className="flex justify-between gap-4 py-1.5 border-b border-paper-3">
              <span className="text-stone-700 truncate">{r.account_name}</span>
              <span className="figure text-[11.5px] whitespace-nowrap">{formatMoney(r.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between pt-1.5">
        <span className="text-stone-500 text-[11px]">Total {label.toLowerCase()}</span>
        <span className={`figure text-[12px] font-medium ${positive ? 'text-mint-900' : 'text-ink'}`}>
          {formatMoney(total)}
        </span>
      </div>
    </div>
  )
}
