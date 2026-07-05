/**
 * generate-pack — store a rendered board pack and register it as a draft.
 *
 * JWT-verified; roles pulse_*, ceo. Body { title, period_start, period_end,
 * scope, scope_fund_ids?, html, commentary? }.
 *
 * Versioning: 1 + count of existing board_packs sharing the same title and
 * period. The HTML is stored in the 'packs' bucket at
 * packs/<yyyy-mm>/<slug>-v<version>.html (contentType text/html) and a
 * board_packs row is inserted with status 'draft'. Audit-logged.
 *
 * Returns { pack_id, storage_path }.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole, serviceClient } from '../_shared/auth.ts'
import { auditLog } from '../_shared/audit.ts'

const SCOPES = ['whole_charity', 'fund_group', 'single_fund'] as const
const MAX_HTML_BYTES = 10 * 1024 * 1024 // 10 MB

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'board-pack'
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!callerHasRole(caller, ['pulse_admin', 'pulse_bookkeeper', 'pulse_payroll', 'ceo'])) {
    return errorResponse('Not authorised', 403)
  }

  const body = (await req.json().catch(() => null)) as
    | {
        title?: unknown
        period_start?: unknown
        period_end?: unknown
        scope?: unknown
        scope_fund_ids?: unknown
        html?: unknown
        commentary?: unknown
      }
    | null

  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (!title || title.length > 200) return errorResponse('title is required')
  if (!isIsoDate(body?.period_start)) return errorResponse('period_start must be YYYY-MM-DD')
  if (!isIsoDate(body?.period_end)) return errorResponse('period_end must be YYYY-MM-DD')
  const periodStart = body.period_start as string
  const periodEnd = body.period_end as string
  if (periodEnd < periodStart) return errorResponse('period_end must not be before period_start')

  const scope = body?.scope
  if (typeof scope !== 'string' || !(SCOPES as readonly string[]).includes(scope)) {
    return errorResponse("scope must be 'whole_charity', 'fund_group' or 'single_fund'")
  }

  let scopeFundIds: string[] | null = null
  if (body?.scope_fund_ids !== undefined && body?.scope_fund_ids !== null) {
    if (
      !Array.isArray(body.scope_fund_ids) ||
      !body.scope_fund_ids.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      return errorResponse('scope_fund_ids must be an array of fund ids')
    }
    scopeFundIds = body.scope_fund_ids as string[]
  }
  if (scope !== 'whole_charity' && (!scopeFundIds || scopeFundIds.length === 0)) {
    return errorResponse('scope_fund_ids is required for fund_group and single_fund packs')
  }

  const html = typeof body?.html === 'string' ? body.html : ''
  if (!html.trim()) return errorResponse('html is required')
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    return errorResponse('The pack HTML is too large (over 10 MB)')
  }

  const commentary =
    typeof body?.commentary === 'object' && body?.commentary !== null ? body.commentary : null

  const svc = serviceClient()

  // Version = 1 + count of packs with the same title + period.
  const { count, error: countError } = await svc
    .from('board_packs')
    .select('id', { count: 'exact', head: true })
    .eq('title', title)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
  if (countError) {
    return errorResponse(`Could not check existing pack versions: ${countError.message}`, 500)
  }
  const version = 1 + (count ?? 0)

  const yyyyMm = periodEnd.slice(0, 7)
  const storagePath = `packs/${yyyyMm}/${slugify(title)}-v${version}.html`

  const { error: uploadError } = await svc.storage
    .from('packs')
    .upload(storagePath, new Blob([html], { type: 'text/html' }), {
      contentType: 'text/html',
      upsert: true,
    })
  if (uploadError) {
    return errorResponse(`Could not store the pack: ${uploadError.message}`, 500)
  }

  const { data: pack, error: insertError } = await svc
    .from('board_packs')
    .insert({
      title,
      period_start: periodStart,
      period_end: periodEnd,
      scope,
      scope_fund_ids: scopeFundIds,
      storage_path: storagePath,
      status: 'draft',
      version,
      commentary,
      created_by: caller.userId,
    })
    .select('id')
    .single()
  if (insertError || !pack) {
    return errorResponse(
      `The pack was stored but could not be registered: ${insertError?.message ?? 'unknown error'}`,
      500,
    )
  }
  const packId = (pack as { id: string }).id

  await auditLog(svc, {
    actor_id: caller.userId,
    action: 'pack_generated',
    entity: 'board_packs',
    entity_id: packId,
    after: { title, period_start: periodStart, period_end: periodEnd, scope, version, storage_path: storagePath },
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  return json({ pack_id: packId, storage_path: storagePath })
})
