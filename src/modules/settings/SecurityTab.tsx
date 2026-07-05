/**
 * Settings → Security — the trustee-facing summary of how the platform
 * protects the Assembly's data (the previous system's security was poor, so
 * this page exists to be shown to the board), plus the audit-log viewer for
 * pulse_admin with a before/after diff on every change.
 */
import { useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Input,
  LoadingRows,
  Select,
  cx,
} from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import type { AuditLogEntry } from '@/types/db'
import { fetchAuditEntities, fetchAuditLog } from './lib'
import { BeforeAfterDiff, RoleChip, SectionCard } from './components'

// ── Static content ───────────────────────────────────────────────────────────

const PRINCIPLES: Array<{ title: string; body: string }> = [
  {
    title: 'Deny by default',
    body: 'Row-level security is enabled on every table. No role can read or write anything unless a policy explicitly grants it — a missing rule means no access, never accidental access.',
  },
  {
    title: 'Invite-only sign-in',
    body: 'There is no open registration. Accounts exist only when a Pulse admin sends an invitation, and deactivating a user cuts off sign-in and every data grant at once.',
  },
  {
    title: 'Bank details encrypted and access logged',
    body: 'Bank account numbers, sort codes and NI numbers are encrypted at rest and masked on screen. The unmasked values are available only to Pulse payroll and admin through a dedicated function — and every single view is written to the audit trail.',
  },
  {
    title: 'A full audit trail',
    body: 'Every change to sensitive records — approvals, coding edits, settings, bank-detail views, import overrides — is captured append-only with who, when, and the before and after values. Audit rows cannot be edited or deleted from the app.',
  },
  {
    title: 'Xero sync is read-mostly',
    body: 'The nightly sync only reads from Xero. The single write path is creating draft bills from CEO-approved expense claims, always triggered by a person. Bank statement and investment postings are generated as CSVs for manual import — nothing is pushed silently.',
  },
  {
    title: 'Storage locked per role',
    body: 'Receipts can only be uploaded by the claimant into their own folder; import files are Pulse-only; board packs are readable strictly according to the reader’s fund visibility; onboarding documents are tied to their tokenised submission.',
  },
  {
    title: 'Rate-limited public surface',
    body: 'The only unauthenticated endpoint is tokenised onboarding. Tokens are single-use, they expire, and the endpoint is rate-limited. Everything else requires a signed-in session that expires.',
  },
]

const ROLE_ROWS: Array<{ role: 'pulse_admin' | 'pulse_bookkeeper' | 'pulse_payroll' | 'ceo' | 'trustee' | 'submitter'; access: string }> = [
  { role: 'pulse_admin', access: 'Everything, including settings, users and the audit trail' },
  { role: 'pulse_bookkeeper', access: 'Imports, expense processing, Xero sync, reports' },
  { role: 'pulse_payroll', access: 'Employee and volunteer records, onboarding, bank details (logged)' },
  { role: 'ceo', access: 'Expense approvals, all reports and fund flags, the two payment-cycle settings' },
  { role: 'trustee', access: 'Read-only — whole-board pack or only the funds they manage' },
  { role: 'submitter', access: 'Their own expense claims and their own profile, nothing else' },
]

export default function SecurityTab() {
  const { isAdmin } = usePermissions()

  return (
    <div className="space-y-4">
      {/* Trustee-facing summary */}
      <Card className="overflow-hidden">
        <div className="px-6 py-5 bg-indigo text-paper">
          <div className="text-[10px] uppercase tracking-[.18em] text-white/60">Security summary</div>
          <h2 className="font-display text-[22px] font-normal mt-1">How this platform protects the Assembly's data</h2>
          <p className="text-[12px] text-white/70 mt-1.5 max-w-2xl leading-relaxed">
            Built to be demonstrably watertight: locked down by default, encrypted where it matters, and logged
            everywhere. This page can be shown to the board as it stands.
          </p>
        </div>
        <div className="p-5 grid sm:grid-cols-2 gap-3">
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="rounded-card border border-stone-150 bg-paper p-4">
              <div className="text-[12.5px] font-medium text-ink">{p.title}</div>
              <p className="text-[11.5px] text-stone-500 leading-relaxed mt-1">{p.body}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Roles table */}
      <SectionCard title="Who can see what" hint="Six roles, each with the least access needed to do the job.">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[560px]">
            <thead>
              <tr>
                <th className="th-register">Role</th>
                <th className="th-register">Access</th>
              </tr>
            </thead>
            <tbody>
              {ROLE_ROWS.map((r) => (
                <tr key={r.role}>
                  <td className="td-register whitespace-nowrap">
                    <RoleChip role={r.role} />
                  </td>
                  <td className="td-register text-stone-700">{r.access}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Audit viewer — pulse_admin only */}
      {isAdmin ? <AuditViewer /> : null}
    </div>
  )
}

// ── Audit log viewer ─────────────────────────────────────────────────────────

function AuditViewer() {
  const [entity, setEntity] = useState('')
  const [action, setAction] = useState('')
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState({ entity: '', action: '', search: '' })
  const [limit, setLimit] = useState(50)
  const [openId, setOpenId] = useState<string | null>(null)

  const entitiesQuery = useSupabaseQuery(() => fetchAuditEntities(), [])
  const logQuery = useSupabaseQuery(
    () =>
      fetchAuditLog({
        entity: applied.entity || undefined,
        action: applied.action || undefined,
        search: applied.search || undefined,
        limit,
      }),
    [applied, limit],
  )

  const rows = logQuery.data ?? []

  return (
    <SectionCard
      title="Audit trail"
      hint="Append-only record of every sensitive change. Visible to the Pulse admin only."
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setApplied({ entity, action, search })}
        >
          Apply filters
        </Button>
      }
    >
      <div className="px-5 py-3.5 border-b border-stone-150 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="label-base">Entity</span>
          <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All entities</option>
            {(entitiesQuery.data ?? []).map((en) => (
              <option key={en} value={en}>
                {en}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="label-base">Action</span>
          <Select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            <option value="INSERT">Insert</option>
            <option value="UPDATE">Update</option>
            <option value="DELETE">Delete</option>
            <option value="bank_details_viewed">Bank details viewed</option>
          </Select>
        </label>
        <label className="block">
          <span className="label-base">Search</span>
          <Input
            value={search}
            placeholder="Entity, action or record id…"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setApplied({ entity, action, search })
            }}
          />
        </label>
      </div>

      {logQuery.loading && !logQuery.data ? (
        <LoadingRows cols={5} rows={8} />
      ) : logQuery.error ? (
        <div className="p-5">
          <ErrorNotice message={logQuery.error} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No audit entries match" hint="Loosen the filters, or the trail is simply quiet." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[680px]">
              <thead>
                <tr>
                  <th className="th-register">When</th>
                  <th className="th-register">Action</th>
                  <th className="th-register">Entity</th>
                  <th className="th-register">Record</th>
                  <th className="th-register">Actor</th>
                  <th className="th-register" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <AuditRow key={r.id} entry={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
                ))}
              </tbody>
            </table>
          </div>
          {rows.length >= limit ? (
            <div className="px-5 py-3 border-t border-stone-150 text-center">
              <Button size="sm" variant="quiet" onClick={() => setLimit((l) => l + 50)}>
                Load 50 more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </SectionCard>
  )
}

function AuditRow({ entry, open, onToggle }: { entry: AuditLogEntry; open: boolean; onToggle: () => void }) {
  const hasDiff = entry.before != null || entry.after != null
  return (
    <>
      <tr className={cx(open && 'bg-paper-2')}>
        <td className="td-register figure whitespace-nowrap">{formatDateTime(entry.created_at)}</td>
        <td className="td-register font-mono text-[11px]">{entry.action}</td>
        <td className="td-register font-mono text-[11px]">{entry.entity}</td>
        <td className="td-register font-mono text-[10.5px] max-w-[140px] truncate" title={entry.entity_id ?? undefined}>
          {entry.entity_id ?? '—'}
        </td>
        <td className="td-register font-mono text-[10.5px] max-w-[140px] truncate" title={entry.actor_id ?? undefined}>
          {entry.actor_id ?? 'system'}
        </td>
        <td className="td-register text-right">
          {hasDiff ? (
            <button onClick={onToggle} className="text-[11px] text-indigo font-medium hover:underline">
              {open ? 'Hide diff' : 'View diff'}
            </button>
          ) : null}
        </td>
      </tr>
      {open && hasDiff ? (
        <tr>
          <td colSpan={6} className="border-t border-stone-150 bg-paper px-4 py-3">
            <BeforeAfterDiff before={entry.before} after={entry.after} />
          </td>
        </tr>
      ) : null}
    </>
  )
}
