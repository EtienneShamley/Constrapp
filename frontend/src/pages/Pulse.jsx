import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Pulse() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title="Constrapp PULSE™" sub="Living AI project health engine" />
      <Card className="text-center py-16">
        <div className="text-5xl mb-4 leading-none">💓</div>
        <h3 className="font-bold text-lg mb-2 m-0" style={{ color: '#FF6B9D' }}>Constrapp PULSE™</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          Real-time portfolio health scoring — a living AI project heartbeat. World-first technology, original IP.
        </p>
        <Badge label="Coming Soon" variant="soon" />
      </Card>
    </div>
  )
}
