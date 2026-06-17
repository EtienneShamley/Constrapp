import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Timeline() {
  return (
    <div>
      <PageHeader title="Timeline" sub="Gantt-style schedule view with delay detection" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Timeline Module</span>
          <Badge label="Sprint 4" variant="soon" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — Gantt schedule view and delay flagging are planned for Sprint 4.
        </p>
      </Card>
    </div>
  )
}
