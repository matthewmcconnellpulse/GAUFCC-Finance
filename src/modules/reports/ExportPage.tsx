/**
 * Reports → Export. The ledger as a spreadsheet.
 *
 * One workbook rather than a menu of downloads: the sheets are meant to be
 * read against each other — a figure on the profit and loss traced to the
 * transactions behind it, and the coding gaps that explain why the funds do
 * not add up to the charity. Separate files would make that a filing exercise.
 *
 * The trial balance is opt-in because it costs 24 Xero calls (one per month
 * end — unlike the other reports it takes no periods parameter) and the rest
 * of the workbook is instant without it.
 */
import { useState } from 'react'
import { Button, Card, ErrorNotice, PageHeader, SectionLabel, StatusChip } from '@/components/ui'
import { usePermissions } from '@/auth/AuthProvider'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { downloadWorkbook } from '@/lib/xlsx'
import { formatMoney } from '@/lib/format'
import {
  exportWindow,
  fetchActivityForWindow,
  fetchExportDataset,
  incomePositive,
  isPl,
  round2,
} from './exportData'
import { buildExportSheets, exportFileName, type ExtraSources } from './exportSheets'
import { fetchBudgetLines, fetchTrialBalanceMonths } from './exportXero'

export default function ExportPage() {
  const { isPulse, isCeo } = usePermissions()
  const canExport = isPulse || isCeo

  const activity = useSupabaseQuery(fetchActivityForWindow, [])
  const [includeTrialBalance, setIncludeTrialBalance] = useState(true)
  const [includeBudgets, setIncludeBudgets] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const window = activity.data ? exportWindow(activity.data) : null

  const run = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      setProgress('Reading the ledger…')
      const data = await fetchExportDataset()

      const extra: ExtraSources = {
        trialBalance: null,
        trialBalanceError: includeTrialBalance
          ? null
          : 'not requested — tick "Include the trial balance" to pull it from Xero.',
        budgets: null,
        budgetsError: includeBudgets ? null : 'not requested.',
      }

      if (includeTrialBalance) {
        setProgress('Reading the trial balance from Xero (1 of 24 month ends)…')
        const tb = await fetchTrialBalanceMonths(data.window, (doneCount, total) =>
          setProgress(`Reading the trial balance from Xero (${doneCount} of ${total} month ends)…`),
        )
        extra.trialBalance = tb.months.length > 0 ? tb.months : null
        extra.trialBalanceError = tb.error
      }

      if (includeBudgets) {
        setProgress('Reading budgets from Xero…')
        const budgets = await fetchBudgetLines()
        extra.budgets = budgets.lines.length > 0 ? budgets.lines : null
        extra.budgetsError = budgets.error
      }

      setProgress('Building the workbook…')
      const sheets = buildExportSheets(data, extra)
      await downloadWorkbook(exportFileName(data), sheets)

      const gaps = data.lines.filter((l) => {
        const account = data.accounts.get(l.account_code ?? '')
        return isPl(account?.class ?? null) && !l.tracking_option_1_id
      })
      const gapTotal = round2(
        gaps.reduce(
          (s, l) =>
            s + incomePositive(l.net, data.accounts.get(l.account_code ?? '')?.class ?? null),
          0,
        ),
      )
      setDone(
        `${exportFileName(data)} — ${data.lines.length.toLocaleString('en-GB')} ledger lines over ${data.window.months.length} months` +
          (gaps.length > 0
            ? `, including ${gaps.length} line${gaps.length === 1 ? '' : 's'} carrying no fund (${formatMoney(gapTotal)}) on the Coding gaps sheet.`
            : '.'),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be built')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  if (!canExport) {
    return (
      <div>
        <PageHeader title="Export" subtitle="The ledger as a spreadsheet" />
        <Card>
          <div className="px-5 py-6 text-[12.5px] text-stone-600">
            The ledger export is available to Pulse and the CEO.
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Export"
        subtitle={window ? `24 months · ${window.label}` : 'The ledger as a spreadsheet'}
        actions={
          <Button variant="money" disabled={busy || !window} onClick={() => void run()}>
            {busy ? 'Building…' : 'Download Excel workbook'}
          </Button>
        }
      />

      {error ? (
        <div className="mb-4">
          <ErrorNotice message={`The export failed — ${error}`} />
        </div>
      ) : null}
      {done ? (
        <div className="mb-4 rounded-card border border-mint-700/40 bg-mint/10 text-mint-900 text-[12.5px] px-4 py-3">
          Downloaded <b className="font-medium">{done}</b>
        </div>
      ) : null}
      {busy && progress ? (
        <div className="mb-4 rounded-card border border-stone-200 bg-paper-2 text-[12.5px] px-4 py-3 text-stone-700">
          {progress}
        </div>
      ) : null}

      <div className="space-y-6">
        <Card className="px-5 py-4">
          <SectionLabel>What you get</SectionLabel>
          <p className="text-[12px] text-stone-500 mb-3">
            One workbook. Every 24-month figure appears twice: a wide sheet with the months across as
            columns, to read and compare, and a matching "detail" sheet with one row per account per
            month, which is the shape to import into another tool. Figures are real numbers and dates
            are real dates, so they sum, pivot and chart without being cleaned up first.
          </p>
          <ul className="text-[12.5px] text-stone-700 space-y-1.5">
            <li>
              <b className="font-medium">Trial balance</b> — every account at each of the 24 month
              ends, debit-positive, so each column proves to nil. Live from Xero.
            </li>
            <li>
              <b className="font-medium">Profit and loss</b> — by account and by month, income
              positive, plus a breakdown by fund.
            </li>
            <li>
              <b className="font-medium">Transactions</b> — every ledger line in the window with its
              account, fund, contact, both sign conventions and the Xero document id.
            </li>
            <li>
              <b className="font-medium">Fund movement</b> — net movement per fund per month, with
              opening balances.
            </li>
            <li>
              <b className="font-medium">Coding gaps</b> — the profit-and-loss lines carrying no
              fund, which are the whole of the difference between the charity's result and the sum of
              the funds.
            </li>
            <li>
              <b className="font-medium">Budgets</b> — every Xero budget by account and period,
              including any held against a Fund tracking category.
            </li>
            <li>
              <b className="font-medium">Accounts and Funds</b> — the reference lists to join on.
            </li>
          </ul>
        </Card>

        <Card className="px-5 py-4">
          <SectionLabel>Live sources</SectionLabel>
          <p className="text-[12px] text-stone-500 mb-3">
            Everything else comes from the ledger mirror and is instant. These two are read from Xero
            when you press the button.
          </p>
          <div className="border border-stone-150 rounded-control divide-y divide-stone-150">
            <label className="flex items-start gap-3 px-3.5 py-3 text-[12.5px] cursor-pointer hover:bg-paper-2">
              <input
                type="checkbox"
                checked={includeTrialBalance}
                onChange={(e) => setIncludeTrialBalance(e.target.checked)}
                className="accent-[#211951] mt-0.5"
              />
              <span>
                <span className="block text-ink">Include the trial balance</span>
                <span className="block text-[11px] text-stone-500">
                  24 separate calls to Xero, one per month end — Xero's trial balance takes a single
                  date and no period range. Adds roughly a minute. It cannot be derived from the
                  mirror, which holds movements but not the opening positions behind them.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 px-3.5 py-3 text-[12.5px] cursor-pointer hover:bg-paper-2">
              <input
                type="checkbox"
                checked={includeBudgets}
                onChange={(e) => setIncludeBudgets(e.target.checked)}
                className="accent-[#211951] mt-0.5"
              />
              <span>
                <span className="block text-ink">Include budgets</span>
                <span className="block text-[11px] text-stone-500">
                  Needs the accounting.budgets.read scope on the Xero connection. If it is missing the
                  sheet says so rather than appearing empty.
                </span>
              </span>
            </label>
          </div>
        </Card>

        <Card className="px-5 py-4">
          <SectionLabel>The window</SectionLabel>
          {activity.loading ? (
            <p className="text-[12.5px] text-stone-500">Reading the ledger's shape…</p>
          ) : activity.error ? (
            <ErrorNotice message={`The ledger's months could not be read — ${activity.error}`} />
          ) : window ? (
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip tone="good">{window.label}</StatusChip>
              <span className="text-[12px] text-stone-600">
                {window.start} to {window.end}
              </span>
              <span className="text-[11.5px] text-stone-500">
                The 24 months ending at the last month the ledger is really reporting on — anchored on
                the ledger rather than today, so a part-posted current month never lands on the end of
                the comparison.
              </span>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  )
}
