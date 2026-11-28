import { COMMERCIAL_MAINTENANCE_TITLE, COMMERCIAL_MAINTENANCE_TEXT } from '../lib/commercialActivation'

// The one read-only notice of a Phase 2 register whose company is not yet
// activated (lib/commercialActivation.js). Shown only when `activation`
// (hooks/useCommercialActivation.jsx) says `maintenance` — never while the
// company is still loading. Styled as the app's other notices
// (components/CurrencySetupBanner.jsx). UX ONLY: the server is authoritative.
export default function CommercialMaintenanceNotice({ activation, className = 'mb-3.5' }) {
  if (activation?.maintenance !== true) return null
  return (
    <div role="status" data-commercial-maintenance className={`${className} rounded-xl border border-brand-amber/40 bg-brand-amber/10 px-4 py-3`}>
      <p className="m-0 text-[12.5px] text-brand-text font-bold">{COMMERCIAL_MAINTENANCE_TITLE}</p>
      <p className="m-0 mt-1 text-[12.5px] text-brand-text">{COMMERCIAL_MAINTENANCE_TEXT}</p>
    </div>
  )
}
