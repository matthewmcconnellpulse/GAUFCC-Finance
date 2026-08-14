/**
 * Settings → Users — pulse_admin only. Profiles register with active toggle,
 * invite-user modal (invokes the invite-user edge function) and the
 * fund-manager assignment editor that drives per-fund trustee visibility.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import {
  AiBadge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  LoadingRows,
  Select,
  StatusChip,
  cx,
} from '@/components/ui'
import { formatDate, formatDateTime, timeAgo } from '@/lib/format'
import { invokeFunction } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { Fund, Organisation, Profile, Role, UserActivityRow } from '@/types/db'
import {
  ALL_ROLES,
  fetchAllFunds,
  fetchFundManagers,
  fetchProfiles,
  fetchUserActivity,
  ROLE_LABELS,
  saveFundManagerAssignments,
  setProfileActive,
  updateProfile,
} from './lib'
import { Modal, RoleChip, SectionCard, Toggle } from './components'

export default function UsersTab() {
  const { isAdmin, isCeo } = usePermissions()

  const profilesQuery = useSupabaseQuery(() => fetchProfiles(), [])
  const fundsQuery = useSupabaseQuery(() => fetchAllFunds(), [])
  const managersQuery = useSupabaseQuery(() => fetchFundManagers(), [])

  const [inviteOpen, setInviteOpen] = useState(false)
  const [editUser, setEditUser] = useState<Profile | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  if (!isAdmin && !isCeo) {
    return (
      <Card>
        <EmptyState
          title="Restricted"
          hint="User management is restricted to the Pulse admin and the CEO."
        />
      </Card>
    )
  }

  const profiles = profilesQuery.data ?? []
  const trustees = profiles.filter((p) => p.role === 'trustee')

  async function toggleActive(p: Profile) {
    setToggleError(null)
    try {
      await setProfileActive(p.id, !p.active)
      profilesQuery.refetch()
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : 'The change could not be saved')
    }
  }

  return (
    <div className="space-y-4">
      {/* Register */}
      <SectionCard
        title="Users"
        hint={
          isAdmin
            ? 'Invite-only — there is no open registration. Deactivating a user blocks sign-in and every RLS grant immediately.'
            : 'Add trustee and volunteer logins with a sign-up link or a password — nothing depends on email delivery.'
        }
        actions={
          <Button size="sm" variant="primary" onClick={() => setInviteOpen(true)}>
            Add user
          </Button>
        }
      >
        {toggleError ? (
          <div className="px-5 pt-4">
            <ErrorNotice message={toggleError} />
          </div>
        ) : null}
        {profilesQuery.loading && !profilesQuery.data ? (
          <LoadingRows cols={5} rows={6} />
        ) : profilesQuery.error ? (
          <div className="p-5">
            <ErrorNotice message={profilesQuery.error} />
          </div>
        ) : profiles.length === 0 ? (
          <EmptyState title="No users yet" hint="Send the first invitation to get started." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[680px]">
              <thead>
                <tr>
                  <th className="th-register">Name</th>
                  <th className="th-register">Email</th>
                  <th className="th-register">Role</th>
                  <th className="th-register">Organisation</th>
                  <th className="th-register">Joined</th>
                  <th className="th-register">Active</th>
                  <th className="th-register" aria-label="Edit" />
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id} className={cx(!p.active && 'opacity-55')}>
                    <td className="td-register font-medium text-ink whitespace-nowrap">{p.full_name || '—'}</td>
                    <td className="td-register font-mono text-[11px]">{p.email}</td>
                    <td className="td-register">
                      <RoleChip role={p.role} />
                    </td>
                    <td className="td-register">{p.organisation === 'pulse' ? 'Pulse' : 'GAUFCC'}</td>
                    <td className="td-register figure whitespace-nowrap">{formatDate(p.created_at)}</td>
                    <td className="td-register">
                      {isAdmin ? (
                        <Toggle on={p.active} onChange={() => void toggleActive(p)} label={`${p.full_name} active`} />
                      ) : (
                        <span className="text-[11px] text-stone-500">{p.active ? 'Active' : 'Inactive'}</span>
                      )}
                    </td>
                    <td className="td-register">
                      {isAdmin ? (
                        <button
                          type="button"
                          className="text-[11px] text-indigo underline underline-offset-2"
                          onClick={() => setEditUser(p)}
                        >
                          Edit
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Fund-manager assignments — admin-only writes at RLS */}
      {isAdmin ? (
        <SectionCard
          title="Fund-manager assignments"
          hint="Which funds each trustee can see. Whole-board trustees see every fund in reports and packs."
        >
          {managersQuery.loading && !managersQuery.data ? (
            <LoadingRows cols={3} rows={4} />
          ) : managersQuery.error ? (
            <div className="p-5">
              <ErrorNotice message={managersQuery.error} />
            </div>
          ) : trustees.length === 0 ? (
            <EmptyState title="No trustees yet" hint="Invite a trustee first, then assign their funds here." />
          ) : (
            <AssignmentEditor
              trustees={trustees}
              funds={fundsQuery.data ?? []}
              fundsLoading={fundsQuery.loading}
              fundsError={fundsQuery.error}
              assignments={managersQuery.data ?? []}
              onSaved={() => managersQuery.refetch()}
            />
          )}
        </SectionCard>
      ) : null}

      {/* Activity trail + AI interest summaries — admin-only reads at RLS */}
      {isAdmin ? <ActivitySection profiles={profiles} /> : null}

      {inviteOpen ? (
        <AddUserModal onClose={() => setInviteOpen(false)} onCreated={() => profilesQuery.refetch()} />
      ) : null}
      {editUser ? (
        <EditUserModal
          user={editUser}
          onClose={() => setEditUser(null)}
          onSaved={() => {
            setEditUser(null)
            profilesQuery.refetch()
          }}
        />
      ) : null}
    </div>
  )
}

// ── Edit user ────────────────────────────────────────────────────────────────

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: Profile
  onClose: () => void
  onSaved: () => void
}) {
  const [fullName, setFullName] = useState(user.full_name)
  const [role, setRole] = useState<Role>(user.role)
  const [organisation, setOrganisation] = useState<Organisation>(user.organisation)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!fullName.trim()) {
      setError('A name is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateProfile(user.id, { full_name: fullName.trim(), role, organisation })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The user could not be updated')
      setBusy(false)
    }
  }

  return (
    <Modal title={`Edit ${user.full_name || user.email}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Full name">
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Email" hint="The sign-in email is fixed to their login — invite a new user to change it.">
          <Input value={user.email} disabled className="opacity-60" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ALL_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Organisation">
            <Select
              value={organisation}
              onChange={(e) => setOrganisation(e.target.value as Organisation)}
            >
              <option value="pulse">Pulse</option>
              <option value="gaufcc">GAUFCC</option>
            </Select>
          </Field>
        </div>
        <p className="text-[10.5px] text-stone-500">
          Role changes take effect on their next page load and are audit-logged. Access follows the
          role immediately — no re-invite needed.
        </p>
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ── User activity + AI interest summaries ────────────────────────────────────

interface ActivityInsight {
  profile_id: string
  name: string
  role: string
  summary: string
}

function ActivitySection({ profiles }: { profiles: Profile[] }) {
  const activity = useSupabaseQuery(() => fetchUserActivity(30), [])
  const [openUser, setOpenUser] = useState<string | null>(null)
  const [insights, setInsights] = useState<ActivityInsight[] | null>(null)
  const [generating, setGenerating] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const rows = activity.data ?? []
  const byUser = new Map<string, UserActivityRow[]>()
  for (const row of rows) {
    const list = byUser.get(row.profile_id)
    if (list) list.push(row)
    else byUser.set(row.profile_id, [row])
  }

  const summaries = [...byUser.entries()]
    .map(([profileId, events]) => {
      const profile = profiles.find((p) => p.id === profileId)
      const pageCounts = new Map<string, number>()
      for (const e of events) pageCounts.set(e.page, (pageCounts.get(e.page) ?? 0) + 1)
      const topPages = [...pageCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      return {
        profileId,
        name: profile?.full_name ?? 'Unknown user',
        role: profile?.role ?? null,
        views: events.length,
        lastSeen: events[0]?.occurred_at ?? null,
        topPages,
        recent: events.slice(0, 15),
      }
    })
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))

  async function generate() {
    setGenerating(true)
    setAiError(null)
    try {
      const res = await invokeFunction<{ insights: ActivityInsight[] }>('user-activity-insights')
      setInsights(res.insights)
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'The insights could not be generated')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <SectionCard
      title="User activity"
      hint="Where each signed-in user actually goes — last 30 days, recorded per page view. Only the Pulse admin sees this."
      actions={
        <Button size="sm" variant="ghost" onClick={() => void generate()} disabled={generating}>
          {generating ? 'Reading the trail…' : insights ? 'Refresh AI summaries' : 'AI — what interests each user?'}
        </Button>
      }
    >
      {aiError ? (
        <div className="px-5 pt-4">
          <ErrorNotice message={aiError} />
        </div>
      ) : null}

      {insights && insights.length > 0 ? (
        <div className="px-5 pt-4 grid gap-2.5 sm:grid-cols-2">
          {insights.map((i) => (
            <div key={i.profile_id} className="rounded-card border border-stone-150 bg-paper px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[12.5px] font-medium text-ink">{i.name}</span>
                <AiBadge />
              </div>
              <p className="text-[12px] text-stone-700 leading-relaxed">{i.summary}</p>
            </div>
          ))}
        </div>
      ) : null}

      {activity.loading && !activity.data ? (
        <LoadingRows cols={4} rows={4} />
      ) : activity.error ? (
        <div className="p-5">
          <ErrorNotice message={activity.error} />
        </div>
      ) : summaries.length === 0 ? (
        <EmptyState
          title="No activity recorded yet"
          hint="Page views are recorded from now on — check back once people have signed in and moved around."
        />
      ) : (
        <div className="overflow-x-auto pt-2">
          <table className="w-full text-[12px] min-w-[640px]">
            <thead>
              <tr>
                <th className="th-register">User</th>
                <th className="th-register">Last active</th>
                <th className="th-register text-right">Views · 30d</th>
                <th className="th-register">Goes to most</th>
                <th className="th-register" aria-label="Trail" />
              </tr>
            </thead>
            <tbody>
              {summaries.map((u) => (
                <Fragment key={u.profileId}>
                  <tr>
                    <td className="td-register font-medium text-ink whitespace-nowrap">{u.name}</td>
                    <td className="td-register text-stone-600 whitespace-nowrap">
                      {u.lastSeen ? timeAgo(u.lastSeen) : '—'}
                    </td>
                    <td className="td-register text-right figure">{u.views}</td>
                    <td className="td-register text-stone-600">
                      {u.topPages.map(([page, n]) => `${page} (${n})`).join(' · ') || '—'}
                    </td>
                    <td className="td-register text-right">
                      <button
                        type="button"
                        className="text-[11px] text-indigo underline underline-offset-2"
                        onClick={() => setOpenUser(openUser === u.profileId ? null : u.profileId)}
                      >
                        {openUser === u.profileId ? 'Hide trail' : 'Trail'}
                      </button>
                    </td>
                  </tr>
                  {openUser === u.profileId ? (
                    <tr>
                      <td colSpan={5} className="px-5 pb-3 bg-paper">
                        <ul className="pt-2 space-y-1">
                          {u.recent.map((e) => (
                            <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 text-[11.5px]">
                              <span className="font-mono text-[10.5px] text-stone-400 whitespace-nowrap">
                                {formatDateTime(e.occurred_at)}
                              </span>
                              <span className="text-ink">{e.page}</span>
                              <span className="font-mono text-[10.5px] text-stone-500 truncate max-w-[280px]">
                                {e.path}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

// ── Add-user modal ───────────────────────────────────────────────────────────

/** Small copy-to-clipboard row for the link/password the modal produces. */
function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.target.select()}
        className="flex-1 min-w-0 rounded-lg border border-stone-200 bg-paper-2 px-2.5 py-1.5 font-mono text-[11px] text-stone-700"
        aria-label="Copy value"
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/**
 * Adds a user with no dependency on email delivery: 'link' mode returns a
 * one-time sign-up link to pass on, 'password' mode creates the login ready
 * to sign in with a password the caller hands over. The CEO is limited to
 * trustee/submitter GAUFCC logins (the invite-user function enforces it too).
 */
function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { isAdmin } = usePermissions()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<Role>('trustee')
  const [organisation, setOrganisation] = useState<Organisation>('gaufcc')
  const [mode, setMode] = useState<'link' | 'password'>('link')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ link: string | null; password: string | null } | null>(null)

  const roleOptions = isAdmin ? ALL_ROLES : (['trustee', 'submitter'] as Role[])

  async function create() {
    if (!email.trim() || !fullName.trim()) {
      setError('An email address and a full name are both needed')
      return
    }
    if (mode === 'password' && password.length < 8) {
      setError('The password needs at least 8 characters')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await invokeFunction<{ ok: boolean; action_link: string | null }>('invite-user', {
        email: email.trim(),
        full_name: fullName.trim(),
        role,
        organisation: isAdmin ? organisation : 'gaufcc',
        mode,
        ...(mode === 'password' ? { password } : {}),
      })
      if (!res.ok) throw new Error('The request was not accepted by the server')
      setDone({ link: res.action_link ?? null, password: mode === 'password' ? password : null })
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The user could not be added')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Modal title="Login ready" onClose={onClose}>
        <div className="space-y-3.5">
          {done.link ? (
            <>
              <p className="text-[12.5px] text-stone-700 leading-relaxed">
                Nothing was emailed. Send {fullName || 'them'} this one-time sign-up link through any
                channel — it lets them choose their own password. It is single-use and short-lived;
                you can generate a fresh one from their person record if it expires.
              </p>
              <CopyRow value={done.link} />
            </>
          ) : (
            <>
              <p className="text-[12.5px] text-stone-700 leading-relaxed">
                The login works right now with the password below. Pass it on securely (not by email
                alongside the address) and encourage them to change it after first sign-in.
              </p>
              <CopyRow value={done.password ?? ''} />
            </>
          )}
          <div className="flex items-center justify-end pt-1">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Add a user" onClose={onClose}>
      <div className="space-y-3.5">
        <Field label="Full name">
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.org" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          {isAdmin ? (
            <Field label="Organisation">
              <Select value={organisation} onChange={(e) => setOrganisation(e.target.value as Organisation)}>
                <option value="gaufcc">GAUFCC</option>
                <option value="pulse">Pulse</option>
              </Select>
            </Field>
          ) : null}
        </div>
        <Field label="How they get in" hint="No email is sent either way — you pass the link or password on yourself.">
          <div className="flex gap-1.5">
            {(
              [
                ['link', 'Sign-up link to send'],
                ['password', 'Set a password now'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cx(
                  'rounded-full border px-3 py-1 text-[11px] font-medium transition-colors',
                  mode === value
                    ? 'border-indigo bg-indigo text-white'
                    : 'border-stone-300 text-stone-600 hover:bg-paper-2',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {mode === 'password' ? (
          <Field label="Password" hint="At least 8 characters. They can change it once signed in.">
            <Input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="choose a password to hand over"
              className="font-mono"
              autoComplete="off"
            />
          </Field>
        ) : null}
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : mode === 'link' ? 'Create login & get link' : 'Create login with password'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ── Fund-manager assignment editor ───────────────────────────────────────────

function AssignmentEditor({
  trustees,
  funds,
  fundsLoading,
  fundsError,
  assignments,
  onSaved,
}: {
  trustees: Profile[]
  funds: Fund[]
  fundsLoading: boolean
  fundsError: string | null
  assignments: Array<{ profile_id: string; fund_id: string; whole_board: boolean }>
  onSaved: () => void
}) {
  const [trusteeId, setTrusteeId] = useState<string>(trustees[0]?.id ?? '')
  const [fundIds, setFundIds] = useState<string[]>([])
  const [wholeBoard, setWholeBoard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = useMemo(
    () => assignments.filter((a) => a.profile_id === trusteeId),
    [assignments, trusteeId],
  )

  // load the selected trustee's existing assignments into the form
  useEffect(() => {
    setFundIds(current.map((a) => a.fund_id))
    setWholeBoard(current.some((a) => a.whole_board))
    setSaved(false)
    setError(null)
  }, [trusteeId, current])

  async function save() {
    if (!trusteeId) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await saveFundManagerAssignments(trusteeId, fundIds, wholeBoard)
      setSaved(true)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The assignments could not be saved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Trustee" className="min-w-56">
          <Select value={trusteeId} onChange={(e) => setTrusteeId(e.target.value)}>
            {trustees.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name || t.email}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2.5 pb-2.5">
          <Toggle on={wholeBoard} onChange={setWholeBoard} label="Whole board" />
          <span className="text-[12px] text-ink">
            Whole board <span className="text-stone-500">— sees every fund in reports and packs</span>
          </span>
        </label>
      </div>

      {fundsLoading ? (
        <LoadingRows cols={3} rows={3} />
      ) : fundsError ? (
        <ErrorNotice message={fundsError} />
      ) : funds.length === 0 ? (
        <p className="text-[12px] text-stone-500">No funds yet — they arrive with the first Xero sync.</p>
      ) : (
        <div>
          <div className="label-base">{wholeBoard ? 'Named funds (kept alongside whole-board access)' : 'Funds this trustee manages'}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 max-h-64 overflow-y-auto rounded-control border border-stone-300 bg-white p-3">
            {funds.map((f) => {
              const checked = fundIds.includes(f.id)
              return (
                <label key={f.id} className="flex items-center gap-2 text-[12px] py-0.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setFundIds((ids) => (checked ? ids.filter((id) => id !== f.id) : [...ids, f.id]))}
                    className="accent-[#211951]"
                  />
                  <span className="truncate">{f.name}</span>
                </label>
              )
            })}
          </div>
          {wholeBoard && fundIds.length === 0 ? (
            <p className="text-[11px] text-warn-ink mt-2">
              Whole-board access is stored against at least one fund row — tick one fund (any fund) to carry the flag.
            </p>
          ) : null}
        </div>
      )}

      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex items-center justify-end gap-2">
        {saved ? <StatusChip tone="good">Saved</StatusChip> : null}
        <Button variant="primary" size="sm" disabled={busy || !trusteeId} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save assignments'}
        </Button>
      </div>
    </div>
  )
}
