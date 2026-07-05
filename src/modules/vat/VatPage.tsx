/**
 * VAT — partial exemption de minimis module.
 *
 * Access: Pulse (edit) · CEO and trustees (read-only). The calculation lives
 * in vatCalc.ts (VAT Notice 706); this page presents it trustee-first:
 * recoverable vs irrecoverable cards, pass/fail chips in plain English, a
 * year view with the annual adjustment, the registration case, an AI
 * "explain this for the board" narrative (labelled, editable) and a
 * printable one-pager for board packs.
 */
import { useMemo, useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import {
  AiBadge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  PageHeader,
  Skeleton,
  StatusChip,
  Textarea,
  cx,
} from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { invokeFunction } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { VatPeriod } from '@/types/db'
import {
  deleteVatPeriod,
  fetchRollingTurnover,
  fetchVatPeriods,
  inputFromPeriod,
  updateVatPeriod,
} from './lib'
import {
  annualAdjustment,
  calculatePartialExemption,
  periodKind,
  periodLabel,
  periodMonths,
  periodYear,
  REGISTRATION_THRESHOLD,
  type AnnualAdjustment,
  type VatCalcResult,
} from './vatCalc'
import { DeMinimisPanel, StatCard, WorkingTable } from './components'
import PeriodEditor from './PeriodEditor'
import RegistrationPanel from './RegistrationPanel'
import OnePager from './OnePager'

interface NarrativeState {
  text: string
  source: 'human' | 'ai' | 'ai_edited'
}

export default function VatPage() {
  const { isPulse, isCeo, isTrustee } = usePermissions()
  const canView = isPulse || isCeo || isTrustee
  const canEdit = isPulse
  const canUseAi = isPulse || isCeo

  const periodsQuery = useSupabaseQuery(() => fetchVatPeriods(), [])
  const turnoverQuery = useSupabaseQuery(() => fetchRollingTurnover(), [])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<'new' | VatPeriod | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Narrative editor state, keyed by period id so switching periods is safe
  const [narratives, setNarratives] = useState<Record<string, NarrativeState>>({})
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [savingNarrative, setSavingNarrative] = useState(false)
  const [narrativeSaved, setNarrativeSaved] = useState(false)

  const [manualTurnover, setManualTurnover] = useState('')

  const periods = periodsQuery.data ?? []
  const selected = useMemo<VatPeriod | null>(() => {
    if (periods.length === 0) return null
    return periods.find((p) => p.id === selectedId) ?? periods[periods.length - 1]
  }, [periods, selectedId])

  /** Everything on screen is calculated live from the stored inputs, so the
   *  figures always agree with vatCalc even if the stored jsonb predates a
   *  calculation change. Saving re-stores the fresh result. */
  const result = useMemo<VatCalcResult | null>(() => {
    if (!selected) return null
    return calculatePartialExemption(inputFromPeriod(selected, periodMonths(selected.period)))
  }, [selected])

  // Year view: all periods sharing the selected period's leading year
  const yearRows = useMemo(() => {
    if (!selected) return []
    const year = periodYear(selected.period)
    return periods
      .filter((p) => periodYear(p.period) === year)
      .map((p) => ({
        period: p.period,
        row: p,
        result: calculatePartialExemption(inputFromPeriod(p, periodMonths(p.period))),
      }))
  }, [periods, selected])

  // Annual adjustment: only meaningful over sub-year periods (a 'YYYY' row is
  // already the longer period, and mixing it with quarters would double count)
  const yearAdj = useMemo<AnnualAdjustment | null>(() => {
    const subYear = yearRows.filter((r) => periodKind(r.period) !== 'year')
    if (subYear.length < 2 || subYear.length !== yearRows.length) return null
    return annualAdjustment(
      subYear.map((r) => inputFromPeriod(r.row, periodMonths(r.period))),
    )
  }, [yearRows])

  const annualResult = yearAdj ? yearAdj.annual : yearRows.length === 1 ? yearRows[0].result : null

  const manualValue = useMemo(() => {
    const n = Number(manualTurnover.replace(/,/g, ''))
    return Number.isFinite(n) && manualTurnover.trim() !== '' ? n : null
  }, [manualTurnover])
  const effectiveTurnover = manualValue ?? turnoverQuery.data?.total ?? null

  const narrative: NarrativeState = selected
    ? narratives[selected.id] ?? { text: selected.narrative ?? '', source: 'human' }
    : { text: '', source: 'human' }

  function setNarrative(next: NarrativeState) {
    if (!selected) return
    setNarrativeSaved(false)
    setNarratives((n) => ({ ...n, [selected.id]: next }))
  }

  async function explainForBoard() {
    if (!selected || !result) return
    setAiBusy(true)
    setAiError(null)
    try {
      const res = await invokeFunction<{ commentary: string }>('ai-commentary', {
        mode: 'generate',
        section: 'vat_partial_exemption',
        context: {
          period: selected.period,
          period_label: periodLabel(selected.period),
          result,
          year: yearRows.map((r) => ({ period: r.period, result: r.result })),
          annual_adjustment: yearAdj,
          rolling_12m_taxable_turnover: effectiveTurnover,
          registration_threshold: REGISTRATION_THRESHOLD,
          charity_is_vat_registered: false,
        },
      })
      setNarrative({ text: res.commentary ?? '', source: 'ai' })
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'The explanation could not be drafted')
    } finally {
      setAiBusy(false)
    }
  }

  async function saveNarrative() {
    if (!selected) return
    setSavingNarrative(true)
    setAiError(null)
    try {
      await updateVatPeriod(selected.id, { narrative: narrative.text })
      setNarrativeSaved(true)
      setNarratives((n) => ({ ...n, [selected.id]: { ...narrative, source: narrative.source === 'ai' ? 'ai_edited' : narrative.source } }))
      periodsQuery.refetch()
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'The narrative could not be saved')
    } finally {
      setSavingNarrative(false)
    }
  }

  async function removePeriod(p: VatPeriod) {
    if (!window.confirm(`Delete the record for ${periodLabel(p.period)}? This cannot be undone.`)) return
    setDeleteError(null)
    try {
      await deleteVatPeriod(p.id)
      setSelectedId(null)
      periodsQuery.refetch()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'The period could not be deleted')
    }
  }

  if (!canView) {
    return (
      <div>
        <PageHeader title="VAT" />
        <Card>
          <EmptyState
            title="No access to the VAT module"
            hint="Partial exemption workings are visible to the Pulse team, the CEO and trustees."
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      {/* Screen view — the print stylesheet swaps this for the one-pager */}
      <div className="print:hidden">
        <PageHeader
          title="VAT partial exemption"
          subtitle="Standard method with de minimis tests (VAT Notice 706) — what registration would mean for the Assembly. GAUFCC is not currently VAT registered."
          actions={
            <>
              {selected && result ? (
                <Button variant="ghost" onClick={() => window.print()}>
                  Print one-pager
                </Button>
              ) : null}
              {canEdit ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  New period
                </Button>
              ) : null}
            </>
          }
        />

        {periodsQuery.loading ? (
          <Card>
            <LoadingRows cols={4} rows={5} />
          </Card>
        ) : periodsQuery.error ? (
          <ErrorNotice message={periodsQuery.error} />
        ) : periods.length === 0 && !editing ? (
          <Card>
            <EmptyState
              title="No VAT periods yet"
              hint={
                canEdit
                  ? 'Add a period, pull candidate figures from the Xero mirror, and the de minimis tests are calculated for you.'
                  : 'The Pulse team has not recorded any VAT periods yet — figures will appear here once they do.'
              }
              action={canEdit ? <Button variant="primary" onClick={() => setEditing('new')}>Add the first period</Button> : undefined}
            />
          </Card>
        ) : (
          <div className="space-y-5">
            {/* Period selector */}
            {periods.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="VAT periods">
                  {periods.map((p) => {
                    const active = selected?.id === p.id
                    return (
                      <button
                        key={p.id}
                        role="tab"
                        aria-selected={active}
                        onClick={() => {
                          setSelectedId(p.id)
                          setEditing(null)
                        }}
                        className={cx(
                          'rounded-full px-3.5 py-1.5 text-[11.5px] font-medium border transition-colors',
                          active
                            ? 'bg-indigo text-paper border-indigo'
                            : 'bg-white text-stone-500 border-stone-300 hover:text-indigo',
                        )}
                      >
                        {periodLabel(p.period)}
                      </button>
                    )
                  })}
                </div>
                {canEdit && selected ? (
                  <div className="flex items-center gap-1.5 ml-auto">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(selected)}>
                      Edit figures
                    </Button>
                    <Button size="sm" variant="reject" onClick={() => void removePeriod(selected)}>
                      Delete
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {deleteError ? <ErrorNotice message={deleteError} /> : null}

            {/* Editor */}
            {editing ? (
              <PeriodEditor
                existing={editing === 'new' ? null : editing}
                takenPeriods={periods.map((p) => p.period)}
                onCancel={() => setEditing(null)}
                onSaved={(p) => {
                  setEditing(null)
                  setSelectedId(p.id)
                  periodsQuery.refetch()
                }}
              />
            ) : null}

            {selected && result ? (
              <>
                {/* Headline cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <StatCard
                    label="Recoverable input VAT"
                    value={formatMoney(result.recoverable)}
                    sub="What could be reclaimed if registered"
                    accent="mint"
                  />
                  <StatCard
                    label="Irrecoverable input VAT"
                    value={formatMoney(result.irrecoverable)}
                    sub="Stuck against exempt activity"
                    accent={result.irrecoverable > 0 ? 'warn' : 'stone'}
                  />
                  <StatCard
                    label="De minimis"
                    value={
                      <StatusChip tone={result.de_minimis_met ? 'good' : 'warn'} className="text-[12px]">
                        {result.de_minimis_met ? 'Met' : 'Not met'}
                      </StatusChip>
                    }
                    sub={result.de_minimis_met ? 'All input VAT recoverable' : 'Exempt VAT is restricted'}
                  />
                  <StatCard
                    label="Recovery rate"
                    value={`${result.recovery_pct}%`}
                    sub="Taxable share of supplies, rounded up"
                  />
                </div>

                {/* Tests + working */}
                <div className="grid lg:grid-cols-2 gap-4 items-start">
                  <DeMinimisPanel result={result} />
                  <Card className="overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-stone-150 font-display text-[16px] text-ink">
                      Standard method working
                    </div>
                    <WorkingTable result={result} />
                  </Card>
                </div>

                {/* Year view */}
                <Card className="overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-stone-150 font-display text-[16px] text-ink">
                    {periodYear(selected.period)} across the periods
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px] min-w-[720px]">
                      <thead>
                        <tr>
                          <th className="th-register">Period</th>
                          <th className="th-register text-right">Taxable supplies</th>
                          <th className="th-register text-right">Exempt supplies</th>
                          <th className="th-register text-right">Input VAT</th>
                          <th className="th-register text-right">Exempt input VAT</th>
                          <th className="th-register">De minimis</th>
                          <th className="th-register text-right">Recoverable</th>
                          <th className="th-register text-right">Irrecoverable</th>
                        </tr>
                      </thead>
                      <tbody>
                        {yearRows.map((r) => (
                          <tr
                            key={r.period}
                            className={cx('hover:bg-paper-2 cursor-pointer', r.period === selected.period && 'bg-paper-2')}
                            onClick={() => setSelectedId(r.row.id)}
                          >
                            <td className="td-register whitespace-nowrap">{periodLabel(r.period)}</td>
                            <td className="td-register figure text-right">{formatMoney(r.row.taxable_supplies)}</td>
                            <td className="td-register figure text-right">{formatMoney(r.row.exempt_supplies)}</td>
                            <td className="td-register figure text-right">{formatMoney(r.result.total_input_vat)}</td>
                            <td className="td-register figure text-right">{formatMoney(r.result.exempt_input_vat)}</td>
                            <td className="td-register">
                              <StatusChip tone={r.result.de_minimis_met ? 'good' : 'warn'}>
                                {r.result.de_minimis_met ? 'Met' : 'Not met'}
                              </StatusChip>
                            </td>
                            <td className="td-register figure text-right">{formatMoney(r.result.recoverable)}</td>
                            <td className="td-register figure text-right">{formatMoney(r.result.irrecoverable)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-5 py-3.5 bg-paper border-t border-stone-150 text-[11.5px] text-stone-600 leading-relaxed">
                    {yearAdj ? (
                      <>
                        <span className="font-medium text-ink">Annual adjustment: </span>
                        recalculating {periodYear(selected.period)} as one longer period gives recoverable VAT of{' '}
                        <span className="figure">{formatMoney(yearAdj.annual.recoverable)}</span> against{' '}
                        <span className="figure">{formatMoney(yearAdj.periodsRecoverable)}</span> from the periods
                        individually — an adjustment of <span className="figure">{formatMoney(yearAdj.adjustment)}</span>{' '}
                        {yearAdj.adjustment >= 0 ? 'in the charity’s favour' : 'repayable'}, posted in the first
                        period of the following year (VAT Notice 706, section 12).
                      </>
                    ) : (
                      'The annual adjustment recalculates the whole year as one longer period once more than one sub-year period is recorded.'
                    )}
                  </div>
                </Card>

                {/* Explain for the board */}
                <Card className="overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-stone-150 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="font-display text-[16px] text-ink">Explain this for the board</div>
                      {narrative.source === 'ai' && narrative.text ? <AiBadge /> : null}
                      {narrative.source === 'ai_edited' && narrative.text ? (
                        <StatusChip tone="neutral">AI-assisted · reviewed</StatusChip>
                      ) : null}
                    </div>
                    {canUseAi ? (
                      <Button size="sm" variant="ghost" disabled={aiBusy} onClick={() => void explainForBoard()}>
                        {aiBusy ? 'Drafting…' : 'Draft with AI'}
                      </Button>
                    ) : null}
                  </div>
                  <div className="p-5 space-y-2.5">
                    {aiError ? <ErrorNotice message={aiError} /> : null}
                    {canUseAi ? (
                      <>
                        <Textarea
                          value={narrative.text}
                          placeholder="A plain-English narrative of what these figures mean for the Assembly — draft it with AI, then edit before it goes anywhere near a pack…"
                          onChange={(e) =>
                            setNarrative({
                              text: e.target.value,
                              source: narrative.source === 'human' ? 'human' : 'ai_edited',
                            })
                          }
                          className="min-h-28 text-[13px] leading-relaxed"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[11px] text-stone-500">
                            {narrative.source === 'ai'
                              ? 'AI draft — edit or accept before it is used. Editing marks it reviewed.'
                              : 'Saved narratives appear on the printed one-pager and in board packs.'}
                          </p>
                          {canEdit ? (
                            <div className="flex items-center gap-2">
                              {narrativeSaved ? <StatusChip tone="good">Saved</StatusChip> : null}
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={savingNarrative}
                                onClick={() => void saveNarrative()}
                              >
                                {savingNarrative ? 'Saving…' : 'Save narrative'}
                              </Button>
                            </div>
                          ) : (
                            <p className="text-[11px] text-stone-500">Drafts here are saved to the record by the Pulse team.</p>
                          )}
                        </div>
                      </>
                    ) : narrative.text ? (
                      <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{narrative.text}</p>
                    ) : (
                      <p className="text-[12px] text-stone-500">No narrative has been written for this period yet.</p>
                    )}
                  </div>
                </Card>

                {/* Registration monitor */}
                {turnoverQuery.loading && !turnoverQuery.data ? (
                  <Card className="p-5">
                    <Skeleton className="h-24" />
                  </Card>
                ) : (
                  <RegistrationPanel
                    annualResult={annualResult}
                    turnoverData={turnoverQuery.data}
                    turnoverLoading={turnoverQuery.loading}
                    turnoverError={turnoverQuery.error}
                    manual={manualTurnover}
                    onManualChange={setManualTurnover}
                    effectiveTurnover={effectiveTurnover}
                  />
                )}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Print-only one-pager */}
      {selected && result ? (
        <OnePager
          period={selected}
          result={result}
          yearRows={yearRows.map((r) => ({ period: r.period, result: r.result }))}
          yearAdjustment={yearAdj}
          turnover={effectiveTurnover}
          narrative={narrative.text}
        />
      ) : null}
    </div>
  )
}
