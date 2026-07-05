/**
 * Settings → Fund classification — the queue of funds auto-created from Xero
 * tracking options that Pulse has not yet classified (classified_at is null).
 * Pulse sets the fund type, opening balance and date, purpose and per-fund
 * warning rules; saving stamps classified_at.
 */
import { useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  FundTypeChip,
  Input,
  LoadingRows,
  Select,
  Textarea,
  cx,
} from '@/components/ui'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { Fund, FundType, WarningRules } from '@/types/db'
import { classifyFund, fetchAllFunds } from './lib'
import { SectionCard } from './components'

const FUND_TYPES: FundType[] = ['restricted', 'endowment', 'designated', 'general', 'dormant']

export default function ClassificationTab() {
  const { isPulse } = usePermissions()
  const fundsQuery = useSupabaseQuery(() => fetchAllFunds(), [])
  const [openId, setOpenId] = useState<string | null>(null)

  if (!isPulse) {
    return (
      <Card>
        <EmptyState title="Pulse access only" hint="Fund classification is handled by the Pulse team." />
      </Card>
    )
  }

  const funds = fundsQuery.data ?? []
  const queue = funds.filter((f) => f.classified_at === null)
  const classified = funds.length - queue.length

  return (
    <SectionCard
      title="Fund classification queue"
      hint={`New tracking options synced from Xero wait here until they are classified. ${classified} of ${funds.length} funds are classified.`}
    >
      {fundsQuery.loading && !fundsQuery.data ? (
        <LoadingRows cols={3} rows={4} />
      ) : fundsQuery.error ? (
        <div className="p-5">
          <ErrorNotice message={fundsQuery.error} />
        </div>
      ) : queue.length === 0 ? (
        <EmptyState
          title="Nothing to classify"
          hint="Every fund from Xero has a type and an opening balance. New tracking options will appear here after a sync."
        />
      ) : (
        <div className="divide-y divide-paper-3">
          {queue.map((f) => (
            <ClassifyRow
              key={f.id}
              fund={f}
              open={openId === f.id}
              onToggle={() => setOpenId(openId === f.id ? null : f.id)}
              onSaved={() => {
                setOpenId(null)
                fundsQuery.refetch()
              }}
            />
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function ClassifyRow({
  fund,
  open,
  onToggle,
  onSaved,
}: {
  fund: Fund
  open: boolean
  onToggle: () => void
  onSaved: () => void
}) {
  const [fundType, setFundType] = useState<FundType>(fund.fund_type ?? 'general')
  const [openingBalance, setOpeningBalance] = useState(String(fund.opening_balance ?? 0))
  const [openingDate, setOpeningDate] = useState(fund.opening_balance_date ?? '')
  const [purpose, setPurpose] = useState(fund.purpose ?? '')
  const [rules, setRules] = useState<WarningRules>(fund.warning_rules ?? {})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const balance = Number(openingBalance.replace(/,/g, ''))
      await classifyFund(fund.id, {
        fund_type: fundType,
        opening_balance: Number.isFinite(balance) ? balance : 0,
        opening_balance_date: openingDate || null,
        purpose: purpose.trim() || null,
        warning_rules: rules,
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The fund could not be classified')
      setBusy(false)
    }
  }

  return (
    <div className={cx(open && 'bg-paper')}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-paper-2"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink truncate">{fund.name}</div>
          <div className="text-[10.5px] text-stone-500 mt-0.5">Awaiting classification since sync</div>
        </div>
        <span className="text-[11px] text-indigo font-medium shrink-0">{open ? 'Close' : 'Classify'}</span>
      </button>

      {open ? (
        <div className="px-5 pb-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Fund type">
              <Select value={fundType} onChange={(e) => setFundType(e.target.value as FundType)}>
                {FUND_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Opening balance (£)">
              <Input
                inputMode="decimal"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Opening balance date">
              <Input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} className="font-mono" />
            </Field>
          </div>
          <Field label="Purpose" hint="What this fund may be spent on — restricted funds especially">
            <Textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} className="min-h-16" />
          </Field>

          <div>
            <div className="label-base">Warning rules for this fund (blank = use the defaults)</div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Field label="Minimum balance (£)">
                <Input
                  inputMode="decimal"
                  value={rules.min_balance ?? ''}
                  placeholder="default"
                  onChange={(e) =>
                    setRules({ ...rules, min_balance: e.target.value.trim() === '' ? null : Number(e.target.value) })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label="Movement factor">
                <Input
                  inputMode="decimal"
                  value={rules.unusual_movement_factor ?? ''}
                  placeholder="default"
                  onChange={(e) =>
                    setRules({
                      ...rules,
                      unusual_movement_factor: e.target.value.trim() === '' ? null : Number(e.target.value),
                    })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label="Dormancy months">
                <Input
                  inputMode="numeric"
                  value={rules.dormancy_months ?? ''}
                  placeholder="default"
                  onChange={(e) =>
                    setRules({ ...rules, dormancy_months: e.target.value.trim() === '' ? null : Number(e.target.value) })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label="Flag deficits">
                <Select
                  value={rules.flag_deficit == null ? 'default' : rules.flag_deficit ? 'yes' : 'no'}
                  onChange={(e) =>
                    setRules({
                      ...rules,
                      flag_deficit: e.target.value === 'default' ? undefined : e.target.value === 'yes',
                    })
                  }
                >
                  <option value="default">Default</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </Field>
            </div>
          </div>

          {error ? <ErrorNotice message={error} /> : null}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[11px] text-stone-500">
              Will be shown as <FundTypeChip type={fundType} />
            </div>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Classify fund'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
