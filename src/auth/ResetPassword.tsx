import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Button, Card, Field, Input, ErrorNotice } from '@/components/ui'

type LinkState = 'checking' | 'ready' | 'dead'

const DEAD_LINK_MESSAGE =
  'This link has expired or has already been used. Ask Pulse for a fresh one, or use "Forgotten password?" on the login page.'

/**
 * Landing page for every set-password link: the "Forgotten password?" email,
 * new-user invites and re-issued sign-in links.
 *
 * Two arrival shapes. Links we hand out ourselves carry ?token_hash=&type= on
 * the charity's domain and are verified here with verifyOtp. Links Supabase
 * builds (the recovery email) redirect here with a session in the URL hash,
 * which the client picks up itself — or with #error=… when the token is dead.
 */
export default function ResetPassword() {
  const navigate = useNavigate()
  const [linkState, setLinkState] = useState<LinkState>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const tokenHash = params.get('token_hash')
    const type = params.get('type')

    async function verify() {
      if (tokenHash && (type === 'invite' || type === 'recovery')) {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
        if (cancelled) return
        // Drop the token from the address bar so a refresh doesn't retry a
        // now-spent token and report it as dead.
        window.history.replaceState(null, '', window.location.pathname)
        setLinkState(error ? 'dead' : 'ready')
        return
      }
      if (hash.get('error')) {
        setLinkState('dead')
        return
      }
      // Supabase-built link: the client consumes the hash tokens on load, so
      // a session should already exist (or be a moment away).
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (data.session) {
        setLinkState('ready')
        return
      }
      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session && !cancelled) setLinkState('ready')
      })
      window.setTimeout(() => {
        if (!cancelled) setLinkState((s) => (s === 'checking' ? 'dead' : s))
      }, 4000)
      return () => sub.subscription.unsubscribe()
    }

    let cleanup: (() => void) | undefined
    void verify().then((c) => {
      cleanup = c ?? undefined
    })
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 10) {
      setError('Use at least 10 characters.')
      return
    }
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(/session/i.test(error.message) ? DEAD_LINK_MESSAGE : error.message)
      setBusy(false)
      return
    }
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper-3 px-4">
      <div className="w-full max-w-sm">
        <Card className="p-7">
          {linkState === 'checking' ? (
            <>
              <h1 className="font-display text-[22px] text-ink mb-2">Checking your link…</h1>
              <p className="text-[13px] text-stone-600">One moment.</p>
            </>
          ) : linkState === 'dead' ? (
            <>
              <h1 className="font-display text-[22px] text-ink mb-3">This link no longer works</h1>
              <p className="text-[13px] leading-relaxed text-stone-600 mb-5">{DEAD_LINK_MESSAGE}</p>
              <Button variant="primary" className="w-full" onClick={() => navigate('/sign-in', { replace: true })}>
                Go to the login page
              </Button>
            </>
          ) : (
            <>
              <h1 className="font-display text-[22px] text-ink mb-4">Choose a password</h1>
              <form onSubmit={onSubmit} className="space-y-4">
                <Field label="New password" hint="At least 10 characters.">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Field label="Confirm password">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>
                {error ? <ErrorNotice message={error} /> : null}
                <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                  {busy ? 'Saving…' : 'Save and continue'}
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
