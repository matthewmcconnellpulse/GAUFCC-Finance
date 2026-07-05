import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Button, Card, Field, Input, ErrorNotice } from '@/components/ui'

/** Landing page for the Supabase recovery link (and invited-user first sign-in). */
export default function ResetPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      setError(error.message)
      setBusy(false)
      return
    }
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper-3 px-4">
      <div className="w-full max-w-sm">
        <Card className="p-7">
          <h1 className="font-display text-[22px] text-ink mb-4">Choose a new password</h1>
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
        </Card>
      </div>
    </div>
  )
}
