/**
 * Fund notes — separate, editable entries (newest first), each optionally
 * flagged "for the attention of" a named user. Pulse + CEO write; a note is
 * editable by its author (Pulse admin can moderate). Trustees read the notes
 * on their funds but cannot see the user directory, so names degrade to "—".
 */
import { useState } from 'react'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  SectionLabel,
  Select,
  Textarea,
} from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import {
  addFundNote,
  deleteFundNote,
  fetchAssignableProfiles,
  fetchFundNotes,
  updateFundNote,
  type FundNoteRow,
} from './lib'

export default function FundNotesCard({ fundId }: { fundId: string }) {
  const { profile } = useAuth()
  const { isPulse, isCeo, isAdmin } = usePermissions()
  const canWrite = isPulse || isCeo

  const notes = useSupabaseQuery(() => fetchFundNotes(fundId), [fundId])
  const people = useSupabaseQuery(
    () => (canWrite ? fetchAssignableProfiles() : Promise.resolve([])),
    [canWrite],
  )

  const [draft, setDraft] = useState('')
  const [draftFao, setDraftFao] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    if (!profile || draft.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await addFundNote(fundId, profile.id, draft.trim(), draftFao || null)
      setDraft('')
      setDraftFao('')
      notes.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The note could not be saved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="px-5 py-4">
        <SectionLabel>Notes</SectionLabel>

        {canWrite ? (
          <div className="mb-4">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Background, restrictions, correspondence — visible to everyone who can see this fund"
              className="min-h-20"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
              <label className="flex items-center gap-2 text-[11.5px] text-stone-600">
                For the attention of
                <Select
                  value={draftFao}
                  onChange={(e) => setDraftFao(e.target.value)}
                  className="!w-auto py-1.5 text-[12px]"
                >
                  <option value="">No one in particular</option>
                  {(people.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                    </option>
                  ))}
                </Select>
              </label>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || draft.trim() === ''}
                onClick={() => void add()}
              >
                {busy ? 'Saving…' : 'Add note'}
              </Button>
            </div>
            {error ? (
              <div className="mt-2">
                <ErrorNotice message={error} />
              </div>
            ) : null}
          </div>
        ) : null}

        {notes.loading ? (
          <LoadingRows cols={1} rows={3} />
        ) : notes.error ? (
          <ErrorNotice message={`Notes could not be loaded — ${notes.error}`} />
        ) : (notes.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No notes yet"
            hint={canWrite ? 'Anything worth remembering about this fund lives here.' : 'Pulse and the CEO can add notes.'}
          />
        ) : (
          <ul className="space-y-3">
            {(notes.data ?? []).map((note) => (
              <NoteItem
                key={note.id}
                note={note}
                canEdit={note.created_by === profile?.id || isAdmin}
                people={people.data ?? []}
                onChanged={notes.refetch}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function NoteItem({
  note,
  canEdit,
  people,
  onChanged,
}: {
  note: FundNoteRow
  canEdit: boolean
  people: Array<{ id: string; full_name: string }>
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(note.body)
  const [fao, setFao] = useState(note.attention_of ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const edited = note.updated_at !== note.created_at

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await updateFundNote(note.id, { body: body.trim(), attention_of: fao || null })
      setEditing(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The note could not be updated')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('Delete this note? This cannot be undone.')) return
    setBusy(true)
    try {
      await deleteFundNote(note.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The note could not be deleted')
      setBusy(false)
    }
  }

  return (
    <li className="rounded-card border border-stone-150 bg-paper px-4 py-3">
      {note.attention_of ? (
        <span className="inline-flex items-center font-medium text-[10px] uppercase tracking-[.08em] px-2 py-0.5 rounded-full bg-indigo/10 text-indigo mb-2">
          FAO {note.fao?.full_name ?? '—'}
        </span>
      ) : null}

      {editing ? (
        <>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-20" />
          <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
            <label className="flex items-center gap-2 text-[11.5px] text-stone-600">
              For the attention of
              <Select
                value={fao}
                onChange={(e) => setFao(e.target.value)}
                className="!w-auto py-1.5 text-[12px]"
              >
                <option value="">No one in particular</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditing(false)
                  setBody(note.body)
                  setFao(note.attention_of ?? '')
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || body.trim() === ''}
                onClick={() => void save()}
              >
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <p className="text-[12.5px] text-stone-800 whitespace-pre-wrap leading-relaxed">{note.body}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
        <span className="text-[10.5px] text-stone-500">
          {note.author?.full_name ?? '—'} · {formatDateTime(note.created_at)}
          {edited ? ' · edited' : ''}
        </span>
        {canEdit && !editing ? (
          <span className="flex gap-3">
            <button
              type="button"
              className="text-[11px] text-indigo underline underline-offset-2"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="text-[11px] text-stone-500 underline underline-offset-2 hover:text-danger-ink"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete
            </button>
          </span>
        ) : null}
      </div>
      {error ? (
        <div className="mt-2">
          <ErrorNotice message={error} />
        </div>
      ) : null}
    </li>
  )
}
