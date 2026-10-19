import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import { useProfile } from '../../hooks/useProfile'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useRetentionReleases } from '../../hooks/useRetentionReleases'
import { useVariations } from '../../hooks/useVariations'
import { isFinancialRole } from '../../lib/margin'
import {
  evaluateShield, groupChecks, SHIELD_STATE, SHIELD_STATE_ORDER, SHIELD_STATE_LABELS,
} from '../../lib/shield'
import ShieldCheckCard from './shield/ShieldCheckCard'
import { ModuleTile, BeatToggle } from '../../components/ModuleMark'
import { MODULE_NAMES } from '../../lib/moduleBranding'

// ── Constrapp SHIELD™ · commercial assurance checks (ADR-50) ─────────────────
//
// ⚠️ THE ROLE GATE IS THIS WRAPPER. SHIELD reads financial-role-only
// collections (supplier invoices, credit notes, payments, retention releases,
// variations) beside the member-readable POs and claims. The workspace — which
// alone MOUNTS those subscriptions — renders only once the profile has settled
// AND the role is financial, so subcontractor and client users never open them
// (not opened-and-hidden). Firestore Security Rules remain the enforced
// boundary; this is the UX mirror.
//
// Every check is lib/shield.js → evaluateShield, which only composes existing
// selectors and status constants. Nothing on this page adds, compares or
// re-derives a figure, and nothing here writes: SHIELD has no write callback,
// no transaction and no persistence of any kind. The page is remounted per
// project by ProjectDetailLayout's keyed outlet (ADR-44), and every hook keeps
// the ADR-41 keyed-snapshot semantics, so a project switch can never show the
// previous project's records.

export default function ProjectShield() {
  const { projectId, currencyCode } = useOutletContext()
  const { profile, profileLoading } = useProfile()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!isFinancialRole(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">SHIELD checks are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          SHIELD reads supplier invoice, credit note, payment, retention and variation records, which Firestore
          Security Rules restrict to Company Admin, Project Manager and QS roles.
        </p>
      </Card>
    )
  }
  return <ShieldWorkspace projectId={projectId} currencyCode={currencyCode} />
}

function StateCount({ state, count }) {
  const tone = {
    [SHIELD_STATE.FINDING]:     'text-brand-red',
    [SHIELD_STATE.NEEDS_DATA]:  'text-brand-blue',
    [SHIELD_STATE.UNAVAILABLE]: 'text-brand-amber',
    [SHIELD_STATE.NO_ISSUE]:    'text-brand-accent',
    [SHIELD_STATE.LOADING]:     'text-brand-muted',
  }[state]
  return (
    <div className="min-w-0 rounded-lg bg-brand-bg/60 px-3 py-2.5">
      <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{SHIELD_STATE_LABELS[state]}</p>
      <p className={`m-0 mt-0.5 text-[20px] font-black tabular-nums leading-tight ${tone}`}>{count}</p>
    </div>
  )
}

function Section({ title, intro, checks, projectId, currencyCode }) {
  if (checks.length === 0) return null
  return (
    <section className="mb-5">
      <h2 className="m-0 mb-1 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
        {title} · {checks.length}
      </h2>
      {intro && <p className="m-0 mb-2.5 text-[12px] text-brand-text-soft">{intro}</p>}
      {checks.map(c => (
        <ShieldCheckCard key={c.id} check={c} projectId={projectId} currencyCode={currencyCode} />
      ))}
    </section>
  )
}

// The module heading (ADR-48 branding, shared advanced-module convention): the
// project name stays the page's <h1>; this stays an <h2>. Like PULSE, only the
// tile's luminous dot animates — continuously, in the module's own cyan — so
// its pause control sits in the same header. A component of its own so that
// pause state stays presentation-only and outside the workspace that owns the
// subscriptions. The animation is decorative: it does not mean SHIELD is
// monitoring anything in the background (every check runs at read time).
function ShieldHeading({ currencyCode }) {
  const [beatPaused, setBeatPaused] = useState(false)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <ModuleTile module="shield" beat paused={beatPaused} />
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] font-bold text-brand-text">{MODULE_NAMES.shield}</h2>
          <p className="m-0 mt-0.5 text-[12px] text-brand-muted">Commercial assurance checks</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-brand-muted">{currencyCode} · ex-GST unless stated</span>
        <BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} subject="glow animation" />
      </div>
    </div>
  )
}

function ShieldWorkspace({ projectId, currencyCode }) {
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError }                = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError }                = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError }          = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { supplierPayments, supplierPaymentsLoading, supplierPaymentsError }          = useSupplierPayments(projectId)
  const { retentionReleases, retentionReleasesLoading, retentionReleasesError }       = useRetentionReleases(projectId)
  const { variations, variationsLoading, variationsError }                            = useVariations(projectId)

  const shield = useMemo(() => evaluateShield({
    sources: {
      purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
      supplierPayments, retentionReleases, variations,
    },
    // The loading / error flags of every source, in the Dashboard snapshot's
    // shape (ADR-42), so availability is decided by the same figureState.
    sourceStates: {
      purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
      progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
      supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
      supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
      supplierPayments:    { loading: supplierPaymentsLoading,    error: supplierPaymentsError },
      retentionReleases:   { loading: retentionReleasesLoading,   error: retentionReleasesError },
      variations:          { loading: variationsLoading,          error: variationsError },
    },
    currencyCode,
  }), [
    purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
    supplierPayments, retentionReleases, variations,
    purchaseOrdersLoading, purchaseOrdersError, progressClaimsLoading, progressClaimsError,
    supplierInvoicesLoading, supplierInvoicesError, supplierCreditNotesLoading, supplierCreditNotesError,
    supplierPaymentsLoading, supplierPaymentsError, retentionReleasesLoading, retentionReleasesError,
    variationsLoading, variationsError, currencyCode,
  ])

  const groups = groupChecks(shield.checks)
  const sectionProps = { projectId, currencyCode }

  return (
    <div>
      <Card className="mb-3.5">
        <ShieldHeading currencyCode={currencyCode} />
        <p className="m-0 mt-1.5 text-[12px] text-brand-text-soft">
          Five assurance checks over this project&apos;s current purchase order, claim, supplier invoice, credit
          note, payment and retention records, read at this moment. Each lists the source records behind it. A
          finding is an exception or a condition needing review — never proof of error — and incomplete or
          unavailable records are reported as exactly that. No score, no prediction, no trend.
        </p>
        {/* Counts of checks by state — never combined into a score. */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {SHIELD_STATE_ORDER.map(s => (
            <StateCount key={s} state={s} count={shield.summary.counts[s]} />
          ))}
        </div>
      </Card>

      <Section
        title="Findings"
        intro="Exceptions the current records support. Each links to the module where the records are reviewed."
        checks={groups[SHIELD_STATE.FINDING]}
        {...sectionProps}
      />
      <Section
        title="Needs data"
        intro="Records loaded, but there is nothing the check can assess yet, or the only records found are malformed — so no conclusion is drawn."
        checks={groups[SHIELD_STATE.NEEDS_DATA]}
        {...sectionProps}
      />
      <Section
        title="Unavailable"
        intro="A record read failed. These checks were not assessed — unavailable is never reported as no issue."
        checks={groups[SHIELD_STATE.UNAVAILABLE]}
        {...sectionProps}
      />
      <Section
        title="Loading"
        checks={groups[SHIELD_STATE.LOADING]}
        {...sectionProps}
      />

      {groups[SHIELD_STATE.NO_ISSUE].length > 0 && (
        <details className="mb-5 group">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
            <span className="transition-transform group-open:rotate-90">▸</span>
            No issue found · {groups[SHIELD_STATE.NO_ISSUE].length}
          </summary>
          <p className="m-0 mb-2.5 text-[12px] text-brand-text-soft">
            Complete, usable records were checked and the condition is absent. Each card names what was checked.
          </p>
          {groups[SHIELD_STATE.NO_ISSUE].map(c => (
            <ShieldCheckCard key={c.id} check={c} projectId={projectId} currencyCode={currencyCode} />
          ))}
        </details>
      )}
    </div>
  )
}
