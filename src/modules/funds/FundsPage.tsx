/**
 * Funds overview — the Assembly's ~60 funds, live from Xero tracking
 * categories. Register (table) and cards (grouped by type) views per the
 * 1d/1e design references.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  FundTypeChip,
  LoadingRows,
  PageHeader,
  Sparkline,
  StatusChip,
  WarningBadge,
  cx,
} from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { FundType } from '@/types/db'
import { Segmented } from './components'
import {
  ATTENTION_HINTS,
  ATTENTION_LABELS,
  FUND_TYPE_ACCENTS,
  FUND_TYPE_BLURBS,
  FUND_TYPE_ORDER,
  FUND_TYPE_ROW_ACCENTS,
  fetchFundBalances,
  fetchFundManagerCounts,
  fetchFundMonthly,
  fetchOpenFundWarnings,
  fundAttention,
  groupWarningsByFund,
  isoDate,
  lastMonthKeys,
  sparklineByFund,
  type AttentionKey,
  type VFundBalance,
} from './lib'

type ViewMode = 'register' | 'cards'
type TypeFilter = 'all' | FundType

export type SortKey = 'name' | 'type' | 'balance' | 'income' | 'spend'
export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: SortKey
  dir: SortDir
}

/**
 * The direction a column opens on when first clicked. Money and counts open
 * largest-first because that is the question being asked of them; a name opens
 * A–Z.
 */
const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  type: 'asc',
  balance: 'desc',
  income: 'desc',
  spend: 'desc',
}

/**
 * Fund names begin with their ledger number — "104 Restricted funds – …" —
 * so they collate numerically, otherwise 112 would sort before 15. Type sorts
 * by FUND_TYPE_ORDER rather than alphabetically, so restricted funds lead as
 * they do everywhere else in the app. Spend is compared on magnitude: a credit
 * against an expenditure account is stored negative, and sorting "largest
 * spend" should not put those at the top.
 */
function compareFunds(a: VFundBalance, b: VFundBalance, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, 'en-GB', { numeric: true, sensitivity: 'base' })
    case 'type': {
      const order = FUND_TYPE_ORDER.indexOf(a.fund_type) - FUND_TYPE_ORDER.indexOf(b.fund_type)
      return order !== 0 ? order : a.name.localeCompare(b.name, 'en-GB', { numeric: true })
    }
    case 'balance':
      return a.balance - b.balance
    case 'income':
      return a.ytd_income - b.ytd_income
    case 'spend':
      return Math.abs(a.ytd_expenditure) - Math.abs(b.ytd_expenditure)
  }
}

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'restricted', label: 'Restricted' },
  { value: 'endowment', label: 'Endowment' },
  { value: 'designated', label: 'Designated' },
  { value: 'general', label: 'General' },
  { value: 'dormant', label: 'Dormant' },
]

const TYPE_LABELS: Record<FundType, string> = {
  restricted: 'Restricted',
  designated: 'Designated',
  endowment: 'Endowment',
  general: 'General',
  dormant: 'Dormant',
}

export default function FundsPage() {
  const navigate = useNavigate()
  const { isPulse, isCeo, isTrustee } = usePermissions()
  const [view, setView] = useState<ViewMode>('register')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [search, setSearch] = useState('')
  const [showDormant, setShowDormant] = useState(false)
  // Which attention reasons are selected. Empty = no attention filter. More
  // than one narrows to funds matching ALL of them, which is how you find
  // "in deficit AND nobody responsible".
  const [attention, setAttention] = useState<Set<AttentionKey>>(new Set())
  // Balance, largest first — the order the register has always opened in.
  const [sort, setSort] = useState<SortState>({ key: 'balance', dir: 'desc' })

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: SORT_DEFAULT_DIR[key] },
    )
  }

  const balances = useSupabaseQuery(fetchFundBalances, [])
  const warningsQ = useSupabaseQuery(fetchOpenFundWarnings, [])
  // fund_managers RLS shows a trustee only their own rows, so asking as a
  // trustee would make every other fund look unowned. Don't ask.
  const canSeeOwnership = isPulse || isCeo
  const managersQ = useSupabaseQuery(
    () => (canSeeOwnership ? fetchFundManagerCounts() : Promise.resolve(null)),
    [canSeeOwnership],
  )
  const trendMonths = useMemo(() => lastMonthKeys(12), [])
  const monthly = useSupabaseQuery(() => {
    const now = new Date()
    return fetchFundMonthly({ since: isoDate(new Date(now.getFullYear(), now.getMonth() - 11, 1)) })
  }, [])

  const sparklines = useMemo(
    () => sparklineByFund(monthly.data ?? [], trendMonths),
    [monthly.data, trendMonths],
  )

  const funds = balances.data ?? []

  const warningsByFund = useMemo(
    () => groupWarningsByFund(warningsQ.data ?? []),
    [warningsQ.data],
  )
  const attentionByFund = useMemo(() => {
    const map = new Map<string, Set<AttentionKey>>()
    for (const f of funds) {
      map.set(f.fund_id, fundAttention(f, warningsByFund, managersQ.data ?? null))
    }
    return map
  }, [funds, warningsByFund, managersQ.data])

  // Type, search and dormant filters only — the counts on the attention chips
  // are taken from this, so each chip says how many funds it would show rather
  // than how many exist overall.
  const inScope = useMemo(() => {
    const q = search.trim().toLowerCase()
    return funds.filter((f) => {
      if (typeFilter === 'all') {
        if ((f.fund_type === 'dormant' || !f.active) && !showDormant) return false
      } else if (f.fund_type !== typeFilter) {
        return false
      }
      if (q && !f.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [funds, typeFilter, search, showDormant])

  const attentionCounts = useMemo(() => {
    const counts = new Map<AttentionKey, number>()
    for (const f of inScope) {
      for (const key of attentionByFund.get(f.fund_id) ?? []) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }, [inScope, attentionByFund])

  // Chips are offered only where something can match, so the row does not fill
  // with reasons that never apply to this charity's funds.
  const attentionOptions = useMemo(() => {
    const order: AttentionKey[] = [
      'any',
      'serious',
      'deficit',
      'dormancy',
      'min_balance',
      'unusual_movement',
      'unowned',
      'unclassified',
    ]
    return order.filter((key) => {
      if (key === 'unclassified' && !isPulse) return false
      return (attentionCounts.get(key) ?? 0) > 0 || attention.has(key)
    })
  }, [attentionCounts, attention, isPulse])

  const visible = useMemo(() => {
    if (attention.size === 0) return inScope
    return inScope.filter((f) => {
      const keys = attentionByFund.get(f.fund_id)
      if (!keys) return false
      for (const wanted of attention) if (!keys.has(wanted)) return false
      return true
    })
  }, [inScope, attention, attentionByFund])

  function toggleAttention(key: AttentionKey) {
    setAttention((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Sorted here rather than inside the register so the cards view orders
  // within its groups the same way.
  const sorted = useMemo(() => {
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...visible].sort((a, b) => {
      const cmp = compareFunds(a, b, sort.key) * factor
      // A stable tie-break, so equal figures never shuffle between renders.
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name, 'en-GB', { numeric: true })
    })
  }, [visible, sort])

  const unclassified = funds.filter((f) => f.classified_at === null).length

  if (balances.loading) {
    return (
      <div>
        <PageHeader title="Funds" subtitle="The Assembly's funds, live from Xero tracking categories" />
        <Card>
          <LoadingRows cols={5} rows={10} />
        </Card>
      </div>
    )
  }

  if (balances.error) {
    return (
      <div>
        <PageHeader title="Funds" subtitle="The Assembly's funds, live from Xero tracking categories" />
        <ErrorNotice message={`Funds could not be loaded — ${balances.error}`} />
      </div>
    )
  }

  if (funds.length === 0) {
    return (
      <div>
        <PageHeader title="Funds" subtitle="The Assembly's funds, live from Xero tracking categories" />
        <Card>
          <EmptyState
            title={isTrustee ? 'No funds are linked to you yet' : 'No funds yet'}
            hint={
              isPulse
                ? 'Funds appear here after the first Xero sync. Connect Xero under Settings, then use Refresh now in the top bar.'
                : isTrustee
                  ? 'Trustees see the funds Pulse links to them — ask Pulse to assign your funds (or whole-board access) and they will appear here.'
                  : 'Once Pulse connects Xero and runs the first sync, the funds you can see will appear here.'
            }
            action={
              isPulse ? (
                <Button variant="ghost" onClick={() => navigate('/settings')}>
                  Go to settings
                </Button>
              ) : undefined
            }
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Funds"
        subtitle={`${funds.length} funds, live from Xero tracking categories`}
        actions={
          isPulse ? (
            <Button variant="ghost" size="sm" onClick={() => navigate('/funds/integrity')}>
              Data integrity
              {unclassified > 0 ? (
                <span className="font-mono text-[10px] bg-warn/20 text-warn-ink rounded-full px-1.5">
                  {unclassified}
                </span>
              ) : null}
            </Button>
          ) : undefined
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map((fl) => (
            <button
              key={fl.value}
              onClick={() => setTypeFilter(fl.value)}
              className={cx(
                'px-3.5 py-1.5 rounded-full border text-[11.5px] font-medium transition-colors',
                typeFilter === fl.value
                  ? 'bg-indigo text-paper border-indigo'
                  : 'bg-white text-stone-500 border-stone-300 hover:text-indigo',
              )}
            >
              {fl.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search funds"
          aria-label="Search funds"
          className="input-base !w-52 !rounded-full !py-1.5 text-[12px]"
        />
        <label className="flex items-center gap-2 text-[11.5px] text-stone-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDormant}
            onChange={(e) => setShowDormant(e.target.checked)}
            className="accent-[#211951]"
          />
          Show dormant
        </label>
        <div className="ml-auto">
          <Segmented<ViewMode>
            options={[
              { value: 'register', label: 'Register' },
              { value: 'cards', label: 'Cards' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      {/* Needs attention — filter by what actually triggered */}
      {attentionOptions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 mb-4 -mt-1">
          <span className="text-[10.5px] font-medium uppercase tracking-[.12em] text-stone-500">
            Needs attention
          </span>
          {attentionOptions.map((key) => {
            const count = attentionCounts.get(key) ?? 0
            const on = attention.has(key)
            const serious = key === 'serious' || key === 'deficit'
            return (
              <button
                key={key}
                onClick={() => toggleAttention(key)}
                aria-pressed={on}
                title={ATTENTION_HINTS[key]}
                className={cx(
                  'inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11.5px] font-medium transition-colors',
                  on
                    ? serious
                      ? 'bg-danger-ink text-paper border-danger-ink'
                      : 'bg-indigo text-paper border-indigo'
                    : serious
                      ? 'bg-white text-danger-ink border-danger/40 hover:border-danger-ink'
                      : 'bg-white text-stone-500 border-stone-300 hover:text-indigo',
                )}
              >
                {ATTENTION_LABELS[key]}
                <span
                  className={cx(
                    'font-mono text-[10px] rounded-full px-1.5',
                    on ? 'bg-white/20' : 'bg-stone-150 text-stone-500',
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
          {attention.size > 0 ? (
            <button
              onClick={() => setAttention(new Set())}
              className="text-[11.5px] text-stone-500 hover:text-indigo underline underline-offset-2"
            >
              clear
            </button>
          ) : null}
          {attention.size > 1 ? (
            <span className="text-[11px] text-stone-500">
              showing funds matching all {attention.size} reasons
            </span>
          ) : null}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            title="No funds match"
            hint={
              attention.size > 0
                ? 'No fund has every reason you have selected. Try one reason at a time.'
                : 'Try a different filter or clear the search.'
            }
            action={
              attention.size > 0 ? (
                <Button variant="ghost" onClick={() => setAttention(new Set())}>
                  Clear the attention filter
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : view === 'register' ? (
        <RegisterView
          funds={sorted}
          sparklines={sparklines}
          isPulse={isPulse}
          attentionByFund={attentionByFund}
          sort={sort}
          onSort={toggleSort}
          onOpen={(id) => navigate(`/funds/${id}`)}
        />
      ) : (
        <CardsView funds={sorted} sparklines={sparklines} onOpen={(id) => navigate(`/funds/${id}`)} />
      )}
    </div>
  )
}

// ── Register (1d) ────────────────────────────────────────────────────────────

/**
 * Reasons worth a chip on the row, worst first. 'any' and 'serious' are
 * roll-ups used by the filter and would only repeat what the specific reasons
 * already say, so they are left out here.
 */
const REASON_CHIP_ORDER: AttentionKey[] = [
  'deficit',
  'min_balance',
  'unusual_movement',
  'dormancy',
  'unowned',
  'unclassified',
]

/**
 * A sortable column heading.
 *
 * The whole cell is the button so the hit target is the column heading rather
 * than just its text, and aria-sort carries the state for a screen reader —
 * the arrow alone would not.
 */
function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
  className,
}: {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (key: SortKey) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const active = sort.key === sortKey
  return (
    <th
      className={cx('th-register p-0', className)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cx(
          'w-full flex items-center gap-1 px-4 py-2.5 hover:text-indigo transition-colors',
          align === 'right' ? 'justify-end' : 'justify-start',
          active && 'text-indigo',
        )}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <span aria-hidden className={cx('text-[9px] leading-none', active ? 'opacity-100' : 'opacity-25')}>
          {active && sort.dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  )
}

function RegisterView({
  funds,
  sparklines,
  isPulse,
  attentionByFund,
  sort,
  onSort,
  onOpen,
}: {
  funds: VFundBalance[]
  sparklines: Map<string, number[]>
  isPulse: boolean
  attentionByFund: Map<string, Set<AttentionKey>>
  sort: SortState
  onSort: (key: SortKey) => void
  onOpen: (id: string) => void
}) {
  const total = funds.reduce((s, f) => s + f.balance, 0)
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[760px]">
          <thead>
            <tr>
              <SortableTh label="Fund" sortKey="name" sort={sort} onSort={onSort} />
              <SortableTh label="Type" sortKey="type" sort={sort} onSort={onSort} />
              <SortableTh label="Balance" sortKey="balance" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="YTD income" sortKey="income" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="YTD spend" sortKey="spend" sort={sort} onSort={onSort} align="right" />
              <th className="th-register text-right">12-mo trend</th>
            </tr>
          </thead>
          <tbody>
            {funds.map((f) => {
              const points = sparklines.get(f.fund_id) ?? []
              return (
                <tr
                  key={f.fund_id}
                  onClick={() => onOpen(f.fund_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpen(f.fund_id)
                  }}
                  tabIndex={0}
                  className="cursor-pointer hover:bg-paper-2 focus:bg-paper-2 focus:outline-none transition-colors"
                >
                  <td
                    className="td-register"
                    style={{ borderLeft: `3px solid ${FUND_TYPE_ROW_ACCENTS[f.fund_type]}` }}
                  >
                    <div className="font-medium text-[13px] text-ink">{f.name}</div>
                    <div className="flex flex-wrap gap-1.5 mt-1 empty:hidden">
                      {/* Named reasons rather than a bare count — "1 warning"
                          tells nobody what to do about it. */}
                      {REASON_CHIP_ORDER.filter(
                        (key) =>
                          attentionByFund.get(f.fund_id)?.has(key) &&
                          // Classification is Pulse's own housekeeping, not
                          // something to show a trustee.
                          (key !== 'unclassified' || isPulse),
                      ).map(
                        (key) =>
                          key === 'deficit' || key === 'min_balance' ? (
                            <WarningBadge key={key}>{ATTENTION_LABELS[key]}</WarningBadge>
                          ) : (
                            <StatusChip key={key} tone={key === 'unclassified' ? 'warn' : 'neutral'}>
                              {ATTENTION_LABELS[key]}
                            </StatusChip>
                          ),
                      )}
                    </div>
                  </td>
                  <td className="td-register">
                    <FundTypeChip type={f.fund_type} />
                  </td>
                  <td className="td-register text-right figure text-[13px] font-medium text-ink">
                    {formatMoney(f.balance)}
                  </td>
                  <td className="td-register text-right figure text-[12px] text-mint-900">
                    {formatMoney(f.ytd_income)}
                  </td>
                  <td className="td-register text-right figure text-[12px] text-stone-700">
                    {formatMoney(f.ytd_expenditure)}
                  </td>
                  <td className="td-register">
                    <div className="flex justify-end">
                      {points.length >= 2 ? (
                        <Sparkline points={points} width={72} height={20} up={points[points.length - 1] >= points[0]} />
                      ) : (
                        <span className="text-stone-400 text-[11px]">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap justify-between gap-2 px-4 py-3 border-t border-stone-150 text-[11px] text-stone-500">
        <span>
          {funds.length === 1 ? '1 fund shown' : `${funds.length} funds shown`} ·{' '}
          <span className="figure">{formatMoney(total)}</span>
        </span>
        <span>Click a fund for its full page</span>
      </div>
    </Card>
  )
}

// ── Cards, grouped by type (1e) ──────────────────────────────────────────────

function CardsView({
  funds,
  sparklines,
  onOpen,
}: {
  funds: VFundBalance[]
  sparklines: Map<string, number[]>
  onOpen: (id: string) => void
}) {
  const groups = FUND_TYPE_ORDER.map((type) => ({
    type,
    funds: funds.filter((f) => f.fund_type === type),
  })).filter((g) => g.funds.length > 0)

  const grandTotal = funds.reduce((s, f) => s + f.balance, 0)

  return (
    <div className="space-y-8">
      {/* proportional split bar */}
      {grandTotal > 0 ? (
        <div
          className="flex h-2.5 rounded-full overflow-hidden max-w-md"
          role="img"
          aria-label="Share of total balance by fund type"
        >
          {groups.map((g) => {
            const sum = g.funds.reduce((s, f) => s + f.balance, 0)
            const share = Math.max(0, sum) / grandTotal
            if (share <= 0) return null
            return (
              <div
                key={g.type}
                style={{ width: `${(share * 100).toFixed(1)}%`, background: FUND_TYPE_ACCENTS[g.type] }}
                title={`${TYPE_LABELS[g.type]} ${formatMoney(sum, { whole: true })}`}
              />
            )
          })}
        </div>
      ) : null}

      {groups.map((g) => {
        const sum = g.funds.reduce((s, f) => s + f.balance, 0)
        return (
          <div key={g.type} className="grid gap-4 md:grid-cols-[190px_1fr] items-start">
            {/* group rail */}
            <div className="md:sticky md:top-20 pl-3.5" style={{ borderLeft: `3px solid ${FUND_TYPE_ACCENTS[g.type]}` }}>
              <div className="text-[10px] font-medium uppercase tracking-[.13em] text-stone-700">
                {TYPE_LABELS[g.type]}
              </div>
              <div className="font-display text-[22px] text-ink mt-1">{formatMoney(sum, { whole: true })}</div>
              <div className="text-[11px] text-stone-500 mt-1">
                {g.funds.length === 1 ? '1 fund' : `${g.funds.length} funds`} · {FUND_TYPE_BLURBS[g.type]}
              </div>
            </div>
            {/* cards */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.funds.map((f) => {
                const points = sparklines.get(f.fund_id) ?? []
                return (
                  <button
                    key={f.fund_id}
                    onClick={() => onOpen(f.fund_id)}
                    className="text-left bg-white border border-stone-150 rounded-card px-[18px] py-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-panel focus:outline-none focus:ring-2 focus:ring-indigo/30"
                  >
                    <div className="font-medium text-[13px] leading-snug text-ink">{f.name}</div>
                    <div className="flex justify-between items-end mt-3 gap-2">
                      <div>
                        <div className="font-display text-[21px] text-indigo leading-none">
                          {formatMoney(f.balance, { whole: true })}
                        </div>
                        <div className="font-mono text-[10px] text-stone-500 mt-1.5">
                          in {formatMoney(f.ytd_income, { whole: true })} · out{' '}
                          {formatMoney(f.ytd_expenditure, { whole: true })}
                        </div>
                      </div>
                      {points.length >= 2 ? (
                        <Sparkline points={points} width={60} height={20} up={points[points.length - 1] >= points[0]} />
                      ) : null}
                    </div>
                    {f.open_warning_count > 0 ? (
                      <div className="mt-2.5">
                        <WarningBadge>
                          {f.open_warning_count === 1 ? '1 warning' : `${f.open_warning_count} warnings`}
                        </WarningBadge>
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
