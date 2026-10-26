import {
  MEASUREMENT_KIND, pointsToPath, areaPathWithHoles, holesPath, measurementDeductions, isReadableMeasurement, HIT_TOLERANCE_PX,
} from '../../../lib/quant'

// ── SVG overlay in CANONICAL page units ───────────────────────────────────────
//
// The <svg> carries `viewBox="0 0 pageWidth pageHeight"` and is sized to the
// same CSS box as the canvas, so every shape here is drawn in the stored
// coordinate space and lines up with the bitmap at every zoom. Strokes use
// `vector-effect="non-scaling-stroke"` so they stay 2px on screen; handle
// radii are converted from screen pixels with `cssScale` for the same reason.
//
// Presentation only: it never computes a quantity and, since Quant 1C-A
// (ADR-53), it handles NO pointer events of its own — every tap, drag, pan and
// pinch is resolved by the viewer against canonical coordinates (nearest
// vertex / nearest edge / shape hit test in lib/quant.js), so a 44 px finger
// target applies at every zoom and two close handles can never both answer.
// Colours are the Quant token for geometry and the shared status tokens for
// selection/edit state — meaning is always ALSO carried by the list beside the
// viewer, never by colour alone.
//
// Deductions (Quant 1D, ADR-54): an area with holes is filled with
// `fill-rule: evenodd` through lib/quant.js → areaPathWithHoles, so each
// opening reads as an opening; the hole outlines are drawn DASHED on top of
// the solid outer outline. A hole being traced is the dashed amber draft with
// a tighter dash; a hole being edited shows its parent's outline faintly
// beside it, so the user sees what the hole must stay inside.

const HANDLE_PX = 7
const COUNT_PX  = 9

function Shape({ m, selected, cssScale }) {
  const stroke = selected ? 'stroke-brand-accent' : 'stroke-brand-quant'
  if (m.kind === MEASUREMENT_KIND.COUNT) {
    const r = COUNT_PX / cssScale
    return (
      <g className={`${stroke} fill-brand-quant/25`}>
        {m.points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={r} strokeWidth={selected ? 3 : 2} vectorEffect="non-scaling-stroke" />
            <text
              x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central"
              fontSize={12 / cssScale} className="fill-brand-text stroke-none font-bold"
            >
              {i + 1}
            </text>
          </g>
        ))}
      </g>
    )
  }
  if (m.kind === MEASUREMENT_KIND.AREA) {
    const holes = measurementDeductions(m)
    return (
      <g className={stroke}>
        {/* The fill, with the holes cut out. */}
        <path
          d={areaPathWithHoles(m.points, holes)}
          fillRule="evenodd"
          className={`stroke-none ${selected ? 'fill-brand-accent/15' : 'fill-brand-quant/15'}`}
        />
        {/* The outer outline, solid. */}
        <path
          d={pointsToPath(m.points, true)}
          className="fill-none"
          strokeWidth={selected ? 3 : 2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* The deductions, dashed. */}
        {holes.length > 0 && (
          <path
            d={holesPath(holes)}
            className="fill-none"
            strokeWidth={selected ? 2.5 : 1.75}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </g>
    )
  }
  return (
    <path
      d={pointsToPath(m.points, false)}
      className={`${stroke} fill-none`}
      strokeWidth={selected ? 3 : 2}
      strokeLinejoin="round"
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  )
}

export default function MeasurementOverlay({
  pageWidth, pageHeight, cssScale,
  measurements = [], selectedId = null,
  draft = null,            // { kind, points, deduction? } — in-progress drawing (a deduction is an area traced inside its parent)
  editing = null,          // { kind, points, vertex, outline?, holes? } — geometry being edited; `vertex` is the selected point index;
                           //   `outline` is the parent's outline when a HOLE is edited, `holes` the other holes to keep clear of
  calibration = null,      // page calibration (pointA / pointB) to show
  calibrationDraft = [],   // the one or two points picked for a new calibration
}) {
  const handleR = HANDLE_PX / cssScale
  const hitR = HIT_TOLERANCE_PX / cssScale
  return (
    <g pointerEvents="none">
      {/* Saved measurements — active, readable ones only. */}
      {measurements.filter(isReadableMeasurement).map(m => (
        <Shape key={m.id} m={m} selected={m.id === selectedId} cssScale={cssScale} />
      ))}

      {/* The page's current calibration segment. */}
      {calibration?.pointA && calibration?.pointB && (
        <g className="stroke-brand-blue">
          <line
            x1={calibration.pointA.x} y1={calibration.pointA.y}
            x2={calibration.pointB.x} y2={calibration.pointB.y}
            strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
          />
          {[calibration.pointA, calibration.pointB].map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={handleR * 0.7} className="fill-brand-blue" />
          ))}
        </g>
      )}

      {/* Calibration points being picked. */}
      {calibrationDraft.length > 0 && (
        <g className="stroke-brand-blue fill-brand-blue">
          {calibrationDraft.length === 2 && (
            <line
              x1={calibrationDraft[0].x} y1={calibrationDraft[0].y}
              x2={calibrationDraft[1].x} y2={calibrationDraft[1].y}
              strokeWidth="2" vectorEffect="non-scaling-stroke"
            />
          )}
          {calibrationDraft.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={handleR} />)}
        </g>
      )}

      {/* In-progress measurement (dashed) with its points. A deduction draft
          uses a tighter dash so it reads as an opening, not a new area. */}
      {draft && draft.points.length > 0 && (
        <g className="stroke-brand-amber fill-brand-amber">
          {draft.kind !== MEASUREMENT_KIND.COUNT && (
            <path
              d={pointsToPath(draft.points, draft.kind === MEASUREMENT_KIND.AREA)}
              className={draft.kind === MEASUREMENT_KIND.AREA ? 'fill-brand-amber/15' : 'fill-none'}
              strokeWidth="2" strokeDasharray={draft.deduction ? '3 3' : '6 4'} vectorEffect="non-scaling-stroke"
            />
          )}
          {draft.points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={handleR * 0.8} />)}
        </g>
      )}

      {/* Geometry edit: the measurement's points as handles. The selected vertex
          carries a ring the size of its 44 px touch target, so the user can see
          what a tap will move or remove. */}
      {editing && (
        <g className="stroke-brand-accent fill-brand-accent">
          {/* Context for a hole edit: the parent's outline; and the other holes,
              which the edited one must stay clear of. */}
          {editing.outline && (
            <path d={pointsToPath(editing.outline, true)} className="fill-none stroke-brand-quant" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          )}
          {editing.holes?.length > 0 && (
            <path d={holesPath(editing.holes)} className="fill-none stroke-brand-quant" strokeWidth="1.5" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          )}
          {editing.kind !== MEASUREMENT_KIND.COUNT && (
            <path
              d={pointsToPath(editing.points, editing.kind === MEASUREMENT_KIND.AREA)}
              className={editing.kind === MEASUREMENT_KIND.AREA ? 'fill-brand-accent/15' : 'fill-none'}
              strokeWidth="2" strokeDasharray={editing.outline ? '3 3' : undefined} vectorEffect="non-scaling-stroke"
            />
          )}
          {editing.points.map((p, i) => (
            <g key={i}>
              {i === editing.vertex && (
                <circle cx={p.x} cy={p.y} r={hitR} className="fill-brand-accent/10 stroke-brand-accent" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              )}
              <circle cx={p.x} cy={p.y} r={i === editing.vertex ? handleR * 1.3 : handleR} className={i === editing.vertex ? 'stroke-brand-text' : ''} strokeWidth={i === editing.vertex ? 2 : 0} vectorEffect="non-scaling-stroke" />
              {editing.kind === MEASUREMENT_KIND.COUNT && (
                <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" fontSize={11 / cssScale} className="fill-brand-bg stroke-none font-bold">{i + 1}</text>
              )}
            </g>
          ))}
        </g>
      )}
      {/* The page box itself, so an empty page is still visibly bounded. */}
      <rect x="0" y="0" width={pageWidth} height={pageHeight} className="fill-none stroke-brand-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </g>
  )
}
