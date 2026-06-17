import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function SitePhotos() {
  return (
    <div>
      <PageHeader title="Site Photos" sub="Tagged photo uploads per project" />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-brand-text">Site Photos Module</span>
          <Badge label="Sprint 4" variant="soon" />
        </div>
        <p className="text-sm text-brand-muted">
          Coming in a later sprint — photo uploads, project tagging, and gallery view are planned for Sprint 4.
        </p>
      </Card>
    </div>
  )
}
