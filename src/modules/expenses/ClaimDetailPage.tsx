/**
 * Claim detail — creation flow, AI receipt reading and the status timeline
 * (design ref 1g).
 *  · Owner + draft: full editing — batch receipt upload with extract-receipt,
 *    manual lines, submit (mint).
 *  · Pulse bookkeeper/admin on submitted or approved claims: coding edits
 *    (category / fund / VAT) before push — the audit trail is server-side.
 *  · Approved claims: Pulse sees 'Push to Xero' (human trigger, never auto).
 * Draft-only editing is enforced in the UI here; RLS enforces it server-side.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  PageHeader,
  SectionLabel,
  Skeleton,
} from '@/components/ui'
import { formatDateTime, formatMoney, formatPeriod } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { ExpenseLine } from '@/types/db'
import {
  ClaimStatusChip,
  ClaimTimeline,
  DeadlineBanner,
  InfoNotice,
  useDeadline,
} from './components'
import { LineCard, UploadDropzone, UploadJobList, type LineMode, type UploadJob } from './LineEditor'
import {
  approveClaim,
  archiveClaim,
  CLAIM_STATUS_LABELS,
  DEFAULT_MILEAGE_RATE_PENCE,
  deleteClaim,
  deleteLine,
  extractReceipt,
  fetchClaim,
  fetchExpenseCategories,
  fetchFundOptions,
  fetchLines,
  fetchDuplicateWarnings,
  fetchMileageRatePence,
  fileSha256,
  formatDayMonth,
  insertLine,
  needsConfirmation,
  prefillFromExtraction,
  pushClaimToXero,
  receiptPath,
  rejectClaim,
  returnClaim,
  submitClaim,
  sumGross,
  todayIso,
  unarchiveClaim,
  updateClaim,
  updateLine,
  uploadReceipt,
  type ClaimWithSubmitter,
  type DuplicateWarning,
  type StoredExtraction,
} from './lib'

export default function ClaimDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const perms = usePermissions()
  const deadline = useDeadline()

  const claimQ = useSupabaseQuery(() => fetchClaim(id), [id])
  const linesQ = useSupabaseQuery(() => fetchLines(id), [id])
  const fundsQ = useSupabaseQuery(fetchFundOptions, [])
  const catsQ = useSupabaseQuery(fetchExpenseCategories, [])
  const mileageRateQ = useSupabaseQuery(fetchMileageRatePence, [])

  // Local working copies — mutations update these optimistically; the queries
  // remain the source of truth on refetch (e.g. after a manual sync).
  const [claim, setClaim] = useState<ClaimWithSubmitter | null>(null)
  const [lines, setLines] = useState<ExpenseLine[]>([])
  useEffect(() => setClaim(claimQ.data ?? null), [claimQ.data])
  useEffect(() => setLines(linesQ.data ?? []), [linesQ.data])

  // Duplicate receipt warnings, re-checked whenever the lines' fingerprints
  // change (a new upload, an edited date or amount). Advisory only: a failure
  // here must never stop someone claiming, so it degrades to no warnings.
  const [duplicates, setDuplicates] = useState<Map<string, DuplicateWarning[]>>(new Map())
  const lineFingerprint = lines
    .map((l) => `${l.id}:${l.receipt_sha256 ?? ''}:${l.date}:${l.gross}`)
    .join('|')
  useEffect(() => {
    if (!id || lines.length === 0) {
      setDuplicates(new Map())
      return
    }
    let cancelled = false
    void fetchDuplicateWarnings(id)
      .then((m) => {
        if (!cancelled) setDuplicates(m)
      })
      .catch(() => {
        if (!cancelled) setDuplicates(new Map())
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lineFingerprint])

  const [actionError, setActionError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<UploadJob[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const jobSeq = useRef(0)

  // Everything on this screen saves as you go (on blur / on change) — there
  // is deliberately no Save button. This counter drives the "Saving… / saved"
  // cue so that fact is visible.
  const [pendingSaves, setPendingSaves] = useState(0)
  const trackSave = async <T,>(work: Promise<T>): Promise<T> => {
    setPendingSaves((n) => n + 1)
    try {
      return await work
    } finally {
      setPendingSaves((n) => n - 1)
    }
  }

  const funds = fundsQ.data ?? []
  const categories = catsQ.data ?? []

  const isOwner = claim != null && profile != null && claim.submitter_id === profile.id
  const isDraft = claim?.status === 'draft'
  // Pulse can prepare a claim on someone's behalf (RLS + guard allow it);
  // the bookkeeper builds the draft but only the owner or the admin submits.
  const canEditAll = (isOwner || perms.isAdmin || perms.isBookkeeper) && isDraft
  const onBehalf = canEditAll && !isOwner
  const canSubmit = isDraft && (isOwner || perms.isAdmin)
  const isPulseStaff = perms.isBookkeeper || perms.isAdmin
  const underReview = claim?.status === 'submitted' || claim?.status === 'approved'
  const canCode = isPulseStaff && underReview
  const lineMode: LineMode = canEditAll ? 'full' : canCode ? 'coding' : 'read'
  const isArchived = claim?.archived_at != null
  const canPush = isPulseStaff && claim?.status === 'approved' && !isArchived
  // Reviewers can hand a claim back for amendment; the CEO also decides here.
  const canDecide = perms.isCeo && claim?.status === 'submitted'
  const canReview = !isArchived && ((isPulseStaff && underReview) || canDecide)
  const pushedOrPaid = claim?.status === 'pushed_to_xero' || claim?.status === 'paid'
  // Drafts: the owner or the admin. Anything else not yet in Xero: admin only
  // (archive is the reversible alternative). Pushed/paid claims are never deleted.
  const canDelete = claim != null && (isDraft ? isOwner || perms.isAdmin : perms.isAdmin && !pushedOrPaid)
  const canArchive = claim != null && isPulseStaff

  const total = useMemo(() => sumGross(lines), [lines])
  const unconfirmedCount = useMemo(() => lines.filter(needsConfirmation).length, [lines])
  const missingDescriptions = useMemo(
    () => lines.filter((l) => !l.description.trim()).length,
    [lines],
  )
  const missingAmounts = useMemo(() => lines.filter((l) => l.gross === 0).length, [lines])
  const missingDates = useMemo(() => lines.filter((l) => !l.date).length, [lines])

  // ── Mutation helpers (optimistic, with error surface) ─────────────────────

  const fail = (e: unknown, fallback: string) =>
    setActionError(e instanceof Error ? e.message : fallback)

  const persistTotal = (nextLines: ExpenseLine[]) => {
    if (!claim) return
    const t = sumGross(nextLines)
    setClaim((c) => (c ? { ...c, total: t } : c))
    updateClaim(claim.id, { total: t }).catch(() => {
      // best-effort — the definitive total is written again on submit
    })
  }

  const patchLine = async (lineId: string, patch: Partial<ExpenseLine>) => {
    const next = lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l))
    setLines(next)
    setActionError(null)
    try {
      await trackSave(updateLine(lineId, patch))
      if ('gross' in patch) persistTotal(next)
    } catch (e) {
      fail(e, 'Could not save the line')
      linesQ.refetch()
    }
  }

  const confirmLine = (line: ExpenseLine) => {
    const extraction = (line.ai_extraction ?? {}) as StoredExtraction
    const confirmed: StoredExtraction = { ...extraction, user_confirmed: true }
    void patchLine(line.id, { ai_extraction: confirmed })
  }

  const removeLine = async (lineId: string) => {
    const next = lines.filter((l) => l.id !== lineId)
    setLines(next)
    try {
      await deleteLine(lineId)
      persistTotal(next)
    } catch (e) {
      fail(e, 'Could not remove the line')
      linesQ.refetch()
    }
  }

  const addManualLine = async () => {
    if (!claim) return
    setActionError(null)
    try {
      const line = await insertLine(claim.id, {
        date: todayIso(),
        description: '',
        net: 0,
        vat: 0,
        gross: 0,
      })
      setLines((ls) => [...ls, line])
    } catch (e) {
      fail(e, 'Could not add a line')
    }
  }

  // ── Receipt batch upload → extract-receipt → pre-filled lines ─────────────

  const handleFiles = async (files: File[]) => {
    if (!claim || !profile || uploading) return
    setUploading(true)
    setActionError(null)
    for (const file of files) {
      const jobId = ++jobSeq.current
      setJobs((js) => [...js, { id: jobId, name: file.name, status: 'uploading' }])
      const setJob = (patch: Partial<UploadJob>) =>
        setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, ...patch } : j)))
      try {
        const path = receiptPath(claim.submitter_id, claim.id, file.name)
        // Fingerprint before upload so the same photo is recognised later,
        // whoever submits it.
        const sha256 = await fileSha256(file)
        await uploadReceipt(path, file)
        setJob({ status: 'reading' })
        let line: ExpenseLine
        try {
          const { extraction, confidence } = await extractReceipt(path)
          line = await insertLine(claim.id, {
            ...prefillFromExtraction(extraction, confidence, file.name, categories),
            receipt_storage_path: path,
            receipt_sha256: sha256,
          })
          setJob({ status: 'done' })
        } catch {
          // Extraction failed — keep the receipt and let the human fill it in
          line = await insertLine(claim.id, {
            date: todayIso(),
            description: file.name,
            net: 0,
            vat: 0,
            gross: 0,
            receipt_storage_path: path,
            receipt_sha256: sha256,
          })
          setJob({ status: 'error', error: 'could not read it — fill the line in below' })
        }
        setLines((ls) => {
          const next = [...ls, line]
          persistTotal(next)
          return next
        })
      } catch (e) {
        setJob({ status: 'error', error: e instanceof Error ? e.message : 'upload failed' })
      }
    }
    setUploading(false)
  }

  // ── Claim-level actions ────────────────────────────────────────────────────

  const changePeriod = (period: string) => {
    if (!claim || !/^\d{4}-\d{2}$/.test(period)) return
    setClaim((c) => (c ? { ...c, period } : c))
    updateClaim(claim.id, { period }).catch((e) => fail(e, 'Could not change the claim month'))
  }

  const submit = async () => {
    if (!claim || submitting) return
    setSubmitting(true)
    setActionError(null)
    try {
      await submitClaim(claim.id, total)
      setClaim((c) =>
        c ? { ...c, status: 'submitted', submitted_at: new Date().toISOString(), total } : c,
      )
      setJobs([])
    } catch (e) {
      fail(e, 'Could not submit the claim')
    } finally {
      setSubmitting(false)
    }
  }

  const push = async () => {
    if (!claim || pushing) return
    setPushing(true)
    setActionError(null)
    try {
      const result = await pushClaimToXero(claim.id)
      setClaim((c) => (c ? { ...c, status: 'pushed_to_xero', xero_bill_id: result.xero_bill_id } : c))
      if (result.receipts_failed && result.receipts_failed.length > 0) {
        setActionError(
          `The draft bill was created, but ${result.receipts_failed.length} receipt${result.receipts_failed.length === 1 ? '' : 's'} could not be attached (${result.receipts_failed.join(', ')}) — if this mentions scopes, tick accounting.attachments on the Xero app and re-authorise, then add the receipts to the bill by hand this time.`,
        )
      }
    } catch (e) {
      fail(e, 'Could not push the bill to Xero')
    } finally {
      setPushing(false)
    }
  }

  const removeClaim = async () => {
    if (!claim) return
    const message = isDraft
      ? 'Delete this draft claim? Its lines and receipts will be removed.'
      : `Permanently delete this ${CLAIM_STATUS_LABELS[claim.status].toLowerCase()} claim for ${formatMoney(claim.total)}? This cannot be undone — archive it instead if it might be needed again.`
    if (!window.confirm(message)) return
    try {
      await deleteClaim(claim.id)
      navigate('/expenses')
    } catch (e) {
      fail(e, 'Could not delete the claim')
    }
  }

  const toggleArchive = async () => {
    if (!claim || !profile) return
    setActionError(null)
    try {
      if (claim.archived_at) {
        await unarchiveClaim(claim.id)
        setClaim((c) => (c ? { ...c, archived_at: null, archived_by: null } : c))
      } else {
        await archiveClaim(claim.id, profile.id)
        setClaim((c) =>
          c ? { ...c, archived_at: new Date().toISOString(), archived_by: profile.id } : c,
        )
      }
    } catch (e) {
      fail(e, 'Could not update the claim')
    }
  }

  // ── Review: return for amendment / CEO decision ────────────────────────────

  const me = profile ? { full_name: profile.full_name, email: profile.email ?? null } : null

  const returnForAmendment = async () => {
    if (!claim || !profile || reviewBusy) return
    const note = reviewNote.trim()
    if (!note) {
      setReviewError('Add a note so the claimant knows what to change.')
      return
    }
    setReviewBusy(true)
    setReviewError(null)
    try {
      await returnClaim(claim.id, note)
      setClaim((c) =>
        c
          ? {
              ...c,
              status: 'draft',
              review_note: note,
              returned_by: profile.id,
              returned_at: new Date().toISOString(),
              returner: me,
              ceo_approved_by: null,
              ceo_approved_at: null,
              approver: null,
            }
          : c,
      )
      setReviewNote('')
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'Could not return the claim')
    } finally {
      setReviewBusy(false)
    }
  }

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!claim || !profile || reviewBusy) return
    const note = reviewNote.trim()
    if (decision === 'rejected' && !note) {
      setReviewError('Give the claimant a reason for the rejection.')
      return
    }
    setReviewBusy(true)
    setReviewError(null)
    try {
      if (decision === 'approved') await approveClaim(claim.id, profile.id, note || undefined)
      else await rejectClaim(claim.id, profile.id, note)
      setClaim((c) =>
        c
          ? {
              ...c,
              status: decision,
              ceo_approved_by: profile.id,
              ceo_approved_at: new Date().toISOString(),
              ceo_comment: note || null,
              approver: me,
            }
          : c,
      )
      setReviewNote('')
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'Could not record the decision')
    } finally {
      setReviewBusy(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (claimQ.loading) {
    return (
      <div>
        <Skeleton className="h-9 w-64 mb-6" />
        <Card>
          <LoadingRows cols={4} rows={6} />
        </Card>
      </div>
    )
  }
  if (claimQ.error) {
    return <ErrorNotice message={claimQ.error} />
  }
  if (!claim) {
    return (
      <Card>
        <EmptyState
          title="Claim not found"
          hint="It may have been deleted, or you may not have access to it."
          action={
            <Link to="/expenses" className="text-indigo underline underline-offset-2 text-[12.5px]">
              Back to expenses
            </Link>
          }
        />
      </Card>
    )
  }

  const submitBlockers: string[] = []
  if (lines.length === 0) submitBlockers.push('add at least one line')
  if (missingDescriptions > 0)
    submitBlockers.push(
      `${missingDescriptions} ${missingDescriptions === 1 ? 'line needs' : 'lines need'} a description`,
    )
  if (missingAmounts > 0)
    submitBlockers.push(
      `${missingAmounts} ${missingAmounts === 1 ? 'line needs' : 'lines need'} an amount`,
    )
  if (missingDates > 0)
    submitBlockers.push(`${missingDates} ${missingDates === 1 ? 'line needs' : 'lines need'} a date`)
  if (unconfirmedCount > 0)
    submitBlockers.push(
      `${unconfirmedCount} AI-read ${unconfirmedCount === 1 ? 'line needs' : 'lines need'} your check`,
    )

  return (
    <div>
      <PageHeader
        title={
          canEditAll
            ? claim.returned_at
              ? 'Amend expense claim'
              : 'New expense claim'
            : `Expense claim — ${formatPeriod(claim.period)}`
        }
        subtitle={
          <span className="inline-flex items-center gap-2 flex-wrap">
            {claim.submitter?.full_name ?? 'Your claim'} · {formatPeriod(claim.period)}
            <ClaimStatusChip status={claim.status} />
            {isArchived ? <span className="text-[11px] text-stone-500">archived</span> : null}
            {onBehalf ? (
              <span className="text-[11px] text-stone-500">entered by Pulse on their behalf</span>
            ) : null}
          </span>
        }
        actions={
          <>
            {canDelete ? (
              <Button variant="quiet" onClick={() => void removeClaim()}>
                {isDraft ? 'Delete draft' : 'Delete claim'}
              </Button>
            ) : null}
            {canArchive ? (
              <Button variant="quiet" onClick={() => void toggleArchive()}>
                {isArchived ? 'Restore from archive' : 'Archive'}
              </Button>
            ) : null}
            {perms.canApprove && claim.status === 'submitted' ? (
              <Button variant="ghost" onClick={() => navigate('/expenses/approvals')}>
                Open approval queue
              </Button>
            ) : null}
            {canPush ? (
              <Button variant="money" onClick={() => void push()} disabled={pushing}>
                {pushing ? 'Pushing…' : 'Push to Xero'}
              </Button>
            ) : null}
          </>
        }
      />

      {canEditAll ? <DeadlineBanner mode="submit" deadline={deadline} /> : null}
      {actionError ? (
        <div className="mb-4">
          <ErrorNotice message={actionError} />
        </div>
      ) : null}

      {isArchived ? (
        <div className="mb-4">
          <InfoNotice tone="warn">
            This claim is archived — it stays out of the working lists and the approval queue. Restore
            it to bring it back.
          </InfoNotice>
        </div>
      ) : null}

      {claim.status === 'rejected' && claim.ceo_comment ? (
        <div className="mb-4">
          <InfoNotice tone="warn">
            <b>Rejected{claim.approver ? ` by ${claim.approver.full_name}` : ' by the CEO'}:</b>{' '}
            {claim.ceo_comment}
          </InfoNotice>
        </div>
      ) : null}

      {claim.status === 'draft' && claim.returned_at && claim.review_note ? (
        <div className="mb-4">
          <InfoNotice tone="warn">
            <b>Returned for amendment{claim.returner ? ` by ${claim.returner.full_name}` : ''}</b> on{' '}
            {formatDateTime(claim.returned_at)}: {claim.review_note}
            {isOwner ? ' — make the changes below and submit again.' : ''}
          </InfoNotice>
        </div>
      ) : null}

      <div className="grid lg:grid-cols-[1fr_300px] gap-5 items-start">
        <div className="space-y-4 min-w-0">
          {canEditAll ? (
            <Card className="p-4 sm:p-5">
              <SectionLabel>Claim month</SectionLabel>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="month"
                  value={claim.period}
                  onChange={(e) => changePeriod(e.target.value)}
                  className="input-base !w-auto py-1.5 text-[12px]"
                  aria-label="Claim month"
                />
                <span className="text-[11.5px] text-stone-500">
                  Defaults to the current month — expenses from earlier months can go on the same claim.
                </span>
              </div>
            </Card>
          ) : null}

          {canEditAll ? (
            <>
              <UploadDropzone onFiles={(files) => void handleFiles(files)} disabled={uploading} />
              <UploadJobList jobs={jobs} />
            </>
          ) : null}

          {canCode ? (
            <InfoNotice tone="mint">
              Pulse review — you can adjust the coding (category, fund) and correct the amounts (net,
              VAT, miles) right up until this claim is pushed to Xero. Every edit is audit-logged.
            </InfoNotice>
          ) : null}

          <div>
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <span className="inline-flex items-baseline gap-2.5">
                <SectionLabel>
                  Lines{lines.length > 0 ? ` · ${lines.length}` : ''}
                </SectionLabel>
                {canEditAll ? (
                  <span
                    className={`text-[10.5px] ${pendingSaves > 0 ? 'text-cyan-700' : 'text-stone-400'}`}
                    aria-live="polite"
                  >
                    {pendingSaves > 0 ? 'Saving…' : 'changes save automatically'}
                  </span>
                ) : null}
              </span>
              {canEditAll ? (
                <Button size="sm" variant="ghost" onClick={() => void addManualLine()}>
                  Add a line manually
                </Button>
              ) : null}
            </div>
            {linesQ.loading ? (
              <Card>
                <LoadingRows cols={4} rows={3} />
              </Card>
            ) : linesQ.error ? (
              <ErrorNotice message={linesQ.error} />
            ) : lines.length === 0 ? (
              <Card>
                <EmptyState
                  title="No lines yet"
                  hint={
                    canEditAll
                      ? 'Drop your receipts above — we read the date, merchant and amounts for you — or add a line manually.'
                      : 'This claim has no lines.'
                  }
                />
              </Card>
            ) : (
              <div className="space-y-3">
                {lines.map((line) => (
                  <LineCard
                    key={line.id}
                    line={line}
                    categories={categories}
                    funds={funds}
                    mode={lineMode}
                    mileageRatePence={mileageRateQ.data ?? DEFAULT_MILEAGE_RATE_PENCE}
                    duplicates={duplicates.get(line.id)}
                    onPatch={(patch) => void patchLine(line.id, patch)}
                    onDelete={canEditAll ? () => void removeLine(line.id) : undefined}
                    onConfirm={canEditAll ? () => confirmLine(line) : undefined}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Total strip */}
          {lines.length > 0 ? (
            <div className="bg-paper-2 border border-stone-150 rounded-card px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
              <span className="text-[12.5px] font-medium text-ink">
                Claim total
                {isDraft ? (
                  <span className="block text-[10.5px] font-normal text-stone-500 mt-0.5">
                    saved as a draft — safe to leave and come back
                  </span>
                ) : null}
              </span>
              <span className="font-mono text-[15px] font-medium text-ink">{formatMoney(total)}</span>
            </div>
          ) : null}

          {/* Submit — the owner or the Pulse admin */}
          {canSubmit ? (
            <div className="space-y-3">
              {deadline ? (
                deadline.rolled ? (
                  <InfoNotice tone="warn">
                    This month's run has closed — submit now and, once approved, this will be paid on{' '}
                    <b>{formatDayMonth(deadline.paymentDate)}</b>.
                  </InfoNotice>
                ) : (
                  <InfoNotice tone="mint">
                    <b>You're in time.</b> Submit today and, once the CEO approves it by{' '}
                    {formatDayMonth(deadline.approvalDate)}, this will be paid in the{' '}
                    {formatDayMonth(deadline.paymentDate)} run.
                  </InfoNotice>
                )
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="money"
                  onClick={() => void submit()}
                  disabled={submitting || submitBlockers.length > 0}
                  className="px-7 py-3 text-[13px]"
                >
                  {submitting ? 'Submitting…' : `Submit claim — ${formatMoney(total)}`}
                </Button>
                {submitBlockers.length > 0 ? (
                  <span className="text-[11.5px] text-stone-500">
                    Before you submit: {submitBlockers.join(' · ')}.
                  </span>
                ) : null}
              </div>
            </div>
          ) : canEditAll ? (
            <p className="text-[11.5px] text-stone-500">
              Bookkeepers prepare claims — the claimant or the Pulse admin submits it for approval.
            </p>
          ) : null}
        </div>

        <div className="space-y-4">
          {/* Status timeline */}
          <Card className="p-4 sm:p-5">
            <SectionLabel>Progress</SectionLabel>
            <ClaimTimeline claim={claim} />
            {claim.status !== 'rejected' && claim.ceo_comment ? (
              <p className="text-[11.5px] text-stone-500 mt-3 border-t border-stone-150 pt-3">
                CEO comment: {claim.ceo_comment}
              </p>
            ) : null}
          </Card>

          {/* Review — return for amendment; the CEO also approves/rejects here */}
          {canReview ? (
            <Card className="p-4 sm:p-5">
              <SectionLabel>Review</SectionLabel>
              <p className="text-[11.5px] text-stone-600 leading-relaxed mb-2.5">
                {canDecide
                  ? 'Approve, reject, or send it back to the claimant with a note to amend and resubmit.'
                  : 'Send this claim back to the claimant with a note — they amend it, resubmit, and it comes back through approval.'}
              </p>
              <textarea
                className="input-base text-[12px] min-h-[76px] resize-y"
                placeholder={
                  canDecide ? 'Note to the claimant — required to reject or return' : 'What needs changing?'
                }
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                disabled={reviewBusy}
                aria-label="Review note"
              />
              <div className="flex flex-wrap gap-2 mt-2.5">
                {canDecide ? (
                  <Button size="sm" variant="money" onClick={() => void decide('approved')} disabled={reviewBusy}>
                    Approve
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void returnForAmendment()} disabled={reviewBusy}>
                  Return for amendment
                </Button>
                {canDecide ? (
                  <Button size="sm" variant="quiet" onClick={() => void decide('rejected')} disabled={reviewBusy}>
                    Reject
                  </Button>
                ) : null}
              </div>
              {reviewError ? <p className="text-[11px] text-danger-ink mt-2">{reviewError}</p> : null}
              {claim.status === 'approved' ? (
                <p className="text-[10.5px] text-stone-500 mt-2.5 leading-relaxed">
                  Returning an approved claim clears the CEO's approval — the amended claim is approved
                  afresh.
                </p>
              ) : null}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
