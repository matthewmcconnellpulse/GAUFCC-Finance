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
import type { ModuleKey, Profile, Role } from '@/types/db'

interface AuthContextValue {
  session: Session | null
  profile: Profile | null
  loading: boolean
  role: Role | null
  /**
   * Module grants held by this user, on top of what their role implies.
   * Additive and read-only: a grant opens a part of the system to look at, it
   * never widens what anyone may do there.
   */
  modules: Set<ModuleKey>
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [modules, setModules] = useState<Set<ModuleKey>>(new Set())
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
        setModules(new Set())
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
    const userId = session.user.id
    // Profile and grants together: the sidebar cannot be drawn correctly from
    // the role alone, and drawing it twice would flash the wrong menu.
    void Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('profile_modules').select('module').eq('profile_id', userId),
    ]).then(([profileRes, moduleRes]) => {
      if (cancelled) return
      setProfile((profileRes.data as Profile | null) ?? null)
      setModules(
        new Set(
          ((moduleRes.data ?? []) as Array<{ module: string }>).map((r) => r.module as ModuleKey),
        ),
      )
      setLoading(false)
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
      modules,
      signIn,
      signOut,
      requestPasswordReset,
    }),
    [session, profile, modules, loading, signIn, signOut, requestPasswordReset],
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
  const { role, modules } = useAuth()
  const isPulse = role === 'pulse_admin' || role === 'pulse_bookkeeper' || role === 'pulse_payroll'
  /**
   * Whether this person can open a part of the system: their role allows it,
   * or they hold an explicit grant for it. Grants only ever open a door —
   * every canEdit/canApprove check below stays on the role, so a grant cannot
   * turn into the ability to move money.
   */
  const hasModule = (key: ModuleKey) => modules.has(key)
  return {
    role,
    modules,
    hasModule,
    isPulse,
    isAdmin: role === 'pulse_admin',
    isBookkeeper: role === 'pulse_bookkeeper',
    isPayroll: role === 'pulse_payroll',
    isCeo: role === 'ceo',
    isTrustee: role === 'trustee',
    isSubmitter: role === 'submitter',
    canSync: isPulse || role === 'ceo',
    // Sign-off: the CEO, or the Pulse admin standing in (audit-logged either way)
    canApprove: role === 'ceo' || role === 'pulse_admin',
    canEditSettings: role === 'pulse_admin' || role === 'ceo',
    canSeeFunds: isPulse || role === 'ceo' || role === 'trustee' || hasModule('funds'),
    canSeeReports: isPulse || role === 'ceo' || role === 'trustee' || hasModule('reports'),
    canSeeFinancials: isPulse || role === 'ceo' || role === 'trustee' || hasModule('financials'),
    canSeeCashflow: isPulse || role === 'ceo' || hasModule('cashflow'),
    canSeeMonthEnd: isPulse || role === 'ceo' || role === 'trustee' || hasModule('month_end'),
    canSeeVat: isPulse || role === 'ceo' || role === 'trustee' || hasModule('vat'),
    canSeeProjects: isPulse || role === 'ceo' || hasModule('projects'),
    canSeePeople: role === 'pulse_admin' || role === 'pulse_payroll' || role === 'ceo' || hasModule('people'),
    canSeeImports: isPulse || hasModule('imports'),
  }
}
