/**
 * Financials → Profit & Loss / Balance Sheet — rendered live from Xero's
 * Reports API via the xero-report edge function. The report arrives as
 * Xero's generic row tree (Header / Section / Row / SummaryRow); this page
 * renders it faithfully rather than re-deriving figures, so what the board
 * sees here always matches Xero to the penny.
 */

import { useState } from 'react'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Input,
  LoadingRows,
  PageHeader,
  cx,
} from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import {
  endOfLastMonth,
  endOfLastYear,
  fetchXeroReport,
  isoDate,
  monthsAgoStart,
  startOfMonth,
  startOfYear,
  today,
  xeroDateToIso,
  type XeroReport,
  type XeroReportRow,
} from './lib'

// ── Row tree renderer ────────────────────────────────────────────────────────

function cellValues(row: XeroReportRow): string[] {
  return (row.Cells ?? []).map((c) => c.Value ?? '')
}

/** Money-ish cells right-align; the first (label) column stays left. */
function ReportTr({ row, depth }: { row: XeroReportRow; depth: number }) {
  const values = cellValues(row)
  const summary = row.RowType === 'SummaryRow'
  return (
    <tr className={cx('border-t border-stone-150', summary && 'bg-paper-2/70')}>
      {values.map((v, i) => (
        <td
          key={i}
          className={cx(
            'px-4 py-2 text-[12.5px]',
            i === 0 ? 'text-left' : 'text-right figure whitespace-nowrap',
            summary ? 'font-semibold text-ink' : i === 0 ? 'text-stone-700' : 'text-ink',
          )}
          style={i === 0 ? { paddingLeft: `${16 + depth * 18}px` } : undefined}
        >
          {v}
        </td>
      ))}
    </tr>
  )
}

function ReportTable({ report }: { report: XeroReport }) {
  const rows = report.Rows ?? []
  const header = rows.find((r) => r.RowType === 'Header')
  const body = rows.filter((r) => r.RowType !== 'Header')
  const columnCount = Math.max(header?.Cells?.length ?? 0, 2)

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse min-w-[560px]">
        {header ? (
          <thead>
            <tr>
              {cellValues(header).map((v, i) => (
                <th
                  key={i}
                  className={cx('th-register', i === 0 ? 'text-left' : 'text-right')}
                >
                  {v}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((section, si) => {
            if (section.RowType === 'Section') {
              return (
                <SectionRows key={si} section={section} columnCount={columnCount} />
              )
            }
            return <ReportTr key={si} row={section} depth={0} />
          })}
        </tbody>
      </table>
    </div>
  )
}

function SectionRows({
  section,
  columnCount,
}: {
  section: XeroReportRow
  columnCount: number
}) {
  return (
    <>
      {section.Title ? (
        <tr className="border-t border-stone-150">
          <td
            colSpan={columnCount}
            className="px-4 pt-4 pb-1 text-[10.5px] font-medium uppercase tracking-[.14em] text-stone-500"
          >
            {section.Title}
          </td>
        </tr>
      ) : null}
      {(section.Rows ?? []).map((r, i) => (
        <ReportTr key={i} row={r} depth={section.Title ? 1 : 0} />
      ))}
    </>
  )
}

// ── Page shells ──────────────────────────────────────────────────────────────

interface Preset {
  label: string
  value: () => { from?: string; to?: string; date?: string }
}

export function ProfitLossPage() {
  const [from, setFrom] = useState(startOfYear())
  const [to, setTo] = useState(today())

  const report = useSupabaseQuery(
    () => fetchXeroReport('ProfitAndLoss', { fromDate: from, toDate: to }),
    [from, to],
  )

  const presets: Preset[] = [
    { label: 'This month', value: () => ({ from: startOfMonth(), to: today() }) },
    { label: 'This year', value: () => ({ from: startOfYear(), to: today() }) },
    { label: 'Last 12 months', value: () => ({ from: monthsAgoStart(11), to: today() }) },
    {
      label: 'Last year',
      value: () => {
        const y = new Date().getFullYear() - 1
        return { from: `${y}-01-01`, to: `${y}-12-31` }
      },
    },
  ]

  return (
    <ReportShell
      title="Profit & Loss"
      subtitle="Income and expenditure, live from Xero."
      report={report}
      presets={presets}
      onPreset={(p) => {
        const v = p.value()
        if (v.from) setFrom(v.from)
        if (v.to) setTo(v.to)
      }}
      controls={
        <>
          <label className="flex items-center gap-2 text-[11.5px] text-stone-600">
            From
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-[11.5px] text-stone-600">
            To
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </>
      }
    />
  )
}

export function BalanceSheetPage() {
  const [date, setDate] = useState(today())

  const report = useSupabaseQuery(() => fetchXeroReport('BalanceSheet', { date }), [date])

  const presets: Preset[] = [
    { label: 'Today', value: () => ({ date: today() }) },
    { label: 'End of last month', value: () => ({ date: endOfLastMonth() }) },
    {
      label: 'End of last quarter',
      value: () => {
        const now = new Date()
        const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3
        return { date: isoDate(new Date(now.getFullYear(), quarterStartMonth, 0)) }
      },
    },
    { label: 'End of last year', value: () => ({ date: endOfLastYear() }) },
  ]

  return (
    <ReportShell
      title="Balance Sheet"
      subtitle="Assets, liabilities and funds, live from Xero."
      report={report}
      presets={presets}
      onPreset={(p) => {
        const v = p.value()
        if (v.date) setDate(v.date)
      }}
      controls={
        <label className="flex items-center gap-2 text-[11.5px] text-stone-600">
          As at
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      }
    />
  )
}

function ReportShell({
  title,
  subtitle,
  report,
  controls,
  presets,
  onPreset,
}: {
  title: string
  subtitle: string
  report: { data: XeroReport | null; loading: boolean; error: string | null }
  controls: React.ReactNode
  presets: Preset[]
  onPreset: (p: Preset) => void
}) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          {controls}
          <div className="flex flex-wrap gap-1.5 md:ml-auto">
            {presets.map((p) => (
              <Button key={p.label} variant="ghost" onClick={() => onPreset(p)}>
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {report.error ? (
        <ErrorNotice message={report.error} />
      ) : report.loading ? (
        <LoadingRows cols={3} rows={12} />
      ) : !report.data ? (
        <Card>
          <EmptyState title="No report" hint="Xero returned nothing for this period." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="px-4 pt-4">
            {(report.data.ReportTitles ?? []).slice(1).map((t) => (
              <div key={t} className="text-[12px] text-stone-500">
                {t}
              </div>
            ))}
          </div>
          <ReportTable report={report.data} />
          <div className="px-4 py-3 border-t border-stone-150 text-[10.5px] text-stone-400">
            Generated from Xero
            {xeroDateToIso(report.data.UpdatedDateUTC)
              ? ` · ${formatDateTime(xeroDateToIso(report.data.UpdatedDateUTC))}`
              : ''}
          </div>
        </Card>
      )}
    </div>
  )
}
