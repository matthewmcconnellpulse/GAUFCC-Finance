import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Skeleton } from '@/components/ui'

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, profile } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-paper-3">
        <div className="w-full max-w-sm space-y-3 px-6">
          <Skeleton className="h-8" />
          <Skeleton className="h-4 w-2/3 mx-auto" />
        </div>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/sign-in" replace state={{ from: location }} />
  }

  if (profile && !profile.active) {
    return (
      <div className="min-h-screen grid place-items-center bg-paper-3 px-4 text-center">
        <div>
          <h1 className="font-display text-[22px] text-ink">Account deactivated</h1>
          <p className="text-stone-500 text-[12.5px] mt-2">
            Your access has been switched off. Contact Pulse if you think this is a mistake.
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
