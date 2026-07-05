/**
 * HSBC statement drop-in — no bank feed exists on the HSBC corporate account,
 * so statements (PDF or CSV) are dropped here, parsed, sense-checked and
 * converted to a Xero-ready bank statement CSV. CSV generation is blocked
 * until every check passes, or a Pulse user overrides with a typed reason
 * (persisted and audit-logged).
 */
import { useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, EmptyState, ErrorNotice, LoadingRows, SectionLabel, Textarea, cx } from '@/components/ui'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { BankImport } from '@/types/db'
import {
  fetchBankImports,
  fileExtension,
  importFilePath,
  insertBankImport,
  parseImport,
  updateBankImport,
  uploadGeneratedCsv,
  uploadImportFile,
  validateImportFile,
  type UploadPhase,
} from './lib'
import { normaliseParsedStatement, parseHsbcCsv, type HsbcParseResult } from './csvParse'
import { runSenseChecks, statusFromChecks, toPersisted, type CheckOutcome } from './senseChecks'
import { buildXeroBankCsv, downloadTextFile, xeroBankCsvFileName } from './xeroCsv'
import { ChecksBadge, FileDrop, ImportStatusChip, Modal, SenseCheckPanel } from './components'

const PHASES: UploadPhase[] = ['uploading', 'parsing', 'checking', 'saving']

function statementPeriod(imp: Pick<BankImport, 'statement_start' | 'statement_end'>): string {
  if (!imp.statement_start && !imp.statement_end) return '—'
  return `${formatDate(imp.statement_start)} – ${formatDate(imp.statement_end)}`
}

// ── Active import summary card ───────────────────────────────────────────────

function SummaryCard({ imp, note }: { imp: BankImport; note: string | null }) {
  const rows = imp.parsed_rows ?? []
  const ext = fileExtension(imp.file_name).toUpperCase() || 'FILE'
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-control bg-indigo/[.07] grid place-items-center font-mono text-[9px] font-semibold text-indigo shrink-0">
          {ext}
        </div>
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink truncate" title={imp.file_name}>
            {imp.file_name}
          </div>
          <div className="font-mono text-[10.5px] text-stone-500 mt-0.5">
            {rows.length} rows parsed · {statementPeriod(imp)}
          </div>
          {note ? <div className="font-mono text-[10.5px] text-stone-500 mt-0.5">{note}</div> : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div className="bg-paper rounded-control px-3 py-2">
          <div className="text-[8.5px] font-medium uppercase tracking-[.1em] text-stone-500">
            Opening {formatDate(imp.statement_start)}
          </div>
          <div className="figure text-[12.5px] font-medium mt-0.5 text-ink">
            {imp.opening_balance != null ? formatMoney(imp.opening_balance) : '—'}
          </div>
        </div>
        <div className="bg-paper rounded-control px-3 py-2">
          <div className="text-[8.5px] font-medium uppercase tracking-[.1em] text-stone-500">
            Closing {formatDate(imp.statement_end)}
          </div>
          <div className="figure text-[12.5px] font-medium mt-0.5 text-ink">
            {imp.closing_balance != null ? formatMoney(imp.closing_balance) : '—'}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-3">
        <ImportStatusChip status={imp.status} />
        <span className="text-[10.5px] text-stone-500">uploaded {formatDateTime(imp.created_at)}</span>
      </div>
      {imp.override_reason ? (
        <div className="mt-3 rounded-control bg-warn/10 border border-warn/30 px-3 py-2 text-[11px] text-warn-ink">
          Checks overridden — “{imp.override_reason}”
        </div>
      ) : null}
    </Card>
  )
}

// ── Register of past imports ─────────────────────────────────────────────────

function ImportRegister({
  imports,
  activeId,
  onSelect,
}: {
  imports: BankImport[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  if (imports.length === 0) {
    return (
      <EmptyState
        title="No statements imported yet"
        hint="Drop the first HSBC statement above — each import is checked against the ones before it."
      />
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] min-w-[760px]">
        <thead>
          <tr>
            <th className="th-register">File</th>
            <th className="th-register">Statement period</th>
            <th className="th-register text-right">Rows</th>
            <th className="th-register text-right">Opening</th>
            <th className="th-register text-right">Closing</th>
            <th className="th-register">Checks</th>
            <th className="th-register">Status</th>
            <th className="th-register">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {imports.map((imp) => {
            const { passed, total } = {
              passed: (imp.sense_check_results ?? []).filter((r) => r.pass).length,
              total: (imp.sense_check_results ?? []).length,
            }
            return (
              <tr
                key={imp.id}
                onClick={() => onSelect(imp.id)}
                className={cx('cursor-pointer hover:bg-paper-2', imp.id === activeId && 'bg-paper-2')}
              >
                <td className="td-register max-w-[220px]">
                  <button
                    className="text-left font-medium text-indigo truncate max-w-full hover:underline underline-offset-2"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelect(imp.id)
                    }}
                    title={imp.file_name}
                  >
                    {imp.file_name}
                  </button>
                </td>
                <td className="td-register whitespace-nowrap">{statementPeriod(imp)}</td>
                <td className="td-register figure text-right">{imp.parsed_rows?.length ?? 0}</td>
                <td className="td-register figure text-right whitespace-nowrap">
                  {imp.opening_balance != null ? formatMoney(imp.opening_balance) : '—'}
                </td>
                <td className="td-register figure text-right whitespace-nowrap">
                  {imp.closing_balance != null ? formatMoney(imp.closing_balance) : '—'}
                </td>
                <td className="td-register">
                  <ChecksBadge passed={passed} total={total} />
                </td>
                <td className="td-register">
                  <ImportStatusChip status={imp.status} />
                </td>
                <td className="td-register whitespace-nowrap text-stone-500">{formatDate(imp.created_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── The tab ──────────────────────────────────────────────────────────────────

export default function HsbcTab() {
  const { profile } = useAuth()
  const importsQ = useSupabaseQuery(fetchBankImports)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [phase, setPhase] = useState<UploadPhase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  const imports = importsQ.data ?? []
  const active = imports.find((i) => i.id === activeId) ?? imports[0] ?? null

  /**
   * Outcomes are recomputed deterministically for whichever import is open so
   * the drill-down of offending rows is always available; the persisted
   * sense_check_results remain the canonical record and drive the status.
   */
  const outcomes = useMemo<CheckOutcome[] | null>(() => {
    if (!active) return null
    if (!active.parsed_rows || active.parsed_rows.length === 0) {
      return active.sense_check_results?.map((r) => ({ ...r })) ?? null
    }
    const priors = imports.filter((p) => p.id !== active.id && p.created_at < active.created_at)
    return runSenseChecks(
      {
        rows: active.parsed_rows,
        opening_balance: active.opening_balance,
        closing_balance: active.closing_balance,
        statement_start: active.statement_start,
        statement_end: active.statement_end,
      },
      priors,
    )
  }, [active, imports])

  async function handleFile(file: File) {
    setError(null)
    const invalid = validateImportFile(file, ['pdf', 'csv'])
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
      const path = importFilePath('hsbc', file.name)
      await uploadImportFile(path, file)

      setPhase('parsing')
      let parsed: HsbcParseResult
      if (fileExtension(file.name) === 'csv') {
        const deterministic = parseHsbcCsv(await file.text())
        if (deterministic) {
          parsed = deterministic
          parsed.layout = `parsed deterministically · ${deterministic.layout}`
        } else {
          parsed = normaliseParsedStatement(
            await parseImport('hsbc_csv', path),
            'layout not recognised — Claude fallback used, check the figures',
          )
        }
      } else {
        parsed = normaliseParsedStatement(
          await parseImport('hsbc_pdf', path),
          'PDF extracted with Claude — check the figures',
        )
      }
      if (parsed.rows.length === 0) {
        throw new Error('No transactions could be read from that file — check it is an HSBC statement export.')
      }

      setPhase('checking')
      const priors = await fetchBankImports() // fresh, not the possibly-stale query cache
      const checkOutcomes = runSenseChecks(
        {
          rows: parsed.rows,
          opening_balance: parsed.opening_balance,
          closing_balance: parsed.closing_balance,
          statement_start: parsed.statement_start,
          statement_end: parsed.statement_end,
        },
        priors,
      )

      setPhase('saving')
      const row = await insertBankImport({
        file_path: path,
        file_name: file.name,
        statement_start: parsed.statement_start,
        statement_end: parsed.statement_end,
        opening_balance: parsed.opening_balance,
        closing_balance: parsed.closing_balance,
        parsed_rows: parsed.rows,
        sense_check_results: toPersisted(checkOutcomes),
        status: statusFromChecks(checkOutcomes),
        uploaded_by: profile.id,
      })
      setNotes((n) => ({ ...n, [row.id]: parsed.layout }))
      setActiveId(row.id)
      importsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong during the import.')
    } finally {
      setPhase(null)
    }
  }

  const canGenerate =
    active != null &&
    (active.parsed_rows?.length ?? 0) > 0 &&
    (active.status === 'ready' || active.status === 'overridden' || active.status === 'exported')
  const blocked = active != null && !canGenerate && active.status !== 'uploaded'

  async function handleGenerate() {
    if (!active?.parsed_rows) return
    setActionBusy(true)
    setError(null)
    try {
      const csv = buildXeroBankCsv(active.parsed_rows)
      downloadTextFile(xeroBankCsvFileName(active.statement_start, active.statement_end), csv)
      const path = `hsbc/generated/${active.id}-xero.csv`
      await uploadGeneratedCsv(path, csv)
      await updateBankImport(active.id, { generated_csv_path: path, status: 'exported' })
      importsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The CSV could not be generated.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleOverride() {
    if (!active || !profile) return
    const reason = overrideReason.trim()
    if (reason.length < 5) return
    setActionBusy(true)
    setError(null)
    try {
      await updateBankImport(active.id, {
        status: 'overridden',
        override_reason: reason,
        overridden_by: profile.id,
      })
      setOverrideOpen(false)
      setOverrideReason('')
      importsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The override could not be saved.')
    } finally {
      setActionBusy(false)
    }
  }

  if (importsQ.loading && !importsQ.data) {
    return (
      <Card>
        <LoadingRows cols={5} rows={7} />
      </Card>
    )
  }
  if (importsQ.error) {
    return <ErrorNotice message={`The import register could not be loaded — ${importsQ.error}`} />
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[380px_1fr] items-start">
        <div className="space-y-3">
          <FileDrop
            title="Drop the HSBC statement"
            hint="PDF or CSV export, up to 10 MB. No feed exists on this account — this drop-in replaces it."
            accept=".pdf,.csv,application/pdf,text/csv"
            busyPhase={phase}
            phases={PHASES}
            onFile={(f) => void handleFile(f)}
          />
          {error ? <ErrorNotice message={error} /> : null}
          {active ? <SummaryCard imp={active} note={notes[active.id] ?? null} /> : null}
        </div>

        <div>
          {active && outcomes ? (
            <SenseCheckPanel
              outcomes={outcomes}
              footer={
                <div className="flex flex-wrap items-center gap-3">
                  {canGenerate ? (
                    <Button variant="money" disabled={actionBusy} onClick={() => void handleGenerate()}>
                      {active.generated_csv_path ? 'Download Xero CSV again' : 'Generate Xero CSV'}
                    </Button>
                  ) : (
                    <button
                      disabled
                      className="inline-flex items-center rounded-full bg-stone-300 text-stone-500 px-5 py-2.5 text-[12.5px] font-medium cursor-not-allowed"
                    >
                      Generate Xero CSV
                    </button>
                  )}
                  {blocked ? (
                    <span className="text-[11.5px] text-stone-500">
                      blocked until every check clears — or{' '}
                      <button
                        className="text-indigo underline underline-offset-2 hover:text-indigo-soft"
                        onClick={() => setOverrideOpen(true)}
                      >
                        override with a reason
                      </button>{' '}
                      (logged to the audit trail)
                    </span>
                  ) : null}
                  {active.status === 'exported' && active.generated_csv_path ? (
                    <span className="text-[11.5px] text-stone-500">
                      a copy is stored at <span className="font-mono text-[10.5px]">{active.generated_csv_path}</span>
                    </span>
                  ) : null}
                </div>
              }
            />
          ) : (
            <Card>
              <EmptyState
                title="Nothing to check yet"
                hint="Upload a statement and the four sense checks run before any Xero CSV can be produced."
              />
            </Card>
          )}
        </div>
      </div>

      <div>
        <SectionLabel>Import history</SectionLabel>
        <Card className="overflow-hidden">
          <ImportRegister imports={imports} activeId={active?.id ?? null} onSelect={setActiveId} />
        </Card>
      </div>

      {overrideOpen && active ? (
        <Modal title="Override the sense checks" onClose={() => setOverrideOpen(false)}>
          <p className="text-[12.5px] text-stone-700">
            This unblocks the Xero CSV for <span className="font-medium">{active.file_name}</span> even though not
            every check has cleared. Your name and reason are recorded on the import and in the audit trail.
          </p>
          <label className="block mt-3">
            <span className="label-base">Reason for overriding</span>
            <Textarea
              autoFocus
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g. 27–28 Jun is a weekend with no activity — confirmed against the paper statement"
            />
          </label>
          <div className="flex items-center justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setOverrideOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={overrideReason.trim().length < 5 || actionBusy}
              onClick={() => void handleOverride()}
            >
              Override and unblock
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
