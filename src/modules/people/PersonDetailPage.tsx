/**
 * Person detail — record view for the payroll team: personal details,
 * contact, emergency contact, documents (people-docs signed URLs),
 * onboarding submission history, status advance (verify → complete) and the
 * audited bank-details reveal.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
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
  Skeleton,
} from '@/components/ui'
import { formatDate, formatDateTime } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { OnboardingStatus, OnboardingSubmission, Person } from '@/types/db'
import { OnboardingStatusChip, PersonTypeChip } from './components'
import {
  createPersonLogin,
  docsFromSubmissions,
  generatePersonLoginLink,
  fetchPerson,
  fetchSubmissions,
  revealBankDetails,
  setOnboardingStatus,
  signedDocUrl,
  updatePerson,
  type PersonBankDetails,
  type PersonPatch,
} from './lib'

// ── Small local pieces ───────────────────────────────────────────────────────

function DetailRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">{label}</dt>
      <dd className={`text-[13px] text-ink mt-0.5 ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</dd>
    </div>
  )
}

function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </Card>
  )
}

// ── Status advance ───────────────────────────────────────────────────────────

const NEXT_STATUS: Partial<Record<OnboardingStatus, { to: OnboardingStatus; label: string; blurb: string }>> = {
  submitted: {
    to: 'verified',
    label: 'Mark verified',
    blurb: 'Confirms you have checked their details against the documents provided.',
  },
  verified: {
    to: 'complete',
    label: 'Mark complete',
    blurb: 'Confirms payroll setup is finished and the record needs no further action.',
  },
}

function StatusCard({ person, onChanged }: { person: Person; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = NEXT_STATUS[person.onboarding_status]

  const advance = async () => {
    if (!next) return
    setBusy(true)
    setError(null)
    try {
      await setOnboardingStatus(person.id, next.to)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The status could not be updated')
    } finally {
      setBusy(false)
    }
  }

  return (
    <CardSection title="Onboarding status">
      <div className="flex items-center gap-2">
        <OnboardingStatusChip status={person.onboarding_status} />
      </div>
      {next ? (
        <div className="mt-4 space-y-2">
          <Button onClick={() => void advance()} disabled={busy} className="w-full">
            {busy ? 'Saving…' : next.label}
          </Button>
          <p className="text-[11px] text-stone-500 leading-relaxed">{next.blurb}</p>
        </div>
      ) : (
        <p className="text-[11px] text-stone-500 mt-3 leading-relaxed">
          {person.onboarding_status === 'complete'
            ? 'Nothing left to do for this record.'
            : 'Waiting on their form — the status moves on automatically when they submit.'}
        </p>
      )}
      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}
      <p className="text-[10.5px] text-stone-400 mt-3">Status changes are recorded in the audit log.</p>
    </CardSection>
  )
}

// ── Bank details (masked by default, audited reveal) ─────────────────────────

function BankCard({ person }: { person: Person }) {
  const [revealed, setRevealed] = useState<PersonBankDetails | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reveal = async () => {
    setBusy(true)
    setError(null)
    try {
      setRevealed(await revealBankDetails(person.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bank details could not be retrieved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <CardSection title="Bank details">
      <dl className="space-y-3">
        <DetailRow label="Bank" value={revealed?.bank_name ?? person.bank_name ?? '—'} />
        <DetailRow
          label="Account number"
          value={revealed?.bank_account ?? person.bank_account_masked ?? '••••'}
          mono
        />
        <DetailRow
          label="Sort code"
          value={revealed?.bank_sort_code ?? person.bank_sort_code_masked ?? '••-••-••'}
          mono
        />
        <DetailRow
          label="NI number"
          value={revealed?.ni_number ?? person.ni_number_masked ?? '••••'}
          mono
        />
      </dl>
      <div className="mt-4">
        {revealed ? (
          <div className="space-y-2">
            <div className="rounded-control bg-paper-2 border border-stone-150 px-3 py-2 text-[11px] text-stone-500">
              This access has been logged in the audit trail.
            </div>
            <Button variant="quiet" size="sm" onClick={() => setRevealed(null)}>
              Hide again
            </Button>
          </div>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => void reveal()} disabled={busy}>
              {busy ? 'Retrieving…' : 'Reveal bank details'}
            </Button>
            <p className="text-[10.5px] text-stone-400 mt-2">
              Revealing is limited to payroll and admin, and every view is logged.
            </p>
          </>
        )}
      </div>
      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}
    </CardSection>
  )
}

// ── Documents ────────────────────────────────────────────────────────────────

function DocumentsCard({ submissions }: { submissions: OnboardingSubmission[] }) {
  const docs = useMemo(() => docsFromSubmissions(submissions), [submissions])
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = async (path: string) => {
    setOpeningPath(path)
    setError(null)
    try {
      const url = await signedDocUrl(path)
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The document could not be opened')
    } finally {
      setOpeningPath(null)
    }
  }

  return (
    <CardSection title="Documents">
      {docs.length === 0 ? (
        <p className="text-[12px] text-stone-500 leading-relaxed">
          No documents uploaded — they may have been emailed to the payroll team instead.
        </p>
      ) : (
        <ul className="space-y-2">
          {docs.map((doc) => (
            <li
              key={doc.storage_path}
              className="flex items-center justify-between gap-3 rounded-control border border-stone-150 px-3 py-2"
            >
              <span className="text-[12px] text-ink truncate" title={doc.name}>
                {doc.name}
              </span>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => void open(doc.storage_path)}
                disabled={openingPath === doc.storage_path}
              >
                {openingPath === doc.storage_path ? 'Opening…' : 'View'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}
    </CardSection>
  )
}

// ── Submission history ───────────────────────────────────────────────────────

const SENSITIVE_KEY = /bank|ni_number|sort_code|account/i

function PayloadDetails({ payload }: { payload: unknown }) {
  if (typeof payload !== 'object' || payload === null) {
    return <p className="text-[11.5px] text-stone-500">No details recorded.</p>
  }
  const entries = Object.entries(payload as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  )
  if (entries.length === 0) {
    return <p className="text-[11.5px] text-stone-500">No details recorded.</p>
  }
  return (
    <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 mt-2">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="text-[9.5px] font-medium uppercase tracking-[.12em] text-stone-400">
            {key.replace(/_/g, ' ')}
          </dt>
          <dd className="text-[11.5px] text-stone-700 font-mono break-words">
            {SENSITIVE_KEY.test(key) ? '••••' : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function SubmissionsCard({ submissions }: { submissions: OnboardingSubmission[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <CardSection title="Onboarding submissions">
      {submissions.length === 0 ? (
        <p className="text-[12px] text-stone-500">Nothing submitted yet.</p>
      ) : (
        <ul className="space-y-2">
          {submissions.map((sub) => (
            <li key={sub.id} className="rounded-control border border-stone-150 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-ink font-mono">
                  {formatDateTime(sub.submitted_at)}
                </span>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setOpenId(openId === sub.id ? null : sub.id)}
                >
                  {openId === sub.id ? 'Hide details' : 'Details'}
                </Button>
              </div>
              {openId === sub.id ? <PayloadDetails payload={sub.payload} /> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10.5px] text-stone-400 mt-3">
        Bank and NI values are masked here — use the audited reveal instead.
      </p>
    </CardSection>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { isAdmin, isPayroll } = usePermissions()
  const [editing, setEditing] = useState(false)

  const person = useSupabaseQuery(() => fetchPerson(id ?? ''), [id])
  const submissions = useSupabaseQuery(() => fetchSubmissions(id ?? ''), [id])

  if (!isAdmin && !isPayroll) {
    return (
      <div>
        <PageHeader title="Person" subtitle="Employee and volunteer records" />
        <Card>
          <EmptyState
            title="People records are restricted"
            hint="Only the Pulse payroll team and administrators can view this area."
          />
        </Card>
      </div>
    )
  }

  if (person.loading) {
    return (
      <div>
        <Skeleton className="h-8 w-64 mb-6" />
        <Card>
          <LoadingRows cols={3} rows={8} />
        </Card>
      </div>
    )
  }

  if (person.error) {
    return (
      <div>
        <PageHeader title="Person" />
        <ErrorNotice message={`This record could not be loaded — ${person.error}`} />
      </div>
    )
  }

  const p = person.data
  if (!p) {
    return (
      <div>
        <PageHeader title="Person" />
        <Card>
          <EmptyState
            title="Record not found"
            hint="It may have been removed, or the link may be out of date."
            action={
              <Link to="/people" className="text-indigo underline underline-offset-2 text-[12.5px]">
                Back to people
              </Link>
            }
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <Link
        to="/people"
        className="inline-block text-[11.5px] text-stone-500 hover:text-indigo mb-3"
      >
        ← All people
      </Link>
      <PageHeader
        title={`${p.first_name} ${p.last_name}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <PersonTypeChip type={p.type} />
            <OnboardingStatusChip status={p.onboarding_status} />
            {p.email ? <span>{p.email}</span> : null}
          </span>
        }
        actions={
          editing ? null : (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Edit details
            </Button>
          )
        }
      />

      <div className="grid lg:grid-cols-3 gap-4 items-start">
        {/* Left — the record */}
        <div className="lg:col-span-2 space-y-4">
          {editing ? (
            <EditPersonForm
              person={p}
              onDone={(changed) => {
                setEditing(false)
                if (changed) person.refetch()
              }}
            />
          ) : (
            <>
              <CardSection title="Personal details">
                <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
                  <DetailRow label="Full name" value={`${p.first_name} ${p.last_name}`} />
                  <DetailRow label="Date of birth" value={formatDate(p.date_of_birth)} mono />
                  <DetailRow label="Email" value={p.email} />
                  <DetailRow label="Phone" value={p.phone} mono />
                  <div className="sm:col-span-2">
                    <DetailRow label="Address" value={p.address} />
                  </div>
                </dl>
              </CardSection>

              <CardSection title={p.type === 'employee' ? 'Role' : 'Volunteering'}>
                <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
                  <DetailRow
                    label={p.type === 'employee' ? 'Job title' : 'Capacity'}
                    value={p.type === 'employee' ? p.role_title : p.volunteer_capacity}
                  />
                  <DetailRow label="Start date" value={formatDate(p.start_date)} mono />
                </dl>
              </CardSection>

              <CardSection title="Emergency contact">
                <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
                  <DetailRow label="Name" value={p.emergency_contact_name} />
                  <DetailRow label="Phone" value={p.emergency_contact_phone} mono />
                </dl>
              </CardSection>
            </>
          )}

          {submissions.error ? (
            <ErrorNotice message={`Submissions could not be loaded — ${submissions.error}`} />
          ) : submissions.loading ? (
            <Card>
              <LoadingRows cols={2} rows={2} />
            </Card>
          ) : (
            <SubmissionsCard submissions={submissions.data ?? []} />
          )}
        </div>

        {/* Right — actions and sensitive material */}
        <div className="space-y-4">
          <LoginCard person={p} isAdmin={isAdmin} onChanged={person.refetch} />
          <StatusCard person={p} onChanged={person.refetch} />
          {p.type === 'employee' ? (
            <BankCard person={p} />
          ) : (
            <CardSection title="Bank details">
              <p className="text-[12px] text-stone-500 leading-relaxed">
                Volunteers skip the payroll fields — no bank details are held.
              </p>
            </CardSection>
          )}
          {submissions.loading ? (
            <Card>
              <LoadingRows cols={1} rows={2} />
            </Card>
          ) : (
            <DocumentsCard submissions={submissions.data ?? []} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Edit details (payroll + admin; RLS people_update) ────────────────────────

function EditPersonForm({
  person,
  onDone,
}: {
  person: Person
  onDone: (changed: boolean) => void
}) {
  const [form, setForm] = useState<PersonPatch>({
    first_name: person.first_name,
    last_name: person.last_name,
    email: person.email,
    phone: person.phone,
    address: person.address,
    date_of_birth: person.date_of_birth,
    role_title: person.role_title,
    volunteer_capacity: person.volunteer_capacity,
    start_date: person.start_date,
    emergency_contact_name: person.emergency_contact_name,
    emergency_contact_phone: person.emergency_contact_phone,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (patch: PersonPatch) => setForm((f) => ({ ...f, ...patch }))
  const text = (value: string): string | null => (value.trim() === '' ? null : value)

  async function save() {
    if (!form.first_name?.trim() || !form.last_name?.trim()) {
      setError('First and last name are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updatePerson(person.id, form)
      onDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The details could not be saved')
      setBusy(false)
    }
  }

  return (
    <CardSection title="Edit details">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="First name">
          <Input
            value={form.first_name ?? ''}
            onChange={(e) => set({ first_name: e.target.value })}
          />
        </Field>
        <Field label="Last name">
          <Input value={form.last_name ?? ''} onChange={(e) => set({ last_name: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email ?? ''}
            onChange={(e) => set({ email: text(e.target.value) })}
          />
        </Field>
        <Field label="Phone">
          <Input
            value={form.phone ?? ''}
            onChange={(e) => set({ phone: text(e.target.value) })}
            className="font-mono"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Address">
            <Input
              value={form.address ?? ''}
              onChange={(e) => set({ address: text(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="Date of birth">
          <Input
            type="date"
            value={form.date_of_birth ?? ''}
            onChange={(e) => set({ date_of_birth: text(e.target.value) })}
            className="font-mono"
          />
        </Field>
        <Field label="Start date">
          <Input
            type="date"
            value={form.start_date ?? ''}
            onChange={(e) => set({ start_date: text(e.target.value) })}
            className="font-mono"
          />
        </Field>
        {person.type === 'employee' ? (
          <Field label="Job title">
            <Input
              value={form.role_title ?? ''}
              onChange={(e) => set({ role_title: text(e.target.value) })}
            />
          </Field>
        ) : (
          <Field label="Volunteer capacity">
            <Input
              value={form.volunteer_capacity ?? ''}
              onChange={(e) => set({ volunteer_capacity: text(e.target.value) })}
            />
          </Field>
        )}
        <Field label="Emergency contact name">
          <Input
            value={form.emergency_contact_name ?? ''}
            onChange={(e) => set({ emergency_contact_name: text(e.target.value) })}
          />
        </Field>
        <Field label="Emergency contact phone">
          <Input
            value={form.emergency_contact_phone ?? ''}
            onChange={(e) => set({ emergency_contact_phone: text(e.target.value) })}
            className="font-mono"
          />
        </Field>
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorNotice message={error} />
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save details'}
        </Button>
      </div>
      <p className="text-[10.5px] text-stone-400 mt-3">
        Bank details and NI numbers are updated through onboarding, never here. Changes are
        audit-logged.
      </p>
    </CardSection>
  )
}

// ── Login (expenses access) ──────────────────────────────────────────────────

/** Read-only value with a one-tap copy — for links Pulse sends on themselves. */
function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Older Safari: select the text so a manual copy is one gesture away
      const el = document.getElementById(`copy-${label}`) as HTMLInputElement | null
      el?.select()
    }
  }
  return (
    <div className="flex gap-2">
      <Input
        id={`copy-${label}`}
        readOnly
        value={value}
        onFocus={(e) => e.target.select()}
        className="font-mono !text-[10.5px] flex-1 min-w-0"
        aria-label={label}
      />
      <Button variant="ghost" size="sm" onClick={() => void copy()} className="shrink-0">
        {copied ? 'Copied ✓' : 'Copy'}
      </Button>
    </div>
  )
}

function LoginCard({
  person,
  isAdmin,
  onChanged,
}: {
  person: Person
  isAdmin: boolean
  onChanged: () => void
}) {
  const [email, setEmail] = useState(person.email ?? '')
  const [busy, setBusy] = useState<'email' | 'link' | null>(null)
  const [sentEmail, setSentEmail] = useState(false)
  const [link, setLink] = useState<{ url: string; existing: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const portalUrl = window.location.origin

  async function inviteByEmail() {
    setBusy('email')
    setError(null)
    try {
      await createPersonLogin(person, email.trim().toLowerCase())
      setSentEmail(true)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The invite could not be sent')
    } finally {
      setBusy(null)
    }
  }

  async function getLink() {
    setBusy('link')
    setError(null)
    try {
      const targetEmail = (person.profile_id ? (person.email ?? email) : email).trim().toLowerCase()
      const res = await generatePersonLoginLink(person, targetEmail)
      setLink({ url: res.action_link, existing: res.existing })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The link could not be generated')
    } finally {
      setBusy(null)
    }
  }

  return (
    <CardSection title="Expenses login">
      {person.profile_id ? (
        <>
          <p className="text-[12px] text-stone-700 leading-relaxed">
            Login active — they sign in at the portal with their email, see their own expense
            history and can submit claims.
          </p>
          <div className="mt-3 space-y-1.5">
            <div className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">
              Portal address
            </div>
            <CopyField value={portalUrl} label="portal-address" />
          </div>
          {isAdmin ? (
            <div className="mt-3">
              {link ? (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-[.12em] text-stone-500">
                    One-time set-password link
                  </div>
                  <CopyField value={link.url} label="signin-link" />
                  <p className="text-[10.5px] text-stone-500">
                    Single-use and short-lived — send it however you like. Generate a fresh one if
                    it expires before they use it.
                  </p>
                </div>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={busy !== null}
                    onClick={() => void getLink()}
                  >
                    {busy === 'link' ? 'Generating…' : 'Get a set-password link to send yourself'}
                  </Button>
                  <p className="text-[10.5px] text-stone-400 mt-1.5">
                    No email goes out — you copy the link and pass it on. Handy for a first sign-in
                    or a forgotten password.
                  </p>
                </>
              )}
            </div>
          ) : null}
        </>
      ) : sentEmail ? (
        <p className="text-[12px] text-mint-900 leading-relaxed">
          Invite sent — they choose a password from the email link, and their expense history is
          already waiting for them.
        </p>
      ) : link ? (
        <div className="space-y-1.5">
          <p className="text-[12px] text-stone-700 leading-relaxed">
            {link.existing
              ? 'This email already had a login — it is now linked to this person. Send them the set-password link below.'
              : 'Login created — nothing was emailed. Send them this link to choose their password:'}
          </p>
          <CopyField value={link.url} label="signin-link" />
          <p className="text-[10.5px] text-stone-500">
            Single-use and short-lived. Once they are set up they sign in at {portalUrl}.
          </p>
        </div>
      ) : isAdmin ? (
        <>
          <p className="text-[12px] text-stone-500 leading-relaxed mb-3">
            No login yet. Create one so they can see their expense history and submit claims —
            invite them by email, or take a link and send it yourself.
          </p>
          <Field label="Email for the login">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.org"
            />
          </Field>
          <div className="space-y-2 mt-3">
            <Button
              className="w-full"
              disabled={busy !== null || !emailValid}
              onClick={() => void getLink()}
            >
              {busy === 'link' ? 'Generating…' : 'Create login — copy a link to send yourself'}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              disabled={busy !== null || !emailValid}
              onClick={() => void inviteByEmail()}
            >
              {busy === 'email' ? 'Sending…' : 'Or send the invite email instead'}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-[12px] text-stone-500 leading-relaxed">
          No login yet — the Pulse admin can create one from this page.
        </p>
      )}
      {error ? (
        <div className="mt-3">
          <ErrorNotice message={error} />
        </div>
      ) : null}
    </CardSection>
  )
}
