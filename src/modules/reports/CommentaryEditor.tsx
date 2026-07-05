/**
 * AI commentary per pack section. Two modes against the ai-commentary edge
 * function: 'generate' (draft from the section's computed data) and 'enhance'
 * (polish the author's rough notes). The result lands in an editable textarea
 * and carries the AiBadge until a human edits or explicitly accepts it —
 * nothing ships unreviewed.
 */
import { useState } from 'react'
import { AiBadge, Button, ErrorNotice, StatusChip, Textarea } from '@/components/ui'
import { invokeFunction } from '@/lib/supabase'
import type { CommentaryState } from './PackDocument'

interface AiCommentaryResponse {
  commentary: string
}

export function CommentaryEditor({
  label,
  hint,
  section,
  context,
  state,
  onChange,
  canUseAi,
}: {
  label: string
  hint?: string
  section: string
  /** the section's already-computed data, sent as context for generation */
  context: Record<string, unknown>
  state: CommentaryState
  onChange: (next: CommentaryState) => void
  canUseAi: boolean
}) {
  const [busy, setBusy] = useState<'generate' | 'enhance' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (mode: 'generate' | 'enhance') => {
    setBusy(mode)
    setError(null)
    try {
      const res = await invokeFunction<AiCommentaryResponse>('ai-commentary', {
        mode,
        section,
        context,
        ...(mode === 'enhance' ? { notes: state.text } : {}),
      })
      onChange({ text: res.commentary ?? '', source: 'ai' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Commentary could not be drafted')
    } finally {
      setBusy(null)
    }
  }

  const isAiDraft = state.source === 'ai' && state.text.length > 0

  return (
    <div className="border border-stone-150 rounded-card bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[.12em] text-stone-500">{label}</span>
          {isAiDraft ? <AiBadge /> : null}
          {state.source === 'ai_edited' && state.text ? (
            <StatusChip tone="neutral">AI-assisted · reviewed</StatusChip>
          ) : null}
        </div>
        {canUseAi ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('generate')}>
              {busy === 'generate' ? 'Drafting…' : 'Draft with AI'}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              disabled={busy !== null || state.text.trim().length === 0}
              onClick={() => void run('enhance')}
              title="Polish your rough notes into board-ready commentary"
            >
              {busy === 'enhance' ? 'Enhancing…' : 'Enhance my notes'}
            </Button>
          </div>
        ) : null}
      </div>
      {hint ? <p className="text-[11px] text-stone-500 mb-2">{hint}</p> : null}
      {error ? (
        <div className="mb-2">
          <ErrorNotice message={error} />
        </div>
      ) : null}
      <Textarea
        value={state.text}
        placeholder="Write commentary here, or draft it with AI and edit before it ships…"
        onChange={(e) =>
          onChange({
            text: e.target.value,
            // Any human keystroke on an AI draft counts as review
            source: state.source === 'human' ? 'human' : 'ai_edited',
          })
        }
        className="min-h-28 text-[13px] leading-relaxed"
      />
      {isAiDraft ? (
        <div className="flex items-center justify-between gap-2 mt-2">
          <p className="text-[11px] text-warn-ink">
            AI draft — review it before this pack is saved or issued. Editing the text marks it reviewed.
          </p>
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...state, source: 'ai_edited' })}>
            Accept as reviewed
          </Button>
        </div>
      ) : null}
    </div>
  )
}
