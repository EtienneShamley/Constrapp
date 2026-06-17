import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function PurchaseOrders() {
  return (
    <div>
      <PageHeader title="Purchase Orders" sub="Create, send, and track POs linked to cost codes" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Purchase Orders Module</span>
          <Badge label="Sprint 2" variant="info" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — PO creation, sending, and cost code linking is planned for Sprint 2.
        </p>
      </Card>
    </div>
  )
}
