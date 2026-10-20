import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import { useProfile } from '../../hooks/useProfile'
import { canUseQuant } from '../../lib/quant'
import { ModuleTile, BeatToggle } from '../../components/ModuleMark'
import { MODULE_NAMES } from '../../lib/moduleBranding'
import TakeoffWorkspace from './quant/TakeoffWorkspace'

// ── Constrapp Quant™ 1A · manual drawing measurement (ADR-51) ────────────────
//
// ⚠️ THE ROLE GATE IS THIS WRAPPER. Quant reads the drawing register (open to
// every member) and the two takeoff collections, and shows cost-code names;
// the measurements it saves are the internal estimate's provenance, so the
// workspace — which alone MOUNTS those subscriptions — renders only once the
// profile has settled AND the role is company_admin / project_manager / qs.
// Subcontractor and client users never open a takeoff subscription (not
// opened-and-hidden). Firestore Security Rules remain the enforced boundary;
// this is the UX mirror.
//
// Quant 1A WRITES NO BOQ QUANTITY and no financial document of any kind: it
// writes only takeoffPages and takeoffMeasurements, through revision-guarded
// transactions (lib/quantActions.js). BOQ linkage is Quant 1B.

export default function ProjectQuant() {
  const { projectId } = useOutletContext()
  const { profile, profileLoading } = useProfile()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canUseQuant(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Quant takeoff is restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Quant saves measurement records that Firestore Security Rules restrict to Company Admin, Project
          Manager and QS roles.
        </p>
      </Card>
    )
  }
  return (
    <div>
      <Card className="mb-3.5">
        <QuantHeading />
        <p className="m-0 mt-1.5 text-[12px] text-brand-text-soft">
          Pick a drawing revision and page, calibrate it from one known distance, then measure lengths, areas
          and counts. Every measurement is saved with its sheet, page, cost code and the scale it was measured
          under, and its quantity is recomputed from that record. Quant does not change BOQ quantities — that
          is a later, explicit step.
        </p>
      </Card>
      <TakeoffWorkspace projectId={projectId} />
    </div>
  )
}

// The module heading (ADR-48, shared advanced-module convention): the project
// name stays the page's <h1>; this stays an <h2>. Only the tile's luminous dot
// animates — continuously, in the module's own token — so its pause control
// sits in the same header. A component of its own so that pause state stays
// presentation-only and outside the workspace that owns the subscriptions.
// The animation is decorative: Quant recognises nothing automatically.
function QuantHeading() {
  const [beatPaused, setBeatPaused] = useState(false)
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <ModuleTile module="quant" beat paused={beatPaused} />
        <div className="min-w-0">
          <h2 className="m-0 text-[15px] font-bold text-brand-text">{MODULE_NAMES.quant}</h2>
          <p className="m-0 mt-0.5 text-[12px] text-brand-muted">Manual quantity takeoff</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-brand-muted">Metric · m, m², no.</span>
        <BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} subject="glow animation" />
      </div>
    </div>
  )
}
