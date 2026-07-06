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
  FUND_TYPE_ACCENTS,
  FUND_TYPE_BLURBS,
  FUND_TYPE_ORDER,
  FUND_TYPE_ROW_ACCENTS,
  fetchFundBalances,
  fetchFundMonthly,
  isoDate,
  lastMonthKeys,
  sparklineByFund,
  type VFundBalance,
} from './lib'

type ViewMode = 'register' | 'cards'
type TypeFilter = 'all' | FundType

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
  const { isPulse, isTrustee } = usePermissions()
  const [view, setView] = useState<ViewMode>('register')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [search, setSearch] = useState('')
  const [showDormant, setShowDormant] = useState(false)

  const balances = useSupabaseQuery(fetchFundBalances, [])
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
  const visible = useMemo(() => {
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

      {visible.length === 0 ? (
        <Card>
          <EmptyState title="No funds match" hint="Try a different filter or clear the search." />
        </Card>
      ) : view === 'register' ? (
        <RegisterView funds={visible} sparklines={sparklines} isPulse={isPulse} onOpen={(id) => navigate(`/funds/${id}`)} />
      ) : (
        <CardsView funds={visible} sparklines={sparklines} onOpen={(id) => navigate(`/funds/${id}`)} />
      )}
    </div>
  )
}

// ── Register (1d) ────────────────────────────────────────────────────────────

function RegisterView({
  funds,
  sparklines,
  isPulse,
  onOpen,
}: {
  funds: VFundBalance[]
  sparklines: Map<string, number[]>
  isPulse: boolean
  onOpen: (id: string) => void
}) {
  const total = funds.reduce((s, f) => s + f.balance, 0)
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[760px]">
          <thead>
            <tr>
              <th className="th-register">Fund</th>
              <th className="th-register">Type</th>
              <th className="th-register text-right">Balance</th>
              <th className="th-register text-right">YTD income</th>
              <th className="th-register text-right">YTD spend</th>
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
                      {f.open_warning_count > 0 ? (
                        <WarningBadge>
                          {f.open_warning_count === 1 ? '1 warning' : `${f.open_warning_count} warnings`}
                        </WarningBadge>
                      ) : null}
                      {isPulse && f.classified_at === null ? (
                        <StatusChip tone="warn">Unclassified</StatusChip>
                      ) : null}
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
