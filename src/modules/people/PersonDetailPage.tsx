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
  docsFromSubmissions,
  fetchPerson,
  fetchSubmissions,
  revealBankDetails,
  setOnboardingStatus,
  signedDocUrl,
  type PersonBankDetails,
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
      />

      <div className="grid lg:grid-cols-3 gap-4 items-start">
        {/* Left — the record */}
        <div className="lg:col-span-2 space-y-4">
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
