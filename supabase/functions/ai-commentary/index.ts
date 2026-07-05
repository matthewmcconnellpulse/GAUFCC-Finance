/**
 * ai-commentary — draft or polish board-pack commentary.
 *
 * JWT-verified; roles pulse_*, ceo. Body { mode, section, context, notes? }:
 * - mode 'generate' — plain-English narrative of movements, drivers and flags
 *   from the context JSON (fund balances, movements, warnings).
 * - mode 'enhance' — polish Pulse's rough notes into the same register,
 *   keeping every fact.
 *
 * Returns { commentary }. The frontend always shows it with the AiBadge and
 * it is editable before it is saved into a pack — nothing publishes without
 * human confirmation.
 */

import { handleOptions, json, errorResponse } from '../_shared/http.ts'
import { getCaller, callerHasRole } from '../_shared/auth.ts'
import { callClaude } from '../_shared/ai.ts'

const SYSTEM = `You write board-pack commentary for the General Assembly of Unitarian and Free Christian Churches, a 200-year-old UK charity, prepared by Pulse Accountants.

Register and rules:
- Calm, professional, plain-English prose suitable for charity trustees. No jargon, no hype, no exclamation marks.
- UK conventions throughout: pounds sterling written as £1,250 or £1.2m, dates as 12 May 2026, sentence case headings.
- 120 to 220 words, in 1–3 short paragraphs of flowing prose. No headings, no bullet points, no markdown.
- Describe what moved, what drove it, and anything trustees should note (deficits, warnings, unusual movements). Distinguish restricted from unrestricted funds where relevant.
- Never invent figures: use only numbers present in the material provided. If something is unclear, describe it qualitatively rather than guessing.
- Do not mention that you are an AI, and do not address the reader directly.
- Respond with the commentary text only — no preamble, no quotation marks around it.`

function stripWrapping(text: string): string {
  let out = text.trim()
  const fenced = /^```(?:\w+)?\s*([\s\S]*?)```$/.exec(out)
  if (fenced) out = fenced[1].trim()
  if (out.startsWith('"') && out.endsWith('"') && out.length > 2) {
    out = out.slice(1, -1).trim()
  }
  return out
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
    | { mode?: unknown; section?: unknown; context?: unknown; notes?: unknown }
    | null
  const mode = body?.mode
  if (mode !== 'generate' && mode !== 'enhance') {
    return errorResponse("mode must be 'generate' or 'enhance'")
  }
  const section = typeof body?.section === 'string' && body.section.trim() ? body.section.trim() : null
  if (!section) return errorResponse('section is required')
  if (typeof body?.context !== 'object' || body.context === null) {
    return errorResponse('context is required')
  }
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : ''
  if (mode === 'enhance' && !notes) {
    return errorResponse('notes are required in enhance mode')
  }

  let contextJson: string
  try {
    contextJson = JSON.stringify(body.context, null, 2)
  } catch {
    return errorResponse('context must be serialisable JSON')
  }
  if (contextJson.length > 200_000) {
    return errorResponse('context is too large — narrow the report scope and try again')
  }

  const prompt =
    mode === 'generate'
      ? `Write the commentary for the report section "${section}".

Figures and flags for this section (JSON):
${contextJson}

Write the board-ready commentary now.`
      : `Polish the bookkeeper's rough notes into board-ready commentary for the report section "${section}". Keep every fact and figure from the notes — reword and structure, never drop or change substance.

Rough notes:
${notes}

Supporting figures for this section (JSON), for consistency checks only:
${contextJson}

Write the board-ready commentary now.`

  try {
    const text = await callClaude({
      system: SYSTEM,
      maxTokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    })
    return json({ commentary: stripWrapping(text) })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Commentary generation failed'
    console.error('[ai-commentary]', message)
    return errorResponse(message, 502)
  }
})
