import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Reports() {
  return (
    <div>
      <PageHeader title="Reports" sub="PDF and CSV exports for financial and progress reports" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Reports Module</span>
          <Badge label="Sprint 3" variant="soon" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — financial summary, project progress, and cashflow PDF/CSV exports are planned for Sprint 3.
        </p>
      </Card>
    </div>
  )
}
