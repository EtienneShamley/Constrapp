import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import { ModuleMark, ModuleTile } from '../components/ModuleMark'
import { MODULE_NAMES } from '../lib/moduleBranding'

// The top-level /shield route is a POINTER, not a surface. Constrapp SHIELD™
// (ADR-50) lives on each project's SHIELD tab, because every check is
// evaluated for ONE project in ONE currency from that project's own records —
// there is no portfolio assurance register, no score and no AI. This route
// stays hidden from the sidebar (lib/nav.js); typing the URL lands here and is
// sent on to a project. Branding is static here (ADR-48) and this page opens
// no financial subscription. SHIELD™ is commercial assurance — not HSEQ.
export default function Shield() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title={MODULE_NAMES.shield} sub="Commercial assurance checks" mark={<ModuleTile module="shield" />} />
      <Card className="text-center py-16">
        <ModuleMark module="shield" className="w-12 h-12 mx-auto mb-4" />
        <h3 className="font-bold text-lg mb-2 m-0 text-brand-shield">{MODULE_NAMES.shield}</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          SHIELD checks each project&apos;s own commercial records for objective exceptions — potential duplicate
          supplier invoices, supplier invoice integrity, purchase order over-invoicing exposure, commitment records
          needing reconciliation and existing payables exceptions. Open a project and choose its SHIELD tab.
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
