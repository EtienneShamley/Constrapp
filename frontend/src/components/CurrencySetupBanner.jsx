import { Link } from 'react-router-dom'
import { useCompany } from '../hooks/useCompany'
import { useProfile } from '../hooks/useProfile'
import { DEFAULT_CURRENCY, isCompanyCurrencyConfigured } from '../lib/currency'

// Shown while a company has no confirmed base currency. Nothing is written to
// Firestore until an admin confirms one — an unconfigured company keeps
// displaying DEFAULT_CURRENCY, which reproduces the app's previous output
// exactly, so no existing figure silently changes meaning.
//
// Deliberately a banner, not a blocking modal: currency is a display setting,
// and blocking users (especially non-admins, who cannot resolve it) over one
// would hold real work hostage.
export default function CurrencySetupBanner() {
  const { company, companyLoading } = useCompany()
  const { profile } = useProfile()

  if (companyLoading || !company) return null
  if (isCompanyCurrencyConfigured(company)) return null

  const isAdmin = profile?.role === 'company_admin'

  return (
    <div className="mb-4 rounded-xl border border-brand-amber/40 bg-brand-amber/10 px-4 py-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
        <p className="m-0 text-[12.5px] text-brand-text">
          <span className="font-bold">Company currency not set.</span>{' '}
          {isAdmin
            ? `Amounts display in ${DEFAULT_CURRENCY} until you set your company country and reporting currency.`
            : `Amounts display in ${DEFAULT_CURRENCY} until a Company Admin sets your company country and reporting currency.`}
        </p>
        {isAdmin && (
          <Link
            to="/settings/company"
            className="shrink-0 inline-flex items-center justify-center min-h-[44px] px-3.5 rounded-lg bg-brand-accent/10 border border-brand-accent/40 text-brand-accent text-[12.5px] font-bold hover:bg-brand-accent/20 transition-colors"
          >
            Set country &amp; currency
          </Link>
        )}
      </div>
    </div>
  )
}
