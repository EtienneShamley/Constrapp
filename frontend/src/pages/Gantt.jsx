import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import { ModuleMark, ModuleTile } from '../components/ModuleMark'
import { MODULE_NAMES } from '../lib/moduleBranding'

// The top-level /gantt route is a POINTER, not a surface. Constrapp GANTT™
// (ADR-64) lives on each project's GANTT tab — the ADR-29 programme, because a
// programme belongs to ONE project: there is no portfolio Gantt. This route
// stays hidden from the sidebar (lib/nav.js); typing the URL lands here and is
// sent on to a project. Branding is static here (ADR-48) and this page opens
// no subscription.
export default function Gantt() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title={MODULE_NAMES.gantt} sub="Construction programme" mark={<ModuleTile module="gantt" />} />
      <Card className="text-center py-16">
        <ModuleMark module="gantt" className="w-12 h-12 mx-auto mb-4" />
        <h3 className="font-bold text-lg mb-2 m-0 text-brand-gantt">{MODULE_NAMES.gantt}</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          GANTT shows a project&apos;s own programme — its activities and milestones on a day, week or
          month timeline, grouped by cost code or responsible party, with the activity table beside it as
          the complete record. Open a project and choose its GANTT tab.
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
