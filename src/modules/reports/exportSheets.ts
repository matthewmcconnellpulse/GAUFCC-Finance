/**
 * The workbook: which sheets, what is on them, and in which direction.
 *
 * Every 24-month dataset is written TWICE — once wide (months across as
 * columns) and once long (one row per account per month). That is deliberate
 * and not indecision. The two asks behind this export are incompatible: a
 * person comparing October against October wants both on one row, and a tool
 * importing the data wants tidy rows with a stable schema. Wide satisfies the
 * first and is useless for the second, because its columns change every time
 * the window moves. Long satisfies the second and is unreadable for the first.
 *
 * They cost almost nothing to produce together, because both are projections
 * of the same grid — and an Excel reader can rebuild any wide view from a long
 * sheet with a pivot table in half a minute, whereas unpivoting 24 columns by
 * hand is exactly where a spreadsheet gets quietly corrupted.
 */
import type { CellValue, Sheet } from '@/lib/xlsx'
import {
  NO_FUND,
  debitPositive,
  groupByMonth,
  incomePositive,
  isPl,
  round2,
  type ExportDataset,
  type LedgerLine,
} from './exportData'
import { FUND_TYPE_LABELS } from './lib'

export interface TrialBalanceRow {
  code: string
  name: string
  debit: number
  credit: number
}

/** A trial balance at one month end, as Xero reported it. */
export interface TrialBalanceMonth {
  month: string
  rows: TrialBalanceRow[]
}

export interface BudgetLine {
  budgetId: string
  budgetName: string
  trackingCategory: string | null
  trackingOption: string | null
  accountCode: string
  accountName: string
  period: string
  amount: number
}

export interface ExtraSources {
  trialBalance: TrialBalanceMonth[] | null
  trialBalanceError: string | null
  budgets: BudgetLine[] | null
  budgetsError: string | null
}

function monthDate(monthKey: string): Date {
  return new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1)
}

function monthEndDate(monthKey: string): Date {
  return new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 0)
}

function parseDate(iso: string | null): Date | null {
  if (!iso) return null
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Month columns shared by every wide sheet. */
function monthColumns(months: string[]) {
  return months.map((m) => ({
    header: m,
    key: `m_${m}`,
    format: 'money' as const,
    width: 13,
  }))
}

function monthCells(byMonth: Map<string, { amount: number }> | undefined, months: string[]) {
  const out: Record<string, CellValue> = {}
  for (const m of months) {
    const cell = byMonth?.get(m)
    out[`m_${m}`] = cell ? round2(cell.amount) : null
  }
  return out
}

// ── Dimensions ───────────────────────────────────────────────────────────────

function accountsSheet(data: ExportDataset): Sheet {
  return {
    name: 'Accounts',
    columns: [
      { header: 'Account code', key: 'code', format: 'text', width: 14 },
      { header: 'Account name', key: 'name', width: 42 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'Class', key: 'class', width: 14 },
      { header: 'Natural side', key: 'side', width: 13 },
      { header: 'Reporting code', key: 'reporting', format: 'text', width: 14 },
    ],
    rows: [...data.accounts.values()].map((a) => ({
      code: a.code,
      name: a.name,
      type: a.type,
      class: a.class,
      side:
        a.class === 'REVENUE' || a.class === 'LIABILITY' || a.class === 'EQUITY'
          ? 'Credit'
          : a.class
            ? 'Debit'
            : '',
      reporting: a.reporting_code,
    })),
  }
}

function fundsSheet(data: ExportDataset): Sheet {
  return {
    name: 'Funds',
    columns: [
      { header: 'Fund', key: 'name', width: 46 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Active', key: 'active', width: 9 },
      { header: 'Opening balance', key: 'opening', format: 'money', width: 16 },
      { header: 'Opening balance date', key: 'openingDate', format: 'date', width: 19 },
      { header: 'Xero tracking option id', key: 'option', format: 'text', width: 38 },
      { header: 'Fund id', key: 'id', format: 'text', width: 38 },
    ],
    rows: data.funds.map((f) => ({
      name: f.name,
      type: FUND_TYPE_LABELS[f.fund_type] ?? f.fund_type,
      active: f.active ? 'Yes' : 'No',
      opening: round2(f.opening_balance ?? 0),
      openingDate: parseDate(f.opening_balance_date),
      option: f.tracking_option_id,
      id: f.id,
    })),
  }
}

// ── Profit and loss ──────────────────────────────────────────────────────────

function plLines(data: ExportDataset): LedgerLine[] {
  return data.lines.filter((l) => isPl(data.accounts.get(l.account_code ?? '')?.class ?? null))
}

function plWideSheet(data: ExportDataset): Sheet {
  const lines = plLines(data)
  const byAccount = groupByMonth(
    lines,
    (l) => l.account_code ?? '',
    (l) => incomePositive(l.net, data.accounts.get(l.account_code ?? '')?.class ?? null),
  )
  const months = data.window.months

  const rows: Array<Record<string, CellValue>> = [...byAccount.entries()]
    .map(([code, byMonth]) => {
      const account = data.accounts.get(code)
      const total = months.reduce((sum, m) => sum + (byMonth.get(m)?.amount ?? 0), 0)
      return {
        code,
        name: account?.name ?? '(unknown account)',
        class: account?.class ?? '',
        direction: account?.class === 'REVENUE' ? 'Income' : 'Expenditure',
        ...monthCells(byMonth, months),
        total: round2(total),
      }
    })
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }))

  const totalRow: Record<string, CellValue> = {
    code: '',
    name: 'TOTAL — net income less expenditure',
    class: '',
    direction: '',
    total: round2(rows.reduce((s, r) => s + Number(r.total ?? 0), 0)),
  }
  for (const m of months) {
    totalRow[`m_${m}`] = round2(rows.reduce((s, r) => s + Number(r[`m_${m}`] ?? 0), 0))
  }

  return {
    name: 'P&L (income +)',
    columns: [
      { header: 'Account code', key: 'code', format: 'text', width: 14 },
      { header: 'Account name', key: 'name', width: 42 },
      { header: 'Class', key: 'class', width: 12 },
      { header: 'Direction', key: 'direction', width: 13 },
      ...monthColumns(months),
      { header: 'Total 24m', key: 'total', format: 'money', width: 15 },
    ],
    rows: [...rows, totalRow],
  }
}

function plLongSheet(data: ExportDataset): Sheet {
  const lines = plLines(data)
  const byAccount = groupByMonth(
    lines,
    (l) => l.account_code ?? '',
    (l) => l.net,
  )
  const rows: Array<Record<string, CellValue>> = []
  for (const [code, byMonth] of byAccount) {
    const account = data.accounts.get(code)
    for (const month of data.window.months) {
      const cell = byMonth.get(month)
      if (!cell) continue
      rows.push({
        code,
        name: account?.name ?? '(unknown account)',
        class: account?.class ?? '',
        direction: account?.class === 'REVENUE' ? 'Income' : 'Expenditure',
        period: month,
        periodStart: monthDate(month),
        periodEnd: monthEndDate(month),
        natural: round2(cell.amount),
        incomePositive: round2(incomePositive(cell.amount, account?.class ?? null)),
        lineCount: cell.lineCount,
      })
    }
  }
  rows.sort(
    (a, b) =>
      String(a.code).localeCompare(String(b.code), 'en', { numeric: true }) ||
      String(a.period).localeCompare(String(b.period)),
  )
  return {
    name: 'P&L detail',
    columns: [
      { header: 'Account code', key: 'code', format: 'text', width: 14 },
      { header: 'Account name', key: 'name', width: 42 },
      { header: 'Class', key: 'class', width: 12 },
      { header: 'Direction', key: 'direction', width: 13 },
      { header: 'Period', key: 'period', format: 'text', width: 10 },
      { header: 'Period start', key: 'periodStart', format: 'date', width: 13 },
      { header: 'Period end', key: 'periodEnd', format: 'date', width: 13 },
      { header: 'Amount (account natural)', key: 'natural', format: 'money', width: 22 },
      { header: 'Amount (income +)', key: 'incomePositive', format: 'money', width: 18 },
      { header: 'Lines', key: 'lineCount', format: 'integer', width: 8 },
    ],
    rows,
  }
}

function plByFundSheet(data: ExportDataset): Sheet {
  const lines = plLines(data)
  const rows: Array<Record<string, CellValue>> = []
  const grouped = new Map<string, Map<string, { amount: number; lineCount: number }>>()

  for (const line of lines) {
    const account = data.accounts.get(line.account_code ?? '')
    const fund = line.tracking_option_1_id
      ? data.fundByOption.get(line.tracking_option_1_id)
      : undefined
    const key = [
      line.account_code ?? '',
      fund?.id ?? '',
      fund?.name ?? NO_FUND,
      fund?.fund_type ?? '',
    ].join('\u0000')
    const month = line.date.slice(0, 7)
    let byMonth = grouped.get(key)
    if (!byMonth) {
      byMonth = new Map()
      grouped.set(key, byMonth)
    }
    const cell = byMonth.get(month) ?? { amount: 0, lineCount: 0 }
    cell.amount += incomePositive(line.net, account?.class ?? null)
    cell.lineCount += 1
    byMonth.set(month, cell)
  }

  for (const [key, byMonth] of grouped) {
    const [code, fundId, fundName, fundType] = key.split('\u0000')
    const account = data.accounts.get(code)
    for (const month of data.window.months) {
      const cell = byMonth.get(month)
      if (!cell) continue
      rows.push({
        code,
        name: account?.name ?? '(unknown account)',
        class: account?.class ?? '',
        fundId: fundId || null,
        fundName,
        fundType: fundType ? (FUND_TYPE_LABELS[fundType as never] ?? fundType) : '',
        period: month,
        periodStart: monthDate(month),
        amount: round2(cell.amount),
        lineCount: cell.lineCount,
      })
    }
  }
  rows.sort(
    (a, b) =>
      String(a.fundName).localeCompare(String(b.fundName), 'en', { numeric: true }) ||
      String(a.code).localeCompare(String(b.code), 'en', { numeric: true }) ||
      String(a.period).localeCompare(String(b.period)),
  )

  return {
    name: 'P&L by fund',
    columns: [
      { header: 'Fund', key: 'fundName', width: 46 },
      { header: 'Fund type', key: 'fundType', width: 14 },
      { header: 'Account code', key: 'code', format: 'text', width: 14 },
      { header: 'Account name', key: 'name', width: 42 },
      { header: 'Class', key: 'class', width: 12 },
      { header: 'Period', key: 'period', format: 'text', width: 10 },
      { header: 'Period start', key: 'periodStart', format: 'date', width: 13 },
      { header: 'Amount (income +)', key: 'amount', format: 'money', width: 18 },
      { header: 'Lines', key: 'lineCount', format: 'integer', width: 8 },
      { header: 'Fund id', key: 'fundId', format: 'text', width: 38 },
    ],
    rows,
  }
}

// ── Transactions ─────────────────────────────────────────────────────────────

function transactionsSheet(data: ExportDataset): Sheet {
  const rows = data.lines.map((line) => {
    const account = data.accounts.get(line.account_code ?? '')
    const fund = line.tracking_option_1_id
      ? data.fundByOption.get(line.tracking_option_1_id)
      : undefined
    return {
      date: parseDate(line.date),
      period: line.date.slice(0, 7),
      source: line.source_type,
      status: line.status,
      code: line.account_code,
      account: account?.name ?? '',
      class: account?.class ?? '',
      type: account?.type ?? '',
      contact: line.contact_name,
      description: line.description,
      net: round2(line.net),
      vat: round2(line.vat),
      gross: round2(line.gross),
      incomePositive: isPl(account?.class ?? null)
        ? round2(incomePositive(line.net, account?.class ?? null))
        : null,
      debitPositive: round2(debitPositive(line.net, account?.class ?? null)),
      fundName: fund?.name ?? (isPl(account?.class ?? null) ? NO_FUND : ''),
      fundType: fund ? (FUND_TYPE_LABELS[fund.fund_type] ?? fund.fund_type) : '',
      fundId: fund?.id ?? null,
      xeroId: line.xero_id,
      lineId: line.line_id,
      updated: parseDate(line.updated_date_utc),
    }
  })

  return {
    name: 'Transactions',
    columns: [
      { header: 'Date', key: 'date', format: 'date', width: 12 },
      { header: 'Period', key: 'period', format: 'text', width: 10 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Status', key: 'status', width: 13 },
      { header: 'Account code', key: 'code', format: 'text', width: 13 },
      { header: 'Account name', key: 'account', width: 40 },
      { header: 'Class', key: 'class', width: 12 },
      { header: 'Type', key: 'type', width: 16 },
      { header: 'Contact', key: 'contact', width: 30 },
      { header: 'Description', key: 'description', width: 46 },
      { header: 'Net (account natural)', key: 'net', format: 'money', width: 19 },
      { header: 'VAT', key: 'vat', format: 'money', width: 11 },
      { header: 'Gross', key: 'gross', format: 'money', width: 13 },
      { header: 'Net (income +)', key: 'incomePositive', format: 'money', width: 16 },
      { header: 'Net (debit +)', key: 'debitPositive', format: 'money', width: 15 },
      { header: 'Fund', key: 'fundName', width: 44 },
      { header: 'Fund type', key: 'fundType', width: 13 },
      { header: 'Fund id', key: 'fundId', format: 'text', width: 38 },
      { header: 'Xero document id', key: 'xeroId', format: 'text', width: 38 },
      { header: 'Line id', key: 'lineId', format: 'text', width: 38 },
      { header: 'Last changed in Xero', key: 'updated', format: 'date', width: 19 },
    ],
    rows,
  }
}

// ── Fund movement ────────────────────────────────────────────────────────────

function fundMovementSheets(data: ExportDataset): Sheet[] {
  const months = data.window.months
  const grouped = new Map<string, Map<string, { amount: number; lineCount: number }>>()

  for (const line of data.lines) {
    const account = data.accounts.get(line.account_code ?? '')
    if (!isPl(account?.class ?? null)) continue
    const fund = line.tracking_option_1_id
      ? data.fundByOption.get(line.tracking_option_1_id)
      : undefined
    const key = fund ? fund.id : ''
    const month = line.date.slice(0, 7)
    let byMonth = grouped.get(key)
    if (!byMonth) {
      byMonth = new Map()
      grouped.set(key, byMonth)
    }
    const cell = byMonth.get(month) ?? { amount: 0, lineCount: 0 }
    cell.amount += incomePositive(line.net, account?.class ?? null)
    cell.lineCount += 1
    byMonth.set(month, cell)
  }

  const fundById = new Map(data.funds.map((f) => [f.id, f]))

  const wideRows: Array<Record<string, CellValue>> = [...grouped.entries()]
    .map(([fundId, byMonth]) => {
      const fund = fundById.get(fundId)
      const total = months.reduce((s, m) => s + (byMonth.get(m)?.amount ?? 0), 0)
      return {
        fundName: fund?.name ?? NO_FUND,
        fundType: fund ? (FUND_TYPE_LABELS[fund.fund_type] ?? fund.fund_type) : '',
        opening: fund ? round2(fund.opening_balance ?? 0) : null,
        openingDate: fund ? parseDate(fund.opening_balance_date) : null,
        ...monthCells(byMonth, months),
        total: round2(total),
        fundId: fundId || null,
      }
    })
    .sort((a, b) => String(a.fundName).localeCompare(String(b.fundName), 'en', { numeric: true }))

  const totalRow: Record<string, CellValue> = {
    fundName: 'TOTAL',
    fundType: '',
    opening: null,
    openingDate: null,
    total: round2(wideRows.reduce((s, r) => s + Number(r.total ?? 0), 0)),
    fundId: null,
  }
  for (const m of months) {
    totalRow[`m_${m}`] = round2(wideRows.reduce((s, r) => s + Number(r[`m_${m}`] ?? 0), 0))
  }

  const longRows: Array<Record<string, CellValue>> = []
  for (const [fundId, byMonth] of grouped) {
    const fund = fundById.get(fundId)
    for (const month of months) {
      const cell = byMonth.get(month)
      if (!cell) continue
      longRows.push({
        fundName: fund?.name ?? NO_FUND,
        fundType: fund ? (FUND_TYPE_LABELS[fund.fund_type] ?? fund.fund_type) : '',
        period: month,
        periodStart: monthDate(month),
        net: round2(cell.amount),
        lineCount: cell.lineCount,
        fundId: fundId || null,
      })
    }
  }
  longRows.sort(
    (a, b) =>
      String(a.fundName).localeCompare(String(b.fundName), 'en', { numeric: true }) ||
      String(a.period).localeCompare(String(b.period)),
  )

  return [
    {
      name: 'Fund movement',
      columns: [
        { header: 'Fund', key: 'fundName', width: 46 },
        { header: 'Fund type', key: 'fundType', width: 14 },
        { header: 'Opening balance', key: 'opening', format: 'money', width: 16 },
        { header: 'Opening balance date', key: 'openingDate', format: 'date', width: 19 },
        ...monthColumns(months),
        { header: 'Movement 24m', key: 'total', format: 'money', width: 15 },
        { header: 'Fund id', key: 'fundId', format: 'text', width: 38 },
      ],
      rows: [...wideRows, totalRow],
    },
    {
      name: 'Fund movement detail',
      columns: [
        { header: 'Fund', key: 'fundName', width: 46 },
        { header: 'Fund type', key: 'fundType', width: 14 },
        { header: 'Period', key: 'period', format: 'text', width: 10 },
        { header: 'Period start', key: 'periodStart', format: 'date', width: 13 },
        { header: 'Net movement (income +)', key: 'net', format: 'money', width: 22 },
        { header: 'Lines', key: 'lineCount', format: 'integer', width: 8 },
        { header: 'Fund id', key: 'fundId', format: 'text', width: 38 },
      ],
      rows: longRows,
    },
  ]
}

// ── Coding gaps ──────────────────────────────────────────────────────────────

/**
 * Every profit-and-loss line carrying no fund. This is the sheet that answers
 * "why do the funds not add up to the charity", line by line, and it is here
 * because that question has come up repeatedly and deserves an answer someone
 * can filter and sort rather than a figure on a card.
 */
function codingGapsSheet(data: ExportDataset): Sheet {
  const rows = data.lines
    .filter((l) => {
      const account = data.accounts.get(l.account_code ?? '')
      return isPl(account?.class ?? null) && !l.tracking_option_1_id
    })
    .map((l) => {
      const account = data.accounts.get(l.account_code ?? '')
      return {
        date: parseDate(l.date),
        period: l.date.slice(0, 7),
        code: l.account_code,
        account: account?.name ?? '',
        class: account?.class ?? '',
        source: l.source_type,
        contact: l.contact_name,
        description: l.description,
        effect: round2(incomePositive(l.net, account?.class ?? null)),
        xeroId: l.xero_id,
        updated: parseDate(l.updated_date_utc),
      }
    })
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))

  const total = round2(rows.reduce((s, r) => s + Number(r.effect ?? 0), 0))

  return {
    name: 'Coding gaps',
    notes: [
      'Profit-and-loss lines with no Fund tracking option against them.',
      `These are the whole of the difference between the charity's result and the sum of the funds: ${total.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} across ${rows.length} lines.`,
      'Code them in Xero and re-sync, and they drop off this list.',
    ],
    columns: [
      { header: 'Date', key: 'date', format: 'date', width: 12 },
      { header: 'Period', key: 'period', format: 'text', width: 10 },
      { header: 'Account code', key: 'code', format: 'text', width: 13 },
      { header: 'Account name', key: 'account', width: 40 },
      { header: 'Class', key: 'class', width: 12 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Contact', key: 'contact', width: 30 },
      { header: 'Description', key: 'description', width: 46 },
      { header: 'Effect on result (income +)', key: 'effect', format: 'money', width: 25 },
      { header: 'Xero document id', key: 'xeroId', format: 'text', width: 38 },
      { header: 'Last changed in Xero', key: 'updated', format: 'date', width: 19 },
    ],
    rows,
  }
}

// ── Trial balance and budgets (live Xero) ────────────────────────────────────

function trialBalanceSheets(data: ExportDataset, extra: ExtraSources): Sheet[] {
  if (!extra.trialBalance || extra.trialBalance.length === 0) {
    return [
      {
        name: 'Trial balance',
        table: false,
        notes: [
          'The trial balance could not be included.',
          extra.trialBalanceError ??
            'Xero did not return a trial balance for this window.',
          'It is read live from Xero rather than derived here, because the ledger mirror holds the movements it has mirrored and not the opening positions behind them — a trial balance built from it would not balance.',
        ],
        columns: [],
        rows: [],
      },
    ]
  }

  const months = extra.trialBalance.map((t) => t.month)
  const byAccount = new Map<string, { name: string; months: Map<string, number> }>()
  for (const snapshot of extra.trialBalance) {
    for (const row of snapshot.rows) {
      let entry = byAccount.get(row.code)
      if (!entry) {
        entry = { name: row.name, months: new Map() }
        byAccount.set(row.code, entry)
      }
      entry.months.set(snapshot.month, round2(row.debit - row.credit))
    }
  }

  const wideRows = [...byAccount.entries()]
    .map(([code, entry]) => {
      const account = data.accounts.get(code)
      const row: Record<string, CellValue> = {
        code,
        name: entry.name || account?.name || '',
        class: account?.class ?? '',
        side:
          account?.class === 'REVENUE' || account?.class === 'LIABILITY' || account?.class === 'EQUITY'
            ? 'Credit'
            : account?.class
              ? 'Debit'
              : '',
      }
      for (const m of months) row[`m_${m}`] = entry.months.get(m) ?? null
      return row
    })
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }))

  const totalRow: Record<string, CellValue> = {
    code: '',
    name: 'TOTAL — must be nil in every column',
    class: '',
    side: '',
  }
  for (const m of months) {
    totalRow[`m_${m}`] = round2(wideRows.reduce((s, r) => s + Number(r[`m_${m}`] ?? 0), 0))
  }

  const longRows: Array<Record<string, CellValue>> = []
  for (const [code, entry] of byAccount) {
    const account = data.accounts.get(code)
    for (const m of months) {
      const signed = entry.months.get(m)
      if (signed === undefined) continue
      longRows.push({
        code,
        name: entry.name || account?.name || '',
        class: account?.class ?? '',
        period: m,
        periodEnd: monthEndDate(m),
        debit: signed > 0 ? round2(signed) : null,
        credit: signed < 0 ? round2(-signed) : null,
        signed: round2(signed),
      })
    }
  }

  return [
    {
      name: 'Trial balance (debit +)',
      columns: [
        { header: 'Account code', key: 'code', format: 'text', width: 14 },
        { header: 'Account name', key: 'name', width: 42 },
        { header: 'Class', key: 'class', width: 12 },
        { header: 'Natural side', key: 'side', width: 13 },
        ...monthColumns(months),
      ],
      rows: [...wideRows, totalRow],
    },
    {
      name: 'TB detail',
      columns: [
        { header: 'Account code', key: 'code', format: 'text', width: 14 },
        { header: 'Account name', key: 'name', width: 42 },
        { header: 'Class', key: 'class', width: 12 },
        { header: 'Period', key: 'period', format: 'text', width: 10 },
        { header: 'Period end', key: 'periodEnd', format: 'date', width: 13 },
        { header: 'Debit', key: 'debit', format: 'money', width: 14 },
        { header: 'Credit', key: 'credit', format: 'money', width: 14 },
        { header: 'Balance (debit +)', key: 'signed', format: 'money', width: 17 },
      ],
      rows: longRows,
    },
  ]
}

function budgetsSheet(data: ExportDataset, extra: ExtraSources): Sheet {
  if (!extra.budgets || extra.budgets.length === 0) {
    return {
      name: 'Budgets',
      table: false,
      notes: [
        'No budget data could be included.',
        extra.budgetsError ??
          'Xero returned no budgets for this organisation.',
        'Budgets are read live from Xero and need the accounting.budgets.read scope on the custom connection. That scope is not in Xero’s default set — add it to the app in the Xero developer portal and reconnect, and this sheet fills itself, including any budget held against a Fund tracking category.',
      ],
      columns: [],
      rows: [],
    }
  }

  const optionToFund = new Map(
    data.funds.filter((f) => f.tracking_option_id).map((f) => [f.name.toLowerCase(), f]),
  )

  return {
    name: 'Budgets',
    columns: [
      { header: 'Budget', key: 'budgetName', width: 32 },
      { header: 'Tracking category', key: 'trackingCategory', width: 22 },
      { header: 'Tracking option (fund)', key: 'trackingOption', width: 44 },
      { header: 'Fund type', key: 'fundType', width: 14 },
      { header: 'Account code', key: 'accountCode', format: 'text', width: 14 },
      { header: 'Account name', key: 'accountName', width: 42 },
      { header: 'Period', key: 'period', format: 'text', width: 10 },
      { header: 'Period start', key: 'periodStart', format: 'date', width: 13 },
      { header: 'Budget amount', key: 'amount', format: 'money', width: 16 },
      { header: 'Budget id', key: 'budgetId', format: 'text', width: 38 },
    ],
    rows: extra.budgets.map((b) => {
      const fund = b.trackingOption ? optionToFund.get(b.trackingOption.toLowerCase()) : undefined
      return {
        budgetName: b.budgetName,
        trackingCategory: b.trackingCategory ?? '',
        trackingOption: b.trackingOption ?? '',
        fundType: fund ? (FUND_TYPE_LABELS[fund.fund_type] ?? fund.fund_type) : '',
        accountCode: b.accountCode,
        accountName: b.accountName,
        period: b.period,
        periodStart: monthDate(b.period),
        amount: round2(b.amount),
        budgetId: b.budgetId,
      }
    }),
  }
}

// ── Read me ──────────────────────────────────────────────────────────────────

function readMeSheet(data: ExportDataset, extra: ExtraSources, generatedAt: Date): Sheet {
  const plTotal = round2(
    plLines(data).reduce(
      (s, l) => s + incomePositive(l.net, data.accounts.get(l.account_code ?? '')?.class ?? null),
      0,
    ),
  )
  const gaps = data.lines.filter((l) => {
    const account = data.accounts.get(l.account_code ?? '')
    return isPl(account?.class ?? null) && !l.tracking_option_1_id
  })
  const gapTotal = round2(
    gaps.reduce(
      (s, l) => s + incomePositive(l.net, data.accounts.get(l.account_code ?? '')?.class ?? null),
      0,
    ),
  )

  const rows: Array<Record<string, CellValue>> = [
    { k: 'Generated', v: generatedAt },
    { k: 'Window', v: `${data.window.start} to ${data.window.end}` },
    { k: 'Months', v: data.window.months.length },
    { k: 'Ledger lines in window', v: data.lines.length },
    { k: 'Accounts', v: data.accounts.size },
    { k: 'Funds', v: data.funds.length },
    { k: 'Net income less expenditure, 24m', v: plTotal },
    { k: 'Of which carries no fund', v: gapTotal },
    { k: 'Lines carrying no fund', v: gaps.length },
    {
      k: 'Trial balance',
      v: extra.trialBalance?.length ? `${extra.trialBalance.length} month ends from Xero` : `Not included — ${extra.trialBalanceError ?? 'unavailable'}`,
    },
    {
      k: 'Budgets',
      v: extra.budgets?.length ? `${extra.budgets.length} budget lines from Xero` : `Not included — ${extra.budgetsError ?? 'unavailable'}`,
    },
    { k: 'Mirror truncated', v: data.truncated ? 'YES — figures are short, tell Pulse' : 'No' },
  ]

  return {
    name: 'Read me',
    table: false,
    notes: [
      'GAUFCC Finance — ledger export',
      '',
      'Each 24-month dataset appears twice. The wide sheets (months across as columns) are for reading and comparing; the "detail" sheets are one row per account per month, which is the shape to import into another tool. Both come from the same figures.',
      '',
      'Signs. The ledger stores amounts account-naturally: a plus is a credit on an income, liability or equity account, and a debit on an expense or asset one. Where it matters a sheet carries the convention in its column heading — "income +" means income is positive and expenditure negative, so a column sums to the surplus; "debit +" is the trial-balance convention, so a column sums to nil.',
      '',
      'Source. Everything except the trial balance and budgets is the ledger mirror of Xero, excluding voided and deleted documents. The trial balance and budgets are read live from Xero.',
      '',
      'VAT is carried on every transaction row and is nil throughout — the charity is not VAT registered on this ledger. Do not build a VAT analysis on it.',
    ],
    columns: [
      { header: 'Item', key: 'k', width: 36 },
      { header: 'Value', key: 'v', width: 56 },
    ],
    rows,
  }
}

// ── The workbook ─────────────────────────────────────────────────────────────

export function buildExportSheets(
  data: ExportDataset,
  extra: ExtraSources,
  generatedAt = new Date(),
): Sheet[] {
  return [
    readMeSheet(data, extra, generatedAt),
    ...trialBalanceSheets(data, extra),
    plWideSheet(data),
    plLongSheet(data),
    plByFundSheet(data),
    ...fundMovementSheets(data),
    transactionsSheet(data),
    codingGapsSheet(data),
    budgetsSheet(data, extra),
    accountsSheet(data),
    fundsSheet(data),
  ]
}

export function exportFileName(data: ExportDataset): string {
  return `gaufcc-ledger-export-${data.window.months[0]}-to-${data.window.months[data.window.months.length - 1]}.xlsx`
}
