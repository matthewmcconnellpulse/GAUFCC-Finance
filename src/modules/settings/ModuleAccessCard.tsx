/**
 * Settings → Users → access for one person.
 *
 * A module grant is additive and read-only: it opens a part of the system to
 * look at, and never widens what anyone may do there. Approving a claim,
 * editing a fund or pushing to Xero still needs the role that carries it, so
 * this can be handed out without anyone acquiring the ability to move money —
 * which is the whole reason it is safe to delegate at all.
 *
 * Fund-scoped modules stay fund-scoped: granting Funds shows the funds this
 * person is named responsible for, not all of them, so the way to widen
 * someone's view is to assign them another fund rather than to change access.
 */
import { useEffect, useState } from 'react'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import { Button, ErrorNotice, StatusChip, cx } from '@/components/ui'
import { MODULE_HINTS, MODULE_KEYS, MODULE_LABELS, type ModuleKey, type Profile } from '@/types/db'
import { saveProfileModules } from './lib'

/** Modules whose rows are limited to the funds the person is responsible for. */
const FUND_SCOPED: ReadonlySet<ModuleKey> = new Set(['funds', 'reports', 'expenses'])

export function ModuleAccessCard({
  person,
  granted,
  managedFundCount,
  onSaved,
}: {
  person: Profile
  granted: ModuleKey[]
  /** How many funds they are named responsible for — a fund-scoped grant
   *  shows nothing without at least one. */
  managedFundCount: number
  onSaved: () => void
}) {
  const { profile } = useAuth()
  const { isAdmin } = usePermissions()
  const [selected, setSelected] = useState<Set<ModuleKey>>(new Set(granted))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelected(new Set(granted))
    setSaved(false)
  }, [granted, person.id])

  const dirty =
    selected.size !== granted.length || granted.some((m) => !selected.has(m))

  const needsFunds = [...selected].some((m) => FUND_SCOPED.has(m)) && managedFundCount === 0

  async function save() {
    if (!profile) return
    setSaving(true)
    setError(null)
    try {
      await saveProfileModules(person.id, [...selected], profile.id)
      setSaved(true)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Access could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-stone-150 rounded-card bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <div>
          <span className="text-[12.5px] font-medium text-ink">Access to parts of the system</span>
          <p className="text-[11px] text-stone-500 mt-0.5 max-w-xl">
            On top of what {person.full_name?.split(' ')[0] ?? 'this person'}&apos;s role already allows.
            Access is to look, not to act — approvals, edits and anything that reaches Xero still need the
            role that carries them.
          </p>
        </div>
        {saved && !dirty ? <StatusChip tone="good">Saved</StatusChip> : null}
      </div>

      <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5 mt-3">
        {MODULE_KEYS.map((key) => {
          const on = selected.has(key)
          return (
            <label
              key={key}
              className={cx(
                'flex items-start gap-2.5 px-2.5 py-2 rounded-control cursor-pointer',
                on ? 'bg-indigo/[.05]' : 'hover:bg-paper-2',
                !isAdmin && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!isAdmin}
                className="accent-[#211951] mt-0.5"
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(key)
                    else next.delete(key)
                    return next
                  })
                }
              />
              <span className="min-w-0">
                <span className="block text-[12.5px] text-ink">
                  {MODULE_LABELS[key]}
                  {FUND_SCOPED.has(key) ? (
                    <span className="text-[10px] text-stone-400 ml-1.5">their funds only</span>
                  ) : null}
                </span>
                <span className="block text-[10.5px] text-stone-500 leading-snug">{MODULE_HINTS[key]}</span>
              </span>
            </label>
          )
        })}
      </div>

      {needsFunds ? (
        <div className="mt-3 rounded-card border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[11.5px] text-warn-ink">
          <b className="font-medium">This will show nothing yet.</b>{' '}
          {person.full_name?.split(' ')[0] ?? 'This person'} is not named responsible for any fund, and the
          fund-scoped modules show only the funds someone is responsible for. Assign a fund on its fund page,
          or under Fund responsibilities below.
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <ErrorNotice message={error} />
        </div>
      ) : null}

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <Button variant="money" size="sm" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save access'}
          </Button>
          {dirty ? (
            <button
              onClick={() => setSelected(new Set(granted))}
              className="text-[11.5px] text-stone-500 hover:text-indigo underline underline-offset-2"
            >
              undo changes
            </button>
          ) : null}
          <span className="text-[11px] text-stone-500">
            {selected.size === 0
              ? 'No extra access — their role alone decides what they see.'
              : `${selected.size} module${selected.size === 1 ? '' : 's'} granted. Every change is audit-logged.`}
          </span>
        </div>
      ) : (
        <p className="text-[11px] text-stone-500 mt-3">
          Only a Pulse admin can change access. Handing out access to the ledger is our control.
        </p>
      )}
    </div>
  )
}
