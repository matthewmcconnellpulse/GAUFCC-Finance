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
import { formatMoney, formatPeriod } from '@/lib/format'
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
  deleteClaim,
  deleteLine,
  extractReceipt,
  fetchClaim,
  fetchExpenseCategories,
  fetchFundOptions,
  fetchLines,
  formatDayMonth,
  insertLine,
  needsConfirmation,
  prefillFromExtraction,
  pushClaimToXero,
  receiptPath,
  submitClaim,
  sumGross,
  todayIso,
  updateClaim,
  updateLine,
  uploadReceipt,
  type ClaimWithSubmitter,
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

  // Local working copies — mutations update these optimistically; the queries
  // remain the source of truth on refetch (e.g. after a manual sync).
  const [claim, setClaim] = useState<ClaimWithSubmitter | null>(null)
  const [lines, setLines] = useState<ExpenseLine[]>([])
  useEffect(() => setClaim(claimQ.data ?? null), [claimQ.data])
  useEffect(() => setLines(linesQ.data ?? []), [linesQ.data])

  const [actionError, setActionError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<UploadJob[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const jobSeq = useRef(0)

  const funds = fundsQ.data ?? []
  const categories = catsQ.data ?? []

  const isOwner = claim != null && profile != null && claim.submitter_id === profile.id
  const isDraft = claim?.status === 'draft'
  // Pulse can prepare a claim on someone's behalf (RLS + guard allow it);
  // the bookkeeper builds the draft but only the owner or the admin submits.
  const canEditAll = (isOwner || perms.isAdmin || perms.isBookkeeper) && isDraft
  const onBehalf = canEditAll && !isOwner
  const canSubmit = isDraft && (isOwner || perms.isAdmin)
  const canDeleteDraft = isDraft && (isOwner || perms.isAdmin)
  const canCode =
    (perms.isBookkeeper || perms.isAdmin) &&
    (claim?.status === 'submitted' || claim?.status === 'approved')
  const lineMode: LineMode = canEditAll ? 'full' : canCode ? 'coding' : 'read'
  const canPush = (perms.isBookkeeper || perms.isAdmin) && claim?.status === 'approved'

  const total = useMemo(() => sumGross(lines), [lines])
  const unconfirmedCount = useMemo(() => lines.filter(needsConfirmation).length, [lines])
  const incompleteCount = useMemo(
    () => lines.filter((l) => !l.description.trim() || !l.date || l.gross === 0).length,
    [lines],
  )

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
      await updateLine(lineId, patch)
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
        await uploadReceipt(path, file)
        setJob({ status: 'reading' })
        let line: ExpenseLine
        try {
          const { extraction, confidence } = await extractReceipt(path)
          line = await insertLine(claim.id, {
            ...prefillFromExtraction(extraction, confidence, file.name, categories),
            receipt_storage_path: path,
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
      const { xero_bill_id } = await pushClaimToXero(claim.id)
      setClaim((c) => (c ? { ...c, status: 'pushed_to_xero', xero_bill_id } : c))
    } catch (e) {
      fail(e, 'Could not push the bill to Xero')
    } finally {
      setPushing(false)
    }
  }

  const removeDraft = async () => {
    if (!claim) return
    if (!window.confirm('Delete this draft claim? Its lines and receipts will be removed.')) return
    try {
      await deleteClaim(claim.id)
      navigate('/expenses')
    } catch (e) {
      fail(e, 'Could not delete the draft')
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
  if (incompleteCount > 0)
    submitBlockers.push(
      `${incompleteCount} ${incompleteCount === 1 ? 'line needs' : 'lines need'} a description and an amount`,
    )
  if (unconfirmedCount > 0)
    submitBlockers.push(
      `${unconfirmedCount} AI-read ${unconfirmedCount === 1 ? 'line needs' : 'lines need'} your check`,
    )

  return (
    <div>
      <PageHeader
        title={canEditAll ? 'New expense claim' : `Expense claim — ${formatPeriod(claim.period)}`}
        subtitle={
          <span className="inline-flex items-center gap-2 flex-wrap">
            {claim.submitter?.full_name ?? 'Your claim'} · {formatPeriod(claim.period)}
            <ClaimStatusChip status={claim.status} />
            {onBehalf ? (
              <span className="text-[11px] text-stone-500">entered by Pulse on their behalf</span>
            ) : null}
          </span>
        }
        actions={
          <>
            {canDeleteDraft ? (
              <Button variant="quiet" onClick={() => void removeDraft()}>
                Delete draft
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

      {claim.status === 'rejected' && claim.ceo_comment ? (
        <div className="mb-4">
          <InfoNotice tone="warn">
            <b>Rejected by the CEO:</b> {claim.ceo_comment}
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
              Pulse review — you can adjust the coding (category, fund, VAT) before this claim is
              pushed to Xero. Every edit is audit-logged.
            </InfoNotice>
          ) : null}

          <div>
            <div className="flex items-center justify-between mb-2.5">
              <SectionLabel>
                Lines{lines.length > 0 ? ` · ${lines.length}` : ''}
              </SectionLabel>
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
            <div className="bg-paper-2 border border-stone-150 rounded-card px-4 sm:px-5 py-3 flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-ink">Claim total</span>
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
      </div>
    </div>
  )
}
