/**
 * Epworth monthly investment report — upload (the monthly xlsx workbook is
 * parsed deterministically; PDF/CSV via Claude), map holdings to funds
 * (mappings are remembered month to month in epworth_fund_mappings; only
 * unmapped lines surface loudly), review totals by fund × income type, and
 * export either a Xero manual-journal CSV (tracked per fund) or a cash-account
 * statement CSV, plus a plain posting summary. Nothing is pushed to Xero by
 * the platform.
 *
 * Unrealised gains: the workbook reports gains cumulatively since Epworth's
 * opening valuation, so the month's movement is derived against the previous
 * import — the basis is spelled out in the note that accompanies each parse.
 */
import { useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  FundTypeChip,
  Input,
  LoadingRows,
  SectionLabel,
  cx,
} from '@/components/ui'
import { formatDate, formatPeriod } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { EpworthFundMapping, EpworthImport, IncomeType } from '@/types/db'
import {
  INCOME_TYPES,
  INCOME_TYPE_SHORT,
  coerceIncomeType,
  coercePeriod,
  deleteMappingsForHolding,
  fetchEpworthImports,
  fetchFundOptions,
  fetchFundTrackingCategoryName,
  fetchJournalSettings,
  fetchMappings,
  holdingsOf,
  importFilePath,
  insertEpworthImport,
  insertMappings,
  metaOf,
  parseImport,
  periodEndIso,
  round2,
  saveJournalSettings,
  updateEpworthImport,
  uploadImportFile,
  validateImportFile,
  type FundOption,
  type UploadPhase,
} from './lib'
import {
  buildEpworthCashCsv,
  buildEpworthJournalCsv,
  buildPostingSummaryCsv,
  downloadTextFile,
  type FundTotalsRow,
} from './xeroCsv'
import { FileDrop, ImportStatusChip, WarnIcon } from './components'

const PHASES: UploadPhase[] = ['uploading', 'parsing', 'saving']

const num2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function figure(v: number): string {
  return v === 0 ? '—' : num2.format(v)
}

// ── Data shaping ─────────────────────────────────────────────────────────────

interface HoldingGroup {
  ref: string
  name: string
  amounts: Record<IncomeType, number>
  /** income types present on this holding in this report */
  types: IncomeType[]
}

function emptyAmounts(): Record<IncomeType, number> {
  return { dividend: 0, interest: 0, realised_gain: 0, unrealised_gain: 0, fee: 0 }
}

function groupHoldings(imp: EpworthImport): HoldingGroup[] {
  const byRef = new Map<string, HoldingGroup>()
  for (const h of holdingsOf(imp)) {
    const type = coerceIncomeType(h.income_type)
    const g = byRef.get(h.holding_ref) ?? {
      ref: h.holding_ref,
      name: h.holding_name,
      amounts: emptyAmounts(),
      types: [],
    }
    g.amounts[type] = round2(g.amounts[type] + h.amount)
    if (!g.types.includes(type)) g.types.push(type)
    if (!g.name && h.holding_name) g.name = h.holding_name
    byRef.set(h.holding_ref, g)
  }
  return [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref))
}

function mappingKey(ref: string, type: IncomeType): string {
  return `${ref}|${type}`
}

interface Matrix {
  rows: FundTotalsRow[]
  totals: Record<IncomeType, number>
  grandTotal: number
  unmappedLines: number
  mappedLines: number
}

function buildMatrix(
  groups: HoldingGroup[],
  mappings: Map<string, EpworthFundMapping>,
  fundById: Map<string, FundOption>,
): Matrix {
  const byFund = new Map<string, FundTotalsRow>()
  const totals = emptyAmounts()
  let unmappedLines = 0
  let mappedLines = 0
  for (const g of groups) {
    for (const type of g.types) {
      const amount = g.amounts[type]
      const mapping = mappings.get(mappingKey(g.ref, type))
      const key = mapping?.fund_id ?? '__unmapped__'
      const label = mapping
        ? (fundById.get(mapping.fund_id)?.name ?? 'Unknown fund')
        : 'Unmapped — needs attention'
      const row = byFund.get(key) ?? {
        fund_id: mapping?.fund_id ?? null,
        label,
        amounts: emptyAmounts(),
        total: 0,
      }
      row.amounts[type] = round2(row.amounts[type] + amount)
      row.total = round2(row.total + amount)
      byFund.set(key, row)
      totals[type] = round2(totals[type] + amount)
      if (mapping) mappedLines += 1
      else unmappedLines += 1
    }
  }
  const rows = [...byFund.values()].sort((a, b) => {
    if (a.fund_id == null) return 1
    if (b.fund_id == null) return -1
    return a.label.localeCompare(b.label)
  })
  const grandTotal = round2(INCOME_TYPES.reduce((s, t) => s + totals[t], 0))
  return { rows, totals, grandTotal, unmappedLines, mappedLines }
}

// ── Mapping cell ─────────────────────────────────────────────────────────────

function FundMapCell({
  group,
  mappings,
  fundById,
  funds,
  busy,
  onMap,
  onUnmap,
}: {
  group: HoldingGroup
  mappings: Map<string, EpworthFundMapping>
  fundById: Map<string, FundOption>
  funds: FundOption[]
  busy: boolean
  onMap: (group: HoldingGroup, fundId: string) => void
  onUnmap: (group: HoldingGroup) => void
}) {
  const mapped = group.types
    .map((t) => ({ type: t, mapping: mappings.get(mappingKey(group.ref, t)) }))
    .filter((m) => m.mapping != null)
  const unmappedTypes = group.types.filter((t) => !mappings.get(mappingKey(group.ref, t)))

  if (unmappedTypes.length > 0) {
    return (
      <select
        disabled={busy}
        value=""
        onChange={(e) => {
          if (e.target.value) onMap(group, e.target.value)
        }}
        className="rounded-full border border-dashed border-warn bg-warn/15 text-warn-ink text-[11px] font-medium px-3 py-1 focus:outline-none focus:ring-2 focus:ring-warn/50 cursor-pointer max-w-full"
        aria-label={`Map ${group.ref} to a fund`}
      >
        <option value="">Map to a fund…</option>
        {funds.map((f) => (
          <option key={f.fund_id} value={f.fund_id}>
            {f.name}
          </option>
        ))}
      </select>
    )
  }

  const distinctFunds = [...new Set(mapped.map((m) => m.mapping!.fund_id))]
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {distinctFunds.length === 1 ? (
        <span className="inline-flex items-center font-medium text-[11px] px-2.5 py-0.5 rounded-full bg-indigo/[.07] text-indigo whitespace-nowrap">
          {fundById.get(distinctFunds[0])?.name ?? 'Unknown fund'}
        </span>
      ) : (
        mapped.map((m) => (
          <span
            key={m.type}
            className="inline-flex items-center font-medium text-[10.5px] px-2 py-0.5 rounded-full bg-indigo/[.07] text-indigo whitespace-nowrap"
          >
            {INCOME_TYPE_SHORT[m.type]} → {fundById.get(m.mapping!.fund_id)?.name ?? '?'}
          </span>
        ))
      )}
      <button
        onClick={() => onUnmap(group)}
        disabled={busy}
        className="text-stone-400 hover:text-warn-ink text-[12px] leading-none px-0.5"
        title="Forget this mapping"
        aria-label={`Forget the mapping for ${group.ref}`}
      >
        ×
      </button>
    </span>
  )
}

// ── The tab ──────────────────────────────────────────────────────────────────

export default function EpworthTab() {
  const { profile } = useAuth()
  const importsQ = useSupabaseQuery(fetchEpworthImports)
  const mappingsQ = useSupabaseQuery(fetchMappings)
  const fundsQ = useSupabaseQuery(fetchFundOptions)
  const trackingNameQ = useSupabaseQuery(fetchFundTrackingCategoryName)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [phase, setPhase] = useState<UploadPhase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Journal export settings. Saved mappings (epworth_journal_settings)
  // pre-fill every field; local edits (null = untouched) sit on top until
  // 'Save mappings' writes them back for next month.
  const savedQ = useSupabaseQuery(fetchJournalSettings)
  const saved = savedQ.data ?? null
  const [narration, setNarration] = useState<string | null>(null)
  const [assetCode, setAssetCode] = useState<string | null>(null)
  const [trackingName, setTrackingName] = useState<string | null>(null)
  const [incomeCodes, setIncomeCodes] = useState<Partial<Record<IncomeType, string>>>({})
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  const imports = importsQ.data ?? []
  const active = imports.find((i) => i.id === activeId) ?? imports[0] ?? null
  const funds = fundsQ.data ?? []
  const fundById = useMemo(() => new Map(funds.map((f) => [f.fund_id, f])), [funds])
  const mappings = useMemo(() => {
    const map = new Map<string, EpworthFundMapping>()
    for (const m of mappingsQ.data ?? []) map.set(mappingKey(m.epworth_holding_ref, m.income_type), m)
    return map
  }, [mappingsQ.data])

  const groups = useMemo(() => (active ? groupHoldings(active) : []), [active])
  const matrix = useMemo(() => buildMatrix(groups, mappings, fundById), [groups, mappings, fundById])

  const defaultNarration = active ? `Epworth investment income — ${formatPeriod(active.period)}` : ''
  const narrationValue = narration ?? defaultNarration
  const trackingNameValue = trackingName ?? saved?.tracking_category_name ?? trackingNameQ.data ?? 'Fund'
  const assetCodeValue = assetCode ?? saved?.asset_account_code ?? ''
  const incomeCodeValue = (t: IncomeType) => incomeCodes[t] ?? saved?.income_account_codes[t] ?? ''
  const activeMeta = useMemo(() => (active ? metaOf(active) : {}), [active])

  async function handleSaveMappings() {
    if (!profile) return
    setSaveState('saving')
    setError(null)
    try {
      await saveJournalSettings(
        {
          tracking_category_name: trackingNameValue.trim() || 'Fund',
          asset_account_code: assetCodeValue.trim() || null,
          income_account_codes: Object.fromEntries(
            INCOME_TYPES.map((t) => [t, incomeCodeValue(t).trim()]),
          ) as Record<IncomeType, string>,
        },
        profile.id,
      )
      savedQ.refetch()
      setSaveState('saved')
    } catch (e) {
      setSaveState('idle')
      setError(e instanceof Error ? e.message : 'The mappings could not be saved.')
    }
  }

  async function handleFile(file: File) {
    setError(null)
    const invalid = validateImportFile(file, ['xlsx', 'xls', 'pdf', 'csv'])
    if (invalid) {
      setError(invalid)
      return
    }
    if (!profile) {
      setError('Your profile has not finished loading — try again in a moment.')
      return
    }
    try {
      setPhase('uploading')
      const path = importFilePath('epworth', file.name)
      await uploadImportFile(path, file)

      setPhase('parsing')
      const resp = await parseImport('epworth', path)
      const holdings = (resp.holdings ?? []).map((h) => ({
        holding_ref: h.holding_ref,
        holding_name: h.holding_name,
        income_type: h.income_type,
        amount: round2(h.amount),
      }))
      if (holdings.length === 0) {
        throw new Error('No holdings could be read from that file — check it is the Epworth monthly report.')
      }

      setPhase('saving')
      const row = await insertEpworthImport({
        file_path: path,
        file_name: file.name,
        period: coercePeriod(resp.period),
        parsed: resp.meta ? { holdings, meta: resp.meta } : { holdings },
        uploaded_by: profile.id,
      })
      setActiveId(row.id)
      setNarration(null)
      importsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong during the import.')
    } finally {
      setPhase(null)
    }
  }

  async function handleMap(group: HoldingGroup, fundId: string) {
    if (!profile) return
    setBusy(true)
    setError(null)
    try {
      const unmappedTypes = group.types.filter((t) => !mappings.get(mappingKey(group.ref, t)))
      await insertMappings(
        unmappedTypes.map((type) => ({
          epworth_holding_ref: group.ref,
          fund_id: fundId,
          income_type: type,
          created_by: profile.id,
        })),
      )
      mappingsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The mapping could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function handleUnmap(group: HoldingGroup) {
    setBusy(true)
    setError(null)
    try {
      await deleteMappingsForHolding(group.ref)
      mappingsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The mapping could not be removed.')
    } finally {
      setBusy(false)
    }
  }

  async function markExported() {
    if (!active) return
    await updateEpworthImport(active.id, {
      status: 'exported',
      mapping_results: {
        exported_at: new Date().toISOString(),
        mapped_lines: matrix.mappedLines,
        unmapped_lines: matrix.unmappedLines,
        totals_by_fund: matrix.rows.map((r) => ({
          fund_id: r.fund_id,
          fund: r.label,
          ...r.amounts,
          total: r.total,
        })),
      },
    })
    importsQ.refetch()
  }

  async function handleExportJournal() {
    if (!active || matrix.unmappedLines > 0) return
    setBusy(true)
    setError(null)
    try {
      const csv = buildEpworthJournalCsv(matrix.rows, {
        narration: narrationValue,
        dateIso: periodEndIso(active.period),
        assetAccountCode: assetCodeValue.trim(),
        incomeAccountCodes: Object.fromEntries(
          INCOME_TYPES.map((t) => [t, incomeCodeValue(t).trim()]),
        ) as Record<IncomeType, string>,
        trackingCategoryName: trackingNameValue.trim() || 'Fund',
      })
      downloadTextFile(`epworth-journal-${active.period}.csv`, csv)
      await markExported()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The journal CSV could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  async function handleExportCash() {
    if (!active) return
    const rows = activeMeta.cash_rows ?? []
    if (rows.length === 0) return
    setBusy(true)
    setError(null)
    try {
      downloadTextFile(`epworth-cash-statement-${active.period}.csv`, buildEpworthCashCsv(rows))
      await markExported()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The cash statement CSV could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  async function handleExportSummary() {
    if (!active) return
    setBusy(true)
    setError(null)
    try {
      const csv = buildPostingSummaryCsv(formatPeriod(active.period), matrix.rows)
      downloadTextFile(`epworth-posting-summary-${active.period}.csv`, csv)
      await markExported()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The posting summary could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  const loading = (importsQ.loading && !importsQ.data) || (mappingsQ.loading && !mappingsQ.data)
  if (loading) {
    return (
      <Card>
        <LoadingRows cols={6} rows={7} />
      </Card>
    )
  }
  const queryError = importsQ.error ?? mappingsQ.error
  if (queryError) {
    return <ErrorNotice message={`The Epworth register could not be loaded — ${queryError}`} />
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[380px_1fr] items-start">
        <div className="space-y-3">
          <FileDrop
            title="Drop the Epworth monthly report"
            hint="The monthly workbook (xlsx/xls) is read directly — transactions, gains and Cash Plus accounts. PDF or CSV also works. Up to 10 MB."
            accept=".xlsx,.xls,.pdf,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/pdf,text/csv"
            busyPhase={phase}
            phases={PHASES}
            onFile={(f) => void handleFile(f)}
          />
          {error ? <ErrorNotice message={error} /> : null}
          {fundsQ.error ? (
            <ErrorNotice message={`Funds could not be loaded for mapping — ${fundsQ.error}`} />
          ) : null}
        </div>

        {active ? (
          <div className="space-y-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[13px] text-stone-700 min-w-0">
                <span className="font-medium text-ink">{active.file_name}</span> · parsed {matrix.mappedLines + matrix.unmappedLines}{' '}
                lines across {groups.length} holdings ·{' '}
                {matrix.unmappedLines > 0 ? (
                  <b className="text-warn-ink">
                    {matrix.unmappedLines} unmapped {matrix.unmappedLines === 1 ? 'line needs' : 'lines need'} you
                  </b>
                ) : (
                  <span className="text-mint-900 font-medium">every line mapped</span>
                )}{' '}
                — mappings are remembered next month
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-stone-500 flex items-center gap-1.5">
                  Period
                  <input
                    type="month"
                    value={active.period}
                    onChange={(e) => {
                      const v = e.target.value
                      if (/^\d{4}-\d{2}$/.test(v)) {
                        void updateEpworthImport(active.id, { period: v }).then(() => importsQ.refetch())
                      }
                    }}
                    className="input-base !w-auto py-1 text-[11.5px]"
                  />
                </label>
                <ImportStatusChip status={active.status} />
              </div>
            </div>

            {/* How the unrealised figure was derived + excluded capital movements */}
            {activeMeta.gains_note ? (
              <div className="rounded-lg border border-indigo/20 bg-indigo/[.04] px-4 py-3 text-[12px] text-stone-700">
                <span className="font-medium text-indigo">Unrealised gains basis:</span>{' '}
                {activeMeta.gains_note}
                {(activeMeta.excluded_cash ?? []).length > 0 ? (
                  <div className="mt-2 text-[11.5px] text-stone-600">
                    <span className="font-medium">
                      Capital movements excluded from income (transfers between accounts, redemptions):
                    </span>
                    <ul className="mt-1 space-y-0.5">
                      {(activeMeta.excluded_cash ?? []).map((m, i) => (
                        <li key={i} className="font-mono text-[11px]">
                          {formatDate(m.date)} · {m.account_ref} · {m.narrative} · £{num2.format(m.amount)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Holding → fund mapping table */}
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] min-w-[720px]">
                  <thead>
                    <tr>
                      <th className="th-register">Epworth holding</th>
                      <th className="th-register">Maps to fund</th>
                      {INCOME_TYPES.map((t) => (
                        <th key={t} className="th-register text-right">
                          {INCOME_TYPE_SHORT[t]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const hasUnmapped = g.types.some((t) => !mappings.get(mappingKey(g.ref, t)))
                      return (
                        <tr key={g.ref} className={cx(hasUnmapped && 'bg-warn/5')}>
                          <td className="td-register">
                            <div className="font-mono text-[11.5px] text-ink">{g.ref}</div>
                            {g.name ? <div className="text-[10.5px] text-stone-500 mt-0.5">{g.name}</div> : null}
                          </td>
                          <td className="td-register">
                            <FundMapCell
                              group={g}
                              mappings={mappings}
                              fundById={fundById}
                              funds={funds}
                              busy={busy}
                              onMap={(grp, fundId) => void handleMap(grp, fundId)}
                              onUnmap={(grp) => void handleUnmap(grp)}
                            />
                          </td>
                          {INCOME_TYPES.map((t) => (
                            <td key={t} className="td-register figure text-right whitespace-nowrap">
                              {figure(g.amounts[t])}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-indigo text-paper">
                      <td className="px-4 py-3 text-[12px] font-medium">
                        {formatPeriod(active.period)} totals
                      </td>
                      <td className="px-4 py-3 text-[10.5px] text-paper/55">→ fund reporting + CSV</td>
                      {INCOME_TYPES.map((t) => (
                        <td key={t} className="px-4 py-3 figure text-right text-[11px] font-medium whitespace-nowrap">
                          {num2.format(matrix.totals[t])}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>

            {/* Review — totals by fund × income type */}
            <div>
              <SectionLabel>Review — totals by fund and income type (all figures £)</SectionLabel>
              <Card className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] min-w-[720px]">
                    <thead>
                      <tr>
                        <th className="th-register">Fund</th>
                        {INCOME_TYPES.map((t) => (
                          <th key={t} className="th-register text-right">
                            {INCOME_TYPE_SHORT[t]}
                          </th>
                        ))}
                        <th className="th-register text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matrix.rows.map((r) => (
                        <tr key={r.fund_id ?? 'unmapped'} className={cx(r.fund_id == null && 'bg-warn/5')}>
                          <td className="td-register">
                            {r.fund_id == null ? (
                              <span className="inline-flex items-center gap-1.5 text-warn-ink font-medium">
                                <WarnIcon /> {r.label}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-2">
                                <span className="font-medium text-ink">{r.label}</span>
                                {fundById.get(r.fund_id) ? (
                                  <FundTypeChip type={fundById.get(r.fund_id)!.fund_type} />
                                ) : null}
                              </span>
                            )}
                          </td>
                          {INCOME_TYPES.map((t) => (
                            <td key={t} className="td-register figure text-right whitespace-nowrap">
                              {figure(r.amounts[t])}
                            </td>
                          ))}
                          <td className="td-register figure text-right font-medium whitespace-nowrap">
                            {num2.format(r.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-paper-2 border-t border-stone-150">
                        <td className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-[.08em] text-stone-500">
                          Grand total
                        </td>
                        {INCOME_TYPES.map((t) => (
                          <td key={t} className="px-4 py-2.5 figure text-right font-medium whitespace-nowrap">
                            {num2.format(matrix.totals[t])}
                          </td>
                        ))}
                        <td className="px-4 py-2.5 figure text-right font-semibold whitespace-nowrap">
                          {num2.format(matrix.grandTotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
            </div>

            {/* Journal settings + exports */}
            <Card className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionLabel>Journal export settings</SectionLabel>
                <div className="flex items-center gap-2 pb-2">
                  {saveState === 'saved' ? (
                    <span className="text-[11px] text-mint-900">✓ Saved — these mappings pre-fill every month</span>
                  ) : saved ? (
                    <span className="text-[11px] text-stone-500">pre-filled from saved mappings</span>
                  ) : null}
                  <Button
                    variant="ghost"
                    disabled={saveState === 'saving'}
                    onClick={() => void handleSaveMappings()}
                  >
                    {saveState === 'saving' ? 'Saving…' : 'Save mappings'}
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Narration">
                  <Input value={narrationValue} onChange={(e) => setNarration(e.target.value)} />
                </Field>
                <Field
                  label="Tracking category"
                  hint="Xero's TrackingName1 column — the category the funds live under."
                >
                  <Input
                    value={trackingNameValue}
                    onChange={(e) => {
                      setTrackingName(e.target.value)
                      setSaveState('idle')
                    }}
                  />
                </Field>
                <Field
                  label="Investment asset account code"
                  hint="Debit side — the investment current asset. Save mappings to keep it for next month."
                >
                  <Input
                    value={assetCodeValue}
                    onChange={(e) => {
                      setAssetCode(e.target.value)
                      setSaveState('idle')
                    }}
                    placeholder="leave blank to fill in later"
                    className="font-mono"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  {INCOME_TYPES.map((t) => (
                    <Field key={t} label={`${INCOME_TYPE_SHORT[t]} account`}>
                      <Input
                        value={incomeCodeValue(t)}
                        onChange={(e) => {
                          const v = e.target.value
                          setIncomeCodes((c) => ({ ...c, [t]: v }))
                          setSaveState('idle')
                        }}
                        placeholder="blank"
                        className="font-mono"
                      />
                    </Field>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 mt-4">
                <Button
                  variant="money"
                  disabled={busy || matrix.unmappedLines > 0 || matrix.rows.length === 0}
                  onClick={() => void handleExportJournal()}
                  title={matrix.unmappedLines > 0 ? 'Map every line to a fund first' : undefined}
                >
                  Export Xero manual journal CSV
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || (activeMeta.cash_rows ?? []).length === 0}
                  onClick={() => void handleExportCash()}
                  title={
                    (activeMeta.cash_rows ?? []).length === 0
                      ? 'Available when the report was parsed from the Epworth workbook'
                      : undefined
                  }
                >
                  Export cash-account statement CSV
                </Button>
                <Button variant="ghost" disabled={busy || groups.length === 0} onClick={() => void handleExportSummary()}>
                  Export posting summary CSV
                </Button>
                {matrix.unmappedLines > 0 ? (
                  <span className="text-[11.5px] text-warn-ink">
                    the journal is blocked until every line is mapped to a fund
                  </span>
                ) : null}
              </div>
              <p className="text-[11px] text-stone-500 mt-3">
                Journal date {formatDate(periodEndIso(active.period))} · signed debit/credit pairs per fund and income
                type with TaxRate &lsquo;No VAT&rsquo;, tracked against each fund via {trackingNameValue}. The
                cash-account statement CSV carries the month&rsquo;s actual cash movements instead (Xero bank-statement
                format) for importing the Epworth account as a cash account. Everything is generated as CSVs for the
                bookkeeper to adapt — nothing is pushed to Xero by the platform.
              </p>
              <p className="text-[11px] text-stone-500 mt-1.5">
                Feed-through: investment income appears against each fund in reporting once the journal is posted in
                Xero and the next sync runs.
              </p>
            </Card>
          </div>
        ) : (
          <Card>
            <EmptyState
              title="No Epworth report loaded"
              hint="Upload the monthly report and holdings are matched to their remembered fund mappings — only new lines will need attention."
            />
          </Card>
        )}
      </div>

      <div>
        <SectionLabel>Import history</SectionLabel>
        <Card className="overflow-hidden">
          {imports.length === 0 ? (
            <EmptyState
              title="No Epworth reports imported yet"
              hint="Each month's report builds the mapping memory, so later months map themselves."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] min-w-[560px]">
                <thead>
                  <tr>
                    <th className="th-register">File</th>
                    <th className="th-register">Period</th>
                    <th className="th-register text-right">Lines</th>
                    <th className="th-register">Status</th>
                    <th className="th-register">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((imp) => (
                    <tr
                      key={imp.id}
                      onClick={() => setActiveId(imp.id)}
                      className={cx('cursor-pointer hover:bg-paper-2', imp.id === active?.id && 'bg-paper-2')}
                    >
                      <td className="td-register max-w-[240px]">
                        <button
                          className="text-left font-medium text-indigo truncate max-w-full hover:underline underline-offset-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            setActiveId(imp.id)
                          }}
                          title={imp.file_name}
                        >
                          {imp.file_name}
                        </button>
                      </td>
                      <td className="td-register whitespace-nowrap">{formatPeriod(imp.period)}</td>
                      <td className="td-register figure text-right">{holdingsOf(imp).length}</td>
                      <td className="td-register">
                        <ImportStatusChip status={imp.status} />
                      </td>
                      <td className="td-register whitespace-nowrap text-stone-500">{formatDate(imp.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
