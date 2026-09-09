/**
 * Settings → Xero → Budget and reserves.
 *
 * Two things the board pack needs and cannot infer:
 *
 * - Which Xero budget to track against, this year and last. The list is read
 *   live from Xero, which needs the accounting.budgets.read scope on the
 *   custom connection — it is not in the default set, so when it is missing
 *   this says exactly that instead of showing an empty dropdown.
 * - The annual operating budget, the denominator of reserve coverage. It is
 *   typed here as a fallback: once the tracked Xero budget carries a full year
 *   of expenditure the pack derives the denominator from that instead. Either
 *   way it is never guessed — with neither, coverage reports as unavailable.
 *
 * Writable by pulse_admin only, which is what the settings guard in the
 * database allows; the CEO's exception covers the two payment-cycle keys and
 * nothing else.
 */
import { useEffect, useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  ErrorNotice,
  Field,
  Input,
  LoadingRows,
  Select,
  StatusChip,
} from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { SETTING_KEYS } from '@/types/db'
import { fetchBudgetList, fetchManagementSettings } from '@/modules/reports/management'
import { updateSettingValue } from './lib'
import { SectionCard } from './components'

export default function BudgetSection() {
  const { isAdmin } = usePermissions()
  // app_private.guard_settings_write() lets only pulse_admin write settings —
  // the CEO's exception is scoped to the two payment-cycle keys. Offering the
  // form more widely than that would fail at the database, so the UI matches
  // the rule rather than discovering it on save.
  const canEdit = isAdmin

  const settings = useSupabaseQuery(fetchManagementSettings, [])
  const budgets = useSupabaseQuery(fetchBudgetList, [])

  const [annualBudget, setAnnualBudget] = useState('')
  const [budgetId, setBudgetId] = useState('')
  const [priorBudgetId, setPriorBudgetId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!settings.data) return
    setAnnualBudget(
      settings.data.annualOperatingBudget === null ? '' : String(settings.data.annualOperatingBudget),
    )
    setBudgetId(settings.data.xeroBudgetId ?? '')
    setPriorBudgetId(settings.data.xeroPriorBudgetId ?? '')
  }, [settings.data])

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const trimmed = annualBudget.replace(/[£,\s]/g, '')
      if (trimmed) {
        const n = Number(trimmed)
        if (!Number.isFinite(n) || n <= 0) {
          setError('The annual operating budget needs to be a positive number.')
          setSaving(false)
          return
        }
        await updateSettingValue(SETTING_KEYS.annualOperatingBudget, Math.round(n * 100) / 100)
      } else {
        await updateSettingValue(SETTING_KEYS.annualOperatingBudget, null)
      }
      await updateSettingValue(SETTING_KEYS.xeroBudgetId, budgetId || null)
      await updateSettingValue(SETTING_KEYS.xeroPriorBudgetId, priorBudgetId || null)
      setSaved(true)
      settings.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The budget settings could not be saved')
    } finally {
      setSaving(false)
    }
  }

  if (settings.loading && !settings.data) return <LoadingRows cols={2} rows={4} />

  const scopeMissing = budgets.data && !budgets.data.scope_ok
  const list = budgets.data?.budgets ?? []
  const options = [
    { value: '', label: list.length === 0 ? 'No budgets available' : 'Not tracked' },
    ...list.map((b) => ({ value: b.budget_id, label: b.description })),
  ]

  return (
    <SectionCard
      title="Budget and reserves"
      hint="What the board pack tracks against, and the denominator of reserve coverage"
      actions={
        saved ? <StatusChip tone="good">Saved</StatusChip> : null
      }
    >
      <div className="px-5 py-4 space-y-4">
        {scopeMissing ? (
          <div className="rounded-card border border-warn/50 bg-warn/10 text-warn-ink text-[12px] px-3.5 py-2.5">
            <b className="font-medium">Xero will not release the budgets yet.</b>{' '}
            {budgets.data?.error ??
              'The custom connection needs the accounting.budgets.read scope.'}{' '}
            Budget tracking stays empty in the pack until that is done — everything else is unaffected.
          </div>
        ) : null}
        {budgets.error ? (
          <ErrorNotice message={`The budget list could not be read — ${budgets.error}`} />
        ) : null}
        {!scopeMissing && !budgets.loading && !budgets.error && list.length === 0 ? (
          <div className="rounded-card border border-stone-150 bg-paper-2 text-[12px] text-stone-600 px-3.5 py-2.5">
            Xero has no budgets on this organisation yet. Once the 26/27 figures are entered in Xero they
            appear here and the pack's budget page fills in automatically.
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="This year’s budget"
            hint="The Xero budget the pack compares actuals against."
          >
            <Select
              value={budgetId}
              disabled={!canEdit || list.length === 0}
              onChange={(e) => setBudgetId(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Last year’s budget" hint="Shown as the comparative column. Optional.">
            <Select
              value={priorBudgetId}
              disabled={!canEdit || list.length === 0}
              onChange={(e) => setPriorBudgetId(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Annual operating budget"
          hint="The denominator of reserve coverage: (general funds + cash at bank) ÷ this figure. Leave blank and coverage reports as unavailable rather than guessing."
        >
          <Input
            value={annualBudget}
            disabled={!canEdit}
            onChange={(e) => setAnnualBudget(e.target.value)}
            placeholder="e.g. 1250000"
            className="font-mono max-w-xs"
          />
        </Field>
        {settings.data?.annualOperatingBudget ? (
          <p className="text-[11px] text-stone-500">
            Currently {formatMoney(settings.data.annualOperatingBudget)} a year — about{' '}
            {formatMoney(settings.data.annualOperatingBudget / 12)} a month of operating cost.
          </p>
        ) : null}

        {error ? <ErrorNotice message={error} /> : null}

        {canEdit ? (
          <Button variant="money" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save budget settings'}
          </Button>
        ) : (
          <p className="text-[11px] text-stone-500">
            Only a Pulse admin can change these — ask us and we will set them for you.
          </p>
        )}
      </div>
    </SectionCard>
  )
}
