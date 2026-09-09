/**
 * Pack commentary, written by the accountant preparing the pack.
 *
 * Deliberately not AI-drafted. Commentary on the figures is the reviewer's
 * professional judgement — it is what Pulse is signing its name to in front
 * of trustees — so it is typed by the person who has looked at the ledger,
 * not generated and then checked. The figures themselves are computed from
 * the mirror; this is the narrative around them.
 */
import { Textarea } from '@/components/ui'
import type { CommentaryState } from './PackDocument'

export function CommentaryEditor({
  label,
  hint,
  state,
  onChange,
}: {
  label: string
  hint?: string
  state: CommentaryState
  onChange: (next: CommentaryState) => void
}) {
  return (
    <div className="border border-stone-150 rounded-card bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-medium uppercase tracking-[.12em] text-stone-500">{label}</span>
      </div>
      {hint ? <p className="text-[11px] text-stone-500 mb-2">{hint}</p> : null}
      <Textarea
        value={state.text}
        placeholder="Write the commentary for this section…"
        onChange={(e) => onChange({ text: e.target.value, source: 'human' })}
        className="min-h-28 text-[13px] leading-relaxed"
      />
    </div>
  )
}
