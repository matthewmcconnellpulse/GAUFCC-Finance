import { PageHeader, Card, EmptyState } from '@/components/ui'

export default function ApprovalQueuePage() {
  return (
    <div>
      <PageHeader title="ApprovalQueuePage" subtitle="This module is being built." />
      <Card>
        <EmptyState title="Coming shortly" hint="This screen is part of the current build phase." />
      </Card>
    </div>
  )
}
