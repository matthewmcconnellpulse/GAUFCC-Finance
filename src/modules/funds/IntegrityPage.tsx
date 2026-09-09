/**
 * Data integrity (Pulse-facing) — the four checks that gate every board pack,
 * per the 1i design reference. A period is stamped complete once all checks
 * pass; pulse_admin may override with a logged reason.
 */
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  ErrorNotice,
  LoadingRows,
  PageHeader,
  StatusChip,
  Textarea,
  cx,
} from '@/components/ui'
import { currentPeriod, formatDate, formatDateTime, formatMoney, formatPeriod, timeAgo } from '@/lib/format'
import { supabase } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { useSync } from '@/sync/SyncProvider'
import type { IntegrityStamp } from '@/types/db'
import { AccessDenied, CheckIcon, ChevronIcon, WarnIcon } from './components'
import {
  periodBounds,
  shiftPeriod,
  sourceTypeLabel,
  xeroDeepLink,
  xeroTrackingSetupLink,
  type FundCoverageRow,
  type GlReconRow,
  type IntegrityConflictRow,
  type IntegrityTxnRow,
  type UnmappedOptionRow,
} from './lib'

const DRILLDOWN_CAP = 200

interface ChecksData {
  missing: IntegrityTxnRow[]
  missingCount: number
  conflicting: IntegrityConflictRow[]
  conflictingCount: number
  unmapped: UnmappedOptionRow[]
  glRecon: GlReconRow[]
  coverage: FundCoverageRow[]
}

export default function IntegrityPage() {
  const { isPulse } = usePermissions()
  if (!isPulse) {
    return (
      <div>
        <PageHeader title="Data integrity" />
        <AccessDenied
          title="This screen is for Pulse"
          hint="The data integrity checks are part of Pulse's bookkeeping workflow. The results feed into your board packs — ask Pulse if you would like the latest status."
        />
      </div>
    )
  }
  return <IntegrityInner />
}

function IntegrityInner() {
  const { isAdmin } = usePermissions()
  const { profile } = useAuth()
  const { lastSyncedAt } = useSync()
  const [period, setPeriod] = useState<string>(() => currentPeriod())
  const [openCheck, setOpenCheck] = useState<string | null>(null)

  const checks = useSupabaseQuery<ChecksData>(async () => {
    const { start, end } = periodBounds(period)
    const [missingRes, conflictingRes, unmappedRes, glRes, coverageRes] = await Promise.all([
      supabase
        .from('v_integrity_missing_tracking')
        .select('*', { count: 'exact' })
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: true })
        .limit(DRILLDOWN_CAP),
      supabase
        .from('v_integrity_conflicting_tracking')
        .select('*', { count: 'exact' })
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: true })
        .limit(DRILLDOWN_CAP),
      supabase.from('v_integrity_unmapped_options').select('*').order('name', { ascending: true }),
      supabase.from('v_integrity_gl_recon').select('*').eq('period_month', start).order('account_code'),
      // Not period-scoped: a fund missing from the register is missing in
      // every period, and is the one exception that silently changes totals.
      supabase
        .from('v_integrity_fund_coverage')
        .select('*')
        .order('ledger_amount', { ascending: false, nullsFirst: false }),
    ])
    for (const res of [missingRes, conflictingRes, unmappedRes, glRes, coverageRes]) {
      if (res.error) throw new Error(res.error.message)
    }
    return {
      missing: (missingRes.data ?? []) as IntegrityTxnRow[],
      missingCount: missingRes.count ?? (missingRes.data?.length ?? 0),
      conflicting: (conflictingRes.data ?? []) as IntegrityConflictRow[],
      conflictingCount: conflictingRes.count ?? (conflictingRes.data?.length ?? 0),
      unmapped: (unmappedRes.data ?? []) as UnmappedOptionRow[],
      glRecon: (glRes.data ?? []) as GlReconRow[],
      coverage: (coverageRes.data ?? []) as FundCoverageRow[],
    }
  }, [period])

  const stampQ = useSupabaseQuery(async () => {
    const { data, error } = await supabase
      .from('integrity_stamps')
      .select('*')
      .eq('period', period)
      .order('stamped_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const stamp = (data as IntegrityStamp | null) ?? null
    if (!stamp) return null
    let stampedByName: string | null = null
    try {
      const { data: p } = await supabase.from('profiles').select('full_name').eq('id', stamp.stamped_by).maybeSingle()
      stampedByName = (p as { full_name: string } | null)?.full_name ?? null
    } catch {
      // name is a nicety — the stamp itself is what matters
    }
    return { stamp, stampedByName }
  }, [period])

  // Stamping state
  const [confirming, setConfirming] = useState<'stamp' | 'override' | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [stamping, setStamping] = useState(false)
  const [stampError, setStampError] = useState<string | null>(null)

  const data = checks.data
  const glFailures = (data?.glRecon ?? []).filter((r) => Math.abs(r.variance) >= 0.005)
  const glVarianceTotal = glFailures.reduce((s, r) => s + Math.abs(r.variance), 0)
  const counts = data
    ? {
        missing: data.missingCount,
        conflicting: data.conflictingCount,
        unmapped: data.unmapped.length,
        glRecon: glFailures.length,
        coverage: data.coverage.length,
      }
    : null
  const allPass =
    counts !== null &&
    counts.missing + counts.conflicting + counts.unmapped + counts.glRecon + counts.coverage === 0
  const stamped = stampQ.data ?? null

  async function doStamp(withOverride: boolean) {
    if (!profile || !counts) return
    setStamping(true)
    setStampError(null)
    const results = {
      checks: {
        missing_tracking: counts.missing,
        conflicting_tracking: counts.conflicting,
        unmapped_options: counts.unmapped,
        gl_recon_exceptions: counts.glRecon,
        gl_recon_variance_total: Number(glVarianceTotal.toFixed(2)),
      },
      all_passed: allPass,
      ...(withOverride ? { override: true, override_reason: overrideReason.trim() } : {}),
      stamped_from: 'app',
    }
    const { error } = await supabase
      .from('integrity_stamps')
      .insert({ period, stamped_by: profile.id, results })
    if (error) {
      setStampError(error.message)
    } else {
      setConfirming(null)
      setOverrideReason('')
      stampQ.refetch()
    }
    setStamping(false)
  }

  const toggle = (key: string) => setOpenCheck((cur) => (cur === key ? null : key))

  return (
    <div>
      <PageHeader
        title="Data integrity"
        subtitle="Four checks gate every board pack · results refresh on every sync"
        actions={<MonthPicker period={period} onChange={(p) => { setPeriod(p); setConfirming(null); setStampError(null) }} />}
      />

      {/* Stamp status */}
      <div className="mb-4">
        {stampQ.error ? (
          <ErrorNotice message={`The stamp record could not be loaded — ${stampQ.error}`} />
        ) : stamped ? (
          <div className="flex flex-wrap items-center gap-2 rounded-card border border-mint-700/40 bg-mint/10 px-4 py-3 text-[12.5px] text-mint-900">
            <StatusChip tone="good">Stamped</StatusChip>
            <span>
              {formatPeriod(period)} was stamped complete by {stampQ.data?.stampedByName ?? 'a Pulse user'} on{' '}
              {formatDateTime(stamped.stamp.stamped_at)}. The period is locked for board packs.
            </span>
          </div>
        ) : checks.loading ? null : allPass ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-stone-150 bg-white px-4 py-3">
            <span className="text-[12.5px] text-stone-700">
              All four checks pass for {formatPeriod(period)} — it can be stamped complete.
            </span>
            {confirming === 'stamp' ? (
              <span className="flex items-center gap-2">
                <span className="text-[12px] text-stone-500">Stamp {formatPeriod(period)} as complete?</span>
                <Button variant="money" size="sm" disabled={stamping} onClick={() => void doStamp(false)}>
                  {stamping ? 'Stamping…' : 'Confirm stamp'}
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button variant="money" size="sm" onClick={() => setConfirming('stamp')}>
                Stamp period as complete
              </Button>
            )}
          </div>
        ) : counts !== null ? (
          <div className="rounded-card border border-warn/50 bg-warn/10 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[12.5px] text-warn-ink">
                <WarnIcon />
                Stamping is locked while checks have open exceptions.
              </span>
              {isAdmin ? (
                confirming === 'override' ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="!border-warn/60 !text-warn-ink"
                    onClick={() => setConfirming('override')}
                  >
                    Stamp with override
                  </Button>
                )
              ) : (
                <span className="text-[11px] text-warn-ink">
                  A Pulse admin can override with a logged reason.
                </span>
              )}
            </div>
            {confirming === 'override' && isAdmin ? (
              <div className="mt-3">
                <label className="label-base" htmlFor="override-reason">
                  Reason for overriding open exceptions (logged in the audit trail)
                </label>
                <Textarea
                  id="override-reason"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="For example: two June entries agreed with the CEO, corrected in July"
                  className="!min-h-16 bg-white"
                />
                <div className="flex items-center gap-2 mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="!border-warn/60 !text-warn-ink"
                    disabled={stamping || overrideReason.trim().length < 10}
                    onClick={() => void doStamp(true)}
                  >
                    {stamping ? 'Stamping…' : 'Confirm override and stamp'}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => { setConfirming(null); setOverrideReason('') }}>
                    Cancel
                  </Button>
                  {overrideReason.trim().length < 10 ? (
                    <span className="text-[11px] text-stone-500">Give a fuller reason (at least 10 characters)</span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {stampError ? (
          <div className="mt-2">
            <ErrorNotice message={`The period could not be stamped — ${stampError}`} />
          </div>
        ) : null}
      </div>

      {/* The four checks */}
      {checks.loading ? (
        <Card>
          <LoadingRows cols={4} rows={4} />
        </Card>
      ) : checks.error ? (
        <ErrorNotice message={`The integrity checks could not be loaded — ${checks.error}`} />
      ) : data && counts ? (
        <Card className="overflow-hidden">
          <CheckRow
            title="Transactions missing a fund code"
            sub="Lines in the period with no tracking option on either category"
            countDisplay={String(counts.missing)}
            pass={counts.missing === 0}
            open={openCheck === 'missing'}
            onToggle={() => toggle('missing')}
          >
            {counts.missing === 0 ? (
              <NoExceptions period={period} />
            ) : (
              <TxnDrilldown rows={data.missing} total={counts.missing} />
            )}
          </CheckRow>
          <CheckRow
            title="Conflicting or double fund assignments"
            sub="Lines carrying tracking options that disagree"
            countDisplay={String(counts.conflicting)}
            pass={counts.conflicting === 0}
            open={openCheck === 'conflicting'}
            onToggle={() => toggle('conflicting')}
          >
            {counts.conflicting === 0 ? (
              <NoExceptions period={period} />
            ) : (
              <TxnDrilldown rows={data.conflicting} total={counts.conflicting} showReason />
            )}
          </CheckRow>
          <CheckRow
            title="Tracking options without a fund record"
            sub="New options in Xero need a fund type and opening balance here"
            countDisplay={String(counts.unmapped)}
            pass={counts.unmapped === 0}
            open={openCheck === 'unmapped'}
            onToggle={() => toggle('unmapped')}
          >
            {counts.unmapped === 0 ? (
              <NoExceptions period={period} />
            ) : (
              <UnmappedDrilldown rows={data.unmapped} />
            )}
          </CheckRow>
          <CheckRow
            title="Fund balances reconcile to GL control"
            sub="Sum of fund balances vs the general ledger, by control account"
            countDisplay={formatMoney(glVarianceTotal)}
            pass={counts.glRecon === 0}
            open={openCheck === 'gl'}
            onToggle={() => toggle('gl')}
          >
            {data.glRecon.length === 0 ? (
              <div className="text-[12px] text-stone-500">
                No reconciliation rows for {formatPeriod(period)} yet — they appear after the sync for the period.
              </div>
            ) : (
              <GlDrilldown rows={data.glRecon} />
            )}
          </CheckRow>
          <CheckRow
            title="Every fund in the ledger has a fund record"
            sub="Fund capital accounts in the balance sheet matched to the Fund tracking category"
            countDisplay={String(counts.coverage)}
            pass={counts.coverage === 0}
            open={openCheck === 'coverage'}
            onToggle={() => toggle('coverage')}
            last
          >
            {data.coverage.length === 0 ? (
              <div className="text-[12px] text-stone-500">
                Every fund capital account lines up with a fund in the register.
              </div>
            ) : (
              <CoverageDrilldown rows={data.coverage} />
            )}
          </CheckRow>
        </Card>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2 mt-3 font-mono text-[10.5px] text-stone-400">
        <span>Checks reflect the mirrored Xero data · a stamped period is locked for board packs</span>
        <span>last synced {timeAgo(lastSyncedAt)}</span>
      </div>
    </div>
  )
}

/**
 * A fund the platform cannot see. The register is built from Xero's "Fund"
 * tracking category, so a fund that exists only as a balance-sheet capital
 * account never appears on a fund page or in a board pack — and until this
 * check existed, nothing said so.
 */
function CoverageDrilldown({ rows }: { rows: FundCoverageRow[] }) {
  const missingFunds = rows.filter((r) => r.issue === 'no_fund_in_register')
  const missingAccounts = rows.filter((r) => r.issue === 'no_capital_account')
  return (
    <div className="space-y-4">
      {missingFunds.length > 0 ? (
        <div>
          <div className="text-[11px] font-medium text-warn-ink mb-1.5">
            In the ledger, not in the register — excluded from fund pages and board packs
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr>
                <th className="th-register">Account</th>
                <th className="th-register">Code</th>
                <th className="th-register text-right">Amount in the ledger</th>
              </tr>
            </thead>
            <tbody>
              {missingFunds.map((r) => (
                <tr key={r.account_code ?? r.account_name}>
                  <td className="td-register text-ink">{r.account_name}</td>
                  <td className="td-register font-mono text-[11px] text-stone-500">{r.account_code}</td>
                  <td className="td-register text-right font-mono">
                    {r.ledger_amount != null ? formatMoney(r.ledger_amount) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-stone-500 mt-2 leading-relaxed">
            Give the fund a tracking option in Xero (Settings → Tracking → Fund) and it appears here after the
            next sync. Where the two sides only spell the fund differently, align the names so a reader can tie
            the pack to the ledger.
          </p>
        </div>
      ) : null}
      {missingAccounts.length > 0 ? (
        <div>
          <div className="text-[11px] font-medium text-stone-600 mb-1.5">
            In the register, with no capital account of its own
          </div>
          <ul className="text-[12px] text-stone-700 space-y-0.5">
            {missingAccounts.map((r) => (
              <li key={r.account_name}>{r.account_name}</li>
            ))}
          </ul>
          <p className="text-[11px] text-stone-500 mt-2 leading-relaxed">
            Usually fine — these funds are carried within the general reserves rather than a named capital
            account. Worth a look if you expect one to hold its own balance.
          </p>
        </div>
      ) : null}
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function MonthPicker({ period, onChange }: { period: string; onChange: (p: string) => void }) {
  const atCurrent = period >= currentPeriod()
  return (
    <div className="flex items-center gap-0.5 bg-white border border-stone-300 rounded-full px-1.5 py-1">
      <button
        onClick={() => onChange(shiftPeriod(period, -1))}
        className="px-2 py-0.5 text-stone-500 hover:text-indigo rounded-full"
        aria-label="Previous month"
      >
        ‹
      </button>
      <span className="text-[12px] font-medium text-indigo min-w-[108px] text-center">{formatPeriod(period)}</span>
      <button
        onClick={() => onChange(shiftPeriod(period, 1))}
        disabled={atCurrent}
        className="px-2 py-0.5 text-stone-500 hover:text-indigo rounded-full disabled:opacity-35"
        aria-label="Next month"
      >
        ›
      </button>
    </div>
  )
}

function CheckRow({
  title,
  sub,
  countDisplay,
  pass,
  open,
  onToggle,
  last = false,
  children,
}: {
  title: string
  sub: string
  countDisplay: string
  pass: boolean
  open: boolean
  onToggle: () => void
  last?: boolean
  children: ReactNode
}) {
  return (
    <div className={cx(!last && 'border-b border-stone-150')}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={cx(
          'w-full grid grid-cols-[26px_1fr_auto_24px] sm:grid-cols-[26px_1fr_110px_90px_24px] gap-x-3.5 items-center px-5 py-3.5 text-left transition-colors',
          pass ? 'hover:bg-paper' : 'bg-warn/[.04] hover:bg-warn/[.08]',
        )}
      >
        {pass ? <CheckIcon /> : <WarnIcon />}
        <span className="min-w-0">
          <span className="block font-medium text-[13px] text-ink">{title}</span>
          <span className="block text-[11px] text-stone-500 mt-0.5">{sub}</span>
        </span>
        <span className={cx('figure text-right text-[13px] font-medium', pass ? 'text-ink' : 'text-warn-mid')}>
          {countDisplay}
        </span>
        <span className="text-right hidden sm:block">
          {pass ? <StatusChip tone="good">Pass</StatusChip> : <StatusChip tone="warn">Action</StatusChip>}
        </span>
        <ChevronIcon open={open} />
      </button>
      {open ? <div className="px-5 sm:pl-[60px] pb-4 pt-1 bg-paper">{children}</div> : null}
    </div>
  )
}

function NoExceptions({ period }: { period: string }) {
  return <div className="text-[12px] text-stone-500">No exceptions in {formatPeriod(period)}.</div>
}

function XeroLink({ sourceType, xeroId }: { sourceType: string; xeroId: string }) {
  return (
    <a
      href={xeroDeepLink(sourceType, xeroId)}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="text-[11px] text-indigo underline underline-offset-2 whitespace-nowrap"
    >
      Open in Xero ↗
    </a>
  )
}

function TxnDrilldown({
  rows,
  total,
  showReason = false,
}: {
  rows: IntegrityTxnRow[]
  total: number
  showReason?: boolean
}) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[720px]">
          <thead>
            <tr>
              <th className="th-register !bg-transparent !px-0">Date</th>
              <th className="th-register !bg-transparent">Source</th>
              <th className="th-register !bg-transparent">Description</th>
              <th className="th-register !bg-transparent">Contact</th>
              <th className="th-register !bg-transparent">Account</th>
              {showReason ? <th className="th-register !bg-transparent">Why flagged</th> : null}
              <th className="th-register !bg-transparent text-right">Gross</th>
              <th className="th-register !bg-transparent" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="td-register !px-0 figure text-[11px] whitespace-nowrap">{formatDate(r.date)}</td>
                <td className="td-register">
                  <StatusChip tone="neutral">{sourceTypeLabel(r.source_type)}</StatusChip>
                </td>
                <td className="td-register text-[12px] text-ink max-w-[240px]">
                  <span className="line-clamp-2">{r.description ?? '—'}</span>
                </td>
                <td className="td-register text-[12px] text-stone-700 whitespace-nowrap">{r.contact_name ?? '—'}</td>
                <td className="td-register figure text-[11px]">{r.account_code ?? '—'}</td>
                {showReason ? (
                  <td className="td-register text-[11.5px] text-warn-ink max-w-[200px]">
                    {(r as IntegrityConflictRow).reason}
                  </td>
                ) : null}
                <td className="td-register text-right figure text-[11.5px]">{formatMoney(r.gross)}</td>
                <td className="td-register text-right">
                  <XeroLink sourceType={r.source_type} xeroId={r.xero_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length ? (
        <div className="text-[11px] text-stone-500 mt-2 figure">
          Showing the first {rows.length} of {total} lines
        </div>
      ) : null}
    </div>
  )
}

function UnmappedDrilldown({ rows }: { rows: UnmappedOptionRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[560px]">
        <thead>
          <tr>
            <th className="th-register !bg-transparent !px-0">Xero tracking option</th>
            <th className="th-register !bg-transparent">Option id</th>
            <th className="th-register !bg-transparent text-right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tracking_option_id}>
              <td className="td-register !px-0 text-[12.5px] text-ink">“{r.name}”</td>
              <td className="td-register figure text-[10.5px] text-stone-500">{r.tracking_option_id}</td>
              <td className="td-register text-right whitespace-nowrap">
                <a
                  href={xeroTrackingSetupLink()}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-[11px] text-indigo underline underline-offset-2 mr-3"
                >
                  Open in Xero ↗
                </a>
                <Link to="/settings" className="text-[11px] text-indigo underline underline-offset-2">
                  Classify fund
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GlDrilldown({ rows }: { rows: GlReconRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[560px]">
        <thead>
          <tr>
            <th className="th-register !bg-transparent !px-0">Control account</th>
            <th className="th-register !bg-transparent text-right">GL total</th>
            <th className="th-register !bg-transparent text-right">Tracked total</th>
            <th className="th-register !bg-transparent text-right">Variance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const failed = Math.abs(r.variance) >= 0.005
            return (
              <tr key={`${r.account_code}-${r.period_month}`}>
                <td className="td-register !px-0 text-[12px] text-ink">
                  <span className="figure text-[11px] text-stone-500 mr-2">{r.account_code}</span>
                  {r.account_name}
                </td>
                <td className="td-register text-right figure text-[11.5px]">{formatMoney(r.total)}</td>
                <td className="td-register text-right figure text-[11.5px]">{formatMoney(r.tracked_total)}</td>
                <td
                  className={cx(
                    'td-register text-right figure text-[11.5px] font-medium',
                    failed ? 'text-warn-mid' : 'text-mint-900',
                  )}
                >
                  {formatMoney(r.variance)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
