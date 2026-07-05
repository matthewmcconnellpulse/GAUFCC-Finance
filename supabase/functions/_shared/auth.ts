/**
 * Caller identity + role checks for JWT-verified edge functions.
 * Uses the service-role client for privileged reads/writes AFTER the
 * caller's role has been checked — never expose it to caller-controlled
 * queries directly.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export type Role =
  | 'pulse_admin'
  | 'pulse_bookkeeper'
  | 'pulse_payroll'
  | 'ceo'
  | 'trustee'
  | 'submitter'

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

export interface Caller {
  userId: string
  role: Role
  email: string | null
}

/**
 * Resolve the calling user from the request's JWT and load their role from
 * `profiles`. Throws a Response-able error string on failure.
 */
export async function getCaller(req: Request): Promise<Caller | null> {
  const authHeader = req.headers.get('Authorization') ?? ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  if (!jwt) return null

  const anon = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { auth: { persistSession: false } },
  )
  const {
    data: { user },
  } = await anon.auth.getUser(jwt)
  if (!user) return null

  const svc = serviceClient()
  const { data: profile } = await svc
    .from('profiles')
    .select('role, active, email')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile || !profile.active) return null

  return { userId: user.id, role: profile.role as Role, email: profile.email ?? null }
}

export function callerHasRole(caller: Caller | null, roles: Role[]): caller is Caller {
  return Boolean(caller && roles.includes(caller.role))
}
