import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Subcontractors() {
  return (
    <div>
      <PageHeader title="Subcontractors" sub="Accountability scoring and cost code breakdown" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Constrapp IQ™</span>
          <Badge label="Coming Soon" variant="soon" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — AI-powered subcontractor accountability scoring, schedule analysis, and variation intelligence are planned for Sprint 5.
        </p>
      </Card>
    </div>
  )
}
