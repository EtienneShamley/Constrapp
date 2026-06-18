import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'

export default function Forecasting() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title="Forecasting" sub="Budget forecasting, cashflow and profit analysis" />
      <Card className="text-center py-16">
        <div className="text-5xl mb-4 leading-none">📈</div>
        <h3 className="text-brand-text font-bold text-lg mb-2 m-0">Forecasting &amp; Cashflow</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          Income/expense curves, profit analysis, and budget burn forecasting per project.
        </p>
        <Badge label="Coming in Sprint 4" variant="soon" />
      </Card>
    </div>
  )
}
