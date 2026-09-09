/**
 * Reconciliation — the differences that need investigating, in one place.
 *
 * Three checks, each stated as two figures and the gap between them, with the
 * drill-down that turns "there is a £15,366 difference" into "these are the
 * eleven lines that have no fund on them". A check that cannot be evaluated
 * says so rather than showing a tick: the whole point of this page is that a
 * green light means something.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  ErrorNotice,
  Input,
  LoadingRows,
  PageHeader,
  SectionLabel,
  StatusChip,
  cx,
} from '@/components/ui'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { fetchXeroReport } from '@/modules/financials/lib'
import { Segmented } from '@/modules/reports/components'
import {
  buildReconChecks,
  checksSummary,
  fetchFundTotals,
  fetchReconSignoffs,
  fetchUnallocatedPlLines,
  fetchWholeBusinessPl,
  indexReportRows,
  signOffCheck,
  signoffState,
  withdrawSignoff,
  type ReconCheck,
  type SignoffState,
} from './lib'

// GAUFCC's financial year runs 1 October – 30 September.
const FY_START_MONTH = 9 // 0-indexed October

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fyRange(offset: number, today = new Date()): { start: string; end: string; label: string } {
  const base = today.getMonth() >= FY_START_MONTH ? today.getFullYear() : today.getFullYear() - 1
  const year = base + offset
  return {
    start: iso(new Date(year, FY_START_MONTH, 1)),
    end: iso(new Date(year + 1, FY_START_MONTH, 0)),
    label: `FY ${String(year).slice(2)}/${String(year + 1).slice(2)}`,
  }
}

function monthToDate(today = new Date()): { start: string; end: string; label: string } {
  const start = new Date(today.getFullYear(), today.getMonth(), 1)
  return {
    start: iso(start),
    end: iso(today),
    label: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
  }
}

type PeriodKey = 'fy' | 'prior_fy' | 'mtd'

const PERIOD_OPTIONS: Array<{ value: PeriodKey; label: string }> = [
  { value: 'fy', label: 'This financial year' },
  { value: 'prior_fy', label: 'Last financial year' },
  { value: 'mtd', label: 'Month to date' },
]

const STATUS_TONE = {
  agreed: 'good',
  difference: 'danger',
  indeterminate: 'warn',
} as const

const STATUS_LABEL = {
  agreed: 'Agreed',
  difference: 'Difference',
  indeterminate: 'Cannot check',
} as const

export default function ReconciliationPage() {
  const { profile } = useAuth()
  const { isPulse, isCeo } = usePermissions()
  const canSign = isPulse || isCeo
  const [periodKey, setPeriodKey] = useState<PeriodKey>('fy')
  const [open, setOpen] = useState<string | null>(null)

  const period = useMemo(() => {
    if (periodKey === 'mtd') return monthToDate()
    return fyRange(periodKey === 'prior_fy' ? -1 : 0)
  }, [periodKey])

  const plQ = useSupabaseQuery(() => fetchWholeBusinessPl(period), [period.start, period.end])
  const fundsQ = useSupabaseQuery(fetchFundTotals, [])
  const unallocatedQ = useSupabaseQuery(
    () => fetchUnallocatedPlLines(period),
    [period.start, period.end],
  )
  const signoffsQ = useSupabaseQuery(() => fetchReconSignoffs(period), [period.start, period.end])

  // Net assets can only come from Xero — the mirror holds no journal-level
  // data, so it cannot produce a complete balance sheet.
  const bsQ = useSupabaseQuery(
    async () => {
      const report = await fetchXeroReport('BalanceSheet', { date: period.end })
      return indexReportRows(report)
    },
    [period.end],
  )

  const checks = useMemo<ReconCheck[] | null>(() => {
    if (!plQ.data || !fundsQ.data) return null
    return buildReconChecks({
      pl: plQ.data,
      funds: fundsQ.data,
      balanceSheet: bsQ.data ?? null,
      balanceSheetError: bsQ.error ?? null,
      periodLabel: period.label,
    })
  }, [plQ.data, fundsQ.data, bsQ.data, bsQ.error, period.label])

  const summary = checks ? checksSummary(checks) : null
  const signoffs = signoffsQ.data ?? []
  const states = useMemo(
    () => new Map((checks ?? []).map((c) => [c.id, signoffState(c, signoffs)])),
    [checks, signoffs],
  )
  const signedCount = [...states.values()].filter((st) => st.kind === 'signed').length
  const supersededCount = [...states.values()].filter((st) => st.kind === 'superseded').length
  const loading = (plQ.loading && !plQ.data) || (fundsQ.loading && !fundsQ.data)
  const queryError = plQ.error ?? fundsQ.error

  return (
    <div>
      <PageHeader
        title="Reconciliation"
        subtitle="Differences between the fund reporting and the statutory position that need investigating"
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented options={PERIOD_OPTIONS} value={periodKey} onChange={setPeriodKey} />
        <span className="text-[11.5px] text-stone-500">
          {formatDate(period.start)} – {formatDate(period.end)}
        </span>
      </div>

      {queryError ? (
        <div className="mb-4">
          <ErrorNotice message={`The reconciliation could not be built — ${queryError}`} />
        </div>
      ) : null}

      {plQ.data?.truncated ? (
        <div className="mb-4 rounded-card border border-warn/50 bg-warn/10 text-warn-ink text-[12.5px] px-4 py-3">
          <b className="font-medium">These figures are incomplete.</b> The period holds more ledger lines than
          the page reads in one go, so treat every check below as unreliable until the period is narrowed.
        </div>
      ) : null}

      {loading ? (
        <Card>
          <LoadingRows cols={3} rows={6} />
        </Card>
      ) : null}

      {summary && checks ? (
        <>
          <Card className="px-5 py-4 mb-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <SectionLabel>Position</SectionLabel>
                <p className="text-[13px] text-stone-700 mt-0.5">
                  {summary.allAgreed
                    ? 'Everything reconciles. Nothing needs investigating.'
                    : summary.differences > 0
                      ? `${summary.differences} of ${checks.length} checks show a difference.`
                      : `${summary.indeterminate} of ${checks.length} checks could not be evaluated.`}
                </p>
                <p className="text-[11.5px] text-stone-500 mt-1">
                  {signedCount === checks.length
                    ? 'Every check is signed off against the figures as they stand — these figures are robust.'
                    : supersededCount > 0
                      ? `${supersededCount} sign-off${supersededCount === 1 ? '' : 's'} no longer cover${supersededCount === 1 ? 's' : ''} the current figures and need re-signing.`
                      : `${signedCount} of ${checks.length} signed off. A sign-off records the figures it was given and lapses if they move.`}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {summary.agreed > 0 ? <StatusChip tone="good">{summary.agreed} agreed</StatusChip> : null}
                {summary.differences > 0 ? (
                  <StatusChip tone="danger">{summary.differences} to investigate</StatusChip>
                ) : null}
                {summary.indeterminate > 0 ? (
                  <StatusChip tone="warn">{summary.indeterminate} cannot check</StatusChip>
                ) : null}
                {signedCount > 0 ? <StatusChip tone="indigo">{signedCount} signed off</StatusChip> : null}
                {supersededCount > 0 ? (
                  <StatusChip tone="warn">{supersededCount} to re-sign</StatusChip>
                ) : null}
              </div>
            </div>
          </Card>

          <div className="space-y-4">
            {checks.map((check) => (
              <Card key={check.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-[14px] font-medium text-ink">{check.title}</h3>
                      <StatusChip tone={STATUS_TONE[check.status]}>{STATUS_LABEL[check.status]}</StatusChip>
                    </div>
                    <p className="text-[11.5px] text-stone-500 mt-1 max-w-2xl">{check.purpose}</p>
                  </div>
                  {check.difference !== null && check.status === 'difference' ? (
                    <div className="text-right">
                      <div className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">
                        Difference
                      </div>
                      <div className="figure text-[17px] text-danger-ink">{formatMoney(check.difference)}</div>
                    </div>
                  ) : null}
                </div>

                <div className="grid sm:grid-cols-2 gap-3 mt-4">
                  <Figure label={check.leftLabel} value={check.left} />
                  <Figure label={check.rightLabel} value={check.right} />
                </div>

                <p
                  className={cx(
                    'text-[12px] mt-3 max-w-2xl',
                    check.status === 'agreed' ? 'text-stone-600' : 'text-stone-700',
                  )}
                >
                  {check.explanation}
                </p>

                <div className="flex flex-wrap items-center gap-3 mt-3">
                  {check.actionTo && check.actionLabel ? (
                    <Link
                      to={check.actionTo}
                      className="text-indigo underline underline-offset-2 text-[12px] font-medium"
                    >
                      {check.actionLabel}
                    </Link>
                  ) : null}
                  {check.id === 'fund_result_vs_pl' && (unallocatedQ.data ?? []).length > 0 ? (
                    <button
                      onClick={() => setOpen(open === check.id ? null : check.id)}
                      className="text-indigo hover:underline underline-offset-2 text-[12px]"
                    >
                      {open === check.id ? 'Hide' : 'Show'} the {(unallocatedQ.data ?? []).length} line
                      {(unallocatedQ.data ?? []).length === 1 ? '' : 's'} with no fund
                    </button>
                  ) : null}
                </div>

                {open === check.id && check.id === 'fund_result_vs_pl' ? (
                  <UnallocatedTable rows={unallocatedQ.data ?? []} />
                ) : null}

                <SignoffPanel
                  check={check}
                  state={states.get(check.id) ?? { kind: 'unsigned' }}
                  canSign={canSign}
                  onSign={async (note) => {
                    if (!profile) return
                    await signOffCheck(check, period, profile.id, note)
                    signoffsQ.refetch()
                  }}
                  onWithdraw={async (id) => {
                    await withdrawSignoff(id)
                    signoffsQ.refetch()
                  }}
                />
              </Card>
            ))}
          </div>

          {plQ.data ? (
            <Card className="px-5 py-4 mt-5">
              <SectionLabel>How the whole-charity result is made up</SectionLabel>
              <p className="text-[11.5px] text-stone-500 mt-0.5 mb-3">
                Every revenue and expenditure line in {period.label}, on SORP headings. This is the figure the
                third check compares the funds against.
              </p>
              <div className="grid sm:grid-cols-3 gap-3">
                <Figure label="Total income" value={plQ.data.totalIncome} />
                <Figure label="Total expenditure" value={plQ.data.totalExpenditure} />
                <Figure label="Net result" value={plQ.data.net} emphasise />
              </div>
              <p className="text-[11px] text-stone-500 mt-3">
                {plQ.data.lineCount.toLocaleString('en-GB')} ledger lines read.{' '}
                {plQ.data.unallocatedNet === 0
                  ? 'Every one of them carries a fund.'
                  : `${formatMoney(plQ.data.unallocatedNet)} of that net result carries no fund.`}
              </p>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/**
 * Sign-off for one check.
 *
 * Three states are worth distinguishing and the UI shows all three: unsigned,
 * signed against the figures on screen, and signed against figures that have
 * since moved. The last is the one that matters — it is why the sign-off
 * stores the figures rather than just a tick.
 *
 * Signing a check that shows a difference demands a reason. A difference
 * waved through without one is precisely what this is meant to stop, so the
 * note is required in that case and optional otherwise.
 */
function SignoffPanel({
  check,
  state,
  canSign,
  onSign,
  onWithdraw,
}: {
  check: ReconCheck
  state: SignoffState
  canSign: boolean
  onSign: (note: string | null) => Promise<void>
  onWithdraw: (id: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const noteRequired = check.status !== 'agreed'
  const canSubmit = canSign && !busy && (!noteRequired || note.trim().length > 0)

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setNote('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The sign-off could not be saved')
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'signed') {
    return (
      <div className="mt-4 pt-3 border-t border-stone-150 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11.5px] text-stone-600">
          <StatusChip tone="good" className="mr-2">
            Signed off
          </StatusChip>
          {state.signoff.signer_name ?? 'Signed'} · {formatDateTime(state.signoff.signed_at)}
          {state.signoff.note ? <span className="text-stone-500"> — {state.signoff.note}</span> : null}
        </div>
        {canSign ? (
          <button
            disabled={busy}
            onClick={() => void run(() => onWithdraw(state.signoff.id))}
            className="text-[11.5px] text-stone-500 hover:text-danger-ink underline underline-offset-2"
          >
            Withdraw
          </button>
        ) : null}
        {error ? <ErrorNotice message={error} /> : null}
      </div>
    )
  }

  if (state.kind === 'superseded') {
    return (
      <div className="mt-4 pt-3 border-t border-stone-150">
        <div className="rounded-card border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[11.5px] text-warn-ink">
          <b className="font-medium">This sign-off no longer covers the figures.</b>{' '}
          {state.signoff.signer_name ?? 'Signed'} signed it on {formatDateTime(state.signoff.signed_at)} when
          the difference stood at{' '}
          {state.signoff.difference === null ? 'nil' : formatMoney(state.signoff.difference)}
          {state.movedBy !== null ? `; it has moved by ${formatMoney(state.movedBy)} since` : ''}. Re-check the
          figures and sign again.
        </div>
        {canSign ? (
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={noteRequired ? 'Why is this acceptable? (required)' : 'Note (optional)'}
              className="max-w-md text-[12px]"
            />
            <Button
              variant="money"
              size="sm"
              disabled={!canSubmit}
              onClick={() => void run(() => onSign(note))}
            >
              {busy ? 'Signing…' : 'Sign off again'}
            </Button>
          </div>
        ) : null}
        {error ? <ErrorNotice message={error} /> : null}
      </div>
    )
  }

  return (
    <div className="mt-4 pt-3 border-t border-stone-150">
      {canSign ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              noteRequired
                ? 'Why is this acceptable? (required to sign off a difference)'
                : 'Note (optional)'
            }
            className="max-w-md text-[12px]"
          />
          <Button
            variant="money"
            size="sm"
            disabled={!canSubmit}
            onClick={() => void run(() => onSign(note))}
          >
            {busy ? 'Signing…' : 'Check off'}
          </Button>
          <span className="text-[11px] text-stone-500">
            {noteRequired
              ? 'Records the figures as they stand, so the sign-off lapses if they move.'
              : 'Records who checked it and against which figures.'}
          </span>
        </div>
      ) : (
        <p className="text-[11.5px] text-stone-500">Not yet signed off.</p>
      )}
      {error ? <ErrorNotice message={error} /> : null}
    </div>
  )
}

function Figure({
  label,
  value,
  emphasise,
}: {
  label: string
  value: number | null
  emphasise?: boolean
}) {
  return (
    <div className="border border-stone-150 rounded-control px-3.5 py-2.5 bg-paper">
      <div className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">{label}</div>
      <div
        className={cx(
          'figure mt-1',
          emphasise ? 'text-[17px] text-ink' : 'text-[15px] text-ink',
          value !== null && value < 0 && 'text-danger-ink',
        )}
      >
        {value === null ? <span className="text-stone-400 text-[13px]">not available</span> : formatMoney(value)}
      </div>
    </div>
  )
}

function UnallocatedTable({
  rows,
}: {
  rows: Array<{
    id: string
    date: string
    source_type: string
    description: string | null
    account_code: string | null
    account_name: string | null
    contact_name: string | null
    net: number
  }>
}) {
  return (
    <div className="mt-3 border border-stone-150 rounded-control overflow-hidden">
      <div className="overflow-x-auto max-h-96">
        <table className="w-full text-[11.5px]">
          <thead className="bg-paper-2 sticky top-0">
            <tr>
              <th className="th-register text-left">Date</th>
              <th className="th-register text-left">Description</th>
              <th className="th-register text-left">Account</th>
              <th className="th-register text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-stone-150">
                <td className="td-register whitespace-nowrap">{formatDate(r.date)}</td>
                <td className="td-register">
                  {r.description || r.contact_name || <span className="text-stone-400">no description</span>}
                </td>
                <td className="td-register text-stone-500 whitespace-nowrap">
                  {r.account_code ? `${r.account_code} · ` : ''}
                  {r.account_name ?? '—'}
                </td>
                <td className={cx('td-register figure text-right whitespace-nowrap', r.net < 0 && 'text-danger-ink')}>
                  {formatMoney(r.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-stone-500 px-3.5 py-2 bg-paper-2 border-t border-stone-150">
        Each of these needs a Fund tracking option in Xero. Once coded and re-synced they drop off this list and
        the check agrees.
      </p>
    </div>
  )
}
