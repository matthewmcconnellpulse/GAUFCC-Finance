/**
 * VAT period editor — Pulse-only create/edit form for vat_periods. Includes
 * the "Pull candidates from Xero" assist: deterministic sums over the
 * transaction mirror shown as clearly-labelled estimates the user applies,
 * confirms or edits. Saving recalculates and stores the de minimis result.
 */
import { useMemo, useState, type ChangeEvent } from 'react'
import { Button, Card, ErrorNotice, Field, Input, Select } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import type { VatPeriod } from '@/types/db'
import {
  insertVatPeriod,
  pullXeroCandidates,
  updateVatPeriod,
  type XeroCandidates,
} from './lib'
import { EstimateChip } from './components'
import {
  calculatePartialExemption,
  periodKind,
  periodLabel,
  periodMonths,
  periodRange,
  type PeriodKind,
} from './vatCalc'

interface DraftStrings {
  taxable_supplies: string
  exempt_supplies: string
  da_taxable: string
  da_exempt: string
  residual: string
}

function toNumber(s: string): number {
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

export default function PeriodEditor({
  existing,
  takenPeriods,
  onSaved,
  onCancel,
}: {
  existing: VatPeriod | null
  /** period strings already in use — blocks duplicate inserts client-side */
  takenPeriods: string[]
  onSaved: (p: VatPeriod) => void
  onCancel: () => void
}) {
  const now = new Date()
  const initialKind: PeriodKind = existing ? periodKind(existing.period) : 'quarter'
  const [kind, setKind] = useState<PeriodKind>(initialKind)
  const [year, setYear] = useState<string>(existing ? existing.period.slice(0, 4) : String(now.getFullYear()))
  const [month, setMonth] = useState<string>(
    existing && periodKind(existing.period) === 'month' ? existing.period.slice(5, 7) : String(now.getMonth() + 1).padStart(2, '0'),
  )
  const [quarter, setQuarter] = useState<string>(
    existing && periodKind(existing.period) === 'quarter'
      ? existing.period.slice(5).toUpperCase()
      : `Q${Math.floor(now.getMonth() / 3) + 1}`,
  )

  const [draft, setDraft] = useState<DraftStrings>({
    taxable_supplies: existing ? String(existing.taxable_supplies) : '',
    exempt_supplies: existing ? String(existing.exempt_supplies) : '',
    da_taxable: existing ? String(existing.directly_attributable?.taxable ?? 0) : '',
    da_exempt: existing ? String(existing.directly_attributable?.exempt ?? 0) : '',
    residual: existing ? String(existing.residual_input_vat) : '',
  })

  const [candidates, setCandidates] = useState<XeroCandidates | null>(null)
  const [pulling, setPulling] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const period = useMemo(() => {
    if (kind === 'month') return `${year}-${month}`
    if (kind === 'quarter') return `${year}-${quarter}`
    return year
  }, [kind, year, month, quarter])

  const duplicate = !existing && takenPeriods.includes(period)

  const set = (key: keyof DraftStrings) => (e: ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }))

  async function pull() {
    setPulling(true)
    setError(null)
    setCandidates(null)
    try {
      const range = periodRange(period)
      setCandidates(await pullXeroCandidates(range.start, range.end))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the Xero mirror')
    } finally {
      setPulling(false)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const input = {
        taxable_supplies: toNumber(draft.taxable_supplies),
        exempt_supplies: toNumber(draft.exempt_supplies),
        directly_attributable: {
          taxable: toNumber(draft.da_taxable),
          exempt: toNumber(draft.da_exempt),
        },
        residual_input_vat: toNumber(draft.residual),
        months: periodMonths(period),
      }
      const result = calculatePartialExemption(input)
      const payload = {
        period,
        taxable_supplies: input.taxable_supplies,
        exempt_supplies: input.exempt_supplies,
        residual_input_vat: input.residual_input_vat,
        directly_attributable: input.directly_attributable,
        de_minimis_result: result,
      }
      const saved = existing ? await updateVatPeriod(existing.id, payload) : await insertVatPeriod(payload)
      onSaved(saved)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The period could not be saved')
    } finally {
      setSaving(false)
    }
  }

  const years: string[] = []
  for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 6; y -= 1) years.push(String(y))

  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-3.5 border-b border-stone-150 font-display text-[16px] text-ink">
        {existing ? `Edit ${periodLabel(existing.period)}` : 'New VAT period'}
      </div>
      <div className="p-5 space-y-4">
        {/* Period picker */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Period type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)} disabled={!!existing}>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </Select>
          </Field>
          <Field label="Year">
            <Select value={year} onChange={(e) => setYear(e.target.value)} disabled={!!existing}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
          </Field>
          {kind === 'month' ? (
            <Field label="Month">
              <Select value={month} onChange={(e) => setMonth(e.target.value)} disabled={!!existing}>
                {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
                  <option key={m} value={m}>
                    {new Date(2000, Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'long' })}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {kind === 'quarter' ? (
            <Field label="Quarter" hint="Calendar quarters">
              <Select value={quarter} onChange={(e) => setQuarter(e.target.value)} disabled={!!existing}>
                <option value="Q1">Q1 (Jan – Mar)</option>
                <option value="Q2">Q2 (Apr – Jun)</option>
                <option value="Q3">Q3 (Jul – Sep)</option>
                <option value="Q4">Q4 (Oct – Dec)</option>
              </Select>
            </Field>
          ) : null}
        </div>
        {duplicate ? <ErrorNotice message={`A record for ${periodLabel(period)} already exists — select it from the period list instead.`} /> : null}

        {/* Figures */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="Taxable supplies (£)" hint="Standard, reduced and zero-rated income, VAT-exclusive">
            <Input inputMode="decimal" placeholder="0.00" value={draft.taxable_supplies} onChange={set('taxable_supplies')} className="font-mono" />
          </Field>
          <Field label="Exempt supplies (£)" hint="Income from exempt activities">
            <Input inputMode="decimal" placeholder="0.00" value={draft.exempt_supplies} onChange={set('exempt_supplies')} className="font-mono" />
          </Field>
          <Field label="Residual input VAT (£)" hint="VAT on overheads used for both">
            <Input inputMode="decimal" placeholder="0.00" value={draft.residual} onChange={set('residual')} className="font-mono" />
          </Field>
          <Field label="Input VAT — directly taxable (£)" hint="Wholly attributable to taxable activity">
            <Input inputMode="decimal" placeholder="0.00" value={draft.da_taxable} onChange={set('da_taxable')} className="font-mono" />
          </Field>
          <Field label="Input VAT — directly exempt (£)" hint="Wholly attributable to exempt activity">
            <Input inputMode="decimal" placeholder="0.00" value={draft.da_exempt} onChange={set('da_exempt')} className="font-mono" />
          </Field>
        </div>

        {/* Xero assist */}
        <div className="rounded-card border border-stone-150 bg-paper p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[12.5px] font-medium text-ink">Pull candidates from Xero</div>
              <div className="text-[11px] text-stone-500 mt-0.5">
                Sums income and purchase VAT in the mirror for {periodLabel(period)} — estimates to start from, not the answer.
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void pull()} disabled={pulling}>
              {pulling ? 'Reading mirror…' : 'Pull candidates'}
            </Button>
          </div>
          {candidates ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <EstimateChip />
                <span className="text-[10.5px] text-stone-500">
                  The taxable/exempt split and direct attribution are judgements Xero cannot make — review every figure.
                </span>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                <div className="rounded-control border border-stone-150 bg-white px-3.5 py-2.5 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[11.5px] text-ink">
                      Income lines <span className="figure font-medium">{formatMoney(candidates.income_total)}</span>
                    </div>
                    <div className="text-[10.5px] text-stone-500">{candidates.income_lines} lines → suggested taxable supplies</div>
                  </div>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => setDraft((d) => ({ ...d, taxable_supplies: candidates.income_total.toFixed(2) }))}
                  >
                    Apply
                  </Button>
                </div>
                <div className="rounded-control border border-stone-150 bg-white px-3.5 py-2.5 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[11.5px] text-ink">
                      VAT on purchases <span className="figure font-medium">{formatMoney(candidates.input_vat_total)}</span>
                    </div>
                    <div className="text-[10.5px] text-stone-500">{candidates.expense_lines} lines → suggested residual input VAT</div>
                  </div>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => setDraft((d) => ({ ...d, residual: candidates.input_vat_total.toFixed(2) }))}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {error ? <ErrorNotice message={error} /> : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="quiet" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="money" onClick={() => void save()} disabled={saving || duplicate}>
            {saving ? 'Saving…' : 'Save and calculate'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
