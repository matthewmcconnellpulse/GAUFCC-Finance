/**
 * Expenses report — produced on request for the CEO (and Pulse): every claim
 * for a range of months with who submitted it, who approved it and when, and
 * the spend broken down by claimant, fund and category. Print-ready, with CSV
 * downloads of the claims and of the underlying lines.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import { Button, Card, EmptyState, ErrorNotice, LoadingRows, PageHeader, SectionLabel } from '@/components/ui'
import { formatDate, formatDateTime, formatMoney, formatPeriod } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { buildCsv, downloadTextFile } from '@/modules/imports/xeroCsv'
import type { ClaimStatus } from '@/types/db'
import { ClaimStatusChip, Segmented } from './components'
import {
  CLAIM_STATUS_LABELS,
  fetchClaimsReport,
  fetchExpenseCategories,
  fetchFundOptions,
  type ClaimWithSubmitter,
  type ReportLine,
} from './lib'

type Preset = 'month' | '3m' | '12m' | 'custom'

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'month', label: 'This month' },
  { value: '3m', label: 'Last 3 months' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'custom', label: 'Custom' },
]

/** Claims that represent real spend — drafts and rejections are reported but not summed. */
const SPEND_STATUSES: ReadonlySet<ClaimStatus> = new Set<ClaimStatus>([
  'submitted',
  'approved',
  'pushed_to_xero',
  'paid',
])

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthsBack(n: number): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - n)
  return monthKey(d)
}

function presetRange(preset: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const to = monthKey(new Date())
  if (preset === 'month') return { from: to, to }
  return { from: monthsBack(preset === '3m' ? 2 : 11), to }
}

export default function ExpensesReportPage() {
  const navigate = useNavigate()
  const { isPulse, isCeo } = usePermissions()
  const [preset, setPreset] = useState<Preset>('3m')
  const [custom, setCustom] = useState(() => presetRange('3m'))
  const range = preset === 'custom' ? custom : presetRange(preset)
  const validRange = /^\d{4}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}$/.test(range.to) && range.from <= range.to

  const report = useSupabaseQuery(
    () => (validRange ? fetchClaimsReport(range.from, range.to) : Promise.resolve({ claims: [], lines: [] })),
    [range.from, range.to, validRange],
  )
  const fundsQ = useSupabaseQuery(fetchFundOptions, [])
  const catsQ = useSupabaseQuery(fetchExpenseCategories, [])

  const fundName = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of fundsQ.data ?? []) m.set(f.fund_id, f.name)
    return (id: string | null) => (id ? (m.get(id) ?? 'Unknown fund') : 'Not yet coded')
  }, [fundsQ.data])
  const categoryName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of catsQ.data ?? []) m.set(c.code, `${c.code} — ${c.name}`)
    return (code: string | null) => (code ? (m.get(code) ?? `Account ${code}`) : 'Not yet coded')
  }, [catsQ.data])

  const summary = useMemo(() => {
    const claims = report.data?.claims ?? []
    const lines = report.data?.lines ?? []
    const spendClaims = claims.filter((c) => SPEND_STATUSES.has(c.status))
    const spendIds = new Set(spendClaims.map((c) => c.id))
    const sum = (cs: ClaimWithSubmitter[]) => cs.reduce((s, c) => s + c.total, 0)
    const by = <K,>(rows: ReportLine[], key: (l: ReportLine) => K) => {
      const m = new Map<K, number>()
      for (const l of rows) m.set(key(l), (m.get(key(l)) ?? 0) + l.gross)
      return [...m.entries()].sort((a, b) => b[1] - a[1])
    }
    const spendLines = lines.filter((l) => spendIds.has(l.claim_id))
    const byClaimant = new Map<string, { name: string; count: number; total: number }>()
    for (const c of spendClaims) {
      const cur = byClaimant.get(c.submitter_id) ?? {
        name: c.submitter?.full_name ?? '—',
        count: 0,
        total: 0,
      }
      cur.count += 1
      cur.total += c.total
      byClaimant.set(c.submitter_id, cur)
    }
    return {
      claims,
      lines,
      spendTotal: sum(spendClaims),
      spendCount: spendClaims.length,
      awaiting: claims.filter((c) => c.status === 'submitted'),
      approvedOrPaid: claims.filter((c) => c.status !== 'submitted' && SPEND_STATUSES.has(c.status)),
      drafts: claims.filter((c) => c.status === 'draft').length,
      rejected: claims.filter((c) => c.status === 'rejected').length,
      mileage: spendLines.filter((l) => l.is_mileage).reduce((s, l) => s + l.gross, 0),
      byFund: by(spendLines, (l) => l.fund_id),
      byCategory: by(spendLines, (l) => l.category),
      byClaimant: [...byClaimant.values()].sort((a, b) => b.total - a.total),
    }
  }, [report.data])

  const rangeLabel =
    range.from === range.to ? formatPeriod(range.from) : `${formatPeriod(range.from)} – ${formatPeriod(range.to)}`

  const downloadClaims = () => {
    const rows = summary.claims.map((c) => [
      c.submitter?.full_name ?? '',
      c.submitter?.email ?? '',
      formatPeriod(c.period),
      CLAIM_STATUS_LABELS[c.status],
      c.submitted_at ? formatDate(c.submitted_at) : '',
      c.approver?.full_name ?? '',
      c.ceo_approved_at ? formatDateTime(c.ceo_approved_at) : '',
      c.total,
      c.xero_bill_id ?? '',
      c.ceo_comment ?? '',
    ])
    downloadTextFile(
      `expenses-claims-${range.from}-to-${range.to}.csv`,
      buildCsv(
        ['Claimant', 'Email', 'Month', 'Status', 'Submitted', 'Approved by', 'Approved at', 'Total', 'Xero bill', 'CEO comment'],
        rows,
      ),
    )
  }

  const downloadLines = () => {
    const claimById = new Map(summary.claims.map((c) => [c.id, c]))
    const rows = summary.lines.map((l) => {
      const c = claimById.get(l.claim_id)
      return [
        c?.submitter?.full_name ?? '',
        c ? formatPeriod(c.period) : '',
        c ? CLAIM_STATUS_LABELS[c.status] : '',
        l.date,
        l.description,
        l.category ?? '',
        categoryName(l.category),
        fundName(l.fund_id),
        l.is_mileage ? (l.miles ?? 0) : '',
        l.net,
        l.vat,
        l.gross,
      ]
    })
    downloadTextFile(
      `expenses-lines-${range.from}-to-${range.to}.csv`,
      buildCsv(
        ['Claimant', 'Month', 'Claim status', 'Date', 'Description', 'Account code', 'Category', 'Fund', 'Miles', 'Net', 'VAT', 'Gross'],
        rows,
      ),
    )
  }

  if (!isPulse && !isCeo) {
    return (
      <Card>
        <EmptyState title="Not available" hint="The expenses report is for the CEO and Pulse." />
      </Card>
    )
  }

  return (
    <div>
      {/* Print only the report: the shell (nav, header) is hidden and the report is lifted to the page. */}
      <style>{`@media print {
        body * { visibility: hidden; }
        #expenses-report, #expenses-report * { visibility: visible; }
        #expenses-report { position: absolute; left: 0; top: 0; width: 100%; }
        .no-print { display: none !important; }
      }`}</style>

      <div className="no-print">
        <PageHeader
          title="Expenses report"
          subtitle="Who claimed what, who approved it and when — by month, claimant, fund and category"
          actions={
            <>
              <Button variant="ghost" onClick={() => navigate('/expenses')}>
                Back to expenses
              </Button>
              <Button variant="ghost" onClick={downloadClaims} disabled={summary.claims.length === 0}>
                Download claims CSV
              </Button>
              <Button variant="ghost" onClick={downloadLines} disabled={summary.lines.length === 0}>
                Download lines CSV
              </Button>
              <Button variant="primary" onClick={() => window.print()} disabled={summary.claims.length === 0}>
                Print
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <Segmented options={PRESETS} value={preset} onChange={setPreset} />
          {preset === 'custom' ? (
            <span className="inline-flex items-center gap-2 text-[12px] text-stone-600">
              <input
                type="month"
                value={custom.from}
                onChange={(e) => setCustom((r) => ({ ...r, from: e.target.value }))}
                className="input-base !w-auto py-1.5 text-[12px]"
                aria-label="From month"
              />
              to
              <input
                type="month"
                value={custom.to}
                onChange={(e) => setCustom((r) => ({ ...r, to: e.target.value }))}
                className="input-base !w-auto py-1.5 text-[12px]"
                aria-label="To month"
              />
            </span>
          ) : null}
          {!validRange ? <span className="text-[11.5px] text-danger-ink">Choose a from-month that is not after the to-month.</span> : null}
        </div>
      </div>

      <div id="expenses-report" className="space-y-4">
        <div className="hidden print:block mb-2">
          <h1 className="font-display text-[22px] text-ink">GAUFCC expenses report — {rangeLabel}</h1>
          <p className="text-[11px] text-stone-500">Generated {formatDateTime(new Date().toISOString())}</p>
        </div>

        {report.loading ? (
          <Card>
            <LoadingRows cols={5} rows={6} />
          </Card>
        ) : report.error ? (
          <ErrorNotice message={report.error} />
        ) : summary.claims.length === 0 ? (
          <Card>
            <EmptyState title={`No claims for ${rangeLabel}`} hint="Try a wider range of months." />
          </Card>
        ) : (
          <>
            {/* Headline figures */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Tile label="Claimed" value={formatMoney(summary.spendTotal)} hint={`${summary.spendCount} ${summary.spendCount === 1 ? 'claim' : 'claims'} · ${rangeLabel}`} />
              <Tile
                label="Awaiting approval"
                value={formatMoney(summary.awaiting.reduce((s, c) => s + c.total, 0))}
                hint={`${summary.awaiting.length} submitted`}
              />
              <Tile
                label="Approved, pushed or paid"
                value={formatMoney(summary.approvedOrPaid.reduce((s, c) => s + c.total, 0))}
                hint={`${summary.approvedOrPaid.length} ${summary.approvedOrPaid.length === 1 ? 'claim' : 'claims'}`}
              />
              <Tile
                label="Of which mileage"
                value={formatMoney(summary.mileage)}
                hint={`${summary.drafts} draft · ${summary.rejected} rejected (not counted)`}
              />
            </div>

            {/* Claims */}
            <Card className="overflow-hidden">
              <div className="px-5 pt-4">
                <SectionLabel>Claims · {summary.claims.length}</SectionLabel>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th-register">Claimant</th>
                      <th className="th-register">Month</th>
                      <th className="th-register">Submitted</th>
                      <th className="th-register">Approved</th>
                      <th className="th-register">Status</th>
                      <th className="th-register text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.claims.map((c) => (
                      <tr
                        key={c.id}
                        className="cursor-pointer hover:bg-paper-2 transition-colors"
                        onClick={() => navigate(`/expenses/${c.id}`)}
                      >
                        <td className="td-register text-[12.5px] text-ink whitespace-nowrap">
                          {c.submitter?.full_name ?? '—'}
                        </td>
                        <td className="td-register text-[12px] text-stone-700 whitespace-nowrap">{formatPeriod(c.period)}</td>
                        <td className="td-register text-[12px] text-stone-500 whitespace-nowrap">
                          {c.submitted_at ? formatDate(c.submitted_at) : '—'}
                        </td>
                        <td className="td-register text-[12px] text-stone-700 whitespace-nowrap">
                          {c.ceo_approved_at && c.status !== 'rejected' ? (
                            <>
                              {c.approver?.full_name ?? 'CEO'}
                              <span className="block text-[10.5px] text-stone-500">{formatDate(c.ceo_approved_at)}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="td-register">
                          <ClaimStatusChip status={c.status} />
                        </td>
                        <td className="td-register text-right font-mono text-[12.5px] text-ink whitespace-nowrap">
                          {formatMoney(c.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Breakdowns — real spend only */}
            <div className="grid gap-4 lg:grid-cols-3">
              <BreakdownCard
                title="By claimant"
                rows={summary.byClaimant.map((r) => [`${r.name} (${r.count})`, r.total] as [string, number])}
                total={summary.spendTotal}
              />
              <BreakdownCard
                title="By fund"
                rows={summary.byFund.map(([id, v]) => [fundName(id), v] as [string, number])}
                total={summary.spendTotal}
              />
              <BreakdownCard
                title="By category"
                rows={summary.byCategory.map(([code, v]) => [categoryName(code), v] as [string, number])}
                total={summary.spendTotal}
              />
            </div>
            <p className="text-[10.5px] text-stone-500">
              Breakdowns count submitted, approved, pushed and paid claims. Drafts and rejected claims are listed
              above but not summed. Archived claims are excluded throughout.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">{label}</div>
      <div className="font-display font-light text-[26px] text-indigo leading-none mt-2 figure">{value}</div>
      <div className="text-[10.5px] text-stone-500 mt-1.5">{hint}</div>
    </Card>
  )
}

function BreakdownCard({ title, rows, total }: { title: string; rows: Array<[string, number]>; total: number }) {
  return (
    <Card className="p-4 sm:p-5">
      <SectionLabel>{title}</SectionLabel>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-stone-500">Nothing to show.</p>
      ) : (
        <ul className="text-[12px]">
          {rows.map(([label, value]) => (
            <li key={label} className="flex justify-between gap-3 py-1.5 border-b border-paper-3 last:border-0">
              <span className="text-stone-700 truncate">{label}</span>
              <span className="figure whitespace-nowrap">{formatMoney(value)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between pt-2 mt-1 border-t border-stone-300 text-[12px]">
        <span className="text-stone-500">Total</span>
        <span className="figure font-medium text-ink">{formatMoney(total)}</span>
      </div>
    </Card>
  )
}
