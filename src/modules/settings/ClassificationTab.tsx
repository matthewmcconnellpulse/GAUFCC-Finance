/**
 * Settings → Fund classification — three sections:
 *   1. The queue of funds auto-created from Xero tracking options that Pulse
 *      has not yet classified (classified_at is null).
 *   2. Opening balances for every fund — reserves at the FY start
 *      (30 September closing = 1 October opening).
 *   3. SORP mapping: every P&L account onto its SOFA heading.
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
import { SORP_EXPENDITURE, SORP_INCOME, SORP_LABELS } from '@/lib/sorp'
import { supabase } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { Fund, FundType, SorpCategory, WarningRules, XeroAccount } from '@/types/db'
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
    <div className="space-y-4">
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

    <OpeningBalancesSection
      funds={funds}
      loading={fundsQuery.loading && !fundsQuery.data}
      onSaved={fundsQuery.refetch}
    />
    <SorpMappingSection />
    </div>
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

/**
 * Opening balances — the reserves each fund held at the financial year start.
 * GAUFCC's year runs 1 October – 30 September, so the balance to enter is the
 * closing reserve at 30.09.2025 with the date 01.10.2025: the balance view
 * then counts FY 25/26 transactions from day one and nothing before.
 */
const FY_OPENING_DATE = '2025-10-01'

function OpeningBalancesSection({
  funds,
  loading,
  onSaved,
}: {
  funds: Fund[]
  loading: boolean
  onSaved: () => void
}) {
  const sorted = [...funds].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return (
    <SectionCard
      title="Opening balances"
      hint="Enter each fund's reserves at 30 September 2025. The date is the day the balance takes effect — 1 October 2025 — so the current year's transactions count from day one."
    >
      {loading ? (
        <LoadingRows cols={3} rows={6} />
      ) : (
        <div className="divide-y divide-paper-3">
          {sorted.map((f) => (
            <OpeningBalanceRow key={f.id} fund={f} onSaved={onSaved} />
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function OpeningBalanceRow({ fund, onSaved }: { fund: Fund; onSaved: () => void }) {
  const [balance, setBalance] = useState(
    fund.opening_balance === 0 ? '' : String(fund.opening_balance),
  )
  const [date, setDate] = useState(fund.opening_balance_date ?? FY_OPENING_DATE)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = Number(balance.replace(/,/g, ''))
  const effectiveBalance = balance.trim() === '' ? 0 : parsed
  const dirty =
    effectiveBalance !== fund.opening_balance || date !== (fund.opening_balance_date ?? FY_OPENING_DATE)
  const valid = balance.trim() === '' || Number.isFinite(parsed)

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    const { error: updateError } = await supabase
      .from('funds')
      .update({ opening_balance: effectiveBalance, opening_balance_date: date || null })
      .eq('id', fund.id)
    if (updateError) {
      setError(updateError.message)
    } else {
      setSaved(true)
      onSaved()
    }
    setBusy(false)
  }

  return (
    <div className="px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <span className="text-[12.5px] text-ink truncate block">{fund.name}</span>
        </div>
        <FundTypeChip type={fund.fund_type} />
        <Input
          inputMode="decimal"
          value={balance}
          placeholder="0.00"
          onChange={(e) => {
            setBalance(e.target.value)
            setSaved(false)
          }}
          className="font-mono !w-[130px] py-1.5 text-[12px] text-right"
          aria-label={`Opening balance for ${fund.name}`}
        />
        <Input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value)
            setSaved(false)
          }}
          className="font-mono !w-[150px] py-1.5 text-[12px]"
          aria-label={`Opening balance date for ${fund.name}`}
        />
        <div className="w-[72px] text-right">
          {saved && !dirty ? (
            <span className="text-[11px] text-mint-900">Saved</span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty || !valid || busy}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>
      </div>
      {error ? <p className="text-[11px] text-danger-ink mt-1">{error}</p> : null}
    </div>
  )
}

/**
 * SORP mapping — every active P&L account onto its SOFA heading. Defaults
 * come from migration heuristics; changes save immediately and survive every
 * sync (the engine never writes sorp_category).
 */
type SorpAccountRow = Pick<XeroAccount, 'account_id' | 'code' | 'name' | 'class' | 'sorp_category'>

async function fetchPlAccounts(): Promise<SorpAccountRow[]> {
  const { data, error } = await supabase
    .from('xero_accounts')
    .select('account_id, code, name, class, sorp_category')
    .in('class', ['REVENUE', 'EXPENSE'])
    .eq('status', 'ACTIVE')
    .order('class', { ascending: false })
    .order('code', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as SorpAccountRow[]
}

function SorpMappingSection() {
  const accounts = useSupabaseQuery(fetchPlAccounts, [])
  return (
    <SectionCard
      title="SORP mapping"
      hint="Each P&L account maps to a Charities SORP (SOFA) heading — fund reports and the SOFA group by these. Defaults were guessed from account names; correct anything misfiled."
    >
      {accounts.loading && !accounts.data ? (
        <LoadingRows cols={2} rows={8} />
      ) : accounts.error ? (
        <div className="p-5">
          <ErrorNotice message={accounts.error} />
        </div>
      ) : (
        <>
          <SorpGroup
            label="Income accounts"
            rows={(accounts.data ?? []).filter((a) => a.class === 'REVENUE')}
            options={SORP_INCOME}
          />
          <SorpGroup
            label="Expenditure accounts"
            rows={(accounts.data ?? []).filter((a) => a.class === 'EXPENSE')}
            options={SORP_EXPENDITURE}
          />
        </>
      )}
    </SectionCard>
  )
}

function SorpGroup({
  label,
  rows,
  options,
}: {
  label: string
  rows: SorpAccountRow[]
  options: SorpCategory[]
}) {
  if (rows.length === 0) return null
  return (
    <div>
      <div className="px-5 pt-4 pb-1 text-[10px] font-medium uppercase tracking-[.14em] text-stone-500">
        {label}
      </div>
      <div className="divide-y divide-paper-3">
        {rows.map((a) => (
          <SorpRow key={a.account_id} account={a} options={options} />
        ))}
      </div>
    </div>
  )
}

function SorpRow({ account, options }: { account: SorpAccountRow; options: SorpCategory[] }) {
  const [value, setValue] = useState<string>(account.sorp_category ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: string) {
    setValue(next)
    setBusy(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('xero_accounts')
      .update({ sorp_category: next === '' ? null : next })
      .eq('account_id', account.account_id)
    if (updateError) {
      setError(updateError.message)
      setValue(account.sorp_category ?? '')
    }
    setBusy(false)
  }

  return (
    <div className="px-5 py-2 flex flex-wrap items-center gap-3">
      <span className="text-[12px] text-stone-700 min-w-0 flex-1 basis-64 truncate">
        {account.code ? `${account.code} · ` : ''}
        {account.name}
      </span>
      <Select
        value={value}
        disabled={busy}
        onChange={(e) => void save(e.target.value)}
        className="!w-auto py-1.5 text-[12px]"
        aria-label={`SORP heading for ${account.name}`}
      >
        <option value="">Unmapped</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {SORP_LABELS[o]}
          </option>
        ))}
      </Select>
      {error ? <span className="text-[11px] text-danger-ink w-full">{error}</span> : null}
    </div>
  )
}
