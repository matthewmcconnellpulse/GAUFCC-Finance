/**
 * People — payroll manager dashboard (pulse_admin / pulse_payroll).
 * Onboarding pipeline board, people register, invite modal (shareable link +
 * downloadable .eml draft) and the client-side payroll CSV export.
 */
import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  LoadingRows,
  PageHeader,
  SectionLabel,
  Select,
  cx,
} from '@/components/ui'
import { formatDate } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { OnboardingStatus, Person, PersonType } from '@/types/db'
import { CopyField, Modal, OnboardingStatusChip, PersonTypeChip } from './components'
import { downloadEml } from './eml'
import {
  ONBOARDING_STAGES,
  STAGE_HINTS,
  STAGE_LABELS,
  createOnboardingInvite,
  downloadTextFile,
  fetchPeople,
  onboardingLink,
  payrollCsv,
} from './lib'

type TypeFilter = 'all' | PersonType

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'employee', label: 'Employees' },
  { value: 'volunteer', label: 'Volunteers' },
]

// ── Invite .eml draft ────────────────────────────────────────────────────────

function inviteEmlBody(fullName: string, personType: PersonType, link: string): string {
  const first = fullName.trim().split(/\s+/)[0] || 'there'
  const needs =
    personType === 'employee'
      ? [
          'your contact details and home address',
          'your bank details and National Insurance number, so we can pay you',
          'a photo of your passport, or your right-to-work share code',
          'an emergency contact',
        ]
      : [
          'your contact details',
          'an emergency contact',
          'your DBS certificate, if your role needs one',
        ]
  return [
    `Hello ${first},`,
    '',
    'Welcome to the General Assembly of Unitarian and Free Christian Churches.',
    '',
    'Before you start we need a few details. The form takes about five minutes on a phone or computer:',
    '',
    link,
    '',
    'The link is personal to you and expires in 7 days. If it stops working, reply to this email and we will send a fresh one.',
    '',
    'Have these to hand:',
    ...needs.map((n) => `  - ${n}`),
    '',
    'Nothing you enter is shared beyond the payroll team at Pulse Accountants, and your bank details are encrypted.',
    '',
    'Kind regards',
    'The Pulse payroll team, on behalf of the Assembly',
  ].join('\n')
}

// ── Invite modal ─────────────────────────────────────────────────────────────

function InviteModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [personType, setPersonType] = useState<PersonType>('employee')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!fullName.trim()) {
      setError('Add their name — it personalises the invite.')
      return
    }
    if (!/.+@.+\..+/.test(email.trim())) {
      setError('That email address does not look right.')
      return
    }
    setBusy(true)
    try {
      const t = await createOnboardingInvite({ email, personType, fullName })
      setToken(t)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The invite could not be created')
    } finally {
      setBusy(false)
    }
  }

  if (token) {
    const link = onboardingLink(token)
    return (
      <Modal title="Invite created" onClose={onClose}>
        <div className="space-y-4">
          <p className="text-[12.5px] text-stone-700 leading-relaxed">
            Share this link with {fullName.trim() || 'them'} however suits — it is personal to
            them and expires in 7 days.
          </p>
          <CopyField value={link} ariaLabel="Onboarding link" />
          <div className="rounded-control bg-paper-2 border border-stone-150 px-3.5 py-3 text-[11.5px] text-stone-500 leading-relaxed">
            The .eml below opens as an editable draft in your mail client, pre-addressed with the
            link and a short checklist — nothing sends until you press send yourself.
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() =>
                downloadEml(`onboarding-invite-${email.trim() || 'draft'}`, {
                  to: email.trim(),
                  subject: 'Welcome to the Assembly — a few details before you start',
                  body: inviteEmlBody(fullName, personType, link),
                })
              }
            >
              Download invite .eml
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Invite person" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="Full name">
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="e.g. Sofia Marsh"
            autoFocus
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.org"
          />
        </Field>
        <Field
          label="Type"
          hint="Employees are asked for bank details and right-to-work documents; volunteers skip the payroll fields."
        >
          <Select value={personType} onChange={(e) => setPersonType(e.target.value as PersonType)}>
            <option value="employee">Employee</option>
            <option value="volunteer">Volunteer</option>
          </Select>
        </Field>
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create invite link'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ── Pipeline board ───────────────────────────────────────────────────────────

function PipelineBoard({
  people,
  activeStage,
  onStage,
}: {
  people: Person[]
  activeStage: OnboardingStatus | null
  onStage: (stage: OnboardingStatus | null) => void
}) {
  const counts = useMemo(() => {
    const c = {} as Record<OnboardingStatus, number>
    for (const s of ONBOARDING_STAGES) c[s] = 0
    for (const p of people) c[p.onboarding_status] += 1
    return c
  }, [people])

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {ONBOARDING_STAGES.map((stage, i) => {
        const active = activeStage === stage
        return (
          <button
            key={stage}
            onClick={() => onStage(active ? null : stage)}
            aria-pressed={active}
            className={cx(
              'text-left bg-white border rounded-card shadow-card px-4 py-3.5 transition-colors',
              active ? 'border-indigo ring-1 ring-indigo' : 'border-stone-150 hover:border-stone-300',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[22px] text-ink leading-none">{counts[stage]}</span>
              <span className="text-stone-400 text-[10px] font-mono" aria-hidden>
                {i + 1}/{ONBOARDING_STAGES.length}
              </span>
            </div>
            <div className="text-[12px] font-medium text-ink mt-2">{STAGE_LABELS[stage]}</div>
            <div className="text-[10.5px] text-stone-500 mt-0.5 leading-snug">
              {STAGE_HINTS[stage]}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PeoplePage() {
  const navigate = useNavigate()
  const { isAdmin, isPayroll, isCeo } = usePermissions()
  const people = useSupabaseQuery(fetchPeople, [])
  const [stageFilter, setStageFilter] = useState<OnboardingStatus | null>(null)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [search, setSearch] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)

  const rows = people.data ?? []
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((p) => {
      if (stageFilter && p.onboarding_status !== stageFilter) return false
      if (typeFilter !== 'all' && p.type !== typeFilter) return false
      if (q) {
        const hay = `${p.first_name} ${p.last_name} ${p.email ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, stageFilter, typeFilter, search])

  const exportable = useMemo(
    () =>
      rows.filter(
        (p) => p.onboarding_status === 'verified' || p.onboarding_status === 'complete',
      ),
    [rows],
  )

  const exportForPayroll = () => {
    const today = new Date().toISOString().slice(0, 10)
    downloadTextFile(`payroll-export-${today}.csv`, payrollCsv(exportable), 'text/csv')
  }

  if (!isAdmin && !isPayroll && !isCeo) {
    return (
      <div>
        <PageHeader title="People" subtitle="Employee and volunteer records" />
        <Card>
          <EmptyState
            title="People records are restricted"
            hint="Only the Pulse payroll team, administrators and the CEO can view this area."
          />
        </Card>
      </div>
    )
  }

  const header = (
    <PageHeader
      title="People"
      subtitle="Employee and volunteer onboarding, records and payroll export"
      actions={
        <>
          <Button
            variant="ghost"
            onClick={exportForPayroll}
            disabled={exportable.length === 0}
            title={
              exportable.length === 0
                ? 'No verified people to export yet'
                : `CSV of ${exportable.length} verified ${exportable.length === 1 ? 'person' : 'people'} — bank details stay masked`
            }
          >
            Export for payroll
          </Button>
          <Button onClick={() => setInviteOpen(true)}>Invite person</Button>
        </>
      }
    />
  )

  if (people.loading) {
    return (
      <div>
        {header}
        <Card>
          <LoadingRows cols={5} rows={8} />
        </Card>
      </div>
    )
  }

  if (people.error) {
    return (
      <div>
        {header}
        <ErrorNotice message={`People could not be loaded — ${people.error}`} />
      </div>
    )
  }

  return (
    <div>
      {header}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No people yet"
            hint="Invite your first employee or volunteer — they get a secure link and fill in their own details, no login needed."
            action={<Button onClick={() => setInviteOpen(true)}>Invite person</Button>}
          />
        </Card>
      ) : (
        <>
          <SectionLabel>Onboarding pipeline</SectionLabel>
          <PipelineBoard people={rows} activeStage={stageFilter} onStage={setStageFilter} />

          <div className="mt-6">
            <SectionLabel>Register</SectionLabel>
            <Card>
              <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-stone-150">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name or email"
                  className="max-w-60"
                  aria-label="Search people"
                />
                <div className="flex items-center gap-1" role="group" aria-label="Filter by type">
                  {TYPE_FILTERS.map((f) => (
                    <button
                      key={f.value}
                      onClick={() => setTypeFilter(f.value)}
                      aria-pressed={typeFilter === f.value}
                      className={cx(
                        'rounded-full px-3 py-1 text-[11px] font-medium transition-colors',
                        typeFilter === f.value
                          ? 'bg-indigo text-paper'
                          : 'text-stone-500 hover:text-indigo hover:bg-paper-2',
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                {stageFilter ? (
                  <button
                    onClick={() => setStageFilter(null)}
                    className="ml-auto text-[11px] text-indigo underline underline-offset-2"
                  >
                    Clear stage filter · {STAGE_LABELS[stageFilter]}
                  </button>
                ) : null}
              </div>

              {visible.length === 0 ? (
                <EmptyState
                  title="No matches"
                  hint="Try a different search, or clear the stage and type filters."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr>
                        <th className="th-register">Person</th>
                        <th className="th-register">Type</th>
                        <th className="th-register">Role or capacity</th>
                        <th className="th-register">Start date</th>
                        <th className="th-register">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((p) => (
                        <tr
                          key={p.id}
                          onClick={() => navigate(`/people/${p.id}`)}
                          className="cursor-pointer hover:bg-paper-2 transition-colors"
                        >
                          <td className="td-register">
                            <div className="font-medium text-ink">
                              {p.first_name} {p.last_name}
                            </div>
                            <div className="text-stone-500 text-[11px]">{p.email ?? '—'}</div>
                          </td>
                          <td className="td-register">
                            <PersonTypeChip type={p.type} />
                          </td>
                          <td className="td-register text-stone-700">
                            {(p.type === 'employee' ? p.role_title : p.volunteer_capacity) ?? '—'}
                          </td>
                          <td className="td-register font-mono whitespace-nowrap">
                            {formatDate(p.start_date)}
                          </td>
                          <td className="td-register">
                            <OnboardingStatusChip status={p.onboarding_status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      {inviteOpen ? (
        <InviteModal onClose={() => setInviteOpen(false)} onCreated={() => people.refetch()} />
      ) : null}
    </div>
  )
}
