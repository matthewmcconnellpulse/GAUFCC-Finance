/**
 * People module — fetch helpers, invite creation, audited bank reveal,
 * document helpers and the payroll CSV export.
 *
 * Owned by the people slice; other modules should not import from here.
 *
 * Server dependencies (provided by the migrations agent):
 *  · rpc create_onboarding_token(p_email text, p_person_type text,
 *      p_full_name text) returns text — SECURITY DEFINER, restricted to
 *      pulse_admin / pulse_payroll. Creates the onboarding_tokens row
 *      (service-role-only table), plus the matching `people` row with
 *      onboarding_status 'invited', and returns the raw token for the link.
 *  · rpc get_person_bank_details(p_person_id uuid) — payroll/admin only,
 *      every call is audit-logged server-side.
 */
import { invokeFunction, supabase } from '@/lib/supabase'
import type { OnboardingStatus, OnboardingSubmission, Person, PersonType } from '@/types/db'

// ── Pipeline stages ──────────────────────────────────────────────────────────

export const ONBOARDING_STAGES: OnboardingStatus[] = [
  'invited',
  'in_progress',
  'submitted',
  'verified',
  'complete',
]

export const STAGE_LABELS: Record<OnboardingStatus, string> = {
  invited: 'Invited',
  in_progress: 'In progress',
  submitted: 'Submitted',
  verified: 'Verified',
  complete: 'Complete',
}

export const STAGE_HINTS: Record<OnboardingStatus, string> = {
  invited: 'Link sent, form not started',
  in_progress: 'Form under way',
  submitted: 'Awaiting payroll checks',
  verified: 'Details checked',
  complete: 'Payroll setup finished',
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

export async function fetchPeople(): Promise<Person[]> {
  const { data, error } = await supabase
    .from('people')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as Person[]
}

export async function fetchPerson(id: string): Promise<Person | null> {
  const { data, error } = await supabase.from('people').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Person | null) ?? null
}

/** Editable person fields — payroll + admin (RLS people_update). */
export type PersonPatch = Partial<
  Pick<
    Person,
    | 'first_name'
    | 'last_name'
    | 'email'
    | 'phone'
    | 'address'
    | 'date_of_birth'
    | 'role_title'
    | 'volunteer_capacity'
    | 'start_date'
    | 'emergency_contact_name'
    | 'emergency_contact_phone'
  >
>

export async function updatePerson(id: string, patch: PersonPatch): Promise<void> {
  const { error } = await supabase.from('people').update(patch).eq('id', id)
  if (error) throw new Error(error.message)
}

/**
 * Create a login for an employee/volunteer: sends a Supabase invite email
 * (they choose their password from the link), creates a submitter profile and
 * links people.profile_id so their expense history follows them.
 * Pulse admin only (the invite-user function enforces it).
 */
export async function createPersonLogin(person: Person, email: string): Promise<void> {
  await invokeFunction('invite-user', {
    email,
    full_name: `${person.first_name} ${person.last_name}`.trim(),
    role: 'submitter',
    organisation: 'gaufcc',
    person_id: person.id,
  })
}

export async function fetchSubmissions(personId: string): Promise<OnboardingSubmission[]> {
  const { data, error } = await supabase
    .from('onboarding_submissions')
    .select('*')
    .eq('person_id', personId)
    .order('submitted_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as OnboardingSubmission[]
}

// ── Invites ──────────────────────────────────────────────────────────────────

/**
 * Create an onboarding invite. The onboarding_tokens table is service-role
 * only, so the row is created via the SECURITY DEFINER rpc described in the
 * file header. Returns the raw token used to build the shareable link.
 */
export async function createOnboardingInvite(input: {
  email: string
  personType: PersonType
  fullName: string
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_onboarding_token', {
    p_email: input.email.trim(),
    p_person_type: input.personType,
    p_full_name: input.fullName.trim(),
  })
  if (error) throw new Error(error.message)
  const token =
    typeof data === 'string' ? data : ((data as { token?: string } | null)?.token ?? null)
  if (!token) throw new Error('The invite could not be created — no token was returned')
  return token
}

export function onboardingLink(token: string): string {
  return `${window.location.origin}/onboard/${token}`
}

// ── Status advance (verify → complete) ──────────────────────────────────────

export async function setOnboardingStatus(
  personId: string,
  status: OnboardingStatus,
): Promise<void> {
  const { error } = await supabase
    .from('people')
    .update({ onboarding_status: status })
    .eq('id', personId)
  if (error) throw new Error(error.message)
}

// ── Bank details (audited reveal) ────────────────────────────────────────────

export interface PersonBankDetails {
  bank_name: string | null
  bank_account: string | null
  bank_sort_code: string | null
  ni_number: string | null
}

export async function revealBankDetails(personId: string): Promise<PersonBankDetails> {
  const { data, error } = await supabase.rpc('get_person_bank_details', {
    p_person_id: personId,
  })
  if (error) throw new Error(error.message)
  const row = Array.isArray(data)
    ? (data[0] as PersonBankDetails | undefined)
    : (data as PersonBankDetails | null)
  if (!row) throw new Error('No bank details are held for this person')
  return row
}

// ── Documents ────────────────────────────────────────────────────────────────
// Onboarding uploads land in the people-docs bucket under onboarding/<token>/.
// The submitted payload records each file's storage path, which is how the
// detail page finds them (onboarding_tokens is not client-readable).

export interface PersonDoc {
  name: string
  storage_path: string
}

export function docsFromSubmissions(submissions: OnboardingSubmission[]): PersonDoc[] {
  const seen = new Set<string>()
  const docs: PersonDoc[] = []
  for (const sub of submissions) {
    const raw = (sub.payload as { documents?: unknown } | null)?.documents
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const { name, storage_path } = item as { name?: unknown; storage_path?: unknown }
      if (typeof storage_path !== 'string' || seen.has(storage_path)) continue
      seen.add(storage_path)
      docs.push({
        name: typeof name === 'string' && name ? name : (storage_path.split('/').pop() ?? 'Document'),
        storage_path,
      })
    }
  }
  return docs
}

export async function signedDocUrl(storagePath: string, expiresIn = 3600): Promise<string> {
  const path = storagePath.startsWith('people-docs/')
    ? storagePath.slice('people-docs/'.length)
    : storagePath
  const { data, error } = await supabase.storage.from('people-docs').createSignedUrl(path, expiresIn)
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'The document could not be opened')
  return data.signedUrl
}

/** Upload from the public onboarding form. Path: onboarding/<token>/<file>. */
export async function uploadOnboardingDoc(token: string, file: File): Promise<string> {
  const safeName = file.name.replace(/[^\w.\- ]+/g, '_')
  const path = `onboarding/${token}/${Date.now()}-${safeName}`
  const { error } = await supabase.storage.from('people-docs').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(error.message)
  return path
}

// ── Payroll export (client-side CSV) ─────────────────────────────────────────

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** CSV of verified people — name, start date, role, masked bank. */
export function payrollCsv(people: Person[]): string {
  const header = [
    'Name',
    'Type',
    'Role or capacity',
    'Start date',
    'Status',
    'Bank name',
    'Account (masked)',
    'Sort code (masked)',
  ]
  const rows = people.map((p) => [
    `${p.first_name} ${p.last_name}`.trim(),
    p.type === 'employee' ? 'Employee' : 'Volunteer',
    (p.type === 'employee' ? p.role_title : p.volunteer_capacity) ?? '',
    p.start_date ?? '',
    STAGE_LABELS[p.onboarding_status],
    p.type === 'employee' ? (p.bank_name ?? '') : '',
    p.type === 'employee' ? (p.bank_account_masked ?? '') : '',
    p.type === 'employee' ? (p.bank_sort_code_masked ?? '') : '',
  ])
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function downloadTextFile(fileName: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
