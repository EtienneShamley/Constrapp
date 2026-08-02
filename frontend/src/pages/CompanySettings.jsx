import { useState } from 'react'
import PageHeader from '../components/PageHeader'
import Card from '../components/Card'
import Btn from '../components/Btn'
import Badge from '../components/Badge'
import { formatDate } from '../lib/formatters'
import { useCompany } from '../hooks/useCompany'
import { useProfile } from '../hooks/useProfile'
import { useProjects } from '../hooks/useProjects'
import {
  SUPPORTED_MARKETS, OTHER_COUNTRIES, CURRENCIES, DEFAULT_CURRENCY,
  countryName, currencyName, suggestCurrencyForCountry, isCurrencyUnusualForCountry,
  isCompanyCurrencyConfigured, projectHasExplicitCurrency,
  needsTaxLimitationNotice, TAX_LIMITATION_NOTICE,
} from '../lib/currency'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

// Only company_admin may configure the company country and base currency.
// This mirrors the Firestore rule, which is the enforced boundary.
const canConfigure = (role) => role === 'company_admin'

// The stateful configuration form. Mounted ONLY once the company document has
// loaded, so the useState initialisers below see the saved country/currency —
// initialising them against a not-yet-loaded company would open an already
// configured company with empty selects.
function CurrencyForm({ company, configured, saveCompanyCurrency, projects, projectsLoading }) {
  const [countryCode, setCountryCode]   = useState(() => company?.countryCode ?? '')
  const [baseCurrency, setBaseCurrency] = useState(() => company?.baseCurrency ?? '')
  const [confirmed, setConfirmed]       = useState(false)
  // Only the projects the admin deliberately re-pointed. Everything else follows
  // its stored currency, or the chosen base currency when it has none.
  const [overrides, setOverrides]       = useState({})
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState('')
  const [saved, setSaved]               = useState(false)

  const dirty = () => { setSaved(false); setError('') }

  function onCountryChange(e) {
    const next = e.target.value
    setCountryCode(next)
    // Country SUGGESTS a currency; the user still confirms or overrides it.
    const suggested = suggestCurrencyForCountry(next)
    if (suggested) setBaseCurrency(suggested)
    setConfirmed(false)
    dirty()
  }

  // A project's effective currency in this form: an explicit override, else its
  // own stored currency, else the base currency being configured.
  const effectiveFor = (p) =>
    overrides[p.id] ?? (projectHasExplicitCurrency(p) ? p.currency : baseCurrency)

  // Locked projects are frozen by the currency ratchet — Firestore rules reject
  // a currency change on them, so they are never offered here.
  const isLocked = (p) => p?.currencyLocked === true

  // Only projects whose effective currency differs from what is stored are
  // written — re-running the setup with the same choices is a no-op (idempotent),
  // and a project that already carries an explicit currency is never overwritten
  // unless the admin deliberately re-pointed it while still eligible.
  const pendingWrites = projects
    .filter(p => !isLocked(p) || !projectHasExplicitCurrency(p))
    .map(p => ({ projectId: p.id, currency: effectiveFor(p), stored: p.currency }))
    .filter(u => u.currency && u.currency !== u.stored)
    .map(({ projectId, currency }) => ({ projectId, currency }))

  const unpinnedCount = projects.filter(p => !projectHasExplicitCurrency(p)).length
  const unusual  = isCurrencyUnusualForCountry(countryCode, baseCurrency)
  const showTax  = needsTaxLimitationNotice(countryCode)
  const canSave  = !!countryCode && !!baseCurrency && confirmed && !saving && !projectsLoading

  async function onSave() {
    setSaving(true); setError(''); setSaved(false)
    try {
      await saveCompanyCurrency({ countryCode, baseCurrency, projectCurrencies: pendingWrites })
      setOverrides({})
      setConfirmed(false)
      setSaved(true)
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* ── Country & currency ────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <p className="text-[13px] font-bold text-brand-text m-0 mb-3">
          {configured ? 'Change country & base currency' : 'Set your company country & base currency'}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label className={labelCls}>Country <span className="text-brand-red">*</span></label>
            <select className={inputCls} value={countryCode} onChange={onCountryChange}>
              <option value="" disabled>Select country…</option>
              <optgroup label="Common">
                {SUPPORTED_MARKETS.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </optgroup>
              <optgroup label="All countries">
                {OTHER_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </optgroup>
            </select>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Choose the country your company reports from. It suggests a currency — it never forces one.
            </p>
          </div>

          <div>
            <label className={labelCls}>Base currency <span className="text-brand-red">*</span></label>
            <select
              className={inputCls}
              value={baseCurrency}
              onChange={(e) => { setBaseCurrency(e.target.value); setConfirmed(false); dirty() }}
            >
              <option value="" disabled>Select currency…</option>
              {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </select>
            {countryCode && (
              <p className={`m-0 mt-1 text-[11px] ${unusual ? 'text-brand-amber' : 'text-brand-muted'}`}>
                {unusual
                  ? `${suggestCurrencyForCountry(countryCode)} is normal for ${countryName(countryCode)} — you have selected ${baseCurrency}. That is allowed; a company often reports in a different currency from where it is registered.`
                  : `Suggested for ${countryName(countryCode)}. Change it if your company reports in a different currency.`}
              </p>
            )}
          </div>
        </div>

        {/* Tax limitation — currency display is configurable, tax is not. */}
        {showTax && (
          <p className="m-0 mt-3.5 text-[12px] text-brand-amber">
            <span className="font-semibold">Tax:</span> {TAX_LIMITATION_NOTICE} Selecting{' '}
            {countryName(countryCode)} does not make Constrapp tax-compliant there — purchase orders, claims,
            invoices, and variations still calculate and label a flat Australian GST of 10%.
          </p>
        )}

        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Currency is a <span className="font-semibold">label</span>, never a conversion. Constrapp performs no FX
          conversion: no existing amount is recalculated, converted, or changed by anything on this page.
        </p>
      </Card>

      {/* ── Existing projects ─────────────────────────────────────────── */}
      {!projectsLoading && projects.length > 0 && (
        <Card padding={false} className="mb-3.5">
          <div className="px-5 py-4 border-b border-brand-border">
            <p className="text-[13px] font-bold text-brand-text m-0">Existing projects ({projects.length})</p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted max-w-[820px]">
              Every project is pinned to an explicit currency so that a later change to the company base currency can
              never relabel it. {unpinnedCount > 0
                ? `${unpinnedCount} project${unpinnedCount === 1 ? ' has' : 's have'} no currency yet and will be set below — review each one, because these amounts were entered before a currency was recorded.`
                : 'All projects already carry an explicit currency.'}{' '}
              <span className="font-semibold">No amount is converted or recalculated.</span>
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Project', 'Status', 'Stored currency', 'Will be set to'].map(h => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projects.map(p => {
                  const pinned  = projectHasExplicitCurrency(p)
                  const locked  = isLocked(p)
                  const value   = effectiveFor(p)
                  const changes = value && value !== p.currency
                  // Locked AND already pinned ⇒ frozen by the ratchet.
                  const frozen  = locked && pinned
                  return (
                    <tr key={p.id} className="border-b border-brand-border">
                      <td className="px-3.5 py-3">
                        <p className="text-[13px] font-semibold text-brand-text m-0 leading-tight">{p.name}</p>
                        {p.location && <p className="text-[11px] text-brand-muted mt-0.5 m-0">{p.location}</p>}
                      </td>
                      <td className="px-3.5 py-3"><Badge label={p.status} sm /></td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-muted whitespace-nowrap">
                        {pinned ? p.currency : <span className="text-brand-amber">Not set</span>}
                      </td>
                      <td className="px-3.5 py-3">
                        {frozen ? (
                          <span className="text-[12px] text-brand-muted whitespace-nowrap">
                            {p.currency} 🔒 <span className="text-[11px]">locked — has financial records</span>
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <select
                              className="bg-brand-bg border border-brand-border rounded-lg px-2.5 py-1.5 text-[12.5px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
                              value={value || ''}
                              onChange={(e) => { setOverrides(o => ({ ...o, [p.id]: e.target.value })); dirty() }}
                              disabled={!baseCurrency && !pinned}
                            >
                              {!value && <option value="" disabled>Select a country first…</option>}
                              {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                            </select>
                            {changes && <span className="text-[11px] text-brand-accent whitespace-nowrap">will be written</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── Confirm & save ────────────────────────────────────────────── */}
      <Card>
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            className="mt-0.5 w-4 h-4 accent-brand-accent shrink-0"
            checked={confirmed}
            onChange={(e) => { setConfirmed(e.target.checked); dirty() }}
          />
          <span className="text-[12.5px] text-brand-text">
            I confirm this company reports in{' '}
            <span className="font-bold">{baseCurrency || '—'}</span>
            {pendingWrites.length > 0 && (
              <>, and that {pendingWrites.length} existing project{pendingWrites.length === 1 ? '' : 's'} will be
              pinned to the currencies shown above</>
            )}
            . I understand no amount is converted.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3 mt-4">
          <Btn onClick={onSave} disabled={!canSave}>
            {saving ? 'Saving…' : configured ? 'Save changes' : 'Save company currency'}
          </Btn>
          {saved && !saving && <Badge label="Saved" variant="completed" sm />}
          {error && <span className="text-[12px] text-brand-red">{error}</span>}
        </div>

        <p className="m-0 mt-3 text-[11px] text-brand-muted max-w-[820px]">
          Project currencies are written first, then the company configuration — so if anything fails, the company
          stays unconfigured, this prompt stays up, and retrying is safe. Changing the base currency later affects
          only the default for <span className="font-semibold">new</span> projects; existing projects keep the
          currency pinned here.
        </p>
      </Card>
    </>
  )
}

export default function CompanySettings() {
  const { company, companyLoading, saveCompanyCurrency } = useCompany()
  const { profile, profileLoading } = useProfile()
  const { projects, projectsLoading } = useProjects()

  const configured = isCompanyCurrencyConfigured(company)
  const isAdmin    = canConfigure(profile?.role)

  if (companyLoading || profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading company…</div>
  }

  return (
    <div className="max-w-[1280px]">
      <PageHeader
        title="Company Settings"
        sub={company?.name ? `${company.name} · country & reporting currency` : 'Country & reporting currency'}
      />

      {/* ── Current configuration ───────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <div>
            <p className={labelCls}>Country</p>
            <p className="text-lg font-bold text-brand-text m-0">
              {company?.countryCode ? `${countryName(company.countryCode)} (${company.countryCode})` : 'Not set'}
            </p>
          </div>
          <div>
            <p className={labelCls}>Base currency</p>
            <p className="text-lg font-bold text-brand-text m-0">
              {configured
                ? <>{company.baseCurrency} <span className="text-[13px] font-normal text-brand-muted">{currencyName(company.baseCurrency)}</span></>
                : 'Not set'}
            </p>
          </div>
          <div>
            <p className={labelCls}>Last updated</p>
            <p className="text-lg font-bold text-brand-text m-0">
              {company?.currencyUpdatedAt ? formatDate(company.currencyUpdatedAt) : '—'}
            </p>
          </div>
        </div>

        {!configured && (
          <p className="m-0 mt-3 text-[11px] text-brand-amber">
            Your company currency has not been set. Amounts display in {DEFAULT_CURRENCY} until it is — nothing has been
            written and no existing figure has changed.
          </p>
        )}
      </Card>

      {isAdmin ? (
        // Keyed on the saved configuration so a successful save remounts the
        // form on the freshly-saved values, while unsaved edits persist between
        // saves (the idiom used by the commercial baseline form).
        <CurrencyForm
          key={`${company?.countryCode ?? ''}|${company?.baseCurrency ?? ''}`}
          company={company}
          configured={configured}
          saveCompanyCurrency={saveCompanyCurrency}
          projects={projects}
          projectsLoading={projectsLoading}
        />
      ) : (
        <Card>
          <p className="text-[13px] text-brand-text font-semibold m-0">Company currency is managed by a Company Admin</p>
          <p className="text-[12.5px] text-brand-muted m-0 mt-1">
            Only the Company Admin role can set the company country and base currency. Access is enforced by Firestore
            Security Rules.
          </p>
        </Card>
      )}
    </div>
  )
}
