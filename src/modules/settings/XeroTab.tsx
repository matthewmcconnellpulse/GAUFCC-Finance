/**
 * Settings → Xero — connection status card with "Test connection"
 * (pulse_admin + CEO) and "Sync now", plus the sync_runs history register
 * with expandable error detail. The sync is read-mostly: the only write back
 * to Xero is bills created from approved expense claims.
 */
import { useState } from 'react'
import { usePermissions } from '@/auth/AuthProvider'
import { Button, EmptyState, ErrorNotice, LoadingRows, StatusChip, cx } from '@/components/ui'
import { formatDateTime, timeAgo } from '@/lib/format'
import { invokeFunction } from '@/lib/supabase'
import { useSupabaseQuery } from '@/lib/useSupabaseQuery'
import { useSync } from '@/sync/SyncProvider'
import type { SyncRun } from '@/types/db'
import { fetchSyncRuns, fetchXeroConnection } from './lib'
import { SectionCard } from './components'
import BudgetSection from './BudgetSection'

interface TestResult {
  ok: boolean
  org_name?: string
  error?: string
}

const CONNECTION_TONES: Record<string, 'live' | 'neutral' | 'danger'> = {
  connected: 'live',
  disconnected: 'neutral',
  error: 'danger',
}

export default function XeroTab() {
  const { isAdmin, isCeo, canSync } = usePermissions()
  const canTest = isAdmin || isCeo
  const { refreshNow, syncing } = useSync()

  const connQuery = useSupabaseQuery(() => fetchXeroConnection(), [])
  const runsQuery = useSupabaseQuery(() => fetchSyncRuns(30), [])

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      setTestResult(await invokeFunction<TestResult>('xero-test-connection', {}))
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'The connection test could not run')
    } finally {
      setTesting(false)
    }
  }

  const conn = connQuery.data

  return (
    <div className="space-y-4">
      {/* Connection card */}
      <SectionCard
        title="Xero connection"
        hint="Read: transactions, ledger, contacts and both tracking categories. Write: bills from approved expenses only — nothing else touches Xero."
        actions={
          <div className="flex items-center gap-2">
            {canTest ? (
              <Button size="sm" variant="ghost" disabled={testing} onClick={() => void testConnection()}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
            ) : null}
            {canSync ? (
              <Button size="sm" variant="money" disabled={syncing} onClick={() => void refreshNow()}>
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="p-5">
          {connQuery.loading && !conn ? (
            <LoadingRows cols={3} rows={2} />
          ) : connQuery.error ? (
            <ErrorNotice message={connQuery.error} />
          ) : !conn ? (
            <EmptyState
              title="No Xero connection yet"
              hint="The connection is established server-side by the Pulse team during deployment."
            />
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <div className="label-base">Status</div>
                <StatusChip tone={CONNECTION_TONES[conn.status] ?? 'neutral'}>{conn.status}</StatusChip>
              </div>
              <div>
                <div className="label-base">Connection type</div>
                <div className="text-[12.5px] text-ink">
                  {conn.connection_type === 'custom_connection' ? 'Custom connection' : 'OAuth 2.0'}
                </div>
              </div>
              <div>
                <div className="label-base">Last sync</div>
                <div className="figure text-[12.5px] text-ink">{formatDateTime(conn.last_sync_at)}</div>
                <div className="text-[10.5px] text-stone-500">{timeAgo(conn.last_sync_at)}</div>
              </div>
              <div>
                <div className="label-base">Tenant</div>
                <div className="figure text-[11px] text-stone-500 break-all">{conn.tenant_id ?? '—'}</div>
              </div>
              {conn.last_error ? (
                <div className="sm:col-span-2 lg:col-span-4">
                  <ErrorNotice message={`Last error: ${conn.last_error}`} />
                </div>
              ) : null}
            </div>
          )}

          {testResult ? (
            <div
              className={cx(
                'mt-4 rounded-card border px-4 py-3 text-[12.5px]',
                testResult.ok
                  ? 'border-mint-700/40 bg-mint/10 text-mint-900'
                  : 'border-danger/30 bg-danger/5 text-danger-ink',
              )}
            >
              {testResult.ok
                ? `Connection verified${testResult.org_name ? ` — connected to ${testResult.org_name}` : ''}.`
                : `Connection failed${testResult.error ? `: ${testResult.error}` : '.'}`}
            </div>
          ) : null}
          {testError ? (
            <div className="mt-4">
              <ErrorNotice message={testError} />
            </div>
          ) : null}
        </div>
      </SectionCard>

      {/* Sync history */}
      <SectionCard title="Sync history" hint="Nightly cron plus manual refreshes — every run is logged.">
        {runsQuery.loading && !runsQuery.data ? (
          <LoadingRows cols={5} rows={6} />
        ) : runsQuery.error ? (
          <div className="p-5">
            <ErrorNotice message={runsQuery.error} />
          </div>
        ) : (runsQuery.data ?? []).length === 0 ? (
          <EmptyState title="No syncs yet" hint="Runs appear here after the first nightly sync or manual refresh." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[640px]">
              <thead>
                <tr>
                  <th className="th-register">Started</th>
                  <th className="th-register">Trigger</th>
                  <th className="th-register">Status</th>
                  <th className="th-register text-right">Records</th>
                  <th className="th-register text-right">Duration</th>
                  <th className="th-register" />
                </tr>
              </thead>
              <tbody>
                {(runsQuery.data ?? []).map((run) => (
                  <RunRow key={run.id} run={run} open={openRun === run.id} onToggle={() => setOpenRun(openRun === run.id ? null : run.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* What the board pack tracks against */}
      <BudgetSection />
    </div>
  )
}

function RunRow({ run, open, onToggle }: { run: SyncRun; open: boolean; onToggle: () => void }) {
  const errorCount = Array.isArray(run.errors) ? run.errors.length : 0
  const duration =
    run.finished_at != null
      ? `${Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000))}s`
      : '—'
  return (
    <>
      <tr className={cx(errorCount > 0 && 'bg-warn/5')}>
        <td className="td-register figure whitespace-nowrap">{formatDateTime(run.started_at)}</td>
        <td className="td-register">{run.trigger === 'cron' ? 'Nightly' : 'Manual'}</td>
        <td className="td-register">
          <StatusChip tone={run.status === 'success' ? 'good' : run.status === 'running' ? 'live' : 'danger'}>
            {run.status}
          </StatusChip>
        </td>
        <td className="td-register figure text-right">{run.records_upserted.toLocaleString('en-GB')}</td>
        <td className="td-register figure text-right">{duration}</td>
        <td className="td-register text-right">
          {errorCount > 0 ? (
            <button onClick={onToggle} className="text-[11px] text-warn-ink font-medium hover:underline">
              {errorCount} error{errorCount === 1 ? '' : 's'} {open ? '▴' : '▾'}
            </button>
          ) : null}
        </td>
      </tr>
      {open && errorCount > 0 ? (
        <tr>
          <td colSpan={6} className="border-t border-stone-150 bg-warn/5 px-4 py-3">
            <pre className="font-mono text-[10.5px] text-warn-ink whitespace-pre-wrap break-all max-h-52 overflow-y-auto">
              {JSON.stringify(run.errors, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  )
}
