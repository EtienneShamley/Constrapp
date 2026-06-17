import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Drawings() {
  return (
    <div>
      <PageHeader title="Drawings & Documents" sub="Upload, version, and mark up drawing files" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Drawings Module</span>
          <Badge label="Sprint 4" variant="soon" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — drawing uploads, version control, revision warnings, and markup tools are planned for Sprint 4.
        </p>
      </Card>
    </div>
  )
}
