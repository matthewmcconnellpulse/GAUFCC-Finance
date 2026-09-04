/**
 * expense-reminders — nudge claimants to put their expenses on the system
 * (JWT-verified; pulse_admin or ceo).
 *
 * Recipients are the people who plausibly have expenses: every active
 * 'submitter', plus anyone active of any role who has raised a claim in the
 * last six months. Someone who has already submitted a claim for the target
 * period (status beyond draft) is skipped; someone sitting on a draft is
 * reminded to finish it rather than asked to start one.
 *
 * Emails go out through Resend (RESEND_API_KEY secret) from the same domain
 * that carries the auth emails, so nothing here depends on Supabase's
 * built-in mailer. A missing key fails with a clear message instead of
 * pretending to send.
 *
 * Body { period?, dry_run? } ('YYYY-MM', defaults to the current month).
 * With dry_run the recipients are worked out and the Resend key is checked
 * against Resend itself (a read-only /domains call), but nothing is sent —
 * so the setup can be proved, and the list seen, before anyone is emailed.
 * Returns { ok: true, sent, skipped } or, for a dry run,
 * { ok: true, dry_run: true, would_send, skipped, recipients, email_ready }.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://gaufcc-finance.com'
const FROM = 'General Assembly Finance <no-reply@gaufcc-finance.com>'

function currentPeriod(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

function formatDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

/** Same rolling logic as the frontend banner: past this month's approval day, the cycle moves on a month. */
function deadlines(approvalDay: number, paymentDay: number): { approve: Date; pay: Date } {
  const today = new Date()
  const dayInMonth = (y: number, mIdx: number, d: number) =>
    new Date(y, mIdx, Math.min(d, new Date(y, mIdx + 1, 0).getDate()))
  let approve = dayInMonth(today.getFullYear(), today.getMonth(), approvalDay)
  if (today.getTime() > approve.getTime()) {
    approve = dayInMonth(today.getFullYear(), today.getMonth() + 1, approvalDay)
  }
  let pay = dayInMonth(approve.getFullYear(), approve.getMonth(), paymentDay)
  if (pay.getTime() < approve.getTime()) {
    pay = dayInMonth(approve.getFullYear(), approve.getMonth() + 1, paymentDay)
  }
  return { approve, pay }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'ceo'])) {
    return errorResponse('Not authorised', 403)
  }

  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) {
    return errorResponse(
      'Email sending is not configured yet — add the RESEND_API_KEY secret to the Supabase project (Edge Functions → Secrets).',
      500,
    )
  }

  const body = (await req.json().catch(() => null)) as
    | { period?: unknown; dry_run?: unknown }
    | null
  const dryRun = body?.dry_run === true
  const period =
    typeof body?.period === 'string' && /^\d{4}-\d{2}$/.test(body.period)
      ? body.period
      : currentPeriod()

  const svc = serviceClient()

  const { data: profiles, error: profilesError } = await svc
    .from('profiles')
    .select('id, email, full_name, role')
    .eq('active', true)
  if (profilesError) return errorResponse(profilesError.message, 500)

  // claims from the last six months tell us who claims at all, and who has
  // already dealt with the target period
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
  const { data: claims, error: claimsError } = await svc
    .from('expense_claims')
    .select('submitter_id, period, status')
    .gte('created_at', sixMonthsAgo.toISOString())
  if (claimsError) return errorResponse(claimsError.message, 500)

  const recentClaimants = new Set((claims ?? []).map((c) => c.submitter_id as string))
  const periodStatus = new Map<string, 'draft' | 'submitted'>()
  for (const c of claims ?? []) {
    if (c.period !== period) continue
    const prev = periodStatus.get(c.submitter_id as string)
    const next = c.status === 'draft' ? 'draft' : 'submitted'
    if (prev !== 'submitted') periodStatus.set(c.submitter_id as string, next)
  }

  const candidates = (profiles ?? []).filter(
    (p) => p.email && (p.role === 'submitter' || recentClaimants.has(p.id as string)),
  )
  const recipients = candidates.filter((p) => periodStatus.get(p.id as string) !== 'submitted')
  const skipped = candidates.length - recipients.length

  if (dryRun) {
    // Prove the key is actually accepted by Resend, and that the sending
    // domain is verified — a present-but-wrong key would otherwise only
    // surface when someone pressed send for real.
    let emailReady = false
    let emailDetail = ''
    try {
      const res = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        emailDetail =
          res.status === 401 || res.status === 403
            ? 'Resend rejected the API key — check RESEND_API_KEY in Edge Functions → Secrets.'
            : `Resend returned ${res.status}.`
      } else {
        const payload = (await res.json().catch(() => null)) as
          | { data?: Array<{ name?: string; status?: string }> }
          | null
        const domains = payload?.data ?? []
        const sending = FROM.match(/@([^>\s]+)/)?.[1] ?? ''
        const match = domains.find((d) => d.name === sending)
        if (!match) {
          emailDetail = `The key works, but ${sending} is not set up in this Resend account${
            domains.length > 0 ? ` (it has: ${domains.map((d) => d.name).join(', ')})` : ''
          }.`
        } else if (match.status !== 'verified') {
          emailDetail = `${sending} is in Resend but its status is "${match.status}" — it must be verified before mail will send.`
        } else {
          emailReady = true
          emailDetail = `Ready — the key works and ${sending} is verified.`
        }
      }
    } catch (e) {
      emailDetail = `Resend could not be reached: ${e instanceof Error ? e.message : 'unknown error'}`
    }

    return json({
      ok: true,
      dry_run: true,
      period,
      would_send: recipients.length,
      skipped,
      email_ready: emailReady,
      email_detail: emailDetail,
      recipients: recipients.map((p) => ({
        name: p.full_name,
        email: p.email,
        has_draft: periodStatus.get(p.id as string) === 'draft',
      })),
    })
  }

  if (recipients.length === 0) {
    return json({ ok: true, sent: 0, skipped })
  }

  const { data: settings } = await svc
    .from('settings')
    .select('key, value')
    .in('key', ['expense_approval_day', 'payment_run_day'])
  const day = (key: string, fallback: number) => {
    const raw = (settings ?? []).find((s) => s.key === key)?.value
    const n = Number.parseInt(String(typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).value ?? raw : raw), 10)
    return Number.isFinite(n) && n >= 1 && n <= 31 ? n : fallback
  }
  const { approve, pay } = deadlines(day('expense_approval_day', 10), day('payment_run_day', 17))

  const monthLabel = formatPeriod(period)
  const emails = recipients.map((p) => {
    const hasDraft = periodStatus.get(p.id as string) === 'draft'
    const firstName = String(p.full_name ?? '').split(' ')[0] || 'there'
    const lead = hasDraft
      ? `You have an unfinished draft claim for ${monthLabel} — don't forget to submit it.`
      : `If you have any expenses for ${monthLabel}, please pop them on the system when you get a moment.`
    return {
      from: FROM,
      to: [p.email as string],
      subject: hasDraft
        ? `Your ${monthLabel} expense claim is still a draft`
        : `Any expenses for ${monthLabel}?`,
      html:
        `<p>Hi ${firstName},</p>` +
        `<p>${lead}</p>` +
        `<p>Claims submitted by <b>${formatDay(approve)}</b> are paid in the <b>${formatDay(pay)}</b> payment run — later ones roll to the next run automatically.</p>` +
        `<p><a href="${SITE_URL}/expenses">Add your expenses</a> — photograph the receipts and the details are read for you.</p>` +
        `<p>General Assembly Finance</p>`,
      text:
        `Hi ${firstName},\n\n${lead}\n\n` +
        `Claims submitted by ${formatDay(approve)} are paid in the ${formatDay(pay)} payment run — later ones roll to the next run automatically.\n\n` +
        `Add your expenses: ${SITE_URL}/expenses\n\nGeneral Assembly Finance`,
    }
  })

  // Resend's batch endpoint takes up to 100 messages per call
  let sent = 0
  for (let i = 0; i < emails.length; i += 100) {
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(emails.slice(i, i + 100)),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return errorResponse(`Resend rejected the send (${res.status}): ${detail.slice(0, 300)}`, 502)
    }
    sent += emails.slice(i, i + 100).length
  }

  await auditLog(svc, {
    actor_id: caller!.userId,
    action: 'expense_reminders_sent',
    entity: 'expense_claims',
    entity_id: period,
    after: { period, sent, skipped, recipients: recipients.map((p) => p.email) },
  })

  return json({ ok: true, sent, skipped })
})
