/**
 * Settings — five tabs synced to /settings/* routes:
 *   General        approval/payment days, sync hour, warning defaults
 *   Xero           connection card, test, sync now, run history
 *   Users          profiles register, invitations, fund-manager assignments (pulse_admin)
 *   Funds          classification queue for newly-synced tracking options (pulse)
 *   Security       trustee-facing security summary + audit viewer (admin)
 *
 * Access: Pulse roles and the CEO. Tab visibility narrows further by role —
 * only pulse_admin ever sees Users; the classification queue is Pulse-only.
 */
import { useLocation, useNavigate } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { TabPills } from './components'
import GeneralTab from './GeneralTab'
import XeroTab from './XeroTab'
import UsersTab from './UsersTab'
import ClassificationTab from './ClassificationTab'
import SecurityTab from './SecurityTab'

type TabKey = 'general' | 'xero' | 'users' | 'funds' | 'security'

export default function SettingsPage() {
  const { isPulse, isAdmin, isCeo } = usePermissions()
  const location = useLocation()
  const navigate = useNavigate()

  const canView = isPulse || isCeo

  const tabs: Array<{ key: TabKey; label: string; show: boolean }> = [
    { key: 'general', label: 'General', show: true },
    { key: 'xero', label: 'Xero', show: true },
    { key: 'users', label: 'Users', show: isAdmin || isCeo },
    { key: 'funds', label: 'Fund classification', show: isPulse },
    { key: 'security', label: 'Security', show: true },
  ]
  const visible = tabs.filter((t) => t.show)

  const path = location.pathname.toLowerCase()
  const fromPath = (['xero', 'users', 'funds', 'security'] as const).find((k) => path.includes(`/settings/${k}`))
  const tab: TabKey = fromPath && visible.some((t) => t.key === fromPath) ? fromPath : 'general'

  if (!canView) {
    return (
      <div>
        <PageHeader title="Settings" />
        <Card>
          <EmptyState
            title="No access to settings"
            hint="Platform settings are managed by the Pulse team and the CEO."
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Platform configuration — every change here is audit-logged."
        actions={
          <TabPills<TabKey>
            tabs={visible.map((t) => ({ key: t.key, label: t.label }))}
            active={tab}
            onSelect={(key) => navigate(key === 'general' ? '/settings' : `/settings/${key}`)}
          />
        }
      />
      {tab === 'general' ? <GeneralTab /> : null}
      {tab === 'xero' ? <XeroTab /> : null}
      {tab === 'users' ? <UsersTab /> : null}
      {tab === 'funds' ? <ClassificationTab /> : null}
      {tab === 'security' ? <SecurityTab /> : null}
    </div>
  )
}
