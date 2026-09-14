/**
 * Agreeing the fund register to a stated position, fund by fund.
 *
 * The three charity-level checks answer "do the totals agree". They cannot
 * answer "which fund is wrong", and they have no memory of a figure agreed at
 * a year end. This does both: it values every fund AT A DATE, compares the
 * total with the figure recorded for that date, and lets each fund be ticked
 * off individually — with the tick lapsing if that fund's balance later moves.
 *
 * Two funds holding the same figure to the penny is called out separately.
 * That is almost never coincidence; it is the same fund in the register twice,
 * and it is a difference with an obvious fix rather than one to go hunting for.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  ErrorNotice,
  Input,
  LoadingRows,
  SectionLabel,
  StatusChip,
  cx,
} from '@/components/ui'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import {
  duplicateBalanceGroups,
  fetchFundBalanceTargets,
  fetchFundBalancesAsAt,
  fetchReconSignoffs,
  fundSignoffState,
  saveFundBalanceTarget,
  signOffFundBalance,
  withdrawFundSignoff,
  type FundBalanceAsAt,
} from './lib'

const DEFAULT_AS_AT = '2025-09-30'

export function FundBalancePanel() {
  const { profile } = useAuth()
  const { isPulse, isCeo } = usePermissions()
  const canSign = isPulse || isCeo

  const [asAt, setAsAt] = useState(DEFAULT_AS_AT)
  const [expectedDraft, setExpectedDraft] = useState('')
  const [editingTarget, setEditingTarget] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onlyUnticked, setOnlyUnticked] = useState(false)

  const balancesQ = useSupabaseQuery(() => fetchFundBalancesAsAt(asAt), [asAt])
  const targetsQ = useSupabaseQuery(fetchFundBalanceTargets, [])
  const signoffsQ = useSupabaseQuery(
    () => fetchReconSignoffs({ start: asAt, end: asAt }),
    [asAt],
  )

  const rows = balancesQ.data ?? []
  const signoffs = signoffsQ.data ?? []
  const target = (targetsQ.data ?? []).find((t) => t.as_at === asAt) ?? null

  const total = useMemo(() => rows.reduce((s, r) => s + r.balance, 0), [rows])
  const difference = target ? Math.round((total - target.expected_total) * 100) / 100 : null
  const agreed = difference !== null && Math.abs(difference) <= 0.01

  const states = useMemo(
    () => new Map(rows.map((r) => [r.fund_id, fundSignoffState(r, signoffs)])),
    [rows, signoffs],
  )
  const tickedCount = [...states.values()].filter((s) => s.kind === 'signed').length
  const lapsedCount = [...states.values()].filter((s) => s.kind === 'superseded').length

  const duplicates = useMemo(() => duplicateBalanceGroups(rows), [rows])
  const duplicateTotal = duplicates.reduce(
    (s, g) => s + g.balance * (g.funds.length - 1),
    0,
  )
  // Does removing one of each duplicated pair close the gap exactly?
  const duplicatesExplain =
    difference !== null &&
    duplicates.length > 0 &&
    Math.abs(Math.round((difference - duplicateTotal) * 100) / 100) <= 0.01

  const visible = onlyUnticked
    ? rows.filter((r) => states.get(r.fund_id)?.kind !== 'signed')
    : rows

  async function tick(fund: FundBalanceAsAt) {
    if (!profile) return
    setBusy(fund.fund_id)
    setError(null)
    try {
      await signOffFundBalance(fund, asAt, profile.id, null)
      signoffsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tick could not be saved')
    } finally {
      setBusy(null)
    }
  }

  async function untick(fundId: string) {
    setBusy(fundId)
    setError(null)
    try {
      await withdrawFundSignoff(fundId, asAt)
      signoffsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tick could not be removed')
    } finally {
      setBusy(null)
    }
  }

  async function tickAllAgreeing() {
    if (!profile) return
    setBusy('all')
    setError(null)
    try {
      for (const row of rows) {
        if (states.get(row.fund_id)?.kind === 'signed') continue
        await signOffFundBalance(row, asAt, profile.id, null)
      }
      signoffsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The ticks could not be saved')
    } finally {
      setBusy(null)
    }
  }

  async function saveTarget() {
    if (!profile) return
    const parsed = Number(expectedDraft.replace(/[£,\s]/g, ''))
    if (!Number.isFinite(parsed)) {
      setError('The expected total needs to be a number.')
      return
    }
    setBusy('target')
    setError(null)
    try {
      await saveFundBalanceTarget(asAt, parsed, target?.note ?? null, profile.id)
      setEditingTarget(false)
      targetsQ.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The expected total could not be saved')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="px-5 py-4 mt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionLabel>Fund balances at a date</SectionLabel>
          <p className="text-[11.5px] text-stone-500 mt-0.5 max-w-2xl">
            Every fund valued at the date below, so a year end can be agreed and each fund ticked off. A tick
            records the balance it was given and lapses if that fund later moves.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-stone-500">As at</label>
          <Input
            type="date"
            value={asAt}
            onChange={(e) => setAsAt(e.target.value)}
            className="!w-40 text-[12px]"
          />
        </div>
      </div>

      {balancesQ.loading && !balancesQ.data ? (
        <div className="mt-4">
          <LoadingRows cols={3} rows={6} />
        </div>
      ) : null}
      {balancesQ.error ? (
        <div className="mt-3">
          <ErrorNotice message={`Balances could not be read — ${balancesQ.error}`} />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="grid sm:grid-cols-3 gap-3 mt-4">
            <Tile label={`Total funds at ${formatDate(asAt)}`} value={total} />
            <Tile
              label="Expected total"
              value={target?.expected_total ?? null}
              action={
                canSign ? (
                  <button
                    onClick={() => {
                      setExpectedDraft(target ? String(target.expected_total) : '')
                      setEditingTarget(true)
                    }}
                    className="text-[11px] text-indigo hover:underline underline-offset-2"
                  >
                    {target ? 'change' : 'set'}
                  </button>
                ) : null
              }
            />
            <Tile label="Difference" value={difference} emphasise tone={agreed ? 'good' : 'bad'} />
          </div>

          {editingTarget ? (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <Input
                value={expectedDraft}
                onChange={(e) => setExpectedDraft(e.target.value)}
                placeholder="e.g. 8041691.41"
                className="max-w-xs font-mono text-[12px]"
              />
              <Button variant="money" size="sm" disabled={busy === 'target'} onClick={() => void saveTarget()}>
                {busy === 'target' ? 'Saving…' : 'Save expected total'}
              </Button>
              <button
                onClick={() => setEditingTarget(false)}
                className="text-[11.5px] text-stone-500 hover:text-indigo underline underline-offset-2"
              >
                cancel
              </button>
            </div>
          ) : null}

          {target ? (
            <p
              className={cx(
                'text-[12px] mt-3',
                agreed ? 'text-mint-900' : 'text-danger-ink',
              )}
            >
              {agreed
                ? `The register agrees to ${formatMoney(target.expected_total)} at ${formatDate(asAt)}.`
                : `The register is ${formatMoney(Math.abs(difference ?? 0))} ${(difference ?? 0) > 0 ? 'above' : 'below'} the ${formatMoney(target.expected_total)} expected at ${formatDate(asAt)}.`}
              {target.note ? <span className="text-stone-500"> {target.note}</span> : null}
            </p>
          ) : (
            <p className="text-[12px] text-stone-500 mt-3">
              No expected total is recorded for this date, so there is nothing to agree against yet.
            </p>
          )}

          {duplicates.length > 0 ? (
            <div className="mt-4 rounded-card border border-warn/50 bg-warn/10 px-4 py-3 text-[12px] text-warn-ink">
              <b className="font-medium">
                {duplicates.length} balance{duplicates.length === 1 ? '' : 's'} appear{duplicates.length === 1 ? 's' : ''} twice in the register
                {duplicatesExplain ? ' — and that is the whole difference' : ''}.
              </b>
              <ul className="mt-2 space-y-1">
                {duplicates.map((g) => (
                  <li key={g.balance} className="flex flex-wrap gap-x-2">
                    <span className="figure font-medium">{formatMoney(g.balance)}</span>
                    <span className="text-warn-ink/80">{g.funds.map((f) => f.name).join('  ·  ')}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11.5px]">
                Two funds holding the same figure to the penny is the same fund in the register twice, usually
                a tracking option re-created with a corrected spelling and the opening balance loaded onto
                both.{' '}
                {duplicatesExplain
                  ? `Retiring one of each pair removes ${formatMoney(duplicateTotal)} and the register agrees exactly.`
                  : `Together the repeats account for ${formatMoney(duplicateTotal)}.`}{' '}
                <Link to="/funds/integrity" className="underline underline-offset-2 font-medium">
                  Fund coverage check
                </Link>
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 mt-4 mb-1">
            <div className="flex items-center gap-1.5">
              <StatusChip tone={tickedCount === rows.length ? 'good' : 'neutral'}>
                {tickedCount} of {rows.length} ticked off
              </StatusChip>
              {lapsedCount > 0 ? <StatusChip tone="warn">{lapsedCount} lapsed</StatusChip> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11.5px] text-stone-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyUnticked}
                  onChange={(e) => setOnlyUnticked(e.target.checked)}
                  className="accent-[#211951]"
                />
                Only those left to do
              </label>
              {canSign && tickedCount < rows.length ? (
                <Button variant="ghost" size="sm" disabled={busy === 'all'} onClick={() => void tickAllAgreeing()}>
                  {busy === 'all' ? 'Ticking…' : `Tick the remaining ${rows.length - tickedCount}`}
                </Button>
              ) : null}
            </div>
          </div>

          {error ? <ErrorNotice message={error} /> : null}

          <div className="border border-stone-150 rounded-control overflow-hidden mt-2">
            <div className="overflow-x-auto max-h-[32rem]">
              <table className="w-full text-[11.5px]">
                <thead className="bg-paper-2 sticky top-0">
                  <tr>
                    <th className="th-register text-left">Fund</th>
                    <th className="th-register text-right">Opening</th>
                    <th className="th-register text-right">Movement</th>
                    <th className="th-register text-right">Transfers</th>
                    <th className="th-register text-right">Balance</th>
                    <th className="th-register text-right">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => {
                    const state = states.get(row.fund_id) ?? { kind: 'unsigned' as const }
                    return (
                      <tr key={row.fund_id} className="border-t border-stone-150">
                        <td className="td-register">
                          <Link
                            to={`/funds/${row.fund_id}`}
                            className="text-ink hover:text-indigo hover:underline underline-offset-2"
                          >
                            {row.name}
                          </Link>
                          {state.kind === 'superseded' ? (
                            <div className="text-[10.5px] text-warn-ink mt-0.5">
                              Ticked at {formatMoney(state.signoff.left_value ?? 0)} — moved by{' '}
                              {formatMoney(state.movedBy ?? 0)} since
                            </div>
                          ) : state.kind === 'signed' ? (
                            <div className="text-[10.5px] text-stone-500 mt-0.5">
                              {state.signoff.signer_name ?? 'Checked'} ·{' '}
                              {formatDateTime(state.signoff.signed_at)}
                            </div>
                          ) : null}
                        </td>
                        <td className="td-register figure text-right whitespace-nowrap text-stone-500">
                          {formatMoney(row.opening)}
                        </td>
                        <td
                          className={cx(
                            'td-register figure text-right whitespace-nowrap',
                            row.movement < 0 ? 'text-danger-ink' : 'text-stone-500',
                          )}
                        >
                          {Math.round(row.movement * 100) === 0 ? '—' : formatMoney(row.movement)}
                        </td>
                        <td
                          className={cx(
                            'td-register figure text-right whitespace-nowrap',
                            row.transfers < 0 ? 'text-danger-ink' : 'text-stone-500',
                          )}
                          title="Apportioned in or out on the fund capital accounts"
                        >
                          {Math.round((row.transfers ?? 0) * 100) === 0 ? '—' : formatMoney(row.transfers)}
                        </td>
                        <td
                          className={cx(
                            'td-register figure text-right whitespace-nowrap font-medium',
                            row.balance < 0 && 'text-danger-ink',
                          )}
                        >
                          {formatMoney(row.balance)}
                        </td>
                        <td className="td-register text-right whitespace-nowrap">
                          {!canSign ? (
                            <span className="text-stone-400">
                              {state.kind === 'signed' ? '✓' : '—'}
                            </span>
                          ) : state.kind === 'signed' ? (
                            <button
                              disabled={busy === row.fund_id}
                              onClick={() => void untick(row.fund_id)}
                              className="text-mint-900 hover:text-stone-500"
                              title="Ticked off — click to undo"
                            >
                              ✓ checked
                            </button>
                          ) : (
                            <button
                              disabled={busy === row.fund_id}
                              onClick={() => void tick(row)}
                              className={cx(
                                'underline underline-offset-2',
                                state.kind === 'superseded'
                                  ? 'text-warn-ink hover:text-indigo'
                                  : 'text-indigo hover:opacity-70',
                              )}
                            >
                              {state.kind === 'superseded' ? 're-check' : 'check off'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[11px] text-stone-500 mt-2">
            Balances are the fund's opening position, plus income less expenditure, plus anything apportioned
            in or out on the fund capital accounts, up to {formatDate(asAt)}. Voided documents are excluded and
            every tick is audit-logged.
          </p>
        </>
      ) : null}
    </Card>
  )
}

function Tile({
  label,
  value,
  emphasise,
  tone,
  action,
}: {
  label: string
  value: number | null
  emphasise?: boolean
  tone?: 'good' | 'bad'
  action?: React.ReactNode
}) {
  return (
    <div className="border border-stone-150 rounded-control px-3.5 py-2.5 bg-paper">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">{label}</span>
        {action}
      </div>
      <div
        className={cx(
          'figure mt-1',
          emphasise ? 'text-[17px]' : 'text-[15px]',
          value === null
            ? 'text-stone-400'
            : tone === 'good'
              ? 'text-mint-900'
              : tone === 'bad'
                ? 'text-danger-ink'
                : 'text-ink',
        )}
      >
        {value === null ? <span className="text-[13px]">not set</span> : formatMoney(value)}
      </div>
    </div>
  )
}
