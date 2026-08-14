/**
 * Claim line editor — one card per line, per the 1g design. Lines read by AI
 * below the confidence threshold get an amber highlight and require an
 * explicit 'Looks right' confirmation before the claim can be submitted.
 */
import { useState, useRef, type ChangeEvent, type DragEvent } from 'react'
import { AiBadge, Button, Field, Input, Select, cx } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import type { ExpenseLine } from '@/types/db'
import { ReceiptThumb, UploadIcon, XIcon } from './components'
import {
  isLowConfidence,
  needsConfirmation,
  round2,
  type CategoryOption,
  type FundOption,
  type StoredExtraction,
} from './lib'

/** full = draft owner · coding = Pulse bookkeeper on a submitted claim · read = everyone else */
export type LineMode = 'full' | 'coding' | 'read'

export function LineCard({
  line,
  categories,
  funds,
  mode,
  onPatch,
  onDelete,
  onConfirm,
}: {
  line: ExpenseLine
  categories: CategoryOption[]
  funds: FundOption[]
  mode: LineMode
  onPatch: (patch: Partial<ExpenseLine>) => void
  onDelete?: () => void
  onConfirm?: () => void
}) {
  // Local strings so typing never fights the persisted value
  const [netText, setNetText] = useState(String(line.net ?? 0))
  const [vatText, setVatText] = useState(String(line.vat ?? 0))
  const [descText, setDescText] = useState(line.description ?? '')

  const editable = mode === 'full'
  const coding = mode === 'coding'
  const unconfirmed = needsConfirmation(line)
  const lowConfidence = isLowConfidence(line)
  const extraction = line.ai_extraction as StoredExtraction | null

  const commitAmounts = (netStr: string, vatStr: string) => {
    const net = round2(Number.parseFloat(netStr) || 0)
    const vat = round2(Number.parseFloat(vatStr) || 0)
    setNetText(String(net))
    setVatText(String(vat))
    if (net !== line.net || vat !== line.vat) {
      onPatch({ net, vat, gross: round2(net + vat) })
    }
  }

  const gross = round2((Number.parseFloat(netText) || 0) + (Number.parseFloat(vatText) || 0))

  return (
    <div
      className={cx(
        'rounded-card border bg-white p-4',
        unconfirmed ? 'border-warn bg-warn/5' : 'border-stone-150',
      )}
    >
      <div className="flex items-start gap-3">
        {line.receipt_storage_path ? (
          <ReceiptThumb path={line.receipt_storage_path} className="w-[42px] h-[52px] shrink-0" />
        ) : null}
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {editable ? (
                <Field label="Description">
                  <Input
                    value={descText}
                    placeholder="What is being claimed? e.g. Train to London — safeguarding training"
                    onChange={(e) => setDescText(e.target.value)}
                    onBlur={() => {
                      const v = descText.trim()
                      if (v !== line.description) onPatch({ description: v })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                    className="py-1.5 text-[13px]"
                  />
                </Field>
              ) : (
                <Field label="Description">
                  <span className="block text-[13px] text-ink py-1.5">
                    {line.description || 'Untitled line'}
                  </span>
                </Field>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
              {line.ai_extraction != null ? <AiBadge confidence={line.ai_confidence} /> : null}
              {editable && onDelete ? (
                <button
                  type="button"
                  onClick={onDelete}
                  className="text-stone-400 hover:text-danger-ink p-1 rounded-control"
                  title="Remove line"
                  aria-label="Remove line"
                >
                  <XIcon />
                </button>
              ) : null}
            </div>
          </div>

          {/* Category and Fund carry long names — they get the widest row. */}
          <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr_1fr] gap-3">
            <Field label="Date">
              {editable ? (
                <Input
                  type="date"
                  value={line.date}
                  onChange={(e) => onPatch({ date: e.target.value })}
                  className="py-1.5 text-[12px]"
                />
              ) : (
                <span className="block font-mono text-[12px] text-ink py-1.5">{line.date}</span>
              )}
            </Field>
            <Field label="Category">
              {editable || coding ? (
                categories.length > 0 ? (
                  <Select
                    value={line.category ?? ''}
                    onChange={(e) => onPatch({ category: e.target.value || null })}
                    className="py-1.5 text-[12px]"
                  >
                    <option value="">Not sure — Pulse will code it</option>
                    {categories.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} — {c.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    defaultValue={line.category ?? ''}
                    placeholder="Account code"
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      if (v !== (line.category ?? '')) onPatch({ category: v || null })
                    }}
                    className="py-1.5 text-[12px]"
                  />
                )
              ) : (
                <span className="block text-[12px] text-ink py-1.5">
                  {categoryLabel(line.category, categories)}
                </span>
              )}
            </Field>
            <Field label="Fund">
              {editable || coding ? (
                <Select
                  value={line.fund_id ?? ''}
                  onChange={(e) => onPatch({ fund_id: e.target.value || null })}
                  className="py-1.5 text-[12px]"
                >
                  <option value="">Not sure — Pulse will code it</option>
                  {funds.map((f) => (
                    <option key={f.fund_id} value={f.fund_id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="block text-[12px] text-ink py-1.5">
                  {funds.find((f) => f.fund_id === line.fund_id)?.name ?? '—'}
                </span>
              )}
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3 sm:max-w-[440px]">
            <Field label="Net">
              {editable ? (
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={netText}
                  onChange={(e) => setNetText(e.target.value)}
                  onBlur={() => commitAmounts(netText, vatText)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  className="py-1.5 text-[12px] font-mono"
                />
              ) : (
                <span className="block font-mono text-[12px] text-ink py-1.5 text-right">
                  {line.net.toFixed(2)}
                </span>
              )}
            </Field>
            <Field label="VAT">
              {editable || coding ? (
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={vatText}
                  onChange={(e) => setVatText(e.target.value)}
                  onBlur={() => commitAmounts(netText, vatText)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  className="py-1.5 text-[12px] font-mono"
                />
              ) : (
                <span className="block font-mono text-[12px] text-ink py-1.5 text-right">
                  {line.vat.toFixed(2)}
                </span>
              )}
            </Field>
            <Field label="Gross" hint={editable ? 'net + VAT' : undefined}>
              <span className="block font-mono text-[12.5px] font-medium text-ink py-1.5 text-right">
                {(editable || coding ? gross : line.gross).toFixed(2)}
              </span>
            </Field>
          </div>

          {extraction?.suggested_category && !line.category && categories.length > 0 ? (
            <div className="text-[10.5px] text-stone-500 mt-2">
              AI suggested '{extraction.suggested_category}' but it didn't match an account — pick one or leave it for Pulse.
            </div>
          ) : null}

          {unconfirmed && onConfirm ? (
            <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-dashed border-warn/50">
              <span className="text-[12px] text-warn-ink leading-relaxed flex-1 min-w-[200px]">
                The receipt was hard to read — is{' '}
                <b className="font-mono">{formatMoney(line.gross)}</b> with{' '}
                <b className="font-mono">{formatMoney(line.vat)}</b> VAT right? Edit the figures or confirm.
              </span>
              <Button size="sm" variant="primary" onClick={onConfirm} className="shrink-0">
                Looks right
              </Button>
            </div>
          ) : null}
          {lowConfidence && !unconfirmed ? (
            <div className="text-[10.5px] text-stone-500 mt-2">Checked by you ✓</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function categoryLabel(code: string | null, categories: CategoryOption[]): string {
  if (!code) return '—'
  const match = categories.find((c) => c.code === code)
  return match ? `${match.code} — ${match.name}` : code
}

// ── Receipt batch upload ─────────────────────────────────────────────────────

export interface UploadJob {
  id: number
  name: string
  status: 'uploading' | 'reading' | 'done' | 'error'
  error?: string
}

export function UploadDropzone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handle = (list: FileList | null) => {
    if (!list || list.length === 0) return
    onFiles(Array.from(list))
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    if (!disabled) handle(e.dataTransfer.files)
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cx(
        'border-2 border-dashed rounded-card bg-white px-5 py-6 flex flex-wrap items-center gap-4 transition-colors',
        dragging ? 'border-mint-700 bg-mint/5' : 'border-stone-300',
        disabled && 'opacity-50',
      )}
    >
      <span className="w-11 h-11 rounded-control bg-mint/15 grid place-items-center shrink-0">
        <UploadIcon />
      </span>
      <div className="flex-1 min-w-[200px]">
        <div className="text-[14px] font-medium text-ink">Drop receipt photos or PDFs here</div>
        <div className="text-[12px] text-stone-500 mt-0.5">
          Snap the whole batch at once — we read the details for you, and you check them.
        </div>
      </div>
      <Button variant="ghost" onClick={() => inputRef.current?.click()} disabled={disabled}>
        Browse files
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,.pdf,application/pdf"
        className="hidden"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          handle(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export function UploadJobList({ jobs }: { jobs: UploadJob[] }) {
  if (jobs.length === 0) return null
  return (
    <ul className="space-y-1.5">
      {jobs.map((job) => (
        <li key={job.id} className="flex items-center gap-2.5 text-[11.5px]">
          <span
            className={cx(
              'w-1.5 h-1.5 rounded-full shrink-0',
              job.status === 'done' && 'bg-mint-700',
              job.status === 'error' && 'bg-warn',
              (job.status === 'uploading' || job.status === 'reading') && 'bg-cyan-600 animate-pulse',
            )}
            aria-hidden
          />
          <span className="font-mono text-[10.5px] text-stone-700 truncate max-w-[240px]">{job.name}</span>
          <span className="text-stone-500">
            {job.status === 'uploading' && 'uploading…'}
            {job.status === 'reading' && 'reading the receipt…'}
            {job.status === 'done' && 'read — check the line below'}
            {job.status === 'error' && (job.error ?? 'something went wrong')}
          </span>
        </li>
      ))}
    </ul>
  )
}
