import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import { ModuleMark, ModuleTile } from '../components/ModuleMark'
import { MODULE_NAMES } from '../lib/moduleBranding'

// The top-level /pulse route is a POINTER, not a surface. PULSE™ 1A (ADR-47)
// lives on each project's PULSE tab, because every indicator is evaluated for
// ONE project in ONE currency from that project's own records — there is no
// portfolio health view, no score and no AI. This route stays hidden from the
// sidebar (lib/nav.js); typing the URL lands here and is sent on to a project.
// Branding is static here (ADR-48): the indicator dot belongs to the project tab.
export default function Pulse() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title={MODULE_NAMES.pulse} sub="Project health indicators" mark={<ModuleTile module="pulse" />} />
      <Card className="text-center py-16">
        <ModuleMark module="pulse" className="w-12 h-12 mx-auto mb-4" />
        <h3 className="font-bold text-lg mb-2 m-0 text-brand-pulse">{MODULE_NAMES.pulse}</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          PULSE checks each project&apos;s own records for explainable conditions — forecast over budget, incomplete
          forecasts, negative forecast margin, overdue programme activities, past-due supplier invoices and pending
          variation exposure. Open a project and choose its PULSE tab.
        </p>
        <Link
          to="/projects"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-brand-border px-4 text-sm font-semibold text-brand-accent hover:bg-brand-card"
        >
          Go to Projects →
        </Link>
      </Card>
    </div>
  )
}
