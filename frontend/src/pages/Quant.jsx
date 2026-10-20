import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import { ModuleMark, ModuleTile } from '../components/ModuleMark'
import { MODULE_NAMES } from '../lib/moduleBranding'

// The top-level /quant route is a POINTER, not a surface. Constrapp Quant™ 1A
// (ADR-51) lives on each project's Quant tab, because every measurement is
// taken on ONE drawing revision of ONE project — there is no portfolio takeoff
// view and no AI. This route stays hidden from the sidebar (lib/nav.js); typing
// the URL lands here and is sent on to a project. Branding is static here
// (ADR-48) and this page opens no subscription.
export default function Quant() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title={MODULE_NAMES.quant} sub="Manual quantity takeoff" mark={<ModuleTile module="quant" />} />
      <Card className="text-center py-16">
        <ModuleMark module="quant" className="w-12 h-12 mx-auto mb-4" />
        <h3 className="font-bold text-lg mb-2 m-0 text-brand-quant">{MODULE_NAMES.quant}</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          Quant measures lengths, areas and counts on a project&apos;s own drawing revisions, against a
          calibration you set from a known distance, and keeps each measurement as a traceable record
          pinned to its sheet and cost code. Open a project and choose its Quant tab.
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
