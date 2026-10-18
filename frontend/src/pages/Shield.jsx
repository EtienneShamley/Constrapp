import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Badge from '../components/Badge'
import { ModuleMark, ModuleTile } from '../components/ModuleMark'
import { MODULE_NAMES } from '../lib/moduleBranding'

// Constrapp SHIELD™ is NOT built. This hidden route (absent from lib/nav.js) is
// a Coming Soon placeholder only: a static mark, no animation, no data and no
// claim of active monitoring (ADR-48). SHIELD™ is commercial audit and
// assurance — not safety or HSEQ (PRODUCT.md).
export default function Shield() {
  return (
    <div className="max-w-[1280px]">
      <PageHeader title={MODULE_NAMES.shield} sub="Commercial audit and assurance" mark={<ModuleTile module="shield" />} />
      <Card className="text-center py-16">
        <ModuleMark module="shield" className="w-12 h-12 mx-auto mb-4" />
        <h3 className="font-bold text-lg mb-2 m-0 text-brand-shield">{MODULE_NAMES.shield}</h3>
        <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">
          Planned commercial audit and assurance checks — approval segregation, financial-document immutability,
          duplicate supplier invoices, and over-claim or out-of-sequence approval anomalies. Not yet available.
        </p>
        <Badge label="Coming Soon" variant="soon" />
      </Card>
    </div>
  )
}
