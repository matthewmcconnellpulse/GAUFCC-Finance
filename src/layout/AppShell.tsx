import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth, usePermissions } from '@/auth/AuthProvider'
import { useSync } from '@/sync/SyncProvider'
import { timeAgo } from '@/lib/format'
import { cx } from '@/components/ui'

interface NavItem {
  to: string
  label: string
  show: boolean
}

function useNavItems(): NavItem[] {
  const p = usePermissions()
  return [
    { to: '/', label: 'Dashboard', show: true },
    { to: '/funds', label: 'Funds', show: p.isPulse || p.isCeo || p.isTrustee },
    { to: '/reports', label: 'Reports', show: p.canSeeReports },
    { to: '/expenses', label: 'Expenses', show: true },
    { to: '/people', label: 'People', show: p.isAdmin || p.isPayroll },
    { to: '/imports', label: 'Imports', show: p.isPulse },
    { to: '/vat', label: 'VAT', show: p.isPulse || p.isCeo || p.isTrustee },
    { to: '/projects', label: 'Projects', show: p.isPulse || p.isCeo },
    { to: '/settings', label: 'Settings', show: p.isAdmin || p.isCeo },
  ]
}

function SyncButton() {
  const { lastSyncedAt, syncing, refreshNow } = useSync()
  const { canSync } = usePermissions()
  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-stone-500 hidden sm:inline">
        Last synced <span className="font-mono">{timeAgo(lastSyncedAt)}</span>
      </span>
      {canSync ? (
        <button
          onClick={() => void refreshNow()}
          disabled={syncing}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[11.5px] font-medium transition-colors',
            syncing
              ? 'border-mint/60 text-mint-900 bg-mint/10'
              : 'border-stone-300 text-indigo hover:bg-paper-2',
          )}
        >
          <span
            className={cx('w-1.5 h-1.5 rounded-full', syncing ? 'bg-mint animate-syncPulse' : 'bg-mint-700')}
            aria-hidden
          />
          {syncing ? 'Syncing…' : 'Refresh now'}
        </button>
      ) : null}
    </div>
  )
}

export default function AppShell() {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  const items = useNavItems().filter((i) => i.show)
  const [mobileOpen, setMobileOpen] = useState(false)

  const nav = (
    <nav className="flex-1 px-3 space-y-0.5">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            cx(
              'block rounded-control px-3.5 py-2 text-[13px] transition-colors',
              isActive
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/65 hover:text-white hover:bg-white/5',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="min-h-screen flex">
      {/* Sidebar — indigo anchor */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col bg-indigo text-white sticky top-0 h-screen no-print">
        <div className="px-6 pt-6 pb-5">
          <div className="font-display text-[17px] leading-tight">GAUFCC Finance</div>
          <div className="text-white/50 text-[10.5px] mt-0.5 font-mono">built by Pulse</div>
        </div>
        {nav}
        <div className="px-6 py-4 border-t border-white/10">
          <div className="text-[12px] text-white/85 truncate">{profile?.full_name ?? '—'}</div>
          <div className="text-[10.5px] text-white/45 capitalize">{profile?.role?.replace('_', ' ')}</div>
          <button
            onClick={() => {
              void signOut().then(() => navigate('/sign-in'))
            }}
            className="mt-2 text-[11px] text-white/55 hover:text-white underline underline-offset-2"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-ink/40" />
          <aside
            className="absolute left-0 top-0 bottom-0 w-64 bg-indigo text-white flex flex-col py-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 pb-5 font-display text-[17px]">GAUFCC Finance</div>
            {nav}
          </aside>
        </div>
      ) : null}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar — every screen carries Refresh now + last synced */}
        <header className="sticky top-0 z-30 bg-paper-3/90 backdrop-blur border-b border-stone-150 no-print">
          <div className="flex items-center justify-between gap-3 px-4 md:px-8 h-14">
            <button
              className="md:hidden rounded-control border border-stone-300 px-3 py-1.5 text-[12px] font-medium text-indigo"
              onClick={() => setMobileOpen(true)}
            >
              Menu
            </button>
            <div className="hidden md:block" />
            <SyncButton />
          </div>
        </header>

        <main className="flex-1 px-4 md:px-8 py-6 max-w-[1400px] w-full mx-auto">
          <Outlet />
        </main>

        <footer className="px-4 md:px-8 py-4 text-[10.5px] text-stone-400 no-print">
          General Assembly of Unitarian and Free Christian Churches · built by Pulse Accountants
        </footer>
      </div>
    </div>
  )
}
