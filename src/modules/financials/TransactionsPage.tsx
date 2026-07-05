/**
 * Financials → Transactions — the account-transaction register, straight from
 * the xero_transactions mirror (one row per document line). Filterable by
 * account, type, fund, date range and free text; paged 50 at a time.
 * RLS applies: Pulse + CEO see everything, trustees only their funds' lines.
 */

import { useMemo, useState } from 'react'
import {
  Card,
  EmptyState,
  ErrorNotice,
  Input,
  LoadingRows,
  PageHeader,
  Paginator,
  Select,
  type PageSize,
} from '@/components/ui'
import { formatDate, formatMoney } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { sourceTypeLabel } from '@/modules/funds/lib'
import {
  EMPTY_TXN_FILTERS,
  fetchActiveAccounts,
  fetchFundsForFilter,
  fetchTransactions,
  type TransactionFilters,
} from './lib'

const SOURCE_TYPES = [
  'ACCREC',
  'ACCPAY',
  'RECEIVE',
  'SPEND',
  'BANK_TRANSFER',
  'CREDIT_NOTE',
  'PREPAYMENT',
  'OVERPAYMENT',
]

export default function TransactionsPage() {
  const [filters, setFilters] = useState<TransactionFilters>(EMPTY_TXN_FILTERS)
  const [searchDraft, setSearchDraft] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<PageSize>(50)

  const accounts = useSupabaseQuery(fetchActiveAccounts, [])
  const funds = useSupabaseQuery(fetchFundsForFilter, [])
  const txns = useSupabaseQuery(
    () => {
      const classCodes = filters.accountClass
        ? (accounts.data ?? [])
            .filter((a) => a.class === filters.accountClass && a.code)
            .map((a) => a.code as string)
        : null
      return fetchTransactions(filters, page, pageSize, classCodes)
    },
    [
      filters.search,
      filters.accountCode,
      filters.accountClass,
      filters.sourceType,
      filters.fundOptionId,
      filters.dateFrom,
      filters.dateTo,
      page,
      pageSize,
      accounts.data,
    ],
  )

  const accountName = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accounts.data ?? []) if (a.code) map.set(a.code, a.name)
    return map
  }, [accounts.data])

  const fundName = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of funds.data ?? []) if (f.tracking_option_id) map.set(f.tracking_option_id, f.name)
    return map
  }, [funds.data])

  const total = txns.data?.total ?? 0
  const setFilter = (patch: Partial<TransactionFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(0)
  }

  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle="Every synced Xero line — invoices, bills, bank items and credit notes."
      />

      {/* Filters */}
      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <form
            className="xl:col-span-2"
            onSubmit={(e) => {
              e.preventDefault()
              setFilter({ search: searchDraft })
            }}
          >
            <Input
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onBlur={() => setFilter({ search: searchDraft })}
              placeholder="Search description or contact…"
              aria-label="Search transactions"
            />
          </form>
          <Select
            value={filters.accountClass}
            onChange={(e) =>
              setFilter({ accountClass: e.target.value as '' | 'REVENUE' | 'EXPENSE' })
            }
            aria-label="Filter income or expenditure"
          >
            <option value="">Income + expenditure</option>
            <option value="REVENUE">Income only</option>
            <option value="EXPENSE">Expenditure only</option>
          </Select>
          <Select
            value={filters.accountCode}
            onChange={(e) => setFilter({ accountCode: e.target.value })}
            aria-label="Filter by account"
          >
            <option value="">All accounts</option>
            {(accounts.data ?? [])
              .filter((a) => a.code)
              .map((a) => (
                <option key={a.account_id} value={a.code ?? ''}>
                  {a.code} — {a.name}
                </option>
              ))}
          </Select>
          <Select
            value={filters.sourceType}
            onChange={(e) => setFilter({ sourceType: e.target.value })}
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            {SOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {sourceTypeLabel(t)}
              </option>
            ))}
          </Select>
          <Select
            value={filters.fundOptionId}
            onChange={(e) => setFilter({ fundOptionId: e.target.value })}
            aria-label="Filter by fund"
          >
            <option value="">All funds</option>
            {(funds.data ?? []).map((f) => (
              <option key={f.id} value={f.tracking_option_id ?? ''}>
                {f.name}
              </option>
            ))}
          </Select>
          <Input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilter({ dateFrom: e.target.value })}
            aria-label="From date"
          />
          <Input
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilter({ dateTo: e.target.value })}
            aria-label="To date"
          />
        </div>
      </Card>

      {txns.error ? (
        <ErrorNotice message={`Transactions could not be loaded — ${txns.error}`} />
      ) : txns.loading ? (
        <LoadingRows cols={7} rows={10} />
      ) : (txns.data?.rows.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="No transactions match"
            hint="Try widening the date range or clearing a filter. New Xero activity lands with the nightly sync or Refresh now."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[980px]">
              <thead>
                <tr>
                  <th className="th-register">Date</th>
                  <th className="th-register">Type</th>
                  <th className="th-register">Contact</th>
                  <th className="th-register">Description</th>
                  <th className="th-register">Account</th>
                  <th className="th-register">Fund</th>
                  <th className="th-register text-right">Net</th>
                  <th className="th-register text-right">VAT</th>
                  <th className="th-register text-right">Gross</th>
                </tr>
              </thead>
              <tbody>
                {(txns.data?.rows ?? []).map((t) => (
                  <tr key={t.id} className="border-t border-stone-150 hover:bg-paper-2/60">
                    <td className="td-register whitespace-nowrap text-[12px] text-stone-700">
                      {formatDate(t.date)}
                    </td>
                    <td className="td-register text-[11.5px] text-stone-600 whitespace-nowrap">
                      {sourceTypeLabel(t.source_type)}
                    </td>
                    <td className="td-register text-[12px] text-ink max-w-[180px] truncate">
                      {t.contact_name ?? '—'}
                    </td>
                    <td className="td-register text-[12px] text-stone-700 max-w-[260px] truncate">
                      {t.description ?? '—'}
                    </td>
                    <td className="td-register text-[11.5px] text-stone-600 max-w-[200px] truncate">
                      {t.account_code
                        ? `${t.account_code}${accountName.get(t.account_code) ? ` — ${accountName.get(t.account_code)}` : ''}`
                        : '—'}
                    </td>
                    <td className="td-register text-[11.5px] text-stone-600 max-w-[200px] truncate">
                      {t.tracking_option_1_id
                        ? (fundName.get(t.tracking_option_1_id) ?? '—')
                        : '—'}
                    </td>
                    <td className="td-register text-right figure text-[12.5px] text-ink">
                      {formatMoney(t.net)}
                    </td>
                    <td className="td-register text-right figure text-[12px] text-stone-600">
                      {formatMoney(t.vat)}
                    </td>
                    <td className="td-register text-right figure text-[12.5px] font-medium text-ink">
                      {formatMoney(t.gross)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Paginator
            page={page}
            pageSize={pageSize}
            total={total}
            shown={txns.data?.rows.length ?? 0}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size)
              setPage(0)
            }}
          />
        </Card>
      )}
    </div>
  )
}
