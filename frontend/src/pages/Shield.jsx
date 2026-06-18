import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Shield() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title="Constrapp SHIELD™" sub="Document integrity, audit trail &amp; anomaly detection" />
      <Card className="text-center py-16">
        <div className="text-5xl mb-4 leading-none">🛡</div>
        <h3 className="font-bold text-lg mb-2 m-0" style={{ color: '#00D4FF' }}>Constrapp SHIELD™</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          Document integrity hashing, audit trail, and access anomaly detection — proprietary and patent-pending.
        </p>
        <Badge label="Coming Soon" variant="soon" />
      </Card>
    </div>
  )
}
