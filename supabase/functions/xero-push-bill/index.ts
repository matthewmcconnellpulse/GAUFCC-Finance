/**
 * xero-push-bill — push an approved expense claim to Xero as a DRAFT bill.
 *
 * JWT-verified; roles pulse_admin, pulse_bookkeeper. Human-triggered only —
 * approval never pushes autonomously; a Pulse user presses the button.
 *
 * Flow: load claim + lines + submitter profile → require status 'approved'
 * (idempotent: an already-pushed claim returns its existing xero_bill_id) →
 * find-or-create the submitter's Xero contact (search by email, then exact
 * name, else PUT Contacts) → PUT Invoices (Type ACCPAY, Status DRAFT,
 * LineAmountTypes Exclusive, line UnitAmount = net, TaxAmount = vat,
 * AccountCode = expense_lines.category, Tracking by fund →
 * funds.tracking_option_id → option/category name lookup) → store
 * xero_bill_id, set claim status 'pushed_to_xero', audit-log.
 *
 * Line amounts are sent POSITIVE (a bill's lines are naturally positive in
 * Xero); the sync engine's signed mirror convention applies only to the
 * read model and is handled when the bill syncs back down.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'
import { xeroFetch } from '../_shared/xero.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

interface ClaimRow {
  id: string
  submitter_id: string
  status: string
  period: string
  total: number
  xero_bill_id: string | null
}

interface LineRow {
  id: string
  date: string
  description: string
  category: string | null
  fund_id: string | null
  net: number
  vat: number
  gross: number
}

interface XeroContactApi {
  ContactID: string
  Name?: string
  ContactStatus?: string
}

interface XeroTrackingElement {
  Name: string
  Option: string
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Escape a value for a Xero `where` clause string literal. */
function xeroEscape(value: string): string {
  return value.replace(/[\\"]/g, (c) => `\\${c}`)
}

function pickContact(contacts: XeroContactApi[] | undefined): string | null {
  if (!contacts?.length) return null
  const active = contacts.find((c) => c.ContactStatus === 'ACTIVE')
  return (active ?? contacts[0]).ContactID
}

/** Search by email, then exact name; create the contact if neither matches. */
async function findOrCreateContact(fullName: string, email: string | null): Promise<string> {
  if (email) {
    const { data } = await xeroFetch<{ Contacts?: XeroContactApi[] }>('Contacts', {
      params: { where: `EmailAddress=="${xeroEscape(email)}"` },
    })
    const found = pickContact(data?.Contacts)
    if (found) return found
  }

  const { data: byName } = await xeroFetch<{ Contacts?: XeroContactApi[] }>('Contacts', {
    params: { where: `Name=="${xeroEscape(fullName)}"` },
  })
  const foundByName = pickContact(byName?.Contacts)
  if (foundByName) return foundByName

  const { data: created } = await xeroFetch<{ Contacts?: XeroContactApi[] }>('Contacts', {
    method: 'PUT',
    body: {
      Contacts: [
        {
          Name: fullName,
          ...(email ? { EmailAddress: email } : {}),
          IsSupplier: true,
        },
      ],
    },
  })
  const newId = created?.Contacts?.[0]?.ContactID
  if (!newId) throw new Error('Xero did not return a ContactID for the new contact')
  return newId
}

/**
 * Resolve each line's fund to a Xero tracking element via
 * funds.tracking_option_id → xero_tracking_options → xero_tracking_categories
 * (all joined on Xero natural keys). Funds without a tracking option map to
 * no tracking — the draft bill is still reviewable in Xero.
 */
async function buildTrackingByFund(
  svc: SupabaseClient,
  fundIds: string[],
): Promise<Map<string, XeroTrackingElement>> {
  const result = new Map<string, XeroTrackingElement>()
  if (!fundIds.length) return result

  const { data: funds, error: fundError } = await svc
    .from('funds')
    .select('id, name, tracking_option_id')
    .in('id', fundIds)
  if (fundError) throw new Error(`Could not read funds: ${fundError.message}`)
  const fundRows = (funds ?? []) as { id: string; name: string; tracking_option_id: string | null }[]

  const optionIds = fundRows
    .map((f) => f.tracking_option_id)
    .filter((id): id is string => Boolean(id))
  if (!optionIds.length) return result

  const { data: options, error: optionError } = await svc
    .from('xero_tracking_options')
    .select('tracking_option_id, tracking_category_id, name')
    .in('tracking_option_id', optionIds)
  if (optionError) throw new Error(`Could not read tracking options: ${optionError.message}`)
  const optionRows = (options ?? []) as {
    tracking_option_id: string
    tracking_category_id: string
    name: string
  }[]
  const optionByTrackingId = new Map(optionRows.map((o) => [o.tracking_option_id, o]))

  const categoryIds = [...new Set(optionRows.map((o) => o.tracking_category_id))]
  const { data: categories, error: categoryError } = await svc
    .from('xero_tracking_categories')
    .select('tracking_category_id, name')
    .in('tracking_category_id', categoryIds)
  if (categoryError) {
    throw new Error(`Could not read tracking categories: ${categoryError.message}`)
  }
  const categoryNameById = new Map(
    ((categories ?? []) as { tracking_category_id: string; name: string }[]).map((c) => [
      c.tracking_category_id,
      c.name,
    ]),
  )

  for (const fund of fundRows) {
    if (!fund.tracking_option_id) continue
    const option = optionByTrackingId.get(fund.tracking_option_id)
    if (!option) continue
    const categoryName = categoryNameById.get(option.tracking_category_id)
    if (!categoryName) continue
    result.set(fund.id, { Name: categoryName, Option: option.name })
  }
  return result
}

/** Next payment run date (settings key payment_run_day, default the 17th). */
async function nextPaymentRunDate(svc: SupabaseClient): Promise<string> {
  let day = 17
  const { data } = await svc
    .from('settings')
    .select('value')
    .eq('key', 'payment_run_day')
    .maybeSingle()
  const value = data?.value
  if (typeof value === 'number' && value >= 1 && value <= 28) day = value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    if (parsed >= 1 && parsed <= 28) day = parsed
  }
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day))
  const due =
    thisMonth >= today
      ? thisMonth
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day))
  return due.toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as { claim_id?: unknown } | null
  const claimId = body?.claim_id
  if (typeof claimId !== 'string' || !claimId) {
    return errorResponse('claim_id is required')
  }

  const svc = serviceClient()

  const { data: claimData, error: claimError } = await svc
    .from('expense_claims')
    .select('id, submitter_id, status, period, total, xero_bill_id')
    .eq('id', claimId)
    .maybeSingle()
  if (claimError) return errorResponse(`Could not load claim: ${claimError.message}`, 500)
  if (!claimData) return errorResponse('Claim not found', 404)
  const claim = claimData as ClaimRow

  // Idempotent: a claim already pushed returns its existing bill id.
  if (claim.status === 'pushed_to_xero' && claim.xero_bill_id) {
    return json({ xero_bill_id: claim.xero_bill_id })
  }
  if (claim.status !== 'approved') {
    return errorResponse(
      `Claim must be approved before it can be pushed to Xero (current status: ${claim.status})`,
    )
  }

  const { data: linesData, error: linesError } = await svc
    .from('expense_lines')
    .select('id, date, description, category, fund_id, net, vat, gross')
    .eq('claim_id', claim.id)
    .order('date', { ascending: true })
  if (linesError) return errorResponse(`Could not load claim lines: ${linesError.message}`, 500)
  const lines = (linesData ?? []) as LineRow[]
  if (!lines.length) return errorResponse('Claim has no lines to push')

  const uncoded = lines.filter((l) => !l.category)
  if (uncoded.length) {
    return errorResponse(
      `${uncoded.length} line${uncoded.length === 1 ? ' is' : 's are'} missing an account code — assign categories in the Pulse review before pushing`,
    )
  }

  const { data: profile, error: profileError } = await svc
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', claim.submitter_id)
    .maybeSingle()
  if (profileError) {
    return errorResponse(`Could not load submitter profile: ${profileError.message}`, 500)
  }
  if (!profile) return errorResponse('Submitter profile not found', 404)
  const submitter = profile as { id: string; full_name: string; email: string | null }

  try {
    const contactId = await findOrCreateContact(submitter.full_name, submitter.email)

    const fundIds = [...new Set(lines.map((l) => l.fund_id).filter((id): id is string => Boolean(id)))]
    const trackingByFund = await buildTrackingByFund(svc, fundIds)

    const today = new Date().toISOString().slice(0, 10)
    const dueDate = await nextPaymentRunDate(svc)

    const bill = {
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      Date: today,
      DueDate: dueDate,
      Status: 'DRAFT',
      LineAmountTypes: 'Exclusive',
      InvoiceNumber: `EXP-${claim.period}-${claim.id.slice(0, 8).toUpperCase()}`,
      LineItems: lines.map((line) => {
        const tracking = line.fund_id ? trackingByFund.get(line.fund_id) : undefined
        return {
          Description: line.description || 'Expense',
          Quantity: 1,
          UnitAmount: round2(line.net),
          TaxAmount: round2(line.vat),
          AccountCode: line.category as string,
          ...(tracking ? { Tracking: [tracking] } : {}),
        }
      }),
    }

    const { data: invoiceResponse } = await xeroFetch<{ Invoices?: { InvoiceID?: string }[] }>(
      'Invoices',
      { method: 'PUT', body: { Invoices: [bill] } },
    )
    const xeroBillId = invoiceResponse?.Invoices?.[0]?.InvoiceID
    if (!xeroBillId) throw new Error('Xero did not return an InvoiceID for the draft bill')

    const { error: updateError } = await svc
      .from('expense_claims')
      .update({ status: 'pushed_to_xero', xero_bill_id: xeroBillId })
      .eq('id', claim.id)
    if (updateError) {
      // The bill exists in Xero but the claim did not update — surface loudly.
      return errorResponse(
        `Draft bill ${xeroBillId} was created in Xero but the claim could not be updated: ${updateError.message}`,
        500,
      )
    }

    await auditLog(svc, {
      actor_id: caller.userId,
      action: 'xero_push_bill',
      entity: 'expense_claims',
      entity_id: claim.id,
      before: { status: claim.status, xero_bill_id: claim.xero_bill_id },
      after: { status: 'pushed_to_xero', xero_bill_id: xeroBillId },
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    })

    return json({ xero_bill_id: xeroBillId })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[xero-push-bill]', message)
    return errorResponse(message, 502)
  }
})
