/**
 * Expenses — role-aware landing page.
 *  · Submitters see their own claims plus 'New claim'.
 *  · Pulse and the CEO see every claim with status/period filters and a link
 *    to the approval queue.
 * The deadline banner is computed from the settings table, never hard-coded.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  PageHeader,
  Select,
  cx,
} from '@/components/ui'
import { formatDate, formatMoney, formatPeriod } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { ClaimStatus } from '@/types/db'
import {
  Avatar,
  ChevronRightIcon,
  ClaimStatusChip,
  DeadlineBanner,
  Segmented,
  useDeadline,
} from './components'
import {
  countSubmittedClaims,
  createClaim,
  fetchActiveProfiles,
  fetchClaims,
  periodOptions,
  type ClaimWithSubmitter,
} from './lib'

export default function ExpensesPage() {
  const { isPulse, isCeo } = usePermissions()
  return isPulse || isCeo ? <AllClaimsView /> : <MyClaimsView />
}

// ── Submitter view ───────────────────────────────────────────────────────────

function MyClaimsView() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { isSubmitter } = usePermissions()
  const deadline = useDeadline()
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const claims = useSupabaseQuery(
    () => (profile ? fetchClaims({ submitterId: profile.id }) : Promise.resolve([])),
    [profile?.id],
  )

  const startClaim = async () => {
    if (!profile || creating) return
    setCreating(true)
    setActionError(null)
    try {
      const claim = await createClaim(profile.id)
      navigate(`/expenses/${claim.id}`)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not start a claim')
      setCreating(false)
    }
  }

  const newClaimButton = isSubmitter ? (
    <Button onClick={() => void startClaim()} disabled={creating}>
      {creating ? 'Starting…' : 'New claim'}
    </Button>
  ) : null

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Your claims and receipts — we read the receipts, you check them"
        actions={newClaimButton}
      />
      <DeadlineBanner mode="submit" deadline={deadline} />
      {actionError ? (
        <div className="mb-4">
          <ErrorNotice message={actionError} />
        </div>
      ) : null}

      {claims.loading ? (
        <Card>
          <LoadingRows cols={4} rows={5} />
        </Card>
      ) : claims.error ? (
        <ErrorNotice message={claims.error} />
      ) : (claims.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            title="No claims yet"
            hint={
              isSubmitter
                ? 'Start a claim and upload your receipt photos — we read the details for you.'
                : 'Claims you submit will appear here.'
            }
            action={newClaimButton}
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {(claims.data ?? []).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => navigate(`/expenses/${c.id}`)}
              className="w-full text-left bg-white border border-stone-150 rounded-card shadow-card px-4 sm:px-5 py-3.5 flex items-center gap-3 hover:bg-paper-2 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">{formatPeriod(c.period)}</div>
                <div className="text-[11px] text-stone-500 mt-0.5">
                  {c.submitted_at ? `Submitted ${formatDate(c.submitted_at)}` : `Started ${formatDate(c.created_at)}`}
                </div>
              </div>
              <ClaimStatusChip status={c.status} />
              <span className="font-mono text-[13.5px] font-medium text-ink w-24 text-right">
                {formatMoney(c.total)}
              </span>
              <ChevronRightIcon className="shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Pulse / CEO view ─────────────────────────────────────────────────────────

type StatusFilter = 'all' | ClaimStatus

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'pushed_to_xero', label: 'Pushed' },
  { value: 'paid', label: 'Paid' },
]

function AllClaimsView() {
  const navigate = useNavigate()
  const { isCeo, isAdmin, isBookkeeper } = usePermissions()
  const deadline = useDeadline()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [periodFilter, setPeriodFilter] = useState<string>('all')
  const canRaiseOnBehalf = isAdmin || isBookkeeper

  const claims = useSupabaseQuery(() => fetchClaims(), [])
  const queueCount = useSupabaseQuery(countSubmittedClaims, [])

  const periods = useMemo(() => periodOptions(claims.data ?? []), [claims.data])

  const visible = useMemo(() => {
    return (claims.data ?? []).filter(
      (c) =>
        (statusFilter === 'all' || c.status === statusFilter) &&
        (periodFilter === 'all' || c.period === periodFilter),
    )
  }, [claims.data, statusFilter, periodFilter])

  const count = queueCount.data ?? 0

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Every claim across the Assembly — filter by status and period"
        actions={
          <>
            {canRaiseOnBehalf ? <NewClaimFor /> : null}
            <Button variant={isCeo ? 'primary' : 'ghost'} onClick={() => navigate('/expenses/approvals')}>
              Approval queue
              {count > 0 ? (
                <span className="font-mono text-[10px] bg-mint text-indigo rounded-full px-1.5 py-px">{count}</span>
              ) : null}
            </Button>
          </>
        }
      />
      <DeadlineBanner mode="approve" deadline={deadline} />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented options={STATUS_FILTERS} value={statusFilter} onChange={setStatusFilter} />
        <Select
          value={periodFilter}
          onChange={(e) => setPeriodFilter(e.target.value)}
          className="!w-auto py-1.5 text-[12px]"
          aria-label="Filter by period"
        >
          <option value="all">All periods</option>
          {periods.map((p) => (
            <option key={p} value={p}>
              {formatPeriod(p)}
            </option>
          ))}
        </Select>
      </div>

      <Card className="overflow-hidden">
        {claims.loading ? (
          <LoadingRows cols={5} rows={8} />
        ) : claims.error ? (
          <div className="p-4">
            <ErrorNotice message={claims.error} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            title="No claims match"
            hint={
              (claims.data ?? []).length === 0
                ? 'When staff, volunteers and suppliers submit expenses, they appear here.'
                : 'Try a different status or period filter.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>
                  <th className="th-register">Submitter</th>
                  <th className="th-register">Period</th>
                  <th className="th-register">Submitted</th>
                  <th className="th-register text-right">Total</th>
                  <th className="th-register">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <ClaimRow key={c.id} claim={c} onOpen={() => navigate(`/expenses/${c.id}`)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-[11px] text-stone-500 mt-3">
        {isCeo
          ? 'Approve submitted claims from the approval queue — approvals are audit-logged.'
          : 'Approved claims are pushed to Xero as draft bills by Pulse — nothing posts without a person.'}
      </p>
    </div>
  )
}

function ClaimRow({ claim, onOpen }: { claim: ClaimWithSubmitter; onOpen: () => void }) {
  return (
    <tr
      onClick={onOpen}
      className={cx('cursor-pointer hover:bg-paper-2 transition-colors')}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <td className="td-register">
        <div className="flex items-center gap-2.5">
          <Avatar name={claim.submitter?.full_name} size={28} />
          <span className="text-[12.5px] text-ink whitespace-nowrap">
            {claim.submitter?.full_name ?? '—'}
          </span>
        </div>
      </td>
      <td className="td-register text-[12px] text-stone-700 whitespace-nowrap">{formatPeriod(claim.period)}</td>
      <td className="td-register text-[12px] text-stone-500 whitespace-nowrap">
        {claim.submitted_at ? formatDate(claim.submitted_at) : '—'}
      </td>
      <td className="td-register text-right font-mono text-[12.5px] text-ink whitespace-nowrap">
        {formatMoney(claim.total)}
      </td>
      <td className="td-register">
        <ClaimStatusChip status={claim.status} />
      </td>
    </tr>
  )
}

/**
 * "New claim for…" — Pulse raises a draft claim on someone's behalf, so paper
 * receipts handed to the office land in the same central place. People need a
 * login first (People → their record → Create login): claims belong to users.
 */
function NewClaimFor() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const people = useSupabaseQuery(() => (open ? fetchActiveProfiles() : Promise.resolve([])), [open])

  const start = async (profileId: string) => {
    if (!profileId || starting) return
    setStarting(true)
    setError(null)
    try {
      const claim = await createClaim(profileId)
      navigate(`/expenses/${claim.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the claim')
      setStarting(false)
    }
  }

  return (
    <span className="relative inline-flex flex-col items-end gap-1">
      {open ? (
        <Select
          autoFocus
          defaultValue=""
          disabled={starting}
          onChange={(e) => void start(e.target.value)}
          onBlur={() => setOpen(false)}
          className="!w-auto py-1.5 text-[12px]"
          aria-label="Raise a claim on behalf of"
        >
          <option value="" disabled>
            {starting ? 'Starting…' : 'Claim on behalf of…'}
          </option>
          {(people.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </Select>
      ) : (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          New claim for…
        </Button>
      )}
      {error ? <span className="text-[10.5px] text-danger-ink">{error}</span> : null}
    </span>
  )
}
