/**
 * Shared Anthropic client for edge functions — raw fetch, no SDK.
 *
 * Model: claude-sonnet-5. Note that Sonnet 5 rejects non-default sampling
 * parameters (temperature/top_p/top_k return a 400), so determinism is asked
 * for in the prompt rather than via temperature. Thinking is explicitly
 * disabled so the whole max_tokens budget goes to output — these are
 * extraction and copywriting calls, not open-ended reasoning.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-5'

export const SUPPORTED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

export type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number]

export function isSupportedMediaType(value: string): value is SupportedMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(value)
}

// ── Message shapes (subset of the Messages API we use) ──────────────────────

export interface AiTextBlock {
  type: 'text'
  text: string
}

export interface AiImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export interface AiDocumentBlock {
  type: 'document'
  source: { type: 'base64'; media_type: 'application/pdf'; data: string }
}

export type AiContentBlock = AiTextBlock | AiImageBlock | AiDocumentBlock

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string | AiContentBlock[]
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[]
  stop_reason?: string
  stop_details?: { category?: string | null } | null
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string }
}

// ── Core call ────────────────────────────────────────────────────────────────

export async function callClaude(opts: {
  system?: string
  messages: AiMessage[]
  maxTokens?: number
}): Promise<string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not configured — add it under Supabase → Edge Functions → Secrets',
    )
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      thinking: { type: 'disabled' },
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages,
    }),
  })

  if (!res.ok) {
    let message = `Anthropic API error (HTTP ${res.status})`
    try {
      const body = (await res.json()) as AnthropicErrorBody
      if (body.error?.message) message = `Anthropic API error: ${body.error.message}`
    } catch {
      // keep the generic message — never leak a stack trace
    }
    throw new Error(message)
  }

  const data = (await res.json()) as AnthropicResponse

  if (data.stop_reason === 'refusal') {
    throw new Error('The AI model declined this request')
  }

  const text = (data.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')

  if (data.stop_reason === 'max_tokens') {
    throw new Error('The AI response was cut off — the document may be too large to process in one go')
  }
  if (!text.trim()) {
    throw new Error('The AI model returned an empty response')
  }
  return text
}

/**
 * Vision/document call: one image or PDF plus an instruction prompt.
 * Supports image/jpeg, image/png, image/webp and application/pdf.
 */
export async function callClaudeVision(
  imageOrPdf: { data: string; media_type: string },
  prompt: string,
  opts?: { system?: string; maxTokens?: number },
): Promise<string> {
  if (!isSupportedMediaType(imageOrPdf.media_type)) {
    throw new Error(
      `Unsupported file type ${imageOrPdf.media_type} — use JPEG, PNG, WebP or PDF`,
    )
  }

  const fileBlock: AiContentBlock =
    imageOrPdf.media_type === 'application/pdf'
      ? {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: imageOrPdf.data },
        }
      : {
          type: 'image',
          source: { type: 'base64', media_type: imageOrPdf.media_type, data: imageOrPdf.data },
        }

  return callClaude({
    system: opts?.system,
    maxTokens: opts?.maxTokens,
    messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: prompt }] }],
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Chunked base64 encoder — safe for multi-megabyte receipts/statements. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** Map a storage path / MIME hint to a supported media type, or null. */
export function resolveMediaType(path: string, blobType?: string | null): SupportedMediaType | null {
  if (blobType && isSupportedMediaType(blobType)) return blobType
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return null
}

/**
 * Parse JSON out of a model response robustly: strips markdown fences and
 * any prose around the outermost JSON object/array.
 */
export function extractJson<T>(text: string): T {
  let candidate = text.trim()

  // Strip ```json ... ``` fences (and bare ``` fences).
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(candidate)
  if (fenced) candidate = fenced[1].trim()

  try {
    return JSON.parse(candidate) as T
  } catch {
    // Fall through to substring extraction.
  }

  const firstBrace = candidate.indexOf('{')
  const firstBracket = candidate.indexOf('[')
  let start = -1
  let end = -1
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace
    end = candidate.lastIndexOf('}')
  } else if (firstBracket !== -1) {
    start = firstBracket
    end = candidate.lastIndexOf(']')
  }
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T
    } catch {
      // fall through
    }
  }
  throw new Error('The AI response could not be parsed as JSON')
}

/** Clamp a model-supplied confidence to 0..1 (defaults to 0.5 when absent). */
export function clampConfidence(value: unknown, fallback = 0.5): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}
