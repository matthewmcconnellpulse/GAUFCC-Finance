/**
 * Financials → Cash flow — the weekly-then-monthly cashflow forecast,
 * mirroring GAUFCC's Excel template: INCOME lines, OUTGOINGS lines (stored
 * negative), total/net rows, and Balance b/fwd → c/fwd cascading from the
 * opening balance. Every cell edits in place and saves on blur/Enter.
 *
 * Xero feeds it two ways: read-only "actual cash in/out" comparison rows
 * (from the mirrored bank lines), and per-line fills — a line mapped to Xero
 * account codes can pull its actual net cash for completed periods with one
 * click (those cells are tinted and marked 'xero', and stay editable).
 */
import { useMemo, useState } from 'react'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import { Button, Card, ErrorNotice, Field, Input, LoadingRows, SectionLabel, cx } from '@/components/ui'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { MultiLineChart, money0, type ChartSeries } from '@/components/charts'
import { ImportPanel } from './ImportPanel'
import type { CashflowConfig, CashflowLine } from '@/types/db'
import {
  buildForecastCsv,
  buildPeriods,
  deactivateLine,
  defaultOpeningDate,
  fetchCells,
  fetchConfig,
  fetchLines,
  fetchXeroActuals,
  insertLine,
  lineActual,
  round2,
  seedTemplateLines,
  todayIso,
  updateLine,
  upsertCell,
  upsertConfig,
  type CfPeriod,
  type XeroCashActuals,
} from './lib'

const num2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function figure(v: number): string {
  return v === 0 ? '—' : num2.format(v)
}

/** '1,234.56', '(500)', '−500', '- 500' → number; null when unparseable. */
function parseAmountInput(raw: string): number | null {
  let s = raw.trim().replace(/[£,\s]/g, '').replace(/−/g, '-')
  if (!s) return 0
  let sign = 1
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1
    s = s.slice(1, -1)
  }
  const n = Number(s)
  return Number.isFinite(n) ? round2(n * sign) : null
}

// ── Editable cell ────────────────────────────────────────────────────────────

function CellEditor({
  value,
  filledFrom,
  section,
  canEdit,
  onCommit,
}: {
  value: number
  /** Where the figure came from, if not typed here — tints the cell. */
  filledFrom: 'xero' | 'import' | null
  section: 'income' | 'outgoing'
  canEdit: boolean
  onCommit: (next: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function commit() {
    const parsed = parseAmountInput(draft)
    setEditing(false)
    if (parsed === null) return
    // The template stores outgoings negative — typing 500 in an outgoings row
    // means £500 out. A leading '+' keeps a genuine credit positive.
    let next = parsed
    if (section === 'outgoing' && parsed > 0 && !draft.trim().startsWith('+')) next = -parsed
    if (next !== value) onCommit(next)
  }

  if (!canEdit) {
    return <span className={cx('figure', value < 0 && 'text-danger-ink')}>{figure(value)}</span>
  }
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value === 0 ? '' : String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(e.target.value)
          e.target.select()
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="w-[86px] rounded border border-indigo/40 bg-white px-1.5 py-0.5 text-[11.5px] figure text-right focus:outline-none focus:ring-2 focus:ring-indigo/30"
      />
    )
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className={cx(
        'w-full text-right figure rounded px-1 py-0.5 hover:bg-indigo/[.06] cursor-text',
        value < 0 && 'text-danger-ink',
        filledFrom === 'xero' && 'bg-mint/10',
        filledFrom === 'import' && 'bg-indigo/[.07]',
      )}
      title={
        filledFrom === 'xero'
          ? 'Filled from Xero — click to override'
          : filledFrom === 'import'
            ? 'Imported from a spreadsheet — click to override'
            : 'Click to edit'
      }
    >
      {figure(value)}
    </button>
  )
}

// ── Setup card (first run) ───────────────────────────────────────────────────

function SetupCard({ onSaved }: { onSaved: () => void }) {
  const { profile } = useAuth()
  const [balance, setBalance] = useState('')
  const [date, setDate] = useState(defaultOpeningDate())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!profile) return
    const opening = parseAmountInput(balance)
    if (opening === null) {
      setError('The opening balance needs to be a number.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await upsertConfig(
        { opening_balance: opening, opening_date: date, weekly_weeks: 13, monthly_months: 6 },
        profile.id,
      )
      await seedTemplateLines()
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The forecast could not be set up.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5 max-w-xl">
      <h2 className="text-[15px] font-medium text-ink">Set up the cashflow forecast</h2>
      <p className="text-[12px] text-stone-500 mt-1 mb-4">
        The grid mirrors the Excel template — 13 weekly columns rolling into 6 monthly ones, income and
        outgoings lines, and a balance that cascades from the opening position. The template's standard lines
        are created for you; add, rename or remove them freely.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Main account balance at the start" hint="Balance b/fwd for the first week column.">
          <Input value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="e.g. 80678.90" className="font-mono" />
        </Field>
        <Field label="First week starts" hint="Snapped to the Monday of that week.">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      <div className="mt-4">
        <Button variant="money" disabled={busy} onClick={() => void save()}>
          Create forecast
        </Button>
      </div>
    </Card>
  )
}

// ── Settings panel (anchor, horizon) ────────────────────────────────────────

/**
 * The forecast's anchor and horizon, edited in place.
 *
 * These used to be three window.prompt() calls, which is no way to change the
 * opening balance of a cashflow: no validation until you had already committed,
 * no way to see the current values while typing, and nothing to cancel back to.
 */
function SettingsPanel({
  config,
  currentWeekLabel,
  onClose,
  onSaved,
}: {
  config: CashflowConfig
  currentWeekLabel: string
  onClose: () => void
  onSaved: () => void
}) {
  const { profile } = useAuth()
  const [balance, setBalance] = useState(String(config.opening_balance))
  const [date, setDate] = useState(config.opening_date)
  const [weeks, setWeeks] = useState(String(config.weekly_weeks))
  const [months, setMonths] = useState(String(config.monthly_months))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!profile) return
    const opening = parseAmountInput(balance)
    if (opening === null) {
      setError('The opening balance needs to be a number.')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('The opening date needs to be a real date.')
      return
    }
    const w = Number(weeks)
    const m = Number(months)
    if (!Number.isInteger(w) || w < 1 || w > 52) {
      setError('Weekly columns must be between 1 and 52.')
      return
    }
    if (!Number.isInteger(m) || m < 0 || m > 24) {
      setError('Monthly columns must be between 0 and 24.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await upsertConfig(
        { ...config, opening_balance: opening, opening_date: date, weekly_weeks: w, monthly_months: m },
        profile.id,
      )
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The settings could not be saved.')
      setBusy(false)
    }
  }

  return (
    <Card className="p-4 border-indigo/30">
      <div className="flex items-start justify-between gap-3">
        <SectionLabel>Forecast settings</SectionLabel>
        <button onClick={onClose} className="text-stone-400 hover:text-ink text-[14px] leading-none" aria-label="Close settings">
          ×
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mt-1">
        <Field label="Opening balance" hint="The bank position as at the date beside it.">
          <Input value={balance} onChange={(e) => setBalance(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Stated at" hint="Snapped to that week's Monday.">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Weekly columns" hint={`Counted forward from ${currentWeekLabel}.`}>
          <Input value={weeks} onChange={(e) => setWeeks(e.target.value)} inputMode="numeric" className="font-mono" />
        </Field>
        <Field label="Monthly columns" hint="Follow on after the last week.">
          <Input value={months} onChange={(e) => setMonths(e.target.value)} inputMode="numeric" className="font-mono" />
        </Field>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      <p className="text-[11px] text-stone-500 mt-1">
        The forecast window always starts at the week you are in, so there is nothing to roll forward — leave
        the opening balance where it was last reconciled and the weeks in between carry the balance through.
      </p>
      <div className="flex items-center gap-2 mt-3">
        <Button variant="money" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

// ── Line editor (rename, Xero codes, fill, remove) ───────────────────────────

function LineEditor({
  line,
  periods,
  onClose,
  onChanged,
  onFill,
}: {
  line: CashflowLine
  periods: CfPeriod[]
  onClose: () => void
  onChanged: () => void
  onFill: (line: CashflowLine) => Promise<number>
}) {
  const [name, setName] = useState(line.name)
  const [codes, setCodes] = useState(line.account_codes.join(', '))
  const [busy, setBusy] = useState(false)
  const [filled, setFilled] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const endedCount = periods.filter((p) => p.ended).length

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await updateLine(line.id, {
        name: name.trim() || line.name,
        account_codes: codes
          .split(/[,\s]+/)
          .map((c) => c.trim())
          .filter(Boolean),
      })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The line could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Remove '${line.name}' from the forecast? Its figures are kept but no longer shown.`)) return
    setBusy(true)
    try {
      await deactivateLine(line.id)
      onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The line could not be removed.')
      setBusy(false)
    }
  }

  return (
    <Card className="p-4 border-indigo/30">
      <div className="flex items-start justify-between gap-3">
        <SectionLabel>Edit line — {line.section === 'income' ? 'income' : 'outgoings'}</SectionLabel>
        <button onClick={onClose} className="text-stone-400 hover:text-ink text-[14px] leading-none" aria-label="Close line editor">
          ×
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 mt-1">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Xero account codes"
          hint="Comma-separated P&L codes. Lets this line pull its actual cash from Xero."
        >
          <Input value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="e.g. 200160, 206160" className="font-mono" />
        </Field>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <Button variant="money" disabled={busy} onClick={() => void save()}>
          Save line
        </Button>
        <Button
          variant="ghost"
          disabled={busy || line.account_codes.length === 0 || endedCount === 0}
          title={
            line.account_codes.length === 0
              ? 'Map Xero account codes first (save the line, then fill)'
              : undefined
          }
          onClick={() => {
            setBusy(true)
            setError(null)
            void onFill(line)
              .then((n) => setFilled(n))
              .catch((e) => setError(e instanceof Error ? e.message : 'The fill failed.'))
              .finally(() => setBusy(false))
          }}
        >
          Fill completed periods from Xero
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void remove()} className="text-danger-ink">
          Remove line
        </Button>
        {filled !== null ? (
          <span className="text-[11.5px] text-mint-900">{filled} period{filled === 1 ? '' : 's'} filled from Xero</span>
        ) : null}
      </div>
    </Card>
  )
}

// ── The page ─────────────────────────────────────────────────────────────────

export default function CashflowPage() {
  const { profile } = useAuth()
  const p = usePermissions()
  const canEdit = p.isAdmin || p.isBookkeeper || p.isCeo
  // The imports bucket is Pulse-only, so the spreadsheet import is too — the
  // CEO can still type into any cell.
  const canImport = p.isPulse

  const configQ = useSupabaseQuery(fetchConfig)
  const linesQ = useSupabaseQuery(fetchLines)
  const cellsQ = useSupabaseQuery(fetchCells)

  const config = configQ.data ?? null
  const periods = useMemo(() => (config ? buildPeriods(config) : []), [config])

  const actualsQ = useSupabaseQuery(
    () =>
      periods.length > 0
        ? fetchXeroActuals(periods)
        : Promise.resolve<XeroCashActuals>({ cashIn: {}, cashOut: {}, byCode: {} }),
    [periods.length, periods[0]?.start ?? '', periods[periods.length - 1]?.endExclusive ?? ''],
  )

  const [editingLine, setEditingLine] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Local overlay so cell edits render instantly without a refetch round-trip.
  const [overrides, setOverrides] = useState<Map<string, { amount: number; note: string | null }>>(new Map())

  const lines = linesQ.data ?? []
  const incomeLines = lines.filter((l) => l.section === 'income')
  const outgoingLines = lines.filter((l) => l.section === 'outgoing')

  const cellMap = useMemo(() => {
    const map = new Map<string, { amount: number; note: string | null }>()
    for (const c of cellsQ.data ?? []) map.set(`${c.line_id}|${c.period_start}`, { amount: c.amount, note: c.note })
    for (const [k, v] of overrides) map.set(k, v)
    return map
  }, [cellsQ.data, overrides])

  const cellAt = (lineId: string, period: CfPeriod) => cellMap.get(`${lineId}|${period.start}`)

  const totals = useMemo(() => {
    const totalIncome = periods.map((per) =>
      round2(incomeLines.reduce((s, l) => s + (cellAt(l.id, per)?.amount ?? 0), 0)),
    )
    const totalOutgoings = periods.map((per) =>
      round2(outgoingLines.reduce((s, l) => s + (cellAt(l.id, per)?.amount ?? 0), 0)),
    )
    const netMovement = periods.map((_, i) => round2(totalIncome[i] + totalOutgoings[i]))
    const balanceBf: number[] = []
    const balanceCf: number[] = []
    let running = config?.opening_balance ?? 0
    for (let i = 0; i < periods.length; i++) {
      balanceBf.push(round2(running))
      running = round2(running + netMovement[i])
      balanceCf.push(running)
    }
    return { totalIncome, totalOutgoings, netMovement, balanceBf, balanceCf }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, incomeLines, outgoingLines, cellMap, config?.opening_balance])

  // Completed weeks between the opening date and today are folded away by
  // default — they are the cascade the current week's b/fwd depends on, not
  // something the forecast reader needs across the screen. Column indices are
  // kept alongside so every row can slice the same way as the totals.
  const historyPeriods = useMemo(() => periods.filter((per) => per.ended), [periods])
  const currentPeriod = useMemo(() => periods.find((per) => per.current) ?? null, [periods])
  const visible = useMemo(() => {
    const idx = periods
      .map((per, i) => ({ per, i }))
      .filter(({ per }) => showHistory || !per.ended)
    return { periods: idx.map((x) => x.per), indices: idx.map((x) => x.i) }
  }, [periods, showHistory])
  const pick = <T,>(values: T[]): T[] => visible.indices.map((i) => values[i])

  async function commitCell(line: CashflowLine, period: CfPeriod, amount: number) {
    if (!profile) return
    setOverrides((prev) => new Map(prev).set(`${line.id}|${period.start}`, { amount, note: null }))
    try {
      await upsertCell({ line_id: line.id, period_start: period.start, amount, updated_by: profile.id })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The cell could not be saved.')
      cellsQ.refetch()
    }
  }

  async function fillLineFromXero(line: CashflowLine): Promise<number> {
    if (!profile) return 0
    const actuals = actualsQ.data
    if (!actuals) return 0
    const today = todayIso()
    let filled = 0
    const next = new Map(overrides)
    for (const per of periods) {
      if (!per.ended) continue
      const amount = lineActual(actuals, line.account_codes, per.start)
      next.set(`${line.id}|${per.start}`, { amount, note: 'xero' })
      await upsertCell({ line_id: line.id, period_start: per.start, amount, note: 'xero', updated_by: profile.id })
      filled += 1
    }
    setOverrides(next)
    return filled
  }

  async function addLine(section: 'income' | 'outgoing') {
    const name = window.prompt(section === 'income' ? 'New income line name' : 'New outgoings line name')
    if (!name?.trim()) return
    try {
      const maxSort = Math.max(-1, ...lines.filter((l) => l.section === section).map((l) => l.sort_order))
      await insertLine({ section, name: name.trim(), sort_order: maxSort + 1 })
      linesQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The line could not be added.')
    }
  }

  function exportCsv() {
    const csv = buildForecastCsv({
      periods,
      incomeLines: incomeLines.map((l) => ({ name: l.name, values: periods.map((per) => cellAt(l.id, per)?.amount ?? 0) })),
      outgoingLines: outgoingLines.map((l) => ({ name: l.name, values: periods.map((per) => cellAt(l.id, per)?.amount ?? 0) })),
      ...totals,
    })
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cashflow-forecast-${todayIso()}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const loading = (configQ.loading && !configQ.data) || (linesQ.loading && !linesQ.data) || (cellsQ.loading && !cellsQ.data)
  if (loading) {
    return (
      <Card>
        <LoadingRows cols={8} rows={10} />
      </Card>
    )
  }
  const queryError = configQ.error ?? linesQ.error ?? cellsQ.error
  if (queryError) {
    return <ErrorNotice message={`The cashflow forecast could not be loaded — ${queryError}`} />
  }

  if (!config) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="font-display text-[26px] text-ink">Cash flow</h1>
          <p className="text-[12.5px] text-stone-500 mt-1">
            A rolling weekly cashflow forecast, fed by Xero and freely amendable.
          </p>
        </div>
        {canEdit ? (
          <SetupCard onSaved={() => configQ.refetch()} />
        ) : (
          <Card className="p-5 text-[12.5px] text-stone-600">The forecast has not been set up yet.</Card>
        )}
      </div>
    )
  }

  const balanceSeries: ChartSeries[] = [
    { key: 'balance', label: 'Main account balance c/fwd', slot: 0, values: pick(totals.balanceCf) },
  ]
  const today = todayIso()
  const editingLineObj = lines.find((l) => l.id === editingLine) ?? null

  const configBar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11.5px] text-stone-600">
      <span>
        Opening balance <b className="figure text-ink">{money0(config.opening_balance)}</b> stated at{' '}
        <span className="font-mono">{config.opening_date}</span>
      </span>
      <span className="text-stone-400">·</span>
      <span>
        Forecast runs {config.weekly_weeks} weeks from{' '}
        <b className="text-ink">{currentPeriod?.label ?? 'this week'}</b>, then {config.monthly_months} months
      </span>
      {historyPeriods.length > 0 ? (
        <>
          <span className="text-stone-400">·</span>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="text-indigo hover:underline underline-offset-2"
          >
            {showHistory ? 'hide' : 'show'} {historyPeriods.length} completed week
            {historyPeriods.length === 1 ? '' : 's'}
          </button>
        </>
      ) : null}
      {canEdit ? (
        <>
          <span className="text-stone-400">·</span>
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className="text-indigo hover:underline underline-offset-2"
          >
            {settingsOpen ? 'close settings' : 'settings'}
          </button>
        </>
      ) : null}
    </div>
  )

  function sectionRows(sectionLines: CashflowLine[], section: 'income' | 'outgoing') {
    return sectionLines.map((l) => (
      <tr key={l.id} className="hover:bg-paper-2/60">
        <td className="td-register sticky left-0 bg-white z-10 whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            {canEdit ? (
              <button
                onClick={() => setEditingLine(editingLine === l.id ? null : l.id)}
                className={cx(
                  'text-[11px] leading-none px-1 rounded',
                  editingLine === l.id ? 'text-indigo font-bold' : 'text-stone-300 hover:text-indigo',
                )}
                title="Edit this line (name, Xero codes, fill, remove)"
                aria-label={`Edit ${l.name}`}
              >
                ⚙
              </button>
            ) : null}
            <span className="text-[12px] text-stone-700">{l.name}</span>
            {l.account_codes.length > 0 ? (
              <span className="font-mono text-[9.5px] text-stone-400" title={`Mapped to Xero: ${l.account_codes.join(', ')}`}>
                {l.account_codes.join(' ')}
              </span>
            ) : null}
          </span>
        </td>
        {visible.periods.map((per) => {
          const cell = cellAt(l.id, per)
          return (
            <td
              key={per.start}
              className={cx(
                'td-register text-right whitespace-nowrap',
                per.ended && 'bg-paper-2/50',
                per.current && 'bg-indigo/[.04]',
                per.kind === 'month' && 'border-l border-stone-150',
              )}
            >
              <CellEditor
                value={cell?.amount ?? 0}
                filledFrom={cell?.note === 'xero' ? 'xero' : cell?.note === 'import' ? 'import' : null}
                section={section}
                canEdit={canEdit}
                onCommit={(next) => void commitCell(l, per, next)}
              />
            </td>
          )
        })}
      </tr>
    ))
  }

  const actuals = actualsQ.data

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] text-ink">Cash flow</h1>
          <p className="text-[12.5px] text-stone-500 mt-1">
            Weekly forecast rolling into monthly, starting from the week you are in — every figure is editable
            and completed weeks can be filled from Xero. Outgoings are entered as money out (type 500, it
            stores −500; use +500 for a refund in).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canImport ? (
            <Button variant="ghost" onClick={() => setImportOpen((v) => !v)}>
              {importOpen ? 'Close import' : 'Import spreadsheet'}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={exportCsv}>
            Export CSV
          </Button>
        </div>
      </div>

      {configBar}
      {error ? <ErrorNotice message={error} /> : null}
      {importedCount !== null ? (
        <div className="rounded-card border border-mint-700/40 bg-mint/10 text-mint-900 text-[12.5px] px-4 py-3 flex items-center justify-between gap-2">
          <span>
            {importedCount} figure{importedCount === 1 ? '' : 's'} imported into the forecast. Imported cells are
            tinted — click any of them to override.
          </span>
          <button onClick={() => setImportedCount(null)} className="underline underline-offset-2">
            dismiss
          </button>
        </div>
      ) : null}
      {importOpen && canImport ? (
        <ImportPanel
          lines={lines}
          periods={periods}
          onClose={() => setImportOpen(false)}
          onApplied={(n) => {
            setImportedCount(n)
            setOverrides(new Map())
            cellsQ.refetch()
          }}
        />
      ) : null}
      {settingsOpen && canEdit ? (
        <SettingsPanel
          config={config}
          currentWeekLabel={currentPeriod?.label ?? 'this week'}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => configQ.refetch()}
        />
      ) : null}
      {editingLineObj ? (
        <LineEditor
          line={editingLineObj}
          periods={periods}
          onClose={() => setEditingLine(null)}
          onChanged={() => linesQ.refetch()}
          onFill={fillLineFromXero}
        />
      ) : null}

      {/* Balance line — where the money runs out is the whole point */}
      <Card className="p-4">
        <h3 className="text-[13px] font-medium text-ink mb-1">Projected main account balance</h3>
        <p className="text-[11px] text-stone-500 mb-3">
          Balance carried forward per column — opening balance plus cumulative net movement. Dates are week
          commencing; hover any point for the full label and figure.
        </p>
        <MultiLineChart
          labels={visible.periods.map((per) => per.label)}
          tickLabels={visible.periods.map((per) => per.shortLabel)}
          series={balanceSeries}
          markerIndex={visible.periods.findIndex((per) => per.current)}
          ariaLabel="Projected balance by period"
        />
        {totals.balanceCf.some((v) => v < 0) ? (
          <p className="text-[11.5px] text-danger-ink mt-2">
            ⚠ The balance goes negative in{' '}
            {periods[totals.balanceCf.findIndex((v) => v < 0)]?.label} — money runs out on these assumptions.
          </p>
        ) : null}
      </Card>

      {/* The grid */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-[11.5px]" style={{ minWidth: visible.periods.length * 104 + 260 }}>
            <thead>
              <tr>
                <th className="th-register sticky left-0 bg-white z-10 min-w-[240px]">
                  Week commencing / month
                </th>
                {visible.periods.map((per) => (
                  <th
                    key={per.start}
                    className={cx(
                      'th-register text-right whitespace-nowrap',
                      per.kind === 'month' && 'border-l border-stone-150',
                      per.current && 'bg-indigo/[.05]',
                    )}
                  >
                    <span className={cx('block', per.ended && 'text-stone-400', per.current && 'text-indigo font-semibold')}>
                      {per.shortLabel}
                    </span>
                    <span className="block text-[9px] font-normal tracking-normal normal-case text-stone-400">
                      {per.current ? 'this week' : per.kind === 'month' ? 'month' : per.ended ? 'ended' : ''}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="td-register sticky left-0 bg-white z-10 text-[10.5px] font-medium uppercase tracking-[.08em] text-stone-500">
                  Income
                  {canEdit ? (
                    <button onClick={() => void addLine('income')} className="ml-2 text-indigo hover:underline underline-offset-2 normal-case tracking-normal">
                      + add line
                    </button>
                  ) : null}
                </td>
                <td colSpan={visible.periods.length} />
              </tr>
              {sectionRows(incomeLines, 'income')}
              <tr className="bg-paper-2 font-medium">
                <td className="td-register sticky left-0 bg-paper-2 z-10">Total income</td>
                {pick(totals.totalIncome).map((v, i) => (
                  <td key={i} className="td-register figure text-right whitespace-nowrap">
                    {figure(v)}
                  </td>
                ))}
              </tr>
              {actuals ? (
                <tr className="text-stone-500">
                  <td className="td-register sticky left-0 bg-white z-10 text-[10.5px]">Xero actual cash in</td>
                  {visible.periods.map((per) => (
                    <td key={per.start} className="td-register figure text-right whitespace-nowrap text-[10.5px]">
                      {actuals.cashIn[per.start] ? num2.format(actuals.cashIn[per.start]) : '—'}
                    </td>
                  ))}
                </tr>
              ) : null}

              <tr>
                <td className="td-register sticky left-0 bg-white z-10 text-[10.5px] font-medium uppercase tracking-[.08em] text-stone-500">
                  Outgoings
                  {canEdit ? (
                    <button onClick={() => void addLine('outgoing')} className="ml-2 text-indigo hover:underline underline-offset-2 normal-case tracking-normal">
                      + add line
                    </button>
                  ) : null}
                </td>
                <td colSpan={visible.periods.length} />
              </tr>
              {sectionRows(outgoingLines, 'outgoing')}
              <tr className="bg-paper-2 font-medium">
                <td className="td-register sticky left-0 bg-paper-2 z-10">Total outgoings</td>
                {pick(totals.totalOutgoings).map((v, i) => (
                  <td key={i} className={cx('td-register figure text-right whitespace-nowrap', v < 0 && 'text-danger-ink')}>
                    {figure(v)}
                  </td>
                ))}
              </tr>
              {actuals ? (
                <tr className="text-stone-500">
                  <td className="td-register sticky left-0 bg-white z-10 text-[10.5px]">Xero actual cash out</td>
                  {visible.periods.map((per) => (
                    <td key={per.start} className="td-register figure text-right whitespace-nowrap text-[10.5px]">
                      {actuals.cashOut[per.start] ? num2.format(actuals.cashOut[per.start]) : '—'}
                    </td>
                  ))}
                </tr>
              ) : null}

              <tr className="border-t border-stone-200 font-medium">
                <td className="td-register sticky left-0 bg-white z-10">Net movement</td>
                {pick(totals.netMovement).map((v, i) => (
                  <td key={i} className={cx('td-register figure text-right whitespace-nowrap', v < 0 && 'text-danger-ink')}>
                    {figure(v)}
                  </td>
                ))}
              </tr>
              <tr className="text-stone-600">
                <td className="td-register sticky left-0 bg-white z-10">Balance b/fwd</td>
                {pick(totals.balanceBf).map((v, i) => (
                  <td key={i} className={cx('td-register figure text-right whitespace-nowrap', v < 0 && 'text-danger-ink')}>
                    {num2.format(v)}
                  </td>
                ))}
              </tr>
              <tr className="bg-indigo text-paper font-medium">
                <td className="px-4 py-2.5 sticky left-0 bg-indigo z-10 text-[11.5px]">Balance c/fwd</td>
                {pick(totals.balanceCf).map((v, i) => (
                  <td key={i} className={cx('px-4 py-2.5 figure text-right whitespace-nowrap text-[11.5px]', v < 0 && 'text-[#ffb3b3]')}>
                    {num2.format(v)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-[11px] text-stone-500">
        The forecast starts at the week you are in and moves with the calendar — completed weeks fold away but
        still carry the balance through, so the first column's b/fwd is the real position. The ⚙ on a line maps
        it to Xero account codes and fills completed columns with the actual cash from the mirror (tinted green,
        still editable). The 'Xero actual cash in/out' rows show the real bank movements per period for a
        sense-check against the forecast, whatever the line mapping. Cells tinted indigo came in from an
        imported spreadsheet; both kinds stay editable.
      </p>
    </div>
  )
}
