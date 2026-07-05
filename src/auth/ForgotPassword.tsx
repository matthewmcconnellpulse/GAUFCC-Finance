import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, Field, Input, ErrorNotice } from '@/components/ui'

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await requestPasswordReset(email)
    if (error) setError(error)
    else setSent(true)
    setBusy(false)
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper-3 px-4">
      <div className="w-full max-w-sm">
        <Card className="p-7">
          <h1 className="font-display text-[22px] text-ink mb-4">Reset your password</h1>
          {sent ? (
            <p className="text-[13px] text-stone-700">
              If an account exists for <span className="font-medium">{email}</span>, a reset link is
              on its way. Check your inbox.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <Field label="Email">
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              {error ? <ErrorNotice message={error} /> : null}
              <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
          )}
          <div className="text-center mt-4">
            <Link
              to="/sign-in"
              className="text-[11.5px] text-stone-500 hover:text-indigo underline underline-offset-2"
            >
              Back to sign in
            </Link>
          </div>
        </Card>
      </div>
    </div>
  )
}
