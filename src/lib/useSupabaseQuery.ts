import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { useSync } from '@/sync/SyncProvider'

interface QueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Small data hook used across modules. Refetches automatically when a manual
 * "Refresh now" sync completes (via the sync refreshToken) and when `deps`
 * change. The fetcher should throw on error.
 */
export function useSupabaseQuery<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList = [],
): QueryState<T> {
  const { refreshToken } = useSync()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetcherRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Something went wrong')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refreshToken, tick])

  const refetch = useCallback(() => setTick((t) => t + 1), [])

  return { data, loading, error, refetch }
}
