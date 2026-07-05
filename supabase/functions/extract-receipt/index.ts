/**
 * extract-receipt — Claude vision extraction for a single receipt.
 *
 * JWT-verified; any ACTIVE authenticated user. Body { storage_path } within
 * the 'receipts' bucket. Defence in depth on top of storage RLS: unless the
 * caller is a pulse_* role, the path must start with `<caller.userId>/`.
 *
 * Returns { extraction: AiExtraction, confidence: number } where confidence
 * is the model's self-assessment clamped to 0..1. If net + vat does not equal
 * gross within £0.02, vat is recomputed as gross − net and confidence is
 * capped at 0.7 so the frontend highlights the line for review.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, serviceClient } from '../_shared/auth.ts'
import {
  callClaudeVision,
  bytesToBase64,
  resolveMediaType,
  extractJson,
  clampConfidence,
} from '../_shared/ai.ts'

const CATEGORIES = [
  'Travel',
  'Subsistence',
  'Venue hire',
  'Office & admin',
  'Postage & printing',
  'IT & subscriptions',
  'Safeguarding & training',
  'Other',
] as const

interface RawExtraction {
  date?: unknown
  merchant?: unknown
  description?: unknown
  net?: unknown
  vat?: unknown
  gross?: unknown
  suggested_category?: unknown
  currency?: unknown
  confidence?: unknown
}

interface Extraction {
  date?: string
  merchant?: string
  description?: string
  net?: number
  vat?: number
  gross?: number
  suggested_category?: string
  currency?: string
}

const SYSTEM = `You read photographed or scanned purchase receipts for a UK charity's expense system.
Respond with ONLY a JSON object matching this schema exactly — no markdown, no commentary:
{
  "date": "YYYY-MM-DD or null if unreadable",
  "merchant": "trading name of the merchant, or null",
  "description": "short plain-English description of what was bought, or null",
  "net": number or null,
  "vat": number or null,
  "gross": number or null,
  "suggested_category": one of ${JSON.stringify(CATEGORIES)},
  "currency": "ISO 4217 code, e.g. GBP",
  "confidence": number between 0 and 1 — your honest overall confidence in the extraction
}
Rules:
- Amounts are plain numbers with up to 2 decimal places (no currency symbols).
- gross is the total paid. If no VAT is itemised, set vat to 0 and net equal to gross.
- Never invent values: use null for anything you cannot read.
- Reduce confidence for blurry images, handwriting, or partially visible totals.`

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? round2(n) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asIsoDate(value: unknown): string | undefined {
  const s = asString(value)
  if (!s) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return undefined
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? undefined : `${m[1]}-${m[2]}-${m[3]}`
}

function isSafeStoragePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 1024 &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\\')
  )
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405)

  const caller = await getCaller(req)
  if (!caller) return errorResponse('Not authorised', 403)

  const body = (await req.json().catch(() => null)) as { storage_path?: unknown } | null
  const storagePath = body?.storage_path
  if (typeof storagePath !== 'string' || !isSafeStoragePath(storagePath)) {
    return errorResponse('storage_path is required')
  }

  // Defence in depth on top of storage RLS: submitters may only read their
  // own folder. Pulse roles may process any receipt during review.
  const isPulse = caller.role.startsWith('pulse_')
  if (!isPulse && !storagePath.startsWith(`${caller.userId}/`)) {
    return errorResponse('Not authorised for this receipt', 403)
  }

  const svc = serviceClient()
  const { data: blob, error: downloadError } = await svc.storage
    .from('receipts')
    .download(storagePath)
  if (downloadError || !blob) {
    return errorResponse('Receipt file not found', 404)
  }

  const mediaType = resolveMediaType(storagePath, blob.type)
  if (!mediaType) {
    return errorResponse('Unsupported file type — upload a JPEG, PNG, WebP or PDF receipt')
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const text = await callClaudeVision(
      { data: bytesToBase64(bytes), media_type: mediaType },
      'Extract this receipt. Respond with only the JSON object.',
      { system: SYSTEM, maxTokens: 1500 },
    )

    const raw = extractJson<RawExtraction>(text)
    let confidence = clampConfidence(raw.confidence)

    const extraction: Extraction = {
      date: asIsoDate(raw.date),
      merchant: asString(raw.merchant),
      description: asString(raw.description),
      net: asNumber(raw.net),
      vat: asNumber(raw.vat),
      gross: asNumber(raw.gross),
      suggested_category: (CATEGORIES as readonly string[]).includes(String(raw.suggested_category))
        ? String(raw.suggested_category)
        : 'Other',
      currency: asString(raw.currency)?.toUpperCase() ?? 'GBP',
    }

    // Arithmetic sense check: net + vat must equal gross within 2p.
    if (
      extraction.net !== undefined &&
      extraction.vat !== undefined &&
      extraction.gross !== undefined &&
      Math.abs(extraction.net + extraction.vat - extraction.gross) > 0.02
    ) {
      extraction.vat = round2(extraction.gross - extraction.net)
      confidence = Math.min(confidence, 0.7)
    }

    return json({ extraction, confidence })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Receipt extraction failed'
    console.error('[extract-receipt]', message)
    return errorResponse(message, 502)
  }
})
