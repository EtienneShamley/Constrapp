import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import { useProfile } from '../../hooks/useProfile'
import { useLocalToday } from '../../hooks/useLocalToday'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useRetentionReleases } from '../../hooks/useRetentionReleases'
import { useProjectActivities } from '../../hooks/useProjectActivities'
import { isFinancialRole } from '../../lib/margin'
import { canReadProgramme } from '../../lib/projectTimeline'
import {
  evaluatePulse, groupIndicators, PULSE_STATE, PULSE_STATE_ORDER, PULSE_STATE_LABELS,
} from '../../lib/pulse'
import IndicatorCard from './pulse/IndicatorCard'
import { ModuleTile, BeatToggle } from '../../components/ModuleMark'
import { MODULE_NAMES } from '../../lib/moduleBranding'

// ── Constrapp PULSE™ · project health indicators (ADR-47) ────────────────────
//
// ⚠️ THE ROLE GATE IS THIS WRAPPER. PULSE reads every financial-role-only
// collection the Dashboard snapshot reads (supplier invoices, credit notes,
// variations, forecast lines, the commercial baseline, supplier payments,
// retention releases) plus the project programme. The workspace — which alone
// MOUNTS those subscriptions — renders only once the profile has settled AND
// the role is financial AND may read the programme, so subcontractor and
// client users never open them (not opened-and-hidden). Firestore Security
// Rules remain the enforced boundary; this is the UX mirror.
//
// Both role lists are identical today (company_admin / project_manager / qs);
// a test pins that, because this page assumes one gate covers every read.
//
// Every indicator is lib/pulse.js → evaluatePulse, which only composes
// existing selectors. Nothing on this page adds, compares or re-derives a
// figure; no write callback is consumed; nothing is stored. The page is
// remounted per project by ProjectDetailLayout's keyed outlet (ADR-44).

export default function ProjectPulse() {
  const { projectId, currencyCode } = useOutletContext()
  const { profile, profileLoading } = useProfile()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!isFinancialRole(profile?.role) || !canReadProgramme(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">PULSE indicators are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          PULSE reads forecast, margin, supplier payment, variation and programme records, which Firestore
          Security Rules restrict to Company Admin, Project Manager and QS roles.
        </p>
      </Card>
    )
  }
  return <PulseWorkspace projectId={projectId} currencyCode={currencyCode} />
}

function StateCount({ state, count }) {
  const tone = {
    [PULSE_STATE.FINDING]:     'text-brand-red',
    [PULSE_STATE.NEEDS_DATA]:  'text-brand-blue',
    [PULSE_STATE.UNAVAILABLE]: 'text-brand-amber',
    [PULSE_STATE.NO_ISSUE]:    'text-brand-accent',
    [PULSE_STATE.LOADING]:     'text-brand-muted',
  }[state]
  return (
    <div className="min-w-0 rounded-lg bg-brand-bg/60 px-3 py-2.5">
      <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{PULSE_STATE_LABELS[state]}</p>
      <p className={`m-0 mt-0.5 text-[20px] font-black tabular-nums leading-tight ${tone}`}>{count}</p>
    </div>
  )
}

function Section({ title, intro, indicators, projectId, currencyCode }) {
  if (indicators.length === 0) return null
  return (
    <section className="mb-5">
      <h2 className="m-0 mb-1 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
        {title} · {indicators.length}
      </h2>
      {intro && <p className="m-0 mb-2.5 text-[12px] text-brand-text-soft">{intro}</p>}
      {indicators.map(ind => (
        <IndicatorCard key={ind.id} indicator={ind} projectId={projectId} currencyCode={currencyCode} />
      ))}
    </section>
  )
}

// The module heading (ADR-48). The project name stays the page's <h1>; this
// stays an <h2>. Only the tile's dot animates — continuously — so its pause
// control sits in the same header. A component of its own so that pause state
// stays presentation-only and outside the workspace that owns the
// subscriptions.
function PulseHeading({ currencyCode }) {
  const [beatPaused, setBeatPaused] = useState(false)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <ModuleTile module="pulse" beat paused={beatPaused} />
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] font-bold text-brand-text">{MODULE_NAMES.pulse}</h2>
          <p className="m-0 mt-0.5 text-[12px] text-brand-muted">Project health indicators</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-brand-muted">{currencyCode} · ex-GST unless stated</span>
        <BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} />
      </div>
    </div>
  )
}

function PulseWorkspace({ projectId, currencyCode }) {
  const now = useLocalToday()
  const { budgetLines, budgetLinesLoading, budgetLinesError }                         = useBudgetLines(projectId)
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError }                = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError }                = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError }          = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { variations, variationsLoading, variationsError }                            = useVariations(projectId)
  const { forecastLines, forecastLinesLoading, forecastLinesError }                   = useForecastLines(projectId)
  const { baseline, baselineLoading, baselineError }                                  = useProjectCommercial(projectId)
  const { supplierPayments, supplierPaymentsLoading, supplierPaymentsError }          = useSupplierPayments(projectId)
  const { retentionReleases, retentionReleasesLoading, retentionReleasesError }       = useRetentionReleases(projectId)
  const { activities, activitiesLoading, activitiesError }                            = useProjectActivities(projectId)

  const pulse = useMemo(() => evaluatePulse({
    sources: {
      budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
      variations, forecastLines, baseline, supplierPayments, retentionReleases, activities,
    },
    // The loading / error flags of every source, in the Dashboard snapshot's
    // shape (ADR-42), so availability is decided by the same figureState.
    sourceStates: {
      budgetLines:         { loading: budgetLinesLoading,         error: budgetLinesError },
      purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
      progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
      supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
      supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
      variations:          { loading: variationsLoading,          error: variationsError },
      forecastLines:       { loading: forecastLinesLoading,       error: forecastLinesError },
      baseline:            { loading: baselineLoading,            error: baselineError },
      supplierPayments:    { loading: supplierPaymentsLoading,    error: supplierPaymentsError },
      retentionReleases:   { loading: retentionReleasesLoading,   error: retentionReleasesError },
      activities:          { loading: activitiesLoading,          error: activitiesError },
    },
    now,
    currencyCode,
  }), [
    budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
    variations, forecastLines, baseline, supplierPayments, retentionReleases, activities,
    budgetLinesLoading, budgetLinesError, purchaseOrdersLoading, purchaseOrdersError,
    progressClaimsLoading, progressClaimsError, supplierInvoicesLoading, supplierInvoicesError,
    supplierCreditNotesLoading, supplierCreditNotesError, variationsLoading, variationsError,
    forecastLinesLoading, forecastLinesError, baselineLoading, baselineError,
    supplierPaymentsLoading, supplierPaymentsError, retentionReleasesLoading, retentionReleasesError,
    activitiesLoading, activitiesError, now, currencyCode,
  ])

  const groups = groupIndicators(pulse.indicators)

  return (
    <div>
      <Card className="mb-3.5">
        <PulseHeading currencyCode={currencyCode} />
        <p className="m-0 mt-1.5 text-[12px] text-brand-text-soft">
          Six conditions checked against this project&apos;s current records — the same Forecast, Commercial, Supplier
          Payments, Variations and Timeline figures, read at this moment. No score, no prediction, no trend: an
          indicator is a finding only when the records support it, and incomplete or unavailable records are
          reported as exactly that.
        </p>
        {/* Counts of indicators by state — never combined into a score. */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {PULSE_STATE_ORDER.map(s => (
            <StateCount key={s} state={s} count={pulse.summary.counts[s]} />
          ))}
        </div>
      </Card>

      <Section
        title="Findings"
        intro="Conditions the current records support. Each links to the workflow where it is investigated and resolved."
        indicators={groups[PULSE_STATE.FINDING]}
        projectId={projectId}
        currencyCode={currencyCode}
      />
      <Section
        title="Needs data"
        intro="Records loaded, but an input the condition depends on is missing or incomplete — so no conclusion is drawn."
        indicators={groups[PULSE_STATE.NEEDS_DATA]}
        projectId={projectId}
        currencyCode={currencyCode}
      />
      <Section
        title="Unavailable"
        intro="A record read failed. These indicators were not assessed — unavailable is never reported as no issue."
        indicators={groups[PULSE_STATE.UNAVAILABLE]}
        projectId={projectId}
        currencyCode={currencyCode}
      />
      <Section
        title="Loading"
        indicators={groups[PULSE_STATE.LOADING]}
        projectId={projectId}
        currencyCode={currencyCode}
      />

      {groups[PULSE_STATE.NO_ISSUE].length > 0 && (
        <details className="mb-5 group">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
            <span className="transition-transform group-open:rotate-90">▸</span>
            No issue found · {groups[PULSE_STATE.NO_ISSUE].length}
          </summary>
          <p className="m-0 mb-2.5 text-[12px] text-brand-text-soft">
            Complete, usable records were checked and the condition is absent. Each card names what was checked.
          </p>
          {groups[PULSE_STATE.NO_ISSUE].map(ind => (
            <IndicatorCard key={ind.id} indicator={ind} projectId={projectId} currencyCode={currencyCode} />
          ))}
        </details>
      )}
    </div>
  )
}
