import { useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, Field, Input, ErrorNotice } from '@/components/ui'
import { isSupabaseConfigured } from '@/lib/supabase'

export default function SignIn() {
  const { session, signIn, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (session && !loading) return <Navigate to="/" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await signIn(email, password)
    if (error) setError(error)
    setBusy(false)
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper-3 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-7">
          <h1 className="font-display text-[30px] text-ink">GAUFCC Finance</h1>
          <p className="text-stone-500 text-[12.5px] mt-1">
            Fund reporting for the General Assembly
          </p>
        </div>
        <Card className="p-7">
          {!isSupabaseConfigured ? (
            <ErrorNotice message="Not configured yet — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel environment variables." />
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <Field label="Email">
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {error ? <ErrorNotice message={error} /> : null}
              <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <div className="text-center">
                <Link
                  to="/forgot-password"
                  className="text-[11.5px] text-stone-500 hover:text-indigo underline underline-offset-2"
                >
                  Forgotten your password?
                </Link>
              </div>
            </form>
          )}
        </Card>
        <p className="text-center text-[10.5px] text-stone-400 mt-5">
          Access is by invitation only — contact Pulse if you need an account.
        </p>
      </div>
    </div>
  )
}
