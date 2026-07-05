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
  Paginator,
  SectionLabel,
  Select,
  Skeleton,
  StatusChip,
  WarningBadge,
  cx,
  type PageSize,
} from '@/components/ui'
import { formatDate, formatMoney, formatMovement } from '@/lib/format'
import { SORP_EXPENDITURE, SORP_INCOME, sorpLabel } from '@/lib/sorp'
import { supabase } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { Fund, SorpCategory, XeroTransaction } from '@/types/db'
import BalanceChart from './BalanceChart'
import FundNotesCard from './FundNotesCard'
import { PeriodSelect } from './components'
import {
  addFundManager,
  buildPl,
  cumulativeBalances,
  fetchAccountMap,
  fetchAssignableProfiles,
  fetchFund,
  fetchFundMonthly,
  fetchOpenWarnings,
  presetRange,
  removeFundManager,
  resolveTrackingOptionIds,
  sourceTypeLabel,
  type FundManagerRow,
  type Period,
  type PlRow,
  type VFundBalance,
} from './lib'

// PostgREST caps a single request at 1,000 rows — "All" walks the result in
// chunks (25k guard is far above any single fund's line count).
const ALL_CHUNK = 1000
const ALL_CAP = 25000

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
  const [pageSize, setPageSize] = useState<PageSize>(25)
  const [classFilter, setClassFilter] = useState<'' | 'REVENUE' | 'EXPENSE'>('')

  useEffect(() => {
    setPage(0)
  }, [period.start, period.end, pageSize, classFilter])

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
    // Income/expenditure filtering happens via the account class: collect the
    // codes of the requested class and constrain the query to them.
    const classCodes =
      classFilter && accounts.data
        ? [...accounts.data.entries()].filter(([, a]) => a.class === classFilter).map(([c]) => c)
        : null
    const buildQuery = () => {
      let q = supabase
        .from('xero_transactions')
        .select('*', { count: 'exact' })
        .in('tracking_option_1_id', ids)
        .gte('date', period.start)
        .lte('date', period.end)
        .order('date', { ascending: false })
        .order('line_id', { ascending: true })
      if (classCodes) q = q.in('account_code', classCodes)
      return q
    }

    if (pageSize === 'all') {
      const rows: XeroTransaction[] = []
      let total = 0
      for (let offset = 0; offset < ALL_CAP; offset += ALL_CHUNK) {
        const { data, error, count } = await buildQuery().range(offset, offset + ALL_CHUNK - 1)
        if (error) throw new Error(error.message)
        total = count ?? total
        rows.push(...((data ?? []) as XeroTransaction[]))
        if (!data || data.length < ALL_CHUNK || rows.length >= total) break
      }
      return { rows, count: total }
    }

    const { data, error, count } = await buildQuery().range(
      page * pageSize,
      page * pageSize + pageSize - 1,
    )
    if (error) throw new Error(error.message)
    return { rows: (data ?? []) as XeroTransaction[], count: count ?? 0 }
  }, [id, period.start, period.end, page, pageSize, classFilter, accounts.data])

  const pl = useMemo(() => {
    if (!plRows.data || plRows.data.unlinked) return null
    return buildPl(plRows.data.rows, accounts.data ?? new Map())
  }, [plRows.data, accounts.data])

  const balanceSeries = useMemo(() => {
    if (!core.data?.fund) return []
    return cumulativeBalances(core.data.monthly, core.data.fund.opening_balance).slice(-36)
  }, [core.data])

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
          <ManagersInline fundId={fund.id} managers={managers} onChanged={core.refetch} />
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
        <div className="px-5 pt-4 flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Transactions</SectionLabel>
          <div className="flex gap-1.5 pb-2">
            {([
              ['', 'All'],
              ['REVENUE', 'Income'],
              ['EXPENSE', 'Expenditure'],
            ] as const).map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setClassFilter(value)}
                className={cx(
                  'rounded-full border px-3 py-1 text-[11px] font-medium transition-colors',
                  classFilter === value
                    ? 'border-indigo bg-indigo text-white'
                    : 'border-stone-300 text-stone-600 hover:bg-paper-2',
                )}
              >
                {label}
              </button>
            ))}
          </div>
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
            <Paginator
              page={page}
              pageSize={pageSize}
              total={txns.data.count}
              shown={txns.data.rows.length}
              onPage={setPage}
              onPageSize={setPageSize}
            />
          </>
        )}
      </Card>

      {/* Notes */}
      <FundNotesCard fundId={fund.id} />
    </div>
  )
}

/**
 * Person responsible — fund_managers chips under the fund title. Everyone
 * sees who is responsible; the Pulse admin assigns and removes (RLS:
 * fund_managers writes are admin-only).
 */
function ManagersInline({
  fundId,
  managers,
  onChanged,
}: {
  fundId: string
  managers: FundManagerRow[]
  onChanged: () => void
}) {
  const { isAdmin } = usePermissions()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const people = useSupabaseQuery(
    () => (isAdmin ? fetchAssignableProfiles() : Promise.resolve([])),
    [isAdmin],
  )
  const assignedIds = new Set(managers.map((m) => m.profile_id))
  const candidates = (people.data ?? []).filter((p) => !assignedIds.has(p.id))

  async function assign(profileId: string) {
    if (!profileId) return
    setBusy(true)
    setError(null)
    try {
      await addFundManager(fundId, profileId)
      setAdding(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The assignment failed')
    } finally {
      setBusy(false)
    }
  }

  async function unassign(profileId: string) {
    setBusy(true)
    setError(null)
    try {
      await removeFundManager(fundId, profileId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The removal failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-stone-500">Responsible —</span>
        {managers.length === 0 ? (
          <span className="text-[11px] text-stone-500">no one assigned</span>
        ) : (
          managers.map((m) => (
            <span
              key={m.profile_id}
              className="inline-flex items-center gap-1 rounded-full bg-indigo/8 border border-indigo/20 px-2.5 py-0.5 text-[11px] text-indigo"
            >
              {m.profiles?.full_name ?? '—'}
              {m.whole_board ? ' (whole board)' : ''}
              {isAdmin ? (
                <button
                  type="button"
                  aria-label={`Remove ${m.profiles?.full_name ?? 'manager'}`}
                  className="text-indigo/60 hover:text-danger-ink"
                  disabled={busy}
                  onClick={() => void unassign(m.profile_id)}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))
        )}
        {isAdmin ? (
          adding ? (
            <Select
              autoFocus
              defaultValue=""
              disabled={busy}
              onChange={(e) => void assign(e.target.value)}
              onBlur={() => setAdding(false)}
              className="!w-auto py-1 text-[11.5px]"
              aria-label="Assign a person responsible"
            >
              <option value="" disabled>
                Choose a person…
              </option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name} ({p.role.replace('_', ' ')})
                </option>
              ))}
            </Select>
          ) : (
            <button
              type="button"
              className="text-[11px] text-indigo underline underline-offset-2"
              onClick={() => setAdding(true)}
            >
              + Assign
            </button>
          )
        ) : null}
      </div>
      {error ? <p className="text-[11px] text-danger-ink mt-1">{error}</p> : null}
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

/** Rows grouped under their SORP (SOFA) heading, headings in statutory order. */
function groupBySorp(
  rows: PlRow[],
  order: SorpCategory[],
): Array<{ key: string; label: string; rows: PlRow[]; total: number }> {
  const byCategory = new Map<string, PlRow[]>()
  for (const row of rows) {
    const key = row.sorp ?? 'unmapped'
    const list = byCategory.get(key)
    if (list) list.push(row)
    else byCategory.set(key, [row])
  }
  const keys: string[] = [...order.filter((c) => byCategory.has(c))]
  if (byCategory.has('unmapped')) keys.push('unmapped')
  return keys.map((key) => {
    const groupRows = byCategory.get(key) ?? []
    return {
      key,
      label: key === 'unmapped' ? 'Unmapped' : sorpLabel(key as SorpCategory),
      rows: groupRows,
      total: groupRows.reduce((s, r) => s + r.amount, 0),
    }
  })
}

function PlTable({ pl }: { pl: ReturnType<typeof buildPl> }) {
  const net = pl.totalIncome - pl.totalExpenditure
  return (
    <div className="text-[12.5px]">
      <PlSection label="Income" rows={pl.income} sorpOrder={SORP_INCOME} total={pl.totalIncome} positive />
      <PlSection label="Expenditure" rows={pl.expenditure} sorpOrder={SORP_EXPENDITURE} total={pl.totalExpenditure} />
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
  sorpOrder,
  total,
  positive = false,
}: {
  label: string
  rows: PlRow[]
  sorpOrder: SorpCategory[]
  total: number
  positive?: boolean
}) {
  const groups = groupBySorp(rows, sorpOrder)
  return (
    <div className="mb-4 last:mb-0">
      <div className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500 pb-1.5 border-b border-stone-150">
        {label}
      </div>
      {groups.length === 0 ? (
        <div className="py-2 text-[11.5px] text-stone-500">None in this period</div>
      ) : (
        groups.map((group) => (
          <div key={group.key}>
            <div className="flex justify-between gap-4 pt-2 pb-0.5">
              <span className="text-[10.5px] font-medium text-indigo/80">{group.label}</span>
              <span className="figure text-[10.5px] text-stone-500 whitespace-nowrap">
                {formatMoney(group.total)}
              </span>
            </div>
            <ul>
              {group.rows.map((r) => (
                <li
                  key={r.account_code}
                  className="flex justify-between gap-4 py-1.5 pl-3 border-b border-paper-3"
                >
                  <span className="text-stone-700 truncate">{r.account_name}</span>
                  <span className="figure text-[11.5px] whitespace-nowrap">{formatMoney(r.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
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
