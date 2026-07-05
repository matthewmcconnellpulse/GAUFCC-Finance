import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { supabase, invokeFunction } from '@/lib/supabase'
import { useAuth } from '@/auth/AuthProvider'
import type { SyncRun } from '@/types/db'

interface SyncContextValue {
  lastSyncedAt: string | null
  syncing: boolean
  /** bump this to tell data hooks to refetch after a completed sync */
  refreshToken: number
  refreshNow: () => Promise<void>
  error: string | null
}

const SyncContext = createContext<SyncContextValue | null>(null)

export function SyncProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const loadLast = useCallback(async () => {
    const { data } = await supabase
      .from('sync_runs')
      .select('*')
      .eq('status', 'success')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const run = data as SyncRun | null
    if (run?.finished_at) setLastSyncedAt(run.finished_at)
  }, [])

  useEffect(() => {
    if (session) void loadLast()
  }, [session, loadLast])

  const refreshNow = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setError(null)
    try {
      // Server-side debounced to one run per 5 minutes
      await invokeFunction('sync-now', {})
      await loadLast()
      setRefreshToken((t) => t + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }, [syncing, loadLast])

  const value = useMemo(
    () => ({ lastSyncedAt, syncing, refreshToken, refreshNow, error }),
    [lastSyncedAt, syncing, refreshToken, refreshNow, error],
  )

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error('useSync must be used inside SyncProvider')
  return ctx
}
