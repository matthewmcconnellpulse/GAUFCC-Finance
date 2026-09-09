/**
 * Cashflow spreadsheet import — upload the client's workbook, let AI map it
 * onto the forecast grid, review the mapping, then apply it.
 *
 * The model is given the grid's real line ids and period dates and asked to
 * solve only the mapping problem — which sheet row is which forecast line,
 * which column is which week. It never computes: totals, balances and net
 * movement rows are deliberately ignored because the grid derives those
 * itself, and any line id or date the model did not receive from us is dropped
 * server-side.
 *
 * Nothing is written until the reviewer presses apply. Figures for trustees
 * do not get set by a model unchallenged, and the review step is also where a
 * column matched to the wrong week gets caught — cheap here, expensive later.
 */
import { useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, ErrorNotice, SectionLabel, cx } from '@/components/ui'
import { invokeFunction } from '@/lib/supabase'
import type { CashflowLine } from '@/types/db'
import {
  CASHFLOW_IMPORT_ACCEPT,
  applyParsedCells,
  isSupportedCashflowFile,
  uploadCashflowFile,
  type CfPeriod,
  type ParsedCashflow,
} from './lib'

const num2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function ImportPanel({
  lines,
  periods,
  onClose,
  onApplied,
}: {
  lines: CashflowLine[]
  periods: CfPeriod[]
  onClose: () => void
  onApplied: (count: number) => void
}) {
  const { profile } = useAuth()
  const [fileName, setFileName] = useState<string | null>(null)
  const [stage, setStage] = useState<'idle' | 'uploading' | 'reading' | 'review' | 'applying'>('idle')
  const [parsed, setParsed] = useState<ParsedCashflow | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines])
  const periodByStart = useMemo(() => new Map(periods.map((p) => [p.start, p])), [periods])

  const rows = useMemo(() => {
    if (!parsed) return []
    return parsed.cells
      .map((c) => ({
        ...c,
        key: `${c.line_id}|${c.period_start}`,
        line: lineById.get(c.line_id) ?? null,
        period: periodByStart.get(c.period_start) ?? null,
      }))
      .sort((a, b) => {
        if (a.line?.section !== b.line?.section) return a.line?.section === 'income' ? -1 : 1
        const nameCmp = (a.line?.name ?? '').localeCompare(b.line?.name ?? '')
        return nameCmp !== 0 ? nameCmp : a.period_start.localeCompare(b.period_start)
      })
  }, [parsed, lineById, periodByStart])

  const accepted = rows.filter((r) => !excluded.has(r.key))
  const acceptedTotal = accepted.reduce((s, r) => s + r.amount, 0)

  async function handleFile(file: File) {
    if (!isSupportedCashflowFile(file.name)) {
      setError('That file type cannot be read — upload an .xlsx, .xls or .csv.')
      return
    }
    setError(null)
    setParsed(null)
    setExcluded(new Set())
    setFileName(file.name)
    try {
      setStage('uploading')
      const path = await uploadCashflowFile(file)
      setStage('reading')
      const res = await invokeFunction<ParsedCashflow>('parse-cashflow', {
        storage_path: path,
        lines: lines.map((l) => ({ id: l.id, name: l.name, section: l.section })),
        periods: periods.map((p) => ({ start: p.start, label: p.label, kind: p.kind })),
      })
      setParsed(res)
      setStage('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The spreadsheet could not be read.')
      setStage('idle')
    }
  }

  async function apply() {
    if (!profile || accepted.length === 0) return
    setStage('applying')
    setError(null)
    try {
      await applyParsedCells(
        accepted.map((r) => ({ line_id: r.line_id, period_start: r.period_start, amount: r.amount })),
        profile.id,
      )
      onApplied(accepted.length)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The figures could not be applied.')
      setStage('review')
    }
  }

  const busy = stage === 'uploading' || stage === 'reading' || stage === 'applying'

  return (
    <Card className="p-4 border-indigo/30">
      <div className="flex items-start justify-between gap-3">
        <SectionLabel>Import figures from a spreadsheet</SectionLabel>
        <button onClick={onClose} className="text-stone-400 hover:text-ink text-[14px] leading-none" aria-label="Close import">
          ×
        </button>
      </div>

      {stage === 'idle' || stage === 'uploading' || stage === 'reading' ? (
        <>
          <p className="text-[12px] text-stone-600 mt-1 mb-3">
            Upload the cashflow workbook as it comes — .xlsx, .xls or .csv. Rows are matched to the forecast
            lines by meaning and columns to the weeks by date, so the sheet does not have to be laid out our
            way. Totals, balance and net movement rows are ignored; the grid works those out itself. You review
            the mapping before anything is written.
          </p>
          <label
            onDragOver={(e) => {
              if (busy) return
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              if (busy) return
              const file = e.dataTransfer.files?.[0]
              if (file) void handleFile(file)
            }}
            className={cx(
              'flex flex-col items-center justify-center gap-1.5 rounded-card border border-dashed px-4 py-7 text-center cursor-pointer',
              busy
                ? 'border-stone-200 bg-paper-2 cursor-wait'
                : dragging
                  ? 'border-indigo bg-indigo/[.05]'
                  : 'border-stone-300 hover:border-indigo/50 hover:bg-paper-2',
            )}
          >
            <input
              type="file"
              accept={CASHFLOW_IMPORT_ACCEPT}
              disabled={busy}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void handleFile(file)
              }}
            />
            <span className="text-[12.5px] font-medium text-ink">
              {stage === 'uploading'
                ? `Uploading ${fileName}…`
                : stage === 'reading'
                  ? `Reading ${fileName}…`
                  : 'Choose a spreadsheet'}
            </span>
            <span className="text-[11px] text-stone-500">
              {busy ? 'This takes a few seconds for a full workbook.' : 'or drop one on this panel'}
            </span>
          </label>
        </>
      ) : null}

      {stage === 'review' || stage === 'applying' ? (
        <>
          <p className="text-[12px] text-stone-600 mt-1">
            {rows.length === 0
              ? `Nothing in ${fileName} could be matched to the forecast.`
              : `${rows.length} figure${rows.length === 1 ? '' : 's'} read from ${fileName}. Untick anything that looks wrong — the rest is written to the grid, overwriting whatever those cells hold now.`}
          </p>

          {parsed?.notes ? (
            <div className="mt-3 rounded-card border border-stone-150 bg-paper-2 px-3.5 py-2.5 text-[11.5px] text-stone-700">
              <b className="font-medium">Worth checking</b> — {parsed.notes}
            </div>
          ) : null}

          {(parsed?.unmatched_rows.length ?? 0) > 0 || (parsed?.unmatched_columns.length ?? 0) > 0 ? (
            <div className="mt-3 rounded-card border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[11.5px] text-warn-ink space-y-1">
              {(parsed?.unmatched_rows.length ?? 0) > 0 ? (
                <div>
                  <b className="font-medium">Rows left out</b> — {parsed?.unmatched_rows.join(', ')}. Add a
                  matching forecast line and import again if these are needed.
                </div>
              ) : null}
              {(parsed?.unmatched_columns.length ?? 0) > 0 ? (
                <div>
                  <b className="font-medium">Columns left out</b> — {parsed?.unmatched_columns.join(', ')}.
                  These fall outside the forecast window.
                </div>
              ) : null}
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="mt-3 max-h-80 overflow-y-auto border border-stone-150 rounded-control">
              <table className="w-full text-[11.5px]">
                <thead className="sticky top-0 bg-paper">
                  <tr>
                    <th className="th-register w-8"></th>
                    <th className="th-register text-left">Line</th>
                    <th className="th-register text-left">Period</th>
                    <th className="th-register text-right">Amount</th>
                    <th className="th-register text-left">From</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const on = !excluded.has(r.key)
                    return (
                      <tr key={r.key} className={cx('border-t border-stone-150', !on && 'opacity-40')}>
                        <td className="td-register">
                          <input
                            type="checkbox"
                            checked={on}
                            className="accent-[#211951]"
                            aria-label={`Include ${r.line?.name} for ${r.period?.label}`}
                            onChange={(e) =>
                              setExcluded((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.delete(r.key)
                                else next.add(r.key)
                                return next
                              })
                            }
                          />
                        </td>
                        <td className="td-register">
                          {r.line?.name ?? <span className="text-danger-ink">unknown line</span>}
                          <span className="text-stone-400 ml-1.5 text-[10px] uppercase tracking-[.08em]">
                            {r.line?.section === 'outgoing' ? 'out' : 'in'}
                          </span>
                        </td>
                        <td className="td-register whitespace-nowrap">{r.period?.label ?? r.period_start}</td>
                        <td className={cx('td-register figure text-right whitespace-nowrap', r.amount < 0 && 'text-danger-ink')}>
                          {num2.format(r.amount)}
                        </td>
                        <td className="td-register text-stone-400 font-mono text-[10px] whitespace-nowrap">
                          {r.source_col && r.source_row ? `${r.source_col}${r.source_row}` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3">
              <ErrorNotice message={error} />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Button variant="money" disabled={busy || accepted.length === 0} onClick={() => void apply()}>
              {stage === 'applying'
                ? 'Applying…'
                : `Apply ${accepted.length} figure${accepted.length === 1 ? '' : 's'}`}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setParsed(null); setStage('idle') }}>
              Choose another file
            </Button>
            {accepted.length > 0 ? (
              <span className="text-[11px] text-stone-500">
                Net effect on the forecast <b className="figure text-ink">{num2.format(acceptedTotal)}</b>
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {error && stage !== 'review' ? (
        <div className="mt-3">
          <ErrorNotice message={error} />
        </div>
      ) : null}
    </Card>
  )
}
