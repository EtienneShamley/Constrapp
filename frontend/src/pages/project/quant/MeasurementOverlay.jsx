import { MEASUREMENT_KIND, pointsToPath, isReadableMeasurement, HIT_TOLERANCE_PX } from '../../../lib/quant'

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
  const closed = m.kind === MEASUREMENT_KIND.AREA
  return (
    <path
      d={pointsToPath(m.points, closed)}
      className={`${stroke} ${closed ? (selected ? 'fill-brand-accent/15' : 'fill-brand-quant/15') : 'fill-none'}`}
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
  draft = null,            // { kind, points } — in-progress drawing
  editing = null,          // { kind, points, vertex } — geometry being edited; `vertex` is the selected point index
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

      {/* In-progress measurement (dashed) with its points. */}
      {draft && draft.points.length > 0 && (
        <g className="stroke-brand-amber fill-brand-amber">
          {draft.kind !== MEASUREMENT_KIND.COUNT && (
            <path
              d={pointsToPath(draft.points, draft.kind === MEASUREMENT_KIND.AREA)}
              className={draft.kind === MEASUREMENT_KIND.AREA ? 'fill-brand-amber/15' : 'fill-none'}
              strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
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
          {editing.kind !== MEASUREMENT_KIND.COUNT && (
            <path
              d={pointsToPath(editing.points, editing.kind === MEASUREMENT_KIND.AREA)}
              className={editing.kind === MEASUREMENT_KIND.AREA ? 'fill-brand-accent/15' : 'fill-none'}
              strokeWidth="2" vectorEffect="non-scaling-stroke"
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
