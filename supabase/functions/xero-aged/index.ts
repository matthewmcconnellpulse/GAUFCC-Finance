/**
 * xero-aged — aged debtors and creditors, live from Xero.
 *
 * JWT-verified; roles pulse_*, ceo, trustee — the same audience as the other
 * statutory-style reports.
 *
 * Read live rather than from the mirror. The transaction mirror holds the
 * category side of an invoice, not the receivable or payable control postings,
 * so it cannot tell settled from outstanding — there is nothing in it to age.
 * Xero's Invoices endpoint carries AmountDue and DueDate per invoice, which is
 * exactly what ageing needs, and reading it on demand means a pack is never
 * issued against a stale debtor position.
 *
 * Body { as_at?: 'YYYY-MM-DD' } (defaults to today).
 * Returns { as_at, receivables, payables } where each side is
 * { total, buckets, contacts: [...], invoices: [...], invoice_count,
 *   contact_count, oldest_days }.
 *
 * Requires accounting.transactions.read (or accounting.transactions) on the
 * custom connection; a 403 from Xero is translated into a message that says so.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole } from '../_shared/auth.ts'
import { xeroFetch } from '../_shared/xero.ts'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const PAGE_SIZE = 100
const MAX_PAGES = 25 // 2,500 outstanding invoices is far beyond GAUFCC's scale

/** Ageing buckets, in days past the due date. */
const BUCKETS = [
  { key: 'current', label: 'Current', from: -Infinity, to: 0 },
  { key: 'days_1_30', label: '1–30 days', from: 1, to: 30 },
  { key: 'days_31_60', label: '31–60 days', from: 31, to: 60 },
  { key: 'days_61_90', label: '61–90 days', from: 61, to: 90 },
  { key: 'days_90_plus', label: 'Over 90 days', from: 91, to: Infinity },
] as const

type BucketKey = (typeof BUCKETS)[number]['key']

interface XeroInvoice {
  InvoiceID?: string
  InvoiceNumber?: string
  Reference?: string
  Type?: string
  Status?: string
  Date?: string
  DueDate?: string
  AmountDue?: number
  Total?: number
  Contact?: { ContactID?: string; Name?: string }
}

interface AgedInvoice {
  invoice_id: string
  number: string | null
  reference: string | null
  contact: string
  date: string | null
  due_date: string | null
  amount_due: number
  days_overdue: number
  bucket: BucketKey
}

interface AgedContact {
  name: string
  total: number
  invoice_count: number
  buckets: Record<BucketKey, number>
  oldest_days: number
}

interface AgedSide {
  total: number
  buckets: Record<BucketKey, number>
  contacts: AgedContact[]
  invoices: AgedInvoice[]
  invoice_count: number
  contact_count: number
  oldest_days: number
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function emptyBuckets(): Record<BucketKey, number> {
  return { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 }
}

/** Xero serialises dates as `/Date(1712345678000+0000)/` — normalise to YYYY-MM-DD. */
function xeroDate(value: string | undefined): string | null {
  if (!value) return null
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(value)
  const d = m ? new Date(Number(m[1])) : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`)
  const to = Date.parse(`${toIso}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.round((to - from) / 86_400_000)
}

function bucketFor(daysOverdue: number): BucketKey {
  for (const b of BUCKETS) {
    if (daysOverdue >= b.from && daysOverdue <= b.to) return b.key
  }
  return 'current'
}

function summarise(invoices: AgedInvoice[]): AgedSide {
  const buckets = emptyBuckets()
  const byContact = new Map<string, AgedContact>()
  let total = 0
  let oldest = 0

  for (const inv of invoices) {
    total += inv.amount_due
    buckets[inv.bucket] = round2(buckets[inv.bucket] + inv.amount_due)
    oldest = Math.max(oldest, inv.days_overdue)
    let contact = byContact.get(inv.contact)
    if (!contact) {
      contact = { name: inv.contact, total: 0, invoice_count: 0, buckets: emptyBuckets(), oldest_days: 0 }
      byContact.set(inv.contact, contact)
    }
    contact.total = round2(contact.total + inv.amount_due)
    contact.invoice_count += 1
    contact.buckets[inv.bucket] = round2(contact.buckets[inv.bucket] + inv.amount_due)
    contact.oldest_days = Math.max(contact.oldest_days, inv.days_overdue)
  }

  const contacts = [...byContact.values()].sort((a, b) => b.total - a.total)
  return {
    total: round2(total),
    buckets,
    contacts,
    invoices: invoices.sort((a, b) => b.amount_due - a.amount_due),
    invoice_count: invoices.length,
    contact_count: contacts.length,
    oldest_days: oldest,
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo', 'trustee'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as { as_at?: unknown } | null
  let asAt = new Date().toISOString().slice(0, 10)
  if (body?.as_at !== undefined && body.as_at !== null) {
    if (typeof body.as_at !== 'string' || !ISO_DATE.test(body.as_at)) {
      return errorResponse('as_at must be YYYY-MM-DD')
    }
    asAt = body.as_at
  }

  const receivables: AgedInvoice[] = []
  const payables: AgedInvoice[] = []

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await xeroFetch<{ Invoices?: XeroInvoice[] }>('Invoices', {
        params: {
          // Outstanding only. AUTHORISED covers approved-and-unpaid; a paid
          // invoice has AmountDue 0 and drops out of the filter anyway.
          where: 'AmountDue > 0',
          Statuses: 'AUTHORISED',
          summaryOnly: 'true',
          page: String(page),
          order: 'DueDate ASC',
        },
      })
      const batch = data?.Invoices ?? []
      for (const inv of batch) {
        const amountDue = typeof inv.AmountDue === 'number' ? round2(inv.AmountDue) : 0
        if (amountDue <= 0) continue
        const type = inv.Type
        if (type !== 'ACCREC' && type !== 'ACCPAY') continue
        const dueDate = xeroDate(inv.DueDate)
        const daysOverdue = dueDate ? Math.max(0, daysBetween(dueDate, asAt)) : 0
        const row: AgedInvoice = {
          invoice_id: inv.InvoiceID ?? '',
          number: inv.InvoiceNumber?.trim() || null,
          reference: inv.Reference?.trim() || null,
          contact: inv.Contact?.Name?.trim() || 'Unnamed contact',
          date: xeroDate(inv.Date),
          due_date: dueDate,
          amount_due: amountDue,
          days_overdue: daysOverdue,
          bucket: dueDate ? bucketFor(daysBetween(dueDate, asAt)) : 'current',
        }
        if (type === 'ACCREC') receivables.push(row)
        else payables.push(row)
      }
      if (batch.length < PAGE_SIZE) break
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Xero could not be reached'
    if (/\b403\b|forbidden|scope/i.test(message)) {
      return errorResponse(
        'Xero refused the invoice read. The custom connection needs the accounting.transactions.read scope — add it in the Xero developer portal, then reconnect.',
        502,
      )
    }
    console.error('[xero-aged]', message)
    return errorResponse(`Aged debtors and creditors could not be read from Xero: ${message}`, 502)
  }

  return json({
    as_at: asAt,
    buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    receivables: summarise(receivables),
    payables: summarise(payables),
  })
})
