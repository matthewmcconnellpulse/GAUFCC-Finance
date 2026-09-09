/**
 * Per-fund note for a board pack.
 *
 * Written by the accountant preparing the pack. AI is available only to
 * *polish* what has already been typed — never to draft a note from the
 * figures alone. That is the line the client drew: commentary on the numbers
 * is Pulse's professional judgement, so the substance always originates with
 * the person who looked at the ledger, and AI is a copy editor at most.
 *
 * The polished text lands straight back in the textarea for the preparer to
 * accept, edit or undo before it reaches the pack.
 */
import { useState } from 'react'
import { Button, ErrorNotice, FundTypeChip, Textarea } from '@/components/ui'
import { invokeFunction } from '@/lib/supabase'
import { formatMoney } from '@/lib/format'
import type { CommentaryState } from './PackDocument'
import type { ReportFundRow } from './lib'

export function FundNoteEditor({
  fund,
  state,
  onChange,
  context,
}: {
  fund: ReportFundRow
  state: CommentaryState
  onChange: (next: CommentaryState) => void
  /** Figures for this fund, sent with the notes so AI cannot contradict them. */
  context: Record<string, unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previous, setPrevious] = useState<string | null>(null)

  const typed = state.text.trim()

  async function polish() {
    if (!typed) return
    setBusy(true)
    setError(null)
    try {
      const res = await invokeFunction<{ commentary: string }>('ai-commentary', {
        mode: 'enhance',
        section: `fund_note:${fund.name}`,
        notes: state.text,
        context,
      })
      const text = (res.commentary ?? '').trim()
      if (!text) throw new Error('The polish came back empty — leave the note as typed')
      setPrevious(state.text)
      onChange({ text, source: 'ai_edited' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The note could not be polished')
    } finally {
      setBusy(false)
    }
  }

  function undo() {
    if (previous === null) return
    onChange({ text: previous, source: 'human' })
    setPrevious(null)
  }

  return (
    <div className="border border-stone-150 rounded-card bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{fund.name}</span>
          <FundTypeChip type={fund.fund_type} />
        </div>
        <span className="text-[11px] text-stone-500 tabular-nums">
          {formatMoney(fund.opening)} → {formatMoney(fund.closing)}
        </span>
      </div>
      <Textarea
        value={state.text}
        placeholder="What the trustees should know about this fund this period…"
        onChange={(e) => onChange({ text: e.target.value, source: 'human' })}
        className="min-h-24 text-[13px] leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <Button variant="ghost" size="sm" disabled={busy || !typed} onClick={() => void polish()}>
          {busy ? 'Polishing…' : 'Polish with AI'}
        </Button>
        {previous !== null ? (
          <Button variant="ghost" size="sm" onClick={undo}>
            Undo polish
          </Button>
        ) : null}
        <span className="text-[11px] text-stone-500">
          {!typed
            ? 'Type the note first — AI only rewords your own words, it never drafts from the figures.'
            : state.source === 'ai_edited'
              ? 'AI-polished. Read it back before you issue the pack.'
              : 'Optional. Funds with no note simply omit it.'}
        </span>
      </div>
      {error ? (
        <div className="mt-2">
          <ErrorNotice message={error} />
        </div>
      ) : null}
    </div>
  )
}
