/**
 * Imports — Pulse-facing tools that replace the missing HSBC bank feed and
 * turn the Epworth monthly report into fund-mapped postings. Two tabs
 * (HSBC statements | Epworth investments) synced to /imports/hsbc and
 * /imports/epworth. Dense, tabular, keyboard-friendly.
 */
import { useLocation, useNavigate } from 'react-router-dom'
import { usePermissions } from '@/auth/AuthProvider'
import { Card, EmptyState, PageHeader } from '@/components/ui'
import { TabPills } from './components'
import HsbcTab from './HsbcTab'
import EpworthTab from './EpworthTab'

type TabKey = 'hsbc' | 'epworth'

export default function ImportsPage() {
  const { isPulse } = usePermissions()
  const location = useLocation()
  const navigate = useNavigate()

  const tab: TabKey = location.pathname.toLowerCase().includes('/epworth') ? 'epworth' : 'hsbc'

  if (!isPulse) {
    return (
      <div>
        <PageHeader title="Imports" />
        <Card>
          <EmptyState
            title="Pulse access only"
            hint="Bank statement and Epworth imports are handled by the Pulse bookkeeping team."
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Imports"
        subtitle="HSBC statement drop-in and Epworth investment mapping — CSVs are generated for manual import, nothing is pushed to Xero from here."
        actions={
          <TabPills<TabKey>
            tabs={[
              { key: 'hsbc', label: 'HSBC statements' },
              { key: 'epworth', label: 'Epworth investments' },
            ]}
            active={tab}
            onSelect={(key) => navigate(key === 'hsbc' ? '/imports' : '/imports/epworth')}
          />
        }
      />
      {tab === 'hsbc' ? <HsbcTab /> : <EpworthTab />}
    </div>
  )
}
