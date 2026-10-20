import { MEASUREMENT_KIND, pointsToPath, isReadableMeasurement } from '../../../lib/quant'

// ── SVG overlay in CANONICAL page units ───────────────────────────────────────
//
// The <svg> carries `viewBox="0 0 pageWidth pageHeight"` and is sized to the
// same CSS box as the canvas, so every shape here is drawn in the stored
// coordinate space and lines up with the bitmap at every zoom. Strokes use
// `vector-effect="non-scaling-stroke"` so they stay 2px on screen; handle
// radii are converted from screen pixels with `cssScale` for the same reason.
//
// Presentation only: it never computes a quantity. Colours are the Quant token
// for geometry and the shared status tokens for selection/edit state —
// meaning is always ALSO carried by the list beside the viewer, never by
// colour alone.

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
            <circle cx={p.x} cy={p.y} r={r} strokeWidth="2" vectorEffect="non-scaling-stroke" />
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
      className={`${stroke} ${closed ? 'fill-brand-quant/15' : 'fill-none'}`}
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
  editing = null,          // { points } — geometry being edited (draggable)
  calibration = null,      // page calibration (pointA / pointB) to show
  calibrationDraft = [],   // the one or two points picked for a new calibration
  onHandlePointerDown,     // (index, event)
}) {
  const handleR = HANDLE_PX / cssScale
  return (
    <>
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

      {/* Geometry edit: the measurement's points as draggable handles. */}
      {editing && (
        <g className="stroke-brand-accent fill-brand-accent">
          <path
            d={pointsToPath(editing.points, editing.kind === MEASUREMENT_KIND.AREA)}
            className={editing.kind === MEASUREMENT_KIND.AREA ? 'fill-brand-accent/15' : 'fill-none'}
            strokeWidth="2" vectorEffect="non-scaling-stroke"
          />
          {editing.points.map((p, i) => (
            <circle
              key={i} cx={p.x} cy={p.y} r={handleR}
              className="cursor-move"
              onPointerDown={(e) => onHandlePointerDown?.(i, e)}
            />
          ))}
        </g>
      )}
      {/* The page box itself, so an empty page is still visibly bounded. */}
      <rect x="0" y="0" width={pageWidth} height={pageHeight} className="fill-none stroke-brand-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </>
  )
}
