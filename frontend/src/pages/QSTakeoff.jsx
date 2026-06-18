import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function QSTakeoff() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title="QS Takeoff" sub="AI-powered quantity extraction from drawings" />
      <Card className="text-center py-16">
        <div className="text-5xl mb-4 leading-none">📏</div>
        <h3 className="text-brand-text font-bold text-lg mb-2 m-0">QS Takeoff — Constrapp Quant™</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          AI quantity takeoff directly from uploaded drawings — patent-pending, exclusive to Constrapp.
        </p>
        <Badge label="Coming in Sprint 6" variant="soon" />
      </Card>
    </div>
  )
}
