/**
 * Public onboarding form — /onboard/:token. No login, no AppShell: the page
 * carries its own product lockup header and footer. Design ref docs/design/1h
 * — friendly and fast for non-technical volunteers: generous type, clear
 * progress, works beautifully on a phone, bank details explained in plain
 * English.
 *
 * Deliberately avoids useAuth/useSync/useSupabaseQuery — everything runs
 * through the public 'onboarding' edge function (validate/submit) plus a
 * direct storage upload for documents, degrading gracefully if the bucket
 * policy blocks anonymous uploads.
 */
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { useParams } from 'react-router-dom'
import { cx } from '@/components/ui'
import { invokeFunction } from '@/lib/supabase'
import type { PersonType } from '@/types/db'
import { uploadOnboardingDoc, type PersonDoc } from './lib'

// ── Form model ───────────────────────────────────────────────────────────────

interface FormState {
  first_name: string
  last_name: string
  date_of_birth: string
  email: string
  phone: string
  address: string
  role_title: string
  volunteer_capacity: string
  start_date: string
  bank_name: string
  bank_account: string
  bank_sort_code: string
  ni_number: string
  emergency_contact_name: string
  emergency_contact_phone: string
  documents: PersonDoc[]
}

const EMPTY_FORM: FormState = {
  first_name: '',
  last_name: '',
  date_of_birth: '',
  email: '',
  phone: '',
  address: '',
  role_title: '',
  volunteer_capacity: '',
  start_date: '',
  bank_name: '',
  bank_account: '',
  bank_sort_code: '',
  ni_number: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  documents: [],
}

type StepId = 'about' | 'role' | 'bank' | 'emergency' | 'documents' | 'review'

function stepsFor(personType: PersonType): StepId[] {
  return personType === 'employee'
    ? ['about', 'role', 'bank', 'emergency', 'documents', 'review']
    : ['about', 'role', 'emergency', 'documents', 'review']
}

// ── Drafts — saved on this device only, never the bank fields ────────────────

function draftKey(token: string): string {
  return `gaufcc-onboard-${token}`
}

function loadDraft(token: string): Partial<FormState> | null {
  try {
    const raw = localStorage.getItem(draftKey(token))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<FormState>
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function saveDraft(token: string, form: FormState): void {
  // Bank details and NI number are deliberately never written to this device.
  const { bank_name: _b, bank_account: _a, bank_sort_code: _s, ni_number: _n, ...safe } = form
  try {
    localStorage.setItem(draftKey(token), JSON.stringify(safe))
  } catch {
    // Storage full or unavailable — the form still works, it just won't
    // survive a closed tab.
  }
}

function clearDraft(token: string): void {
  try {
    localStorage.removeItem(draftKey(token))
  } catch {
    // ignore
  }
}

// ── Validation — friendly, amber, never alarming ─────────────────────────────

const onlyDigits = (s: string) => s.replace(/\D/g, '')

function validateStep(step: StepId, form: FormState, personType: PersonType): Partial<Record<keyof FormState, string>> {
  const errs: Partial<Record<keyof FormState, string>> = {}
  if (step === 'about') {
    if (!form.first_name.trim()) errs.first_name = 'We need your first name'
    if (!form.last_name.trim()) errs.last_name = 'And your last name'
    if (!/.+@.+\..+/.test(form.email.trim())) errs.email = 'That email address does not look right'
    if (!form.phone.trim()) errs.phone = 'A number helps if plans change on the day'
    if (personType === 'employee' && !form.date_of_birth)
      errs.date_of_birth = 'Payroll needs your date of birth'
    if (personType === 'employee' && !form.address.trim())
      errs.address = 'Payroll needs your home address'
  }
  if (step === 'role') {
    if (personType === 'employee' && !form.role_title.trim())
      errs.role_title = 'Your job title, as it appears in your offer'
    if (personType === 'volunteer' && !form.volunteer_capacity.trim())
      errs.volunteer_capacity = 'A few words about how you will be helping'
  }
  if (step === 'bank') {
    if (!form.bank_name.trim()) errs.bank_name = 'The name of your bank'
    if (onlyDigits(form.bank_account).length !== 8)
      errs.bank_account = 'Account numbers are 8 digits'
    if (onlyDigits(form.bank_sort_code).length !== 6)
      errs.bank_sort_code = 'Sort codes are 6 digits, like 12-34-56'
    if (!/^[A-Za-z]{2}\d{6}[A-Za-z]$/.test(form.ni_number.replace(/\s/g, '')))
      errs.ni_number = 'NI numbers look like QQ 12 34 56 C'
  }
  if (step === 'emergency') {
    if (!form.emergency_contact_name.trim()) errs.emergency_contact_name = 'Who should we call'
    if (!form.emergency_contact_phone.trim()) errs.emergency_contact_phone = 'And their number'
  }
  return errs
}

// ── Generous form primitives (local — the shared ones are sized for ops) ─────

function BigField({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="font-medium text-[15px] text-ink mb-2">{label}</div>
      {children}
      {error ? (
        <div className="text-warn-ink text-[12.5px] mt-1.5">{error}</div>
      ) : hint ? (
        <div className="text-stone-500 text-[12px] mt-1.5">{hint}</div>
      ) : null}
    </div>
  )
}

const bigInputClass = (hasError: boolean, mono: boolean) =>
  cx(
    'w-full bg-white border-[1.5px] rounded-[12px] px-4 py-3.5 text-[16px] text-ink placeholder:text-stone-400',
    'focus:outline-none focus:border-indigo transition-colors',
    mono && 'font-mono',
    hasError ? 'border-warn' : 'border-stone-300',
  )

function BigInput({
  error,
  mono = false,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { error?: string; mono?: boolean }) {
  return <input className={bigInputClass(Boolean(error), mono)} {...rest} />
}

function BigTextarea({
  error,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: string }) {
  return <textarea className={cx(bigInputClass(Boolean(error), false), 'min-h-24')} {...rest} />
}

function SavedNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-[12.5px] text-mint-900">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#04b894"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
      {children}
    </div>
  )
}

function LockNote({ children }: { children: ReactNode }) {
  return (
    <div className="bg-white border border-stone-150 rounded-[12px] px-5 py-4 flex gap-3.5 items-start">
      <div
        className="w-9 h-9 rounded-[10px] grid place-items-center flex-none"
        style={{ background: 'rgba(33,25,81,.07)' }}
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#211951"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <div className="text-[12.5px] leading-relaxed text-stone-700">{children}</div>
    </div>
  )
}

// ── Review helpers ───────────────────────────────────────────────────────────

function maskAccount(account: string): string {
  const d = onlyDigits(account)
  return d.length >= 4 ? `•••• ${d.slice(-4)}` : '••••'
}

function maskSortCode(sort: string): string {
  const d = onlyDigits(sort)
  return d.length === 6 ? `••-••-${d.slice(-2)}` : '••-••-••'
}

function maskNi(ni: string): string {
  const s = ni.replace(/\s/g, '').toUpperCase()
  return s.length >= 3 ? `${s.slice(0, 2)}••••••${s.slice(-1)}` : '••••'
}

function ReviewGroup({
  title,
  onEdit,
  rows,
}: {
  title: string
  onEdit: () => void
  rows: Array<[string, string]>
}) {
  return (
    <div className="bg-white border border-stone-150 rounded-[12px] px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="font-medium text-[14px] text-ink">{title}</div>
        <button
          type="button"
          onClick={onEdit}
          className="text-[12.5px] text-indigo underline underline-offset-2"
        >
          Edit
        </button>
      </div>
      <dl className="space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3 text-[13px]">
            <dt className="w-32 shrink-0 text-stone-500">{label}</dt>
            <dd className="text-ink break-words min-w-0">{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

type PageStatus = 'validating' | 'invalid' | 'ready' | 'done'

export default function OnboardingFormPage() {
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<PageStatus>('validating')
  const [personType, setPersonType] = useState<PersonType>('employee')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [stepIndex, setStepIndex] = useState(0)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [uploadBlocked, setUploadBlocked] = useState(false)
  const [uploadNote, setUploadNote] = useState<string | null>(null)

  const steps = useMemo(() => stepsFor(personType), [personType])
  const step = steps[Math.min(stepIndex, steps.length - 1)]

  // Validate the token, then restore any draft saved on this device.
  useEffect(() => {
    let cancelled = false
    if (!token) {
      setStatus('invalid')
      return
    }
    invokeFunction<{ valid: boolean; person_type?: PersonType; email?: string }>('onboarding', {
      action: 'validate',
      token,
    })
      .then((res) => {
        if (cancelled) return
        if (!res?.valid) {
          setStatus('invalid')
          return
        }
        const type = res.person_type ?? 'employee'
        setPersonType(type)
        const draft = loadDraft(token) ?? {}
        setForm({
          ...EMPTY_FORM,
          ...draft,
          documents: Array.isArray(draft.documents) ? draft.documents : [],
          email: draft.email || res.email || '',
        })
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // Keep the draft fresh (bank fields excluded — see saveDraft).
  useEffect(() => {
    if (status === 'ready' && token) saveDraft(token, form)
  }, [form, status, token])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e))
  }

  const goTo = (index: number) => {
    setStepIndex(index)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const next = () => {
    const errs = validateStep(step, form, personType)
    if (Object.values(errs).some(Boolean)) {
      setErrors(errs)
      return
    }
    setErrors({})
    goTo(stepIndex + 1)
  }

  const back = () => {
    setErrors({})
    goTo(Math.max(0, stepIndex - 1))
  }

  const jumpTo = (target: StepId) => {
    const i = steps.indexOf(target)
    if (i >= 0) goTo(i)
  }

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    e.target.value = ''
    if (!files || !token) return
    setUploadNote(null)
    for (const file of Array.from(files)) {
      if (file.size > 10 * 1024 * 1024) {
        setUploadNote(`${file.name} is over 10 MB — try a smaller photo or PDF.`)
        continue
      }
      setUploadingName(file.name)
      try {
        const path = await uploadOnboardingDoc(token, file)
        setForm((f) => ({ ...f, documents: [...f.documents, { name: file.name, storage_path: path }] }))
      } catch {
        setUploadBlocked(true)
      } finally {
        setUploadingName(null)
      }
    }
  }

  const submit = async () => {
    if (!token) return
    setSubmitting(true)
    setSubmitError(null)
    const payload: Record<string, unknown> = {
      person_type: personType,
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      date_of_birth: form.date_of_birth || null,
      email: form.email.trim(),
      phone: form.phone.trim(),
      address: form.address.trim() || null,
      start_date: form.start_date || null,
      emergency_contact_name: form.emergency_contact_name.trim(),
      emergency_contact_phone: form.emergency_contact_phone.trim(),
      documents: form.documents,
    }
    if (personType === 'employee') {
      const sort = onlyDigits(form.bank_sort_code)
      payload.role_title = form.role_title.trim()
      payload.bank_name = form.bank_name.trim()
      payload.bank_account = onlyDigits(form.bank_account)
      payload.bank_sort_code = `${sort.slice(0, 2)}-${sort.slice(2, 4)}-${sort.slice(4, 6)}`
      payload.ni_number = form.ni_number.replace(/\s/g, '').toUpperCase()
    } else {
      payload.volunteer_capacity = form.volunteer_capacity.trim()
    }
    try {
      const res = await invokeFunction<{ ok: boolean }>('onboarding', {
        action: 'submit',
        token,
        payload,
      })
      if (!res?.ok) throw new Error('The form could not be submitted')
      clearDraft(token)
      setStatus('done')
      window.scrollTo({ top: 0 })
    } catch (err) {
      setSubmitError(
        err instanceof Error && err.message !== 'The form could not be submitted'
          ? `Something went wrong sending your details — ${err.message}. Nothing was lost; please try again.`
          : 'Something went wrong sending your details. Nothing was lost; please try again in a moment.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  const showProgress = status === 'ready'

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      <header className="bg-indigo">
        <div className="max-w-2xl mx-auto px-5 sm:px-8 pt-6 pb-7">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-display text-paper text-[17px] leading-tight">GAUFCC Finance</div>
              <div className="text-white/45 text-[10.5px] font-mono mt-0.5">built by Pulse</div>
            </div>
            <span className="text-white/55 text-[11px] text-right">
              Secure link · expires in 7 days
            </span>
          </div>

          {showProgress ? (
            <>
              <h1 className="font-display text-paper text-[26px] font-normal mt-5 leading-tight">
                Welcome aboard{form.first_name.trim() ? `, ${form.first_name.trim()}` : ''}
              </h1>
              <p className="text-white/70 text-[13.5px] leading-relaxed mt-1.5">
                The Assembly needs a few details before you start. Nothing here is shared beyond
                the payroll team at Pulse.
              </p>
              <div className="flex items-center gap-3 mt-5">
                <div className="flex-1 h-[5px] rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${((stepIndex + 1) / steps.length) * 100}%`,
                      background: 'linear-gradient(90deg,#08f2c7,#1de4ff)',
                    }}
                  />
                </div>
                <span className="font-mono text-[11px] font-medium text-mint whitespace-nowrap">
                  Step {stepIndex + 1} of {steps.length}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-5 sm:px-8 py-8">
        {status === 'validating' ? <ValidatingScreen /> : null}
        {status === 'invalid' ? <InvalidScreen /> : null}
        {status === 'done' ? <SuccessScreen personType={personType} /> : null}

        {status === 'ready' ? (
          <div className="space-y-5">
            {stepIndex > 0 && step !== 'review' ? (
              <SavedNote>Your answers so far are saved on this device — you can come back later.</SavedNote>
            ) : null}

            {step === 'about' ? (
              <section className="space-y-5">
                <StepIntro
                  title="About you"
                  blurb="Just the basics — how we address you and how we reach you."
                />
                <div className="grid sm:grid-cols-2 gap-4">
                  <BigField label="First name" error={errors.first_name}>
                    <BigInput
                      value={form.first_name}
                      onChange={(e) => set('first_name', e.target.value)}
                      autoComplete="given-name"
                      error={errors.first_name}
                    />
                  </BigField>
                  <BigField label="Last name" error={errors.last_name}>
                    <BigInput
                      value={form.last_name}
                      onChange={(e) => set('last_name', e.target.value)}
                      autoComplete="family-name"
                      error={errors.last_name}
                    />
                  </BigField>
                </div>
                <BigField
                  label="Date of birth"
                  hint={personType === 'volunteer' ? 'Optional for volunteers.' : 'Payroll needs this to set you up.'}
                  error={errors.date_of_birth}
                >
                  <BigInput
                    type="date"
                    value={form.date_of_birth}
                    onChange={(e) => set('date_of_birth', e.target.value)}
                    autoComplete="bday"
                    mono
                    error={errors.date_of_birth}
                  />
                </BigField>
                <BigField label="Email" error={errors.email}>
                  <BigInput
                    type="email"
                    value={form.email}
                    onChange={(e) => set('email', e.target.value)}
                    autoComplete="email"
                    inputMode="email"
                    error={errors.email}
                  />
                </BigField>
                <BigField
                  label="Best phone number"
                  hint="Only used if plans change on the day."
                  error={errors.phone}
                >
                  <BigInput
                    type="tel"
                    value={form.phone}
                    onChange={(e) => set('phone', e.target.value)}
                    autoComplete="tel"
                    inputMode="tel"
                    placeholder="07…"
                    mono
                    error={errors.phone}
                  />
                </BigField>
                <BigField
                  label="Home address"
                  hint={personType === 'volunteer' ? 'Optional for volunteers.' : undefined}
                  error={errors.address}
                >
                  <BigTextarea
                    value={form.address}
                    onChange={(e) => set('address', e.target.value)}
                    autoComplete="street-address"
                    placeholder="House, street, town and postcode"
                    error={errors.address}
                  />
                </BigField>
              </section>
            ) : null}

            {step === 'role' ? (
              <section className="space-y-5">
                <StepIntro
                  title={personType === 'employee' ? 'Your role' : 'How you will be helping'}
                  blurb={
                    personType === 'employee'
                      ? 'How you will appear on payroll.'
                      : 'A line or two so we know where you fit.'
                  }
                />
                {personType === 'employee' ? (
                  <BigField label="Job title" error={errors.role_title}>
                    <BigInput
                      value={form.role_title}
                      onChange={(e) => set('role_title', e.target.value)}
                      placeholder="e.g. Programme coordinator"
                      error={errors.role_title}
                    />
                  </BigField>
                ) : (
                  <BigField label="Volunteer role" error={errors.volunteer_capacity}>
                    <BigInput
                      value={form.volunteer_capacity}
                      onChange={(e) => set('volunteer_capacity', e.target.value)}
                      placeholder="e.g. Youth panel helper"
                      error={errors.volunteer_capacity}
                    />
                  </BigField>
                )}
                <BigField label="Start date" hint="If you know it — otherwise leave blank.">
                  <BigInput
                    type="date"
                    value={form.start_date}
                    onChange={(e) => set('start_date', e.target.value)}
                    mono
                  />
                </BigField>
                {personType === 'employee' ? (
                  <LockNote>
                    <b className="text-ink">Next step is bank details</b>, so we can pay you and
                    repay your expenses. They are encrypted, shown to no one except Pulse payroll,
                    and every time anyone views them it is logged.
                  </LockNote>
                ) : null}
              </section>
            ) : null}

            {step === 'bank' ? (
              <section className="space-y-5">
                <StepIntro title="Getting you paid" blurb="The plain English version first." />
                <LockNote>
                  <span className="block">
                    <b className="text-ink">Why we ask</b> — these are how your salary and any
                    expenses reach your account.
                  </span>
                  <span className="block mt-1.5">
                    <b className="text-ink">Who can see them</b> — only the payroll team at Pulse
                    Accountants. Not trustees, not other staff.
                  </span>
                  <span className="block mt-1.5">
                    <b className="text-ink">How they are kept</b> — encrypted at rest, masked on
                    screen, and every view is logged. For safety they are never saved on this
                    device either.
                  </span>
                </LockNote>
                <BigField label="Bank name" error={errors.bank_name}>
                  <BigInput
                    value={form.bank_name}
                    onChange={(e) => set('bank_name', e.target.value)}
                    placeholder="e.g. Nationwide"
                    error={errors.bank_name}
                  />
                </BigField>
                <div className="grid sm:grid-cols-2 gap-4">
                  <BigField label="Account number" hint="8 digits." error={errors.bank_account}>
                    <BigInput
                      value={form.bank_account}
                      onChange={(e) => set('bank_account', e.target.value)}
                      inputMode="numeric"
                      placeholder="12345678"
                      mono
                      error={errors.bank_account}
                    />
                  </BigField>
                  <BigField label="Sort code" hint="Like 12-34-56." error={errors.bank_sort_code}>
                    <BigInput
                      value={form.bank_sort_code}
                      onChange={(e) => set('bank_sort_code', e.target.value)}
                      inputMode="numeric"
                      placeholder="12-34-56"
                      mono
                      error={errors.bank_sort_code}
                    />
                  </BigField>
                </div>
                <BigField
                  label="National Insurance number"
                  hint="On your payslips or NI letter — like QQ 12 34 56 C."
                  error={errors.ni_number}
                >
                  <BigInput
                    value={form.ni_number}
                    onChange={(e) => set('ni_number', e.target.value)}
                    placeholder="QQ 12 34 56 C"
                    mono
                    error={errors.ni_number}
                  />
                </BigField>
              </section>
            ) : null}

            {step === 'emergency' ? (
              <section className="space-y-5">
                <StepIntro
                  title="Emergency contact"
                  blurb="Someone we can ring if anything happens while you are with us."
                />
                <BigField label="Their name" error={errors.emergency_contact_name}>
                  <BigInput
                    value={form.emergency_contact_name}
                    onChange={(e) => set('emergency_contact_name', e.target.value)}
                    placeholder="e.g. Anita Patel"
                    error={errors.emergency_contact_name}
                  />
                </BigField>
                <BigField label="Their number" error={errors.emergency_contact_phone}>
                  <BigInput
                    type="tel"
                    value={form.emergency_contact_phone}
                    onChange={(e) => set('emergency_contact_phone', e.target.value)}
                    inputMode="tel"
                    placeholder="07…"
                    mono
                    error={errors.emergency_contact_phone}
                  />
                </BigField>
              </section>
            ) : null}

            {step === 'documents' ? (
              <section className="space-y-5">
                <StepIntro
                  title="Documents"
                  blurb={
                    personType === 'employee'
                      ? 'Right to work — a photo of your passport, or a screenshot of your share code. Add a DBS certificate too if your role needs one.'
                      : 'If your role needs a DBS check, add your certificate here. Nothing to upload? Just continue — you can email documents later.'
                  }
                />
                {!uploadBlocked ? (
                  <label className="block border-2 border-dashed border-stone-300 rounded-[12px] bg-white px-6 py-10 text-center cursor-pointer hover:border-indigo transition-colors">
                    <input
                      type="file"
                      multiple
                      accept="image/*,.pdf"
                      className="sr-only"
                      onChange={(e) => void onFiles(e)}
                    />
                    <div className="text-[15px] font-medium text-ink">
                      {uploadingName ? `Uploading ${uploadingName}…` : 'Tap to add a photo or PDF'}
                    </div>
                    <div className="text-stone-500 text-[12.5px] mt-1">
                      Up to 10 MB each. Photos taken on your phone are fine.
                    </div>
                  </label>
                ) : (
                  <div className="rounded-[12px] border border-warn/50 bg-warn/10 px-5 py-4 text-[13px] text-warn-ink leading-relaxed">
                    Uploads are not working right now — no problem. Finish the form and email your
                    documents to the payroll team instead; the address is in your invite email.
                  </div>
                )}
                {uploadNote ? (
                  <div className="text-[12.5px] text-warn-ink">{uploadNote}</div>
                ) : null}
                {form.documents.length > 0 ? (
                  <ul className="space-y-2">
                    {form.documents.map((doc) => (
                      <li
                        key={doc.storage_path}
                        className="flex items-center justify-between gap-3 bg-white border border-stone-150 rounded-[12px] px-4 py-3"
                      >
                        <span className="text-[13.5px] text-ink truncate" title={doc.name}>
                          {doc.name}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              documents: f.documents.filter(
                                (d) => d.storage_path !== doc.storage_path,
                              ),
                            }))
                          }
                          className="text-[12.5px] text-stone-500 hover:text-ink underline underline-offset-2 shrink-0"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-[12px] text-stone-500">
                  This step is optional — the payroll team will chase anything missing.
                </p>
              </section>
            ) : null}

            {step === 'review' ? (
              <section className="space-y-4">
                <StepIntro
                  title="Check and send"
                  blurb="A quick look before it goes to the payroll team."
                />
                <ReviewGroup
                  title="About you"
                  onEdit={() => jumpTo('about')}
                  rows={[
                    ['Name', `${form.first_name.trim()} ${form.last_name.trim()}`.trim()],
                    ['Date of birth', form.date_of_birth],
                    ['Email', form.email.trim()],
                    ['Phone', form.phone.trim()],
                    ['Address', form.address.trim()],
                  ]}
                />
                <ReviewGroup
                  title={personType === 'employee' ? 'Your role' : 'How you will be helping'}
                  onEdit={() => jumpTo('role')}
                  rows={[
                    [
                      personType === 'employee' ? 'Job title' : 'Volunteer role',
                      personType === 'employee'
                        ? form.role_title.trim()
                        : form.volunteer_capacity.trim(),
                    ],
                    ['Start date', form.start_date],
                  ]}
                />
                {personType === 'employee' ? (
                  <ReviewGroup
                    title="Getting you paid"
                    onEdit={() => jumpTo('bank')}
                    rows={[
                      ['Bank', form.bank_name.trim()],
                      ['Account', maskAccount(form.bank_account)],
                      ['Sort code', maskSortCode(form.bank_sort_code)],
                      ['NI number', maskNi(form.ni_number)],
                    ]}
                  />
                ) : null}
                <ReviewGroup
                  title="Emergency contact"
                  onEdit={() => jumpTo('emergency')}
                  rows={[
                    ['Name', form.emergency_contact_name.trim()],
                    ['Phone', form.emergency_contact_phone.trim()],
                  ]}
                />
                <ReviewGroup
                  title="Documents"
                  onEdit={() => jumpTo('documents')}
                  rows={[
                    [
                      'Uploaded',
                      form.documents.length === 0
                        ? 'None — can be emailed later'
                        : form.documents.map((d) => d.name).join(', '),
                    ],
                  ]}
                />

                <label className="flex items-start gap-3 bg-white border border-stone-150 rounded-[12px] px-5 py-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5 w-5 h-5 accent-[#211951]"
                  />
                  <span className="text-[13.5px] text-stone-700 leading-relaxed">
                    These details are correct, and I am happy for the Assembly and Pulse
                    Accountants to store them for payroll and volunteering admin.
                  </span>
                </label>

                {submitError ? (
                  <div className="rounded-[12px] border border-warn/50 bg-warn/10 px-5 py-4 text-[13px] text-warn-ink leading-relaxed">
                    {submitError}
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* Step controls */}
            <div className="flex gap-3 pt-2">
              {stepIndex > 0 ? (
                <button
                  type="button"
                  onClick={back}
                  className="rounded-full border border-stone-300 px-6 py-3.5 text-[14.5px] font-medium text-stone-700 hover:bg-paper-2 transition-colors"
                >
                  Back
                </button>
              ) : null}
              {step === 'review' ? (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!confirmed || submitting}
                  className="flex-1 rounded-full bg-mint text-indigo font-semibold px-6 py-3.5 text-[14.5px] hover:brightness-95 transition disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Sending…' : 'Send to the payroll team'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={next}
                  className="flex-1 rounded-full bg-indigo text-paper font-medium px-6 py-3.5 text-[14.5px] hover:bg-indigo-soft transition-colors"
                >
                  Continue
                </button>
              )}
            </div>
          </div>
        ) : null}
      </main>

      <footer className="w-full max-w-2xl mx-auto px-5 sm:px-8 pb-10">
        <p className="text-[11.5px] text-stone-500 leading-relaxed border-t border-stone-150 pt-5">
          Your details are held securely by Pulse Accountants on behalf of the General Assembly of
          Unitarian and Free Christian Churches, used only for payroll and volunteering admin, and
          never shared beyond the payroll team. You can ask to see, correct or remove them at any
          time.
        </p>
      </footer>
    </div>
  )
}

// ── Screens ──────────────────────────────────────────────────────────────────

function StepIntro({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h2 className="font-display text-[22px] text-ink leading-tight">{title}</h2>
      <p className="text-stone-500 text-[13.5px] leading-relaxed mt-1">{blurb}</p>
    </div>
  )
}

function ValidatingScreen() {
  return (
    <div className="py-16 text-center" role="status" aria-live="polite">
      <div className="mx-auto w-40 h-4 rounded-full bg-stone-150 animate-pulse" />
      <div className="mx-auto mt-3 w-56 h-4 rounded-full bg-stone-150 animate-pulse" />
      <p className="text-stone-500 text-[13px] mt-6">Checking your link…</p>
    </div>
  )
}

function InvalidScreen() {
  return (
    <div className="py-12 text-center max-w-md mx-auto">
      <div
        className="mx-auto w-12 h-12 rounded-full grid place-items-center"
        style={{ background: 'rgba(33,25,81,.07)' }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#211951"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <h2 className="font-display text-[22px] text-ink mt-5">This link is not working</h2>
      <p className="text-stone-500 text-[13.5px] leading-relaxed mt-2">
        It may have expired — invite links last 7 days — or it may already have been used. Ask the
        person who invited you to send a fresh one; it only takes them a minute.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-6 rounded-full border border-stone-300 px-6 py-3 text-[13.5px] font-medium text-stone-700 hover:bg-paper-2 transition-colors"
      >
        Try again
      </button>
    </div>
  )
}

function SuccessScreen({ personType }: { personType: PersonType }) {
  return (
    <div className="py-10 max-w-md mx-auto text-center">
      <div className="mx-auto w-14 h-14 rounded-full bg-mint grid place-items-center">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#211951"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
      <h2 className="font-display text-[24px] text-ink mt-5">All done — thank you</h2>
      <p className="text-stone-500 text-[13.5px] leading-relaxed mt-2">
        Your details are with the payroll team at Pulse. Here is what happens next.
      </p>
      <ol className="text-left mt-6 space-y-3">
        {[
          'The payroll team checks your details, usually within two working days.',
          'If anything needs a second look, they will call the number you gave.',
          personType === 'employee'
            ? 'Once verified, you are set up for payroll and you will get a sign-in invite by email for claiming expenses.'
            : 'Once verified, you will get a sign-in invite by email so you can claim any expenses.',
        ].map((item, i) => (
          <li
            key={i}
            className="flex gap-3.5 bg-white border border-stone-150 rounded-[12px] px-5 py-4"
          >
            <span className="font-mono text-[13px] text-stone-400 pt-px">{i + 1}</span>
            <span className="text-[13.5px] text-stone-700 leading-relaxed">{item}</span>
          </li>
        ))}
      </ol>
      <p className="text-stone-500 text-[12.5px] mt-6">You can safely close this page now.</p>
    </div>
  )
}
