/**
 * CEO approval queue (design ref 1f) — bulk approve at the desk, one-tap on
 * the phone. Pulse roles get a read-only view of the queue plus the
 * 'Push to Xero' action on approved claims (human trigger — CEO approval
 * never auto-pushes) and a downloadable .eml reminder for the CEO.
 */
import { useEffect, useMemo, useState } from 'react'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  PageHeader,
  Textarea,
  cx,
} from '@/components/ui'
import { formatDate, formatMoney, formatPeriod } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { ExpenseLine } from '@/types/db'
import {
  AccessDenied,
  Avatar,
  CategoryChip,
  CheckIcon,
  DeadlineBanner,
  FundChip,
  ReceiptThumb,
  useDeadline,
} from './components'
import { downloadEml } from './eml'
import {
  approveClaim,
  fetchCeoProfile,
  fetchClaims,
  fetchExpenseCategories,
  fetchFundOptions,
  fetchLinesForClaims,
  isLowConfidence,
  pushClaimToXero,
  rejectClaim,
  sumGross,
  type ClaimWithSubmitter,
} from './lib'

export default function ApprovalQueuePage() {
  const { profile } = useAuth()
  const perms = usePermissions()
  const deadline = useDeadline()

  const canApprove = perms.canApprove // CEO, or the Pulse admin signing off on their behalf
  const readOnly = !canApprove && perms.isPulse
  const allowed = canApprove || perms.isPulse

  // ── Data ───────────────────────────────────────────────────────────────────
  const queueQ = useSupabaseQuery(
    () => (allowed ? fetchClaims({ statuses: ['submitted'] }) : Promise.resolve([])),
    [allowed],
  )
  const queueIds = useMemo(() => (queueQ.data ?? []).map((c) => c.id), [queueQ.data])
  const linesQ = useSupabaseQuery(
    () => (queueIds.length > 0 ? fetchLinesForClaims(queueIds) : Promise.resolve(new Map<string, ExpenseLine[]>())),
    [queueIds.join(',')],
  )
  const fundsQ = useSupabaseQuery(fetchFundOptions, [])
  const catsQ = useSupabaseQuery(fetchExpenseCategories, [])
  const approvedQ = useSupabaseQuery(
    () => (perms.isPulse ? fetchClaims({ statuses: ['approved'] }) : Promise.resolve([])),
    [perms.isPulse],
  )
  const ceoQ = useSupabaseQuery(
    () => (perms.isPulse ? fetchCeoProfile() : Promise.resolve(null)),
    [perms.isPulse],
  )

  const fundName = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of fundsQ.data ?? []) m.set(f.fund_id, f.name)
    return m
  }, [fundsQ.data])
  const categoryName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of catsQ.data ?? []) m.set(c.code, c.name)
    return m
  }, [catsQ.data])

  // ── Local queue state (optimistic) ─────────────────────────────────────────
  const [queue, setQueue] = useState<ClaimWithSubmitter[]>([])
  useEffect(() => setQueue(queueQ.data ?? []), [queueQ.data])
  const [approvedList, setApprovedList] = useState<ClaimWithSubmitter[]>([])
  useEffect(() => setApprovedList(approvedQ.data ?? []), [approvedQ.data])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [rejectHint, setRejectHint] = useState(false)
  const [doneCount, setDoneCount] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pushingId, setPushingId] = useState<string | null>(null)
  const [lastPush, setLastPush] = useState<string | null>(null)

  const focused = queue.find((c) => c.id === focusId) ?? queue[0] ?? null
  useEffect(() => {
    setComment('')
    setRejectHint(false)
  }, [focused?.id])

  const linesFor = (claimId: string): ExpenseLine[] => linesQ.data?.get(claimId) ?? []
  const queueTotal = useMemo(() => sumGross(queue.map((c) => ({ gross: c.total }))), [queue])
  const selectedTotal = useMemo(
    () => sumGross(queue.filter((c) => selected.has(c.id)).map((c) => ({ gross: c.total }))),
    [queue, selected],
  )

  // ── Actions ────────────────────────────────────────────────────────────────

  const removeFromQueue = (id: string) => {
    setQueue((q) => q.filter((c) => c.id !== id))
    setSelected((s) => {
      if (!s.has(id)) return s
      const next = new Set(s)
      next.delete(id)
      return next
    })
  }

  const approveOne = async (claim: ClaimWithSubmitter, note?: string) => {
    if (!profile) return
    setActionError(null)
    removeFromQueue(claim.id)
    setDoneCount((d) => d + 1)
    try {
      await approveClaim(claim.id, profile.id, note)
    } catch (e) {
      setQueue((q) => [claim, ...q])
      setDoneCount((d) => d - 1)
      setActionError(e instanceof Error ? e.message : 'Could not approve the claim')
    }
  }

  const rejectOne = async (claim: ClaimWithSubmitter, note: string) => {
    if (!profile) return
    if (note.trim() === '') {
      setRejectHint(true)
      return
    }
    setActionError(null)
    removeFromQueue(claim.id)
    setDoneCount((d) => d + 1)
    try {
      await rejectClaim(claim.id, profile.id, note)
    } catch (e) {
      setQueue((q) => [claim, ...q])
      setDoneCount((d) => d - 1)
      setActionError(e instanceof Error ? e.message : 'Could not reject the claim')
    }
  }

  const bulkApprove = async () => {
    if (!profile || selected.size === 0) return
    const chosen = queue.filter((c) => selected.has(c.id))
    setActionError(null)
    setQueue((q) => q.filter((c) => !selected.has(c.id)))
    setSelected(new Set())
    setDoneCount((d) => d + chosen.length)
    const results = await Promise.allSettled(chosen.map((c) => approveClaim(c.id, profile.id)))
    const failed = chosen.filter((_, i) => results[i].status === 'rejected')
    if (failed.length > 0) {
      setQueue((q) => [...failed, ...q])
      setDoneCount((d) => d - failed.length)
      setActionError(
        `${failed.length} ${failed.length === 1 ? 'claim' : 'claims'} could not be approved — try again`,
      )
    }
  }

  const push = async (claim: ClaimWithSubmitter) => {
    if (pushingId) return
    setPushingId(claim.id)
    setActionError(null)
    setLastPush(null)
    try {
      const { xero_bill_id } = await pushClaimToXero(claim.id)
      setApprovedList((list) => list.filter((c) => c.id !== claim.id))
      setLastPush(
        `${claim.submitter?.full_name ?? 'Claim'} — ${formatMoney(claim.total)} pushed to Xero as draft bill ${xero_bill_id}`,
      )
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not push the bill to Xero')
    } finally {
      setPushingId(null)
    }
  }

  const downloadReminder = () => {
    const ceo = ceoQ.data
    if (!ceo?.email || !deadline) return
    const n = queue.length
    const firstName = ceo.full_name.split(/\s+/)[0] ?? ceo.full_name
    downloadEml('expense-approvals-reminder', {
      to: ceo.email,
      subject: `${n} ${n === 1 ? 'claim' : 'claims'} awaiting your approval — deadline ${formatDate(deadline.approvalDate)}`,
      body: [
        `Hi ${firstName},`,
        '',
        `${n} expense ${n === 1 ? 'claim is' : 'claims are'} waiting for your approval in GAUFCC Finance, totalling ${formatMoney(queueTotal)}.`,
        '',
        `Approval deadline: ${formatDate(deadline.approvalDate)} — claims approved after this date roll to the next payment run.`,
        `Payment run: ${formatDate(deadline.paymentDate)}.`,
        '',
        `Open the approval queue: ${window.location.origin}/expenses/approvals`,
        '',
        'Thanks,',
        profile?.full_name ?? 'Pulse Accountants',
        'Pulse Accountants',
      ].join('\n'),
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!allowed) {
    return (
      <AccessDenied
        title="This queue is for approvers"
        hint="Claims are signed off by the CEO or the Pulse admin. Your own claims live under Expenses."
      />
    )
  }

  const loading = queueQ.loading || linesQ.loading

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle={
          readOnly
            ? 'Read-only — sign-off is for the CEO or the Pulse admin. Approved claims below are ready to push to Xero.'
            : 'Submitted claims waiting for your sign-off — approvals are audit-logged'
        }
        actions={
          readOnly && queue.length > 0 ? (
            <Button
              variant="ghost"
              onClick={downloadReminder}
              disabled={!ceoQ.data?.email || !deadline}
              title={ceoQ.data?.email ? undefined : 'No active CEO profile with an email address'}
            >
              Download reminder .eml
            </Button>
          ) : null
        }
      />
      <DeadlineBanner mode="approve" deadline={deadline} />

      {actionError ? (
        <div className="mb-4">
          <ErrorNotice message={actionError} />
        </div>
      ) : null}

      {/* ── Desktop: list + focus panel ─────────────────────────────────── */}
      <div className="hidden lg:flex gap-4 items-start">
        <Card className="flex-1 overflow-hidden min-w-0">
          <div className="px-5 py-4 border-b border-stone-150 flex items-center justify-between gap-3">
            <div className="font-display text-[17px] text-ink">
              {queue.length > 0
                ? `${formatPeriod(queue[0].period)} claims — ${queue.length} waiting · ${formatMoney(queueTotal)}`
                : 'Claims waiting'}
            </div>
            {canApprove && selected.size > 0 ? (
              <Button variant="money" size="sm" onClick={() => void bulkApprove()}>
                <CheckIcon />
                Approve {selected.size} selected · {formatMoney(selectedTotal)}
              </Button>
            ) : null}
          </div>
          {loading ? (
            <LoadingRows cols={4} rows={5} />
          ) : queueQ.error ? (
            <div className="p-4">
              <ErrorNotice message={queueQ.error} />
            </div>
          ) : queue.length === 0 ? (
            <QueueClear doneCount={doneCount} readOnly={readOnly} />
          ) : (
            <div>
              {queue.map((c) => {
                const lines = linesFor(c.id)
                const isFocused = focused?.id === c.id
                return (
                  <div
                    key={c.id}
                    onClick={() => setFocusId(c.id)}
                    className={cx(
                      'grid grid-cols-[auto_auto_1fr_120px] gap-x-3 items-center px-5 py-3 border-b border-paper-3 cursor-pointer transition-colors',
                      isFocused ? 'bg-paper-2' : 'hover:bg-paper-2/60',
                    )}
                  >
                    {canApprove ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelected((s) => {
                            const next = new Set(s)
                            if (next.has(c.id)) next.delete(c.id)
                            else next.add(c.id)
                            return next
                          })
                        }}
                        className={cx(
                          'w-[18px] h-[18px] rounded border grid place-items-center transition-colors',
                          selected.has(c.id) ? 'bg-indigo border-indigo' : 'bg-white border-stone-400',
                        )}
                        aria-label={selected.has(c.id) ? 'Deselect claim' : 'Select claim'}
                      >
                        {selected.has(c.id) ? <CheckIcon stroke="#08f2c7" /> : null}
                      </button>
                    ) : (
                      <span className="w-[18px]" aria-hidden />
                    )}
                    <Avatar name={c.submitter?.full_name} size={32} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">
                        {c.submitter?.full_name ?? '—'}{' '}
                        <span className="font-normal text-stone-500 text-[11.5px]">
                          · {formatPeriod(c.period)}
                        </span>
                      </div>
                      <div className="text-[11px] text-stone-500 mt-0.5">
                        {lines.length} {lines.length === 1 ? 'line' : 'lines'}
                        {c.submitted_at ? ` · submitted ${formatDate(c.submitted_at)}` : ''}
                      </div>
                    </div>
                    <div className="text-right font-mono text-[13.5px] font-medium text-ink">
                      {formatMoney(c.total)}
                    </div>
                  </div>
                )
              })}
              <div className="px-5 py-3 text-[11px] text-stone-500">
                Approved claims queue for Pulse review, then push to Xero as draft bills — nothing
                posts without a person.
              </div>
            </div>
          )}
        </Card>

        {focused ? (
          <div className="w-[380px] shrink-0 bg-white border border-stone-300 rounded-card shadow-panel p-5">
            <FocusDetail
              claim={focused}
              lines={linesFor(focused.id)}
              fundName={fundName}
              categoryName={categoryName}
            />
            {canApprove ? (
              <>
                <Textarea
                  value={comment}
                  onChange={(e) => {
                    setComment(e.target.value)
                    if (rejectHint && e.target.value.trim() !== '') setRejectHint(false)
                  }}
                  placeholder="Add a comment (optional — required to reject)"
                  className="mt-4 !min-h-[64px] text-[12px]"
                />
                {rejectHint ? (
                  <p className="text-[11px] text-warn-ink mt-1.5">
                    Add a short comment so the submitter knows why it was rejected.
                  </p>
                ) : null}
                <div className="flex gap-2.5 mt-3.5">
                  <Button variant="reject" className="flex-1" onClick={() => void rejectOne(focused, comment)}>
                    Reject
                  </Button>
                  <Button
                    variant="money"
                    className="flex-[2]"
                    onClick={() => void approveOne(focused, comment.trim() || undefined)}
                  >
                    Approve claim
                  </Button>
                </div>
                <p className="text-[10px] text-stone-500 text-center mt-2.5">
                  Approval is audit-logged and queues the Xero bill for Pulse review
                </p>
              </>
            ) : (
              <p className="text-[11px] text-stone-500 mt-4 border-t border-stone-150 pt-3">
                Read-only — only the CEO or the Pulse admin can approve or reject.
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* ── Phone: tap through the queue, one claim at a time ───────────── */}
      <div className="lg:hidden">
        {loading ? (
          <Card>
            <LoadingRows cols={2} rows={5} />
          </Card>
        ) : queueQ.error ? (
          <ErrorNotice message={queueQ.error} />
        ) : !focused ? (
          <Card>
            <QueueClear doneCount={doneCount} readOnly={readOnly} />
          </Card>
        ) : (
          <div>
            <div className="text-[11px] font-mono text-stone-500 mb-2 text-right">
              {doneCount + 1} of {doneCount + queue.length}
            </div>
            <Card className="p-4">
              <FocusDetail
                claim={focused}
                lines={linesFor(focused.id)}
                fundName={fundName}
                categoryName={categoryName}
              />
              {canApprove ? (
                <>
                  <Textarea
                    value={comment}
                    onChange={(e) => {
                      setComment(e.target.value)
                      if (rejectHint && e.target.value.trim() !== '') setRejectHint(false)
                    }}
                    placeholder="Add a comment (optional — required to reject)"
                    className="mt-4 !min-h-[56px] text-[13px]"
                  />
                  {rejectHint ? (
                    <p className="text-[11.5px] text-warn-ink mt-1.5">
                      Add a short comment so the submitter knows why it was rejected.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-[11.5px] text-stone-500 mt-4">
                  Read-only — only the CEO or the Pulse admin can approve or reject.
                </p>
              )}
            </Card>
            {canApprove ? (
              <div className="sticky bottom-0 bg-paper-3/95 backdrop-blur pt-3 pb-2 mt-3 flex gap-2.5">
                <Button
                  variant="reject"
                  className="flex-1 !py-3.5 !text-[14px]"
                  onClick={() => void rejectOne(focused, comment)}
                >
                  Reject
                </Button>
                <Button
                  variant="money"
                  className="flex-[2] !py-3.5 !text-[14px]"
                  onClick={() => void approveOne(focused, comment.trim() || undefined)}
                >
                  Approve — {formatMoney(focused.total)}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Pulse: approved claims ready to push to Xero ─────────────────── */}
      {perms.isPulse ? (
        <div className="mt-8">
          <div className="font-display text-[19px] text-ink mb-3">Approved — ready to push to Xero</div>
          {lastPush ? (
            <div className="mb-3 rounded-card border border-mint/50 bg-mint/10 text-mint-900 text-[12px] px-4 py-2.5 font-mono">
              {lastPush}
            </div>
          ) : null}
          <Card className="overflow-hidden">
            {approvedQ.loading ? (
              <LoadingRows cols={4} rows={3} />
            ) : approvedQ.error ? (
              <div className="p-4">
                <ErrorNotice message={approvedQ.error} />
              </div>
            ) : approvedList.length === 0 ? (
              <EmptyState
                title="Nothing waiting to push"
                hint="Claims land here once the CEO approves them. Pushing creates a draft bill in Xero — a human trigger, never automatic."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px]">
                  <thead>
                    <tr>
                      <th className="th-register">Submitter</th>
                      <th className="th-register">Approved</th>
                      <th className="th-register text-right">Total</th>
                      <th className="th-register text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvedList.map((c) => (
                      <tr key={c.id}>
                        <td className="td-register">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={c.submitter?.full_name} size={26} />
                            <span className="text-[12.5px] text-ink whitespace-nowrap">
                              {c.submitter?.full_name ?? '—'}
                            </span>
                            <span className="text-[11px] text-stone-500">{formatPeriod(c.period)}</span>
                          </div>
                        </td>
                        <td className="td-register text-[12px] text-stone-500 whitespace-nowrap">
                          {c.ceo_approved_at ? formatDate(c.ceo_approved_at) : '—'}
                        </td>
                        <td className="td-register text-right font-mono text-[12.5px] text-ink">
                          {formatMoney(c.total)}
                        </td>
                        <td className="td-register text-right">
                          <Button
                            variant="money"
                            size="sm"
                            onClick={() => void push(c)}
                            disabled={pushingId !== null}
                          >
                            {pushingId === c.id ? 'Pushing…' : 'Push to Xero'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  )
}

// ── Claim detail shown in the focus panel / phone card ───────────────────────

function FocusDetail({
  claim,
  lines,
  fundName,
  categoryName,
}: {
  claim: ClaimWithSubmitter
  lines: ExpenseLine[]
  fundName: Map<string, string>
  categoryName: Map<string, string>
}) {
  const receipts = lines.filter((l) => l.receipt_storage_path)
  const lowConfidence = lines.some((l) => isLowConfidence(l))
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <Avatar name={claim.submitter?.full_name} size={36} />
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink truncate">
            {claim.submitter?.full_name ?? '—'}
          </div>
          <div className="text-[11px] text-stone-500">
            {formatPeriod(claim.period)}
            {claim.submitted_at ? ` · submitted ${formatDate(claim.submitted_at)}` : ''}
          </div>
        </div>
        <div className="ml-auto font-mono text-[17px] font-medium text-indigo whitespace-nowrap">
          {formatMoney(claim.total)}
        </div>
      </div>

      {receipts.length > 0 ? (
        <div className="flex gap-2 mt-3.5">
          {receipts.slice(0, 3).map((l) => (
            <ReceiptThumb
              key={l.id}
              path={l.receipt_storage_path as string}
              className="flex-1 h-[86px]"
              alt={`Receipt — ${l.description}`}
            />
          ))}
          {receipts.length > 3 ? (
            <span className="flex-1 h-[86px] border border-dashed border-stone-300 rounded-control grid place-items-center text-[10px] text-stone-400">
              +{receipts.length - 3} more
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3.5 border-t border-stone-150">
        {lines.length === 0 ? (
          <p className="text-[11.5px] text-stone-500 py-3">No lines on this claim.</p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="py-2.5 border-b border-paper-3">
              <div className="flex justify-between gap-3">
                <span className="text-[12.5px] text-ink min-w-0">{l.description || 'Untitled line'}</span>
                <span className="font-mono text-[12px] font-medium text-ink shrink-0">
                  {formatMoney(l.gross)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                {l.category ? (
                  <CategoryChip label={categoryName.get(l.category) ?? l.category} />
                ) : (
                  <CategoryChip label="uncoded — Pulse will code it" />
                )}
                {l.fund_id ? <FundChip name={fundName.get(l.fund_id) ?? 'Fund'} /> : null}
                <span className="font-mono text-[9.5px] text-stone-500 ml-auto">{l.date}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {lowConfidence ? (
        <div className="mt-3 bg-warn/10 border border-warn/40 rounded-control px-3 py-2.5 text-[11px] leading-relaxed text-warn-ink">
          Some figures were read from the receipts by AI at lower confidence — the submitter checked
          and confirmed them before submitting.
        </div>
      ) : null}
    </div>
  )
}

// ── Queue clear state ────────────────────────────────────────────────────────

function QueueClear({ doneCount, readOnly }: { doneCount: number; readOnly: boolean }) {
  return (
    <div className="text-center py-14 px-6">
      <span className="mx-auto w-[72px] h-[72px] rounded-full bg-mint grid place-items-center">
        <CheckIcon stroke="#211951" className="w-8 h-8" />
      </span>
      <div className="font-display text-[24px] text-ink mt-5">Queue clear</div>
      <p className="text-[13px] text-stone-700 mt-2 max-w-sm mx-auto leading-relaxed">
        {doneCount > 0
          ? `${doneCount} ${doneCount === 1 ? 'claim' : 'claims'} dealt with this visit. `
          : 'Nothing is waiting for approval. '}
        {readOnly
          ? 'Approved claims go to Xero as draft bills once pushed below.'
          : 'Approved claims go to Pulse for coding review, then to Xero as draft bills.'}
      </p>
    </div>
  )
}
