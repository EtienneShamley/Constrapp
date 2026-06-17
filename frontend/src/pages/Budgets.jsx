import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Budgets() {
  return (
    <div>
      <PageHeader title="Budgets" sub="Cost codes with committed / actual / invoiced / remaining" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Budgets Module</span>
          <Badge label="Sprint 2" variant="info" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — cost code breakdown, budget burn bars, and variance indicators are planned for Sprint 2.
        </p>
      </Card>
    </div>
  )
}
