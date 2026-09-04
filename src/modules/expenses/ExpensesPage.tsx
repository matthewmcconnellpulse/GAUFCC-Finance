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
import { currentPeriod, formatDate, formatMoney, formatPeriod } from '@/lib/format'
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
  previewExpenseReminders,
  sendExpenseReminders,
  type ClaimWithSubmitter,
  type ReminderPreview,
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

type StatusFilter = 'all' | ClaimStatus | 'archived'

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'pushed_to_xero', label: 'Pushed' },
  { value: 'paid', label: 'Paid' },
  { value: 'archived', label: 'Archived' },
]

function AllClaimsView() {
  const navigate = useNavigate()
  const { isCeo, isAdmin, isBookkeeper } = usePermissions()
  const deadline = useDeadline()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [periodFilter, setPeriodFilter] = useState<string>('all')
  const canRaiseOnBehalf = isAdmin || isBookkeeper

  const claims = useSupabaseQuery(() => fetchClaims({ archived: 'include' }), [])
  const queueCount = useSupabaseQuery(countSubmittedClaims, [])

  const periods = useMemo(() => periodOptions(claims.data ?? []), [claims.data])

  // Archived claims live only behind their own filter; every other view is
  // the working list.
  const visible = useMemo(() => {
    return (claims.data ?? []).filter((c) => {
      if (periodFilter !== 'all' && c.period !== periodFilter) return false
      if (statusFilter === 'archived') return c.archived_at != null
      return c.archived_at == null && (statusFilter === 'all' || c.status === statusFilter)
    })
  }, [claims.data, statusFilter, periodFilter])

  const count = queueCount.data ?? 0

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Every claim across the Assembly — filter by status and period"
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/expenses/report')}>
              Report
            </Button>
            {isAdmin || isCeo ? <RemindClaimants /> : null}
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
        <span className="inline-flex items-center gap-1.5">
          <ClaimStatusChip status={claim.status} />
          {claim.archived_at ? <span className="text-[10.5px] text-stone-500">archived</span> : null}
        </span>
      </td>
    </tr>
  )
}

/**
 * "Remind claimants" — emails everyone who plausibly has expenses (active
 * submitters + recent claimants) and hasn't submitted for the chosen month.
 * Draft holders are nudged to finish; already-submitted people are skipped.
 */
function RemindClaimants() {
  const [open, setOpen] = useState(false)
  const [period, setPeriod] = useState(currentPeriod())
  const [preview, setPreview] = useState<ReminderPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPreview(null)
    setError(null)
  }

  const check = async () => {
    if (busy || !/^\d{4}-\d{2}$/.test(period)) return
    setBusy(true)
    reset()
    setResult(null)
    try {
      setPreview(await previewExpenseReminders(period))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The recipients could not be checked')
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { sent, skipped } = await sendExpenseReminders(period)
      setResult(
        sent === 0
          ? `Nobody to remind — ${skipped} ${skipped === 1 ? 'person has' : 'people have'} already submitted.`
          : `Reminder sent to ${sent} ${sent === 1 ? 'person' : 'people'}${skipped > 0 ? ` · ${skipped} already submitted` : ''}.`,
      )
      setOpen(false)
      setPreview(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The reminders could not be sent')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="relative inline-flex flex-col items-end gap-1">
      {open ? (
        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
          <input
            type="month"
            value={period}
            disabled={busy}
            onChange={(e) => {
              setPeriod(e.target.value)
              reset()
            }}
            className="input-base !w-auto py-1.5 text-[12px]"
            aria-label="Month to remind about"
          />
          {preview ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void send()}
              disabled={busy || preview.would_send === 0 || !preview.email_ready}
            >
              {busy
                ? 'Sending…'
                : `Send to ${preview.would_send} ${preview.would_send === 1 ? 'person' : 'people'}`}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void check()} disabled={busy}>
              {busy ? 'Checking…' : 'Check who gets it'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(false)
              reset()
            }}
            disabled={busy}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="ghost"
          onClick={() => {
            setResult(null)
            setOpen(true)
          }}
        >
          Remind claimants…
        </Button>
      )}

      {/* Nothing is sent until the list — and the email setup — has been seen. */}
      {preview ? (
        <div className="rounded-control border border-stone-200 bg-white px-3 py-2.5 max-w-[340px] text-left shadow-sm">
          <p
            className={`text-[11px] leading-relaxed ${preview.email_ready ? 'text-stone-600' : 'text-danger-ink'}`}
          >
            {preview.email_detail}
          </p>
          {preview.would_send === 0 ? (
            <p className="text-[11.5px] text-stone-600 mt-1.5">
              Nobody to remind — everyone has submitted for this month.
            </p>
          ) : (
            <>
              <p className="text-[11.5px] text-ink mt-1.5">
                {preview.would_send} {preview.would_send === 1 ? 'person' : 'people'} would be emailed
                {preview.skipped > 0 ? `, ${preview.skipped} skipped as already submitted` : ''}:
              </p>
              <ul className="text-[11px] text-stone-600 mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {preview.recipients.map((r) => (
                  <li key={r.email}>
                    {r.name}
                    {r.has_draft ? (
                      <span className="text-stone-500"> — has a draft to finish</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
      {result ? <span className="text-[10.5px] text-stone-500">{result}</span> : null}
      {error ? (
        <span className="text-[10.5px] text-danger-ink max-w-[300px] text-right">{error}</span>
      ) : null}
    </span>
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
  const [profileId, setProfileId] = useState('')
  const [period, setPeriod] = useState(currentPeriod())
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const people = useSupabaseQuery(() => (open ? fetchActiveProfiles() : Promise.resolve([])), [open])

  const start = async () => {
    if (!profileId || starting) return
    setStarting(true)
    setError(null)
    try {
      const claim = await createClaim(profileId, period)
      navigate(`/expenses/${claim.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the claim')
      setStarting(false)
    }
  }

  return (
    <span className="relative inline-flex flex-col items-end gap-1">
      {open ? (
        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
          <Select
            autoFocus
            value={profileId}
            disabled={starting}
            onChange={(e) => setProfileId(e.target.value)}
            className="!w-auto py-1.5 text-[12px]"
            aria-label="Raise a claim on behalf of"
          >
            <option value="" disabled>
              Claim on behalf of…
            </option>
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </Select>
          <input
            type="month"
            value={period}
            disabled={starting}
            onChange={(e) => setPeriod(e.target.value)}
            className="input-base !w-auto py-1.5 text-[12px]"
            aria-label="Claim month"
            title="The month the claim belongs to — pick a past month for late expenses"
          />
          <Button size="sm" variant="primary" onClick={() => void start()} disabled={starting || !profileId}>
            {starting ? 'Starting…' : 'Start'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={starting}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          New claim for…
        </Button>
      )}
      {error ? <span className="text-[10.5px] text-danger-ink">{error}</span> : null}
    </span>
  )
}
