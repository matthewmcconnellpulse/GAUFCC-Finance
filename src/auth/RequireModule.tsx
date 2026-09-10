/**
 * Route guard for a part of the system.
 *
 * The sidebar hiding a link is presentation, not security — anyone can type a
 * URL. This is the second of the three places access is decided; the third and
 * only authoritative one is RLS, which returns no rows regardless of what the
 * browser thinks. The guard exists so that someone without access gets a
 * straight answer instead of a screen of empty tables and failed queries.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { usePermissions } from './AuthProvider'
import { Card, EmptyState } from '@/components/ui'

export default function RequireModule({
  allowed,
  title,
  children,
}: {
  /** Result of the matching canSee… check from usePermissions. */
  allowed: boolean
  /** What was being opened, for the message. */
  title: string
  children: ReactNode
}) {
  if (allowed) return <>{children}</>
  return (
    <Card>
      <EmptyState
        title={`You do not have access to ${title}`}
        hint="Access is granted per person by a Pulse admin. If you need this for your work, ask us and we will add it to your account."
        action={
          <Link to="/" className="text-indigo underline underline-offset-2 text-[12.5px]">
            Back to the dashboard
          </Link>
        }
      />
    </Card>
  )
}
