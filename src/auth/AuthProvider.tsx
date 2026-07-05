import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Profile, Role } from '@/types/db'

interface AuthContextValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  role: Role | null
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) {
        setSession(data.session)
        if (!data.session) setLoading(false)
      }
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      if (!next) {
        setProfile(null)
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!session?.user) return
    let cancelled = false
    supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setProfile((data as Profile | null) ?? null)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error ? error.message : null }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const requestPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    return { error: error ? error.message : null }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      profile,
      loading,
      role: profile?.role ?? null,
      signIn,
      signOut,
      requestPasswordReset,
    }),
    [session, profile, loading, signIn, signOut, requestPasswordReset],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/** Convenience role checks used across modules */
export function usePermissions() {
  const { role } = useAuth()
  const isPulse = role === 'pulse_admin' || role === 'pulse_bookkeeper' || role === 'pulse_payroll'
  return {
    role,
    isPulse,
    isAdmin: role === 'pulse_admin',
    isBookkeeper: role === 'pulse_bookkeeper',
    isPayroll: role === 'pulse_payroll',
    isCeo: role === 'ceo',
    isTrustee: role === 'trustee',
    isSubmitter: role === 'submitter',
    canSync: isPulse || role === 'ceo',
    canApprove: role === 'ceo',
    canEditSettings: role === 'pulse_admin' || role === 'ceo',
    canSeeReports: isPulse || role === 'ceo' || role === 'trustee',
  }
}
