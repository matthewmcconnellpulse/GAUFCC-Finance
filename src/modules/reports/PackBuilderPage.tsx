/**
 * Board pack generator — one-click assembly from the builder's period/scope
 * into a paginated, print-ready pack.
 *
 * Print: the pack renders through a portal attached to <body>; while the
 * preview is open a body class hides #root under @media print, so File →
 * Print (or the Print button) yields exactly the A4 pages.
 *
 * Save: the same portal keeps the PackDocument mounted in a hidden container
 * at all times, so "Save to pack library" serialises the rendered DOM via the
 * container's innerHTML, wraps it with buildPackHtml (shared PACK_CSS +
 * fonts), and posts it to the generate-pack edge function.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  FundTypeChip,
  Input,
  LoadingRows,
  PageHeader,
  SectionLabel,
  StatusChip,
  cx,
} from '@/components/ui'
import { invokeFunction, supabase } from '@/lib/supabase'
import { formatMoney } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { CommentaryEditor } from './CommentaryEditor'
import { FundNoteEditor } from './FundNoteEditor'
import { PeriodControls, Segmented } from './components'
import PackDocument, {
  EMPTY_COMMENTARY,
  PACK_CONCEPTS,
  type PackCommentary,
  type PackConcept,
  type PackFundNotes,
  type PackInputs,
} from './PackDocument'
import { buildPackHtml, PACK_CSS } from './packCss'
import {
  buildMonthlyIndex,
  buildReportModel,
  fetchIntegrityStamps,
  fetchReportSources,
  fetchSettingsSnapshot,
  fetchTopMovements,
  monthKeysInPeriod,
  periodLabel,
  scopeDescription,
  trackingIdsForFunds,
  type BuilderState,
  type MonthlyIndex,
  type MovementRow,
  type SettingsSnapshot,
} from './lib'

interface GeneratePackResponse {
  pack_id: string
  storage_path: string
}

const DEFAULT_SETTINGS: SettingsSnapshot = { approvalDay: 10, paymentRunDay: 17 }

export default function PackBuilderPage({
  state,
  onChange,
}: {
  state: BuilderState
  onChange: (next: BuilderState) => void
}) {
  const { profile } = useAuth()
  const { isPulse, isCeo, isAdmin } = usePermissions()

  const [title, setTitle] = useState('Board finance pack')
  const [concept, setConcept] = useState<PackConcept>('ledger')
  const [extraFundIds, setExtraFundIds] = useState<string[]>([])
  const [commentary, setCommentary] = useState<PackCommentary>(EMPTY_COMMENTARY)
  const [fundNotes, setFundNotes] = useState<PackFundNotes>({})
  const [previewOpen, setPreviewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const serialRef = useRef<HTMLDivElement | null>(null)

  const sources = useSupabaseQuery(fetchReportSources, [])
  const stamps = useSupabaseQuery(
    () => fetchIntegrityStamps(monthKeysInPeriod(state.period)),
    [state.period.start, state.period.end],
  )
  const settings = useSupabaseQuery(fetchSettingsSnapshot, [])

  const model = useMemo(
    () => (sources.data ? buildReportModel(sources.data, state) : null),
    [sources.data, state],
  )
  const monthlyIndex = useMemo<MonthlyIndex>(
    () => (sources.data ? buildMonthlyIndex(sources.data.monthly) : new Map()),
    [sources.data],
  )

  // A fund that exists only as a balance-sheet capital account has no fund
  // record, so nothing in this pack can include it. Say so here rather than
  // let a pack go to trustees quietly short of a fund.
  const coverage = useSupabaseQuery(async () => {
    const { data, error } = await supabase
      .from('v_integrity_fund_coverage')
      .select('account_name, ledger_amount, issue')
      .eq('issue', 'no_fund_in_register')
      .order('ledger_amount', { ascending: false, nullsFirst: false })
    if (error) throw new Error(error.message)
    return (data ?? []) as Array<{ account_name: string; ledger_amount: number | null }>
  }, [])

  const movements = useSupabaseQuery<MovementRow[] | null>(async () => {
    if (!sources.data || !model) return null
    const src = sources.data
    const trackingIds =
      state.scope === 'whole_charity' ? null : trackingIdsForFunds(src.tracking, model.scopedFundIds)
    const fundNames = new Map(src.funds.map((f) => [f.id, f.name]))
    return fetchTopMovements(state.period, trackingIds, src.tracking.fundByOption, fundNames)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.data, model, state.period.start, state.period.end, state.scope, state.groupType, state.fundId])

  // Print plumbing — hide the app shell while the preview is open
  useEffect(() => {
    if (!previewOpen) return
    document.body.classList.add('pack-print-mode')
    return () => document.body.classList.remove('pack-print-mode')
  }, [previewOpen])

  const label = periodLabel(state.period)
  const scopeLabel = model
    ? scopeDescription(state, sources.data?.balances.find((b) => b.fund_id === state.fundId)?.name)
    : ''

  const flaggedFunds = useMemo(() => (model ? model.rows.filter((r) => r.flagged) : []), [model])
  const fundPages = useMemo(() => {
    if (!model) return []
    const extras = model.rows.filter((r) => !r.flagged && extraFundIds.includes(r.fund_id))
    return [...flaggedFunds, ...extras]
  }, [model, flaggedFunds, extraFundIds])


  const notedFundCount = useMemo(
    () => fundPages.filter((f) => (fundNotes[f.fund_id]?.text ?? '').trim()).length,
    [fundPages, fundNotes],
  )

  const packInputs: PackInputs | null =
    model && sources.data
      ? {
          title,
          concept,
          period: state.period,
          periodLabel: label,
          scopeLabel,
          model,
          monthlyIndex,
          fundPages,
          topMovements: movements.data ?? [],
          warnings: sources.data.warnings,
          stamps: stamps.data ?? [],
          settings: settings.data ?? DEFAULT_SETTINGS,
          preparedBy: profile?.full_name ?? 'Pulse Accountants',
          commentary,
          fundNotes,
        }
      : null

  const savePack = async () => {
    if (!serialRef.current || !model) return
    setSaving(true)
    setSaveError(null)
    setSavedPath(null)
    try {
      const html = buildPackHtml(`<div class="pk-preview">${serialRef.current.innerHTML}</div>`, title)
      const body: Record<string, unknown> = {
        title,
        period_start: state.period.start,
        period_end: state.period.end,
        scope: state.scope,
        html,
        commentary: {
          sections: commentary,
          funds: Object.fromEntries(
            fundPages
              .filter((f) => (fundNotes[f.fund_id]?.text ?? '').trim())
              .map((f) => [f.fund_id, { name: f.name, ...fundNotes[f.fund_id] }]),
          ),
        },
      }
      if (state.scope !== 'whole_charity') body.scope_fund_ids = model.scopedFundIds
      const res = await invokeFunction<GeneratePackResponse>('generate-pack', body)
      setSavedPath(res.storage_path)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'The pack could not be saved')
    } finally {
      setSaving(false)
    }
  }


  if (sources.loading) {
    return (
      <div>
        <PageHeader title="Board pack" subtitle="Assemble a print-ready pack from the live ledger" />
        <Card>
          <LoadingRows cols={4} rows={8} />
        </Card>
      </div>
    )
  }
  if (sources.error) {
    return (
      <div>
        <PageHeader title="Board pack" subtitle="Assemble a print-ready pack from the live ledger" />
        <ErrorNotice message={`Pack data could not be loaded — ${sources.error}`} />
      </div>
    )
  }
  if (!model || model.rows.length === 0) {
    return (
      <div>
        <PageHeader title="Board pack" subtitle="Assemble a print-ready pack from the live ledger" />
        <Card>
          <EmptyState
            title="Nothing to assemble yet"
            hint="Choose a scope with funds in it on the report builder, then come back — the pack is built from those views."
            action={
              <Link to="/reports" className="text-indigo underline underline-offset-2 text-[12.5px]">
                Open the report builder
              </Link>
            }
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Board pack"
        subtitle={`${scopeLabel} · ${label}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setPreviewOpen(true)}>
              Preview & print
            </Button>
            <Button
              variant="money"
              disabled={saving}
              onClick={() => void savePack()}
            >
              {saving ? 'Saving…' : 'Save to pack library'}
            </Button>
          </>
        }
      />

      {saveError ? (
        <div className="mb-4">
          <ErrorNotice message={`Save failed — ${saveError}`} />
        </div>
      ) : null}
      {savedPath ? (
        <div className="mb-4 rounded-card border border-mint-700/40 bg-mint/10 text-mint-900 text-[12.5px] px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <span>Pack saved to the library as a draft.</span>
          <Link to="/reports/library" className="underline underline-offset-2 font-medium">
            Open the pack library
          </Link>
        </div>
      ) : null}
      {(coverage.data ?? []).length > 0 ? (
        <div className="mb-4 rounded-card border border-warn/50 bg-warn/10 text-warn-ink text-[12.5px] px-4 py-3">
          <b className="font-medium">
            {(coverage.data ?? []).length} fund
            {(coverage.data ?? []).length === 1 ? '' : 's'} in the ledger cannot appear in this pack.
          </b>{' '}
          {(coverage.data ?? [])
            .map((r) => `${r.account_name}${r.ledger_amount != null ? ` (${formatMoney(r.ledger_amount)})` : ''}`)
            .join(', ')}{' '}
          — no fund record, because there is no Fund tracking option in Xero. Add the tracking option and
          re-sync, or issue the pack knowing these are excluded.{' '}
          <Link to="/funds/integrity" className="underline underline-offset-2 font-medium">
            Fund coverage check
          </Link>
        </div>
      ) : null}

      <div className="space-y-6">
        {/* Setup */}
        <Card className="px-5 py-4">
          <SectionLabel>Pack setup</SectionLabel>
          <div className="grid md:grid-cols-2 gap-4">
            <Field label="Pack title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Cover concept" hint="The Ledger is the default — interior pages share one layout.">
              <Segmented options={PACK_CONCEPTS} value={concept} onChange={setConcept} />
            </Field>
          </div>
          <div className="mt-4">
            <SectionLabel>Period</SectionLabel>
            <PeriodControls value={state.period} onChange={(period) => onChange({ ...state, period })} />
            <p className="text-[11px] text-stone-500 mt-2">
              Scope follows the report builder — currently {scopeLabel.toLowerCase()}. Change it there if needed.
            </p>
          </div>
        </Card>

        {/* Fund pages */}
        <Card className="px-5 py-4">
          <SectionLabel>Per-fund pages</SectionLabel>
          {flaggedFunds.length > 0 ? (
            <div className="mb-3">
              <p className="text-[12px] text-stone-700 mb-2">
                Flagged funds are included automatically this period:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {flaggedFunds.map((f) => (
                  <span
                    key={f.fund_id}
                    className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-warn/10 text-warn-ink border border-warn/30"
                  >
                    {f.name}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-stone-500 mb-3">No funds are flagged this period.</p>
          )}
          <p className="text-[12px] text-stone-700 mb-2">Add further funds to the pack:</p>
          <div className="max-h-56 overflow-y-auto border border-stone-150 rounded-control divide-y divide-stone-150">
            {model.rows
              .filter((r) => !r.flagged)
              .map((r) => (
                <label
                  key={r.fund_id}
                  className="flex items-center gap-3 px-3.5 py-2 text-[12.5px] cursor-pointer hover:bg-paper-2"
                >
                  <input
                    type="checkbox"
                    checked={extraFundIds.includes(r.fund_id)}
                    onChange={(e) =>
                      setExtraFundIds((prev) =>
                        e.target.checked ? [...prev, r.fund_id] : prev.filter((id) => id !== r.fund_id),
                      )
                    }
                    className="accent-[#211951]"
                  />
                  <span className="flex-1">{r.name}</span>
                  <FundTypeChip type={r.fund_type} />
                </label>
              ))}
          </div>
          <p className="text-[11px] text-stone-500 mt-2">
            {fundPages.length} per-fund page{fundPages.length === 1 ? '' : 's'} will be included.
          </p>
        </Card>

        {/* Per-fund notes — one per fund page in the pack */}
        <Card className="px-5 py-4">
          <SectionLabel>Notes on individual funds</SectionLabel>
          <p className="text-[12px] text-stone-500 mb-3">
            A note against a fund prints on that fund's page. Type it yourself; AI will polish your wording if you
            ask, but it never drafts a note from the figures. Funds with no note simply omit it.
          </p>
          {fundPages.length === 0 ? (
            <p className="text-[12px] text-stone-500">
              No per-fund pages are in the pack yet — add a fund above and a note box appears for it here.
            </p>
          ) : (
            <div className="space-y-4">
              {fundPages.map((f) => (
                <FundNoteEditor
                  key={f.fund_id}
                  fund={f}
                  state={fundNotes[f.fund_id] ?? { text: '', source: 'human' }}
                  onChange={(next) => setFundNotes((n) => ({ ...n, [f.fund_id]: next }))}
                  context={{
                    fund: f.name,
                    fund_type: f.fund_type,
                    period: label,
                    opening: f.opening,
                    income: f.income,
                    expenditure: f.expenditure,
                    net: f.net,
                    closing: f.closing,
                    purpose: f.purpose,
                    flagged: f.flagged,
                    warnings: (sources.data?.warnings ?? [])
                      .filter((w) => w.fund_id === f.fund_id)
                      .map((w) => w.message),
                  }}
                />
              ))}
            </div>
          )}
        </Card>

        {/* Commentary — written by the preparer, reviewed before issue */}
        <Card className="px-5 py-4">
          <SectionLabel>Commentary</SectionLabel>
          <p className="text-[12px] text-stone-500 mb-3">
            Your words on the figures. The numbers in the pack are computed from the ledger; this is the
            narrative the trustees read alongside them.
          </p>
          <div className="space-y-4">
            <CommentaryEditor
              label="Executive summary"
              hint="Plain-English narrative of the period — movements, drivers and flags."
              state={commentary.executive_summary}
              onChange={(next) => setCommentary((c) => ({ ...c, executive_summary: next }))}
            />
            <CommentaryEditor
              label="Note on the figures"
              hint="Optional note for the financial pages — accounting treatment, one-offs, context."
              state={commentary.financials}
              onChange={(next) => setCommentary((c) => ({ ...c, financials: next }))}
            />
            <CommentaryEditor
              label="Reserves & outlook"
              hint="Commentary for the restricted vs unrestricted split and the reserves position."
              state={commentary.reserves}
              onChange={(next) => setCommentary((c) => ({ ...c, reserves: next }))}
            />
          </div>
        </Card>

        {/* Assembly summary */}
        <Card className="px-5 py-4">
          <SectionLabel>What goes in</SectionLabel>
          {stamps.error ? (
            <div className="mb-3">
              <ErrorNotice message={`Integrity stamps could not be loaded — ${stamps.error}`} />
            </div>
          ) : null}
          <ul className="text-[12.5px] text-stone-700 space-y-1.5">
            <li>Cover — {PACK_CONCEPTS.find((c) => c.value === concept)?.label}, contents, executive summary</li>
            <li>Charity-level financials — movements by fund, waterfall and reserves split</li>
            <li>Top ten movements in funds — largest net movers, ranked</li>
            <li>
              {fundPages.length} per-fund page{fundPages.length === 1 ? '' : 's'}
              {flaggedFunds.length > 0 ? ` (${flaggedFunds.length} flagged, auto-included)` : ''}
              {notedFundCount > 0 ? ` · ${notedFundCount} carrying a note` : ''}
            </li>
            <li>
              Data integrity —{' '}
              {stamps.loading
                ? 'checking stamps…'
                : `${(stamps.data ?? []).filter((s) => s.stamped).length} of ${(stamps.data ?? []).length} months stamped complete`}
            </li>
            <li>Appendix — warnings register and platform settings snapshot</li>
          </ul>
          <div className="flex items-center gap-2 mt-4">
            <Button variant="ghost" onClick={() => setPreviewOpen(true)}>
              Preview & print
            </Button>
            <Button variant="money" disabled={saving} onClick={() => void savePack()}>
              {saving ? 'Saving…' : 'Save to pack library'}
            </Button>
            {isAdmin || isCeo ? (
              <span className="text-[11px] text-stone-500">Saved packs stay draft until marked final in the library.</span>
            ) : null}
          </div>
        </Card>
      </div>

      {/* The pack itself — portal to <body>, hidden unless previewing, always
          mounted so Save can serialise it. */}
      {packInputs
        ? createPortal(
            <div className={previewOpen ? 'pack-overlay' : 'pack-hidden-doc'}>
              <style>{PACK_CSS}</style>
              {previewOpen ? (
                <div className="pack-overlay-toolbar no-print">
                  <div className="text-[12px]">
                    <span className="font-medium">{title}</span>
                    <span className="opacity-60"> · {label} · File → Print produces the PDF</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => window.print()}
                      className="rounded-full bg-white/10 hover:bg-white/20 px-4 py-1.5 text-[12px] font-medium"
                    >
                      Print / save as PDF
                    </button>
                    <button
                      onClick={() => void savePack()}
                      disabled={saving}
                      className={cx(
                        'rounded-full px-4 py-1.5 text-[12px] font-semibold',
                        saving
                          ? 'bg-white/10 text-white/40 cursor-not-allowed'
                          : 'bg-mint text-indigo hover:brightness-95',
                      )}
                    >
                      {saving ? 'Saving…' : 'Save to library'}
                    </button>
                    <button
                      onClick={() => setPreviewOpen(false)}
                      className="rounded-full border border-white/25 hover:bg-white/10 px-4 py-1.5 text-[12px]"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="pk-preview" ref={serialRef}>
                <PackDocument {...packInputs} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
