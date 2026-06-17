import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Contacts() {
  return (
    <div>
      <PageHeader title="Contacts" sub="Subcontractors, suppliers, and consultants" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Contacts Module</span>
          <Badge label="Sprint 2" variant="info" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — contact management with ABN, trade type, and notes is planned for Sprint 2.
        </p>
      </Card>
    </div>
  )
}
