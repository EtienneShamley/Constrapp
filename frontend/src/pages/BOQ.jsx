import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function BOQ() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title="BOQ & Tender" sub="Bill of Quantities · QS Takeoff → Budget transfer" />
      <Card className="text-center py-16">
        <div className="text-5xl mb-4 leading-none">📋</div>
        <h3 className="text-brand-text font-bold text-lg mb-2 m-0">BOQ & Tender Tool</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          Build a Bill of Quantities, set margin &amp; overheads, and transfer to project budget in one click.
        </p>
        <Badge label="Coming in Sprint 3" variant="soon" />
      </Card>
    </div>
  )
}
