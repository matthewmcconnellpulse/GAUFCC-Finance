/**
 * Settings → General → What a report opens on.
 *
 * GAUFCC's financial year starts on 1 October, so "this financial year" — the
 * old hard-coded default — meant that from 1 October every report in the
 * system opened on a year that was days old. On 13 October 2026 that was FY27
 * with 36 ledger lines in it, against a normal month of about 245.
 *
 * The shipped default therefore reads the ledger rather than the clock. Two
 * things in the live data make that harder than "the last month with rows",
 * and latestDataMonth handles both: a single line dated September 2027 (a
 * mis-key, eleven months ahead, which a max-date rule would have followed),
 * and the current month part-posted, which would read as a collapse in
 * activity. See latestDataMonth in modules/reports/lib for the rule.
 *
 * Writable by pulse_admin only — app_private.guard_settings_write() allows no
 * one else for this key, so the form matches the rule rather than discovering
 * it on save.
 */
import { useEffect, useMemo, useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import { Button, ErrorNotice, Field, Input, LoadingRows, Select, StatusChip } from '@/components/ui'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import {
  DEFAULT_REPORT_DEFAULT,
  fetchActivityMonths,
  fetchReportDefaultSetting,
  periodLabel,
  resolveDefaultPeriod,
  type PeriodPreset,
  type ReportDefaultSetting,
} from '@/modules/reports/lib'
import { updateSettingValue } from './lib'
import { SectionCard } from './components'

type Mode = ReportDefaultSetting['mode']

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'latest_data_month', label: 'The latest month with real activity' },
  { value: 'preset', label: 'A fixed period type' },
  { value: 'fixed', label: 'A fixed set of dates' },
]

const PRESETS: Array<{ value: Exclude<PeriodPreset, 'custom'>; label: string }> = [
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year', label: 'This calendar year' },
  { value: 'fy', label: 'This financial year' },
]

export default function ReportDefaultCard() {
  const { isAdmin } = usePermissions()
  const canEdit = isAdmin

  const saved = useSupabaseQuery(fetchReportDefaultSetting, [])
  const months = useSupabaseQuery(fetchActivityMonths, [])

  const [draft, setDraft] = useState<ReportDefaultSetting>(DEFAULT_REPORT_DEFAULT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    if (saved.data) setDraft(saved.data)
  }, [saved.data])

  // Exactly what a reader would land on if this were saved — the setting is
  // abstract, the resulting period is not, so show the period.
  const preview = useMemo(
    () => (months.data ? resolveDefaultPeriod(draft, months.data) : null),
    [draft, months.data],
  )

  const save = async () => {
    setSaving(true)
    setError(null)
    setSavedAt(null)
    try {
      await updateSettingValue('report_default_period', draft)
      setSavedAt(new Date().toLocaleTimeString('en-GB'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The default could not be saved')
    } finally {
      setSaving(false)
    }
  }

  const setMode = (mode: Mode) => {
    if (mode === 'latest_data_month') setDraft({ mode })
    else if (mode === 'preset') setDraft({ mode, preset: 'fy' })
    else {
      const fallback = preview ?? { start: '', end: '' }
      setDraft({ mode: 'fixed', start: fallback.start, end: fallback.end })
    }
  }

  return (
    <SectionCard
      title="What a report opens on"
      hint="The period the report builder and board pack start from, before anyone changes it."
      actions={preview ? <StatusChip tone="good">{periodLabel(preview)}</StatusChip> : null}
    >
      <div className="px-5 py-4">
        {saved.loading ? (
          <LoadingRows cols={2} rows={3} />
        ) : (
          <>
            {saved.error ? (
              <div className="mb-3">
                <ErrorNotice message={`The current setting could not be read — ${saved.error}`} />
              </div>
            ) : null}

            <div className="grid md:grid-cols-2 gap-4">
              <Field label="Default period">
                <Select
                  value={draft.mode}
                  disabled={!canEdit}
                  onChange={(e) => setMode(e.target.value as Mode)}
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>

              {draft.mode === 'preset' ? (
                <Field label="Which period">
                  <Select
                    value={draft.preset}
                    disabled={!canEdit}
                    onChange={(e) =>
                      setDraft({
                        mode: 'preset',
                        preset: e.target.value as Exclude<PeriodPreset, 'custom'>,
                      })
                    }
                  >
                    {PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>

            {draft.mode === 'fixed' ? (
              <div className="grid md:grid-cols-2 gap-4 mt-4">
                <Field label="From">
                  <Input
                    type="date"
                    value={draft.start}
                    disabled={!canEdit}
                    onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                  />
                </Field>
                <Field label="To">
                  <Input
                    type="date"
                    value={draft.end}
                    disabled={!canEdit}
                    onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}

            <p className="text-[11.5px] text-stone-500 mt-3">
              {draft.mode === 'latest_data_month'
                ? 'Read from the ledger each time, so it never goes stale and never opens on a month that has barely been posted. A part-posted month is skipped until it carries a normal share of activity, and anything dated in the future is ignored.'
                : draft.mode === 'preset'
                  ? 'Always this period type, measured from today. Note that a financial year starting 1 October will be nearly empty for the first weeks of October.'
                  : 'Always these exact dates, for everyone, until someone changes them here.'}
            </p>

            {months.error ? (
              <p className="text-[11.5px] text-warn-ink mt-2">
                The ledger's month activity could not be read ({months.error}), so the preview above
                is unavailable. Reports fall back to the financial year if this stays unreadable.
              </p>
            ) : null}

            {error ? (
              <div className="mt-3">
                <ErrorNotice message={`Save failed — ${error}`} />
              </div>
            ) : null}

            {canEdit ? (
              <div className="flex items-center gap-2 mt-4">
                <Button variant="money" disabled={saving} onClick={() => void save()}>
                  {saving ? 'Saving…' : 'Save default'}
                </Button>
                {savedAt ? (
                  <span className="text-[11.5px] text-stone-500">
                    Saved at {savedAt}. It applies the next time someone opens a report.
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-[11.5px] text-stone-500 mt-4">
                Only a Pulse administrator can change this.
              </p>
            )}
          </>
        )}
      </div>
    </SectionCard>
  )
}
