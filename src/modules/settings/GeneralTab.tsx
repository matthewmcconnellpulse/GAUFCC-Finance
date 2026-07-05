/**
 * Settings → General — the expense approval and payment run days (1–28
 * selects, editable by pulse_admin and the CEO), the nightly sync hour
 * (display only) and the default warning rules applied to funds without
 * per-fund overrides (pulse_admin only, per the database guard).
 */
import { useEffect, useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import { Button, ErrorNotice, Field, Input, LoadingRows, Select, StatusChip } from '@/components/ui'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { WarningRules } from '@/types/db'
import { SETTING_KEYS } from '@/types/db'
import { fetchSettings, settingValue, updateSettingValue } from './lib'
import { SectionCard } from './components'

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1)

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

export default function GeneralTab() {
  const { isAdmin, isCeo } = usePermissions()
  const canEditDays = isAdmin || isCeo
  const canEditWarnings = isAdmin

  const query = useSupabaseQuery(() => fetchSettings(), [])

  const [approvalDay, setApprovalDay] = useState<number | null>(null)
  const [paymentDay, setPaymentDay] = useState<number | null>(null)
  const [warnings, setWarnings] = useState<WarningRules | null>(null)
  const [saving, setSaving] = useState<'days' | 'warnings' | null>(null)
  const [saved, setSaved] = useState<'days' | 'warnings' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // seed local form state once the settings arrive
  useEffect(() => {
    if (!query.data) return
    setApprovalDay(settingValue<number>(query.data, SETTING_KEYS.expenseApprovalDay, 10))
    setPaymentDay(settingValue<number>(query.data, SETTING_KEYS.paymentRunDay, 17))
    setWarnings(
      settingValue<WarningRules>(query.data, SETTING_KEYS.warningDefaults, {
        min_balance: null,
        flag_deficit: true,
        unusual_movement_factor: 2.5,
        dormancy_months: 24,
      }),
    )
  }, [query.data])

  const syncHour = settingValue<number>(query.data, SETTING_KEYS.syncHour, 4)

  async function saveDays() {
    if (approvalDay == null || paymentDay == null) return
    setSaving('days')
    setError(null)
    setSaved(null)
    try {
      await updateSettingValue(SETTING_KEYS.expenseApprovalDay, approvalDay)
      await updateSettingValue(SETTING_KEYS.paymentRunDay, paymentDay)
      setSaved('days')
      query.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The dates could not be saved')
    } finally {
      setSaving(null)
    }
  }

  async function saveWarnings() {
    if (!warnings) return
    setSaving('warnings')
    setError(null)
    setSaved(null)
    try {
      await updateSettingValue(SETTING_KEYS.warningDefaults, warnings)
      setSaved('warnings')
      query.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The warning defaults could not be saved')
    } finally {
      setSaving(null)
    }
  }

  if (query.loading && !query.data) {
    return <LoadingRows cols={3} rows={6} />
  }
  if (query.error) {
    return <ErrorNotice message={query.error} />
  }

  return (
    <div className="space-y-4">
      {error ? <ErrorNotice message={error} /> : null}

      {/* Payment cycle */}
      <SectionCard
        title="Expense payment cycle"
        hint="Used dynamically everywhere — the submitter banner, the CEO approval queue and the payment run all read these values live."
        actions={
          canEditDays ? (
            <div className="flex items-center gap-2">
              {saved === 'days' ? <StatusChip tone="good">Saved</StatusChip> : null}
              <Button size="sm" variant="primary" disabled={saving !== null} onClick={() => void saveDays()}>
                {saving === 'days' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="p-5">
          <div className="grid sm:grid-cols-2 gap-4 max-w-lg">
            <Field label="Approval deadline day" hint="Claims must be submitted and CEO-approved on or before this day">
              <Select
                value={approvalDay ?? 10}
                disabled={!canEditDays}
                onChange={(e) => setApprovalDay(Number(e.target.value))}
                className="font-mono"
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment run day" hint="Approved claims are paid on this day each month">
              <Select
                value={paymentDay ?? 17}
                disabled={!canEditDays}
                onChange={(e) => setPaymentDay(Number(e.target.value))}
                className="font-mono"
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {approvalDay != null && paymentDay != null && paymentDay <= approvalDay ? (
            <p className="text-[11.5px] text-warn-ink mt-3">
              The payment run day is on or before the approval deadline — claims approved on the {ordinal(approvalDay)} would
              roll to the following month's run.
            </p>
          ) : null}
          {!canEditDays ? (
            <p className="text-[11px] text-stone-500 mt-3">These dates are set by a Pulse admin or the CEO.</p>
          ) : null}
        </div>
      </SectionCard>

      {/* Sync hour */}
      <SectionCard title="Nightly sync" hint="The pg_cron schedule mirrors this value.">
        <div className="p-5 flex items-center gap-3">
          <span className="figure text-[20px] text-ink">{String(syncHour).padStart(2, '0')}:00</span>
          <span className="text-[12px] text-stone-500">
            Europe/London, every night. A manual "Refresh now" is always available in the top bar and is debounced to one
            run per five minutes.
          </span>
        </div>
      </SectionCard>

      {/* Warning defaults */}
      <SectionCard
        title="Fund warning defaults"
        hint="Applied to funds without per-fund overrides. Warnings surface as amber badges — never red unless a policy is breached."
        actions={
          canEditWarnings ? (
            <div className="flex items-center gap-2">
              {saved === 'warnings' ? <StatusChip tone="good">Saved</StatusChip> : null}
              <Button size="sm" variant="primary" disabled={saving !== null} onClick={() => void saveWarnings()}>
                {saving === 'warnings' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="p-5">
          {warnings ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Field label="Minimum balance (£)" hint="Blank = no minimum">
                <Input
                  inputMode="decimal"
                  disabled={!canEditWarnings}
                  value={warnings.min_balance ?? ''}
                  placeholder="none"
                  onChange={(e) =>
                    setWarnings({
                      ...warnings,
                      min_balance: e.target.value.trim() === '' ? null : Number(e.target.value),
                    })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label="Unusual movement factor" hint="Flag when a period's movement exceeds this multiple of the trailing average">
                <Input
                  inputMode="decimal"
                  disabled={!canEditWarnings}
                  value={warnings.unusual_movement_factor ?? ''}
                  placeholder="e.g. 2.5"
                  onChange={(e) =>
                    setWarnings({
                      ...warnings,
                      unusual_movement_factor: e.target.value.trim() === '' ? null : Number(e.target.value),
                    })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label="Dormancy months" hint="Months without movement before a fund is flagged dormant">
                <Input
                  inputMode="numeric"
                  disabled={!canEditWarnings}
                  value={warnings.dormancy_months ?? ''}
                  placeholder="e.g. 24"
                  onChange={(e) =>
                    setWarnings({
                      ...warnings,
                      dormancy_months: e.target.value.trim() === '' ? null : Number(e.target.value),
                    })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label="Flag deficits" hint="Warn when a fund balance goes negative">
                <Select
                  disabled={!canEditWarnings}
                  value={warnings.flag_deficit ? 'yes' : 'no'}
                  onChange={(e) => setWarnings({ ...warnings, flag_deficit: e.target.value === 'yes' })}
                >
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </Field>
            </div>
          ) : null}
          {!canEditWarnings ? (
            <p className="text-[11px] text-stone-500 mt-3">Warning defaults are maintained by a Pulse admin.</p>
          ) : null}
        </div>
      </SectionCard>
    </div>
  )
}
