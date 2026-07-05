/**
 * Dashboard — the landing view for every role. Headline fund figures,
 * a needs-attention panel and the latest sync status. RLS scopes every
 * query server-side (trustees see only their funds), so this page simply
 * renders whatever comes back.
 */
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  FundTypeChip,
  SectionLabel,
  Skeleton,
  StatusChip,
  WarningBadge,
} from '@/components/ui'
import { currentPeriod, formatDate, formatMoney, formatMovement, formatPeriod, timeAgo } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { ClaimStatus, SyncRun } from '@/types/db'
import { StatTile } from '@/modules/funds/components'
import { fetchFundBalances, fetchOpenWarnings } from '@/modules/funds/lib'

export default function DashboardPage() {
  const { profile } = useAuth()
  const perms = usePermissions()
  const navigate = useNavigate()
  const seesFunds = perms.isPulse || perms.isCeo || perms.isTrustee
  const seesClaims = perms.isPulse || perms.isCeo || perms.isSubmitter

  const balances = useSupabaseQuery(async () => (seesFunds ? fetchFundBalances() : []), [seesFunds])
  const warnings = useSupabaseQuery(async () => (seesFunds ? fetchOpenWarnings({ limit: 8 }) : []), [seesFunds])

  const claims = useSupabaseQuery(async () => {
    if (!seesClaims) return null
    const { count, error } = await supabase
      .from('expense_claims')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'submitted')
    if (error) throw new Error(error.message)
    return count ?? 0
  }, [seesClaims])

  const stamp = useSupabaseQuery(async () => {
    if (!perms.isPulse) return null
    const { data, error } = await supabase
      .from('integrity_stamps')
      .select('id, stamped_at')
      .eq('period', currentPeriod())
      .order('stamped_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return (data as { id: string; stamped_at: string } | null) ?? null
  }, [perms.isPulse])

  const lastRun = useSupabaseQuery(async () => {
    const { data, error } = await supabase
      .from('sync_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return (data as SyncRun | null) ?? null
  }, [])

  const firstName = profile?.full_name?.split(' ')[0]
  const funds = balances.data ?? []
  const total = funds.reduce((s, f) => s + f.balance, 0)
  const ytdNet = funds.reduce((s, f) => s + f.ytd_income - f.ytd_expenditure, 0)
  const restricted = funds.filter((f) => f.fund_type === 'restricted')
  const unrestricted = funds.filter((f) => f.fund_type !== 'restricted')
  const restrictedTotal = restricted.reduce((s, f) => s + f.balance, 0)
  const unrestrictedTotal = unrestricted.reduce((s, f) => s + f.balance, 0)
  const openWarningCount = funds.reduce((s, f) => s + f.open_warning_count, 0)
  const flaggedFunds = funds.filter((f) => f.open_warning_count > 0).length
  const unclassified = funds.filter((f) => f.classified_at === null).length

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-[26px] font-normal text-ink leading-tight">
          {firstName ? `Welcome back, ${firstName}` : 'Dashboard'}
        </h1>
        <p className="text-stone-500 text-[12.5px] mt-1">
          {seesFunds
            ? "Here's where the Assembly's funds stand."
            : 'Your expenses and profile, in one place.'}
        </p>
      </div>

      {/* Sync status line */}
      <SyncStatusLine run={lastRun.data ?? null} loading={lastRun.loading} isPulse={perms.isPulse} />

      {!seesFunds ? (
        <SubmitterDashboard awaiting={claims.data ?? null} />
      ) : balances.loading ? (
        <div className="grid gap-3 grid-cols-2 xl:grid-cols-4 mb-6">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : balances.error ? (
        <div className="mb-6">
          <ErrorNotice message={`The fund figures could not be loaded — ${balances.error}`} />
        </div>
      ) : funds.length === 0 ? (
        <Card className="mb-6">
          <EmptyState
            title={perms.isPulse ? 'Waiting for the first Xero sync' : 'No funds are visible to you yet'}
            hint={
              perms.isPulse
                ? 'Connect Xero under Settings, then use Refresh now in the top bar. The fund register builds itself from tracking categories.'
                : perms.isTrustee
                  ? 'Once Pulse links funds to you, they will appear here with balances, movements and warnings.'
                  : 'Once Pulse connects Xero and runs the first sync, the fund figures will appear here.'
            }
            action={
              perms.isPulse ? (
                <Button variant="ghost" onClick={() => navigate('/settings')}>
                  Go to settings
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* Headline tiles */}
          <div
            className={`grid gap-3 grid-cols-2 ${claims.data !== null && claims.data !== undefined ? 'xl:grid-cols-5 lg:grid-cols-3' : 'xl:grid-cols-4'} mb-6`}
          >
            <StatTile
              tone="hero"
              label="Total funds"
              value={formatMoney(total, { whole: true })}
              sub={`${formatMovement(ytdNet, { whole: true })} this year`}
            />
            <StatTile
              label="Restricted"
              value={formatMoney(restrictedTotal, { whole: true })}
              sub={restricted.length === 1 ? '1 fund' : `${restricted.length} funds`}
            />
            <StatTile
              label="Unrestricted"
              value={formatMoney(unrestrictedTotal, { whole: true })}
              sub={`designated + general · ${unrestricted.length} funds`}
            />
            <StatTile
              tone={openWarningCount > 0 ? 'warn' : 'plain'}
              label="Open warnings"
              value={String(openWarningCount)}
              sub={
                openWarningCount === 0
                  ? 'all quiet'
                  : `across ${flaggedFunds} ${flaggedFunds === 1 ? 'fund' : 'funds'}`
              }
            />
            {claims.data !== null && claims.data !== undefined ? (
              <button
                onClick={() => navigate(perms.canApprove ? '/expenses/approvals' : '/expenses')}
                className="text-left"
              >
                <StatTile
                  tone={claims.data > 0 && perms.canApprove ? 'warn' : 'plain'}
                  label={perms.canApprove ? 'Awaiting your approval' : 'Claims awaiting approval'}
                  value={String(claims.data)}
                  sub={perms.canApprove ? 'open the approval queue' : 'submitted claims'}
                />
              </button>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-3 items-start">
            {/* Needs attention */}
            <Card className="lg:col-span-2">
              <div className="px-5 py-4">
                <SectionLabel>Needs attention</SectionLabel>
                {warnings.loading ? (
                  <div className="space-y-2.5 py-2">
                    <Skeleton className="h-4" />
                    <Skeleton className="h-4" />
                    <Skeleton className="h-4" />
                  </div>
                ) : warnings.error ? (
                  <ErrorNotice message={`Warnings could not be loaded — ${warnings.error}`} />
                ) : (
                  <NeedsAttention
                    warnings={warnings.data ?? []}
                    unclassified={perms.isPulse ? unclassified : 0}
                    stampStatus={perms.isPulse ? { loaded: !stamp.loading, stamped: Boolean(stamp.data) } : null}
                  />
                )}
              </div>
            </Card>

            {/* Largest funds */}
            <Card>
              <div className="px-5 py-4">
                <SectionLabel>Largest funds</SectionLabel>
                <ul>
                  {funds.slice(0, 6).map((f) => (
                    <li key={f.fund_id}>
                      <Link
                        to={`/funds/${f.fund_id}`}
                        className="flex items-center justify-between gap-3 py-2 border-b border-paper-3 last:border-0 hover:bg-paper-2 -mx-2 px-2 rounded-control"
                      >
                        <span className="min-w-0">
                          <span className="block text-[12.5px] text-ink truncate">{f.name}</span>
                          <FundTypeChip type={f.fund_type} className="mt-1" />
                        </span>
                        <span className="figure text-[12px] font-medium whitespace-nowrap">
                          {formatMoney(f.balance, { whole: true })}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link
                  to="/funds"
                  className="inline-block mt-3 text-[12px] text-indigo underline underline-offset-2"
                >
                  View all funds
                </Link>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function SyncStatusLine({ run, loading, isPulse }: { run: SyncRun | null; loading: boolean; isPulse: boolean }) {
  if (loading) return <div className="mb-4"><Skeleton className="h-4 w-72" /></div>
  return (
    <div className="flex flex-wrap items-center gap-2 mb-5 text-[11.5px] text-stone-500">
      {!run ? (
        <>
          <StatusChip tone="neutral">No sync yet</StatusChip>
          <span>
            {isPulse ? (
              <>
                Connect Xero under <Link to="/settings" className="text-indigo underline underline-offset-2">Settings</Link>,
                then use Refresh now in the top bar.
              </>
            ) : (
              'Figures appear after Pulse runs the first Xero sync.'
            )}
          </span>
        </>
      ) : run.status === 'running' ? (
        <>
          <StatusChip tone="live">Sync running</StatusChip>
          <span>started {timeAgo(run.started_at)}</span>
        </>
      ) : run.status === 'error' ? (
        <>
          <StatusChip tone="warn">Last sync failed</StatusChip>
          <span className="figure">{formatDate(run.started_at)}</span>
          {isPulse ? (
            <Link to="/settings" className="text-indigo underline underline-offset-2">
              Check the Xero connection
            </Link>
          ) : null}
        </>
      ) : (
        <>
          <StatusChip tone="good">Synced</StatusChip>
          <span>
            {timeAgo(run.finished_at)} · <span className="figure">{run.records_upserted.toLocaleString('en-GB')}</span>{' '}
            records · {run.trigger === 'cron' ? 'overnight run' : 'manual refresh'}
          </span>
        </>
      )}
    </div>
  )
}

function NeedsAttention({
  warnings,
  unclassified,
  stampStatus,
}: {
  warnings: Array<{
    id: string
    fund_id: string
    message: string
    severity: 'amber' | 'red'
    rule: string
    as_of: string
    funds: { name: string } | null
  }>
  unclassified: number
  stampStatus: { loaded: boolean; stamped: boolean } | null
}) {
  const pulseRows: ReactNode[] = []
  if (unclassified > 0) {
    pulseRows.push(
      <li key="unclassified" className="flex flex-wrap items-center gap-2 py-2.5 border-b border-paper-3 text-[12.5px]">
        <StatusChip tone="warn">Classify</StatusChip>
        <span className="text-stone-700">
          {unclassified === 1 ? '1 new fund needs' : `${unclassified} new funds need`} a fund type and opening balance
        </span>
        <Link to="/funds/integrity" className="text-indigo underline underline-offset-2 text-[12px]">
          Review
        </Link>
      </li>,
    )
  }
  if (stampStatus?.loaded) {
    pulseRows.push(
      <li key="stamp" className="flex flex-wrap items-center gap-2 py-2.5 border-b border-paper-3 text-[12.5px]">
        {stampStatus.stamped ? (
          <>
            <StatusChip tone="good">Stamped</StatusChip>
            <span className="text-stone-700">{formatPeriod(currentPeriod())} integrity checks are stamped complete</span>
          </>
        ) : (
          <>
            <StatusChip tone="neutral">Not stamped</StatusChip>
            <span className="text-stone-700">{formatPeriod(currentPeriod())} has not been stamped yet</span>
            <Link to="/funds/integrity" className="text-indigo underline underline-offset-2 text-[12px]">
              Run the checks
            </Link>
          </>
        )}
      </li>,
    )
  }

  if (pulseRows.length === 0 && warnings.length === 0) {
    return <EmptyState title="Nothing needs attention" hint="Fund warnings and housekeeping tasks will appear here." />
  }

  return (
    <ul>
      {pulseRows}
      {warnings.map((w) => (
        <li key={w.id} className="flex flex-wrap items-center gap-2 py-2.5 border-b border-paper-3 last:border-0 text-[12.5px]">
          <WarningBadge breached={w.severity === 'red'}>{w.rule.replace(/_/g, ' ')}</WarningBadge>
          <Link to={`/funds/${w.fund_id}`} className="font-medium text-ink hover:text-indigo">
            {w.funds?.name ?? 'Fund'}
          </Link>
          <span className="text-stone-700">{w.message}</span>
          <span className="text-[11px] text-stone-500 ml-auto figure">{formatDate(w.as_of)}</span>
        </li>
      ))}
    </ul>
  )
}

function SubmitterDashboard({ awaiting }: { awaiting: number | null }) {
  const navigate = useNavigate()

  const mine = useSupabaseQuery(async () => {
    const { data, error } = await supabase.from('expense_claims').select('status')
    if (error) throw new Error(error.message)
    const counts = new Map<ClaimStatus, number>()
    for (const row of (data ?? []) as Array<{ status: ClaimStatus }>) {
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
    }
    return counts
  }, [])

  const drafts = mine.data?.get('draft') ?? 0
  const paid = mine.data?.get('paid') ?? 0

  return (
    <div className="grid gap-4 lg:grid-cols-3 items-start">
      <Card className="lg:col-span-2">
        <div className="px-5 py-4">
          <SectionLabel>Your expenses</SectionLabel>
          {mine.loading ? (
            <div className="space-y-2.5 py-2">
              <Skeleton className="h-4" />
              <Skeleton className="h-4" />
            </div>
          ) : mine.error ? (
            <ErrorNotice message={`Your claims could not be loaded — ${mine.error}`} />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 py-2">
                <MiniStat label="Drafts" value={drafts} />
                <MiniStat label="Awaiting approval" value={awaiting ?? mine.data?.get('submitted') ?? 0} />
                <MiniStat label="Paid" value={paid} />
              </div>
              <Button variant="primary" size="sm" className="mt-2" onClick={() => navigate('/expenses')}>
                Go to expenses
              </Button>
            </>
          )}
        </div>
      </Card>
      <Card>
        <div className="px-5 py-4">
          <SectionLabel>How it works</SectionLabel>
          <p className="text-[12px] text-stone-700 leading-relaxed">
            Add receipts to a claim and submit it before the monthly deadline. Once the CEO approves, it joins the
            next payment run. You can track each claim's progress under Expenses.
          </p>
        </div>
      </Card>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-paper border border-stone-150 rounded-control px-3 py-2.5">
      <div className="text-[9.5px] font-medium uppercase tracking-[.12em] text-stone-500">{label}</div>
      <div className="figure text-[18px] font-medium text-ink mt-1">{value}</div>
    </div>
  )
}
