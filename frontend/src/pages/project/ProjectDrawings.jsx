import { useState } from 'react'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { useProfile } from '../../hooks/useProfile'
import { useDrawings } from '../../hooks/useDrawings'
import {
  DISCIPLINES, canWriteDrawings, filterDrawings, formatDiscipline, isWithdrawnDrawing,
} from '../../lib/drawings'
import DrawingEditorModal from './documents/DrawingEditorModal'
import { inputCls, thCls } from './documents/styles'

// The DRAWINGS REGISTER — the list of every drawing master on this project, with
// the revision each one is currently issued at.
//
// The safe default view is ACTIVE drawings only: a register whose default state
// includes withdrawn sheets is a register that will eventually get something
// built from a withdrawn sheet.
//
// Desktop shows a register table. Below `md` the table is REPLACED by cards —
// never squeezed — with the drawing number and title large enough to read on a
// phone on site, and 44px tap targets throughout.
export default function ProjectDrawings() {
  const { projectId } = useOutletContext()
  const { profile }   = useProfile()
  const navigate      = useNavigate()

  const {
    drawings, drawingsLoading, drawingsError, createDrawing,
  } = useDrawings(projectId)

  const [search, setSearch]                     = useState('')
  const [discipline, setDiscipline]             = useState('')
  const [includeWithdrawn, setIncludeWithdrawn] = useState(false)
  const [showEditor, setShowEditor]             = useState(false)

  const canWrite = canWriteDrawings(profile?.role)
  const rows = filterDrawings(drawings, { search, discipline, includeWithdrawn })

  // Create the master, then go straight to it — the first revision is uploaded
  // from the drawing itself, so an upload failure leaves an honest empty
  // drawing rather than a half-created one.
  async function handleCreate(values) {
    const id = await createDrawing(values)
    navigate(`drawings/${id}`)
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          Controlled drawing register — every sheet, its current revision, and its full issue history.
        </p>
        {canWrite && <Btn sm onClick={() => setShowEditor(true)}>+ New Drawing</Btn>}
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5 mb-3.5">
        <input
          className={`${inputCls} sm:max-w-[280px]`}
          placeholder="Search number, title or revision…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className={`${inputCls} sm:max-w-[200px]`}
          value={discipline}
          onChange={e => setDiscipline(e.target.value)}
        >
          <option value="">All disciplines</option>
          {DISCIPLINES.map(d => <option key={d} value={d}>{formatDiscipline(d)}</option>)}
        </select>
        <label className="flex items-center gap-2 min-h-[44px] text-[12.5px] text-brand-muted cursor-pointer">
          <input
            type="checkbox"
            checked={includeWithdrawn}
            onChange={e => setIncludeWithdrawn(e.target.checked)}
          />
          Show withdrawn
        </label>
      </div>

      <Card padding={false}>
        {drawingsError ? (
          // ⚠️ NOT "no drawings". A failed subscription and an empty register are
          // opposite facts, and confusing them on a drawing register is a
          // site-safety problem.
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-red m-0">Drawings are unavailable.</p>
            <p className="text-[12px] text-brand-muted mt-1 mb-0">
              We could not load this project's drawings. Check your connection and refresh.
            </p>
          </div>
        ) : drawingsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading drawings…</div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {drawings.length === 0
                ? 'No drawings yet. Create the first sheet to start the register.'
                : 'No drawings match these filters.'}
            </p>
            {canWrite && drawings.length === 0 && (
              <Btn onClick={() => setShowEditor(true)}>+ Create your first drawing</Btn>
            )}
          </div>
        ) : (
          <>
            {/* Desktop / tablet register.
                Wide content scrolls inside its OWN container — the established
                pattern across every table in the app. Without it the table
                overflows the Card, whose `overflow-hidden` CLIPS rather than
                scrolls, putting the Open link out of reach on a narrow desktop
                or tablet. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full border-collapse min-w-[820px]">
                <thead>
                  <tr className="bg-brand-card border-b border-brand-border">
                    {['Drawing No.', 'Title', 'Discipline', 'Current Rev', 'Issued', 'Status', ''].map((h, i) => (
                      <th key={h || i} className={thCls}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(d => (
                    <tr key={d.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                      <td className="px-3.5 py-3 text-[13px] font-bold text-brand-text">{d.drawingNumber}</td>
                      <td className="px-3.5 py-3 text-[13px] text-brand-text">{d.title}</td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{formatDiscipline(d.discipline)}</td>
                      <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">
                        {d.currentRevisionCode || <span className="text-brand-muted font-normal">None</span>}
                      </td>
                      <td className="px-3.5 py-3 text-[12px] text-brand-muted">{d.currentRevisionIssuedDate || '—'}</td>
                      <td className="px-3.5 py-3">
                        {isWithdrawnDrawing(d)
                          ? <Badge label="Withdrawn" variant="danger" sm />
                          : d.currentRevisionId
                            ? <Badge label="Current" variant="active" sm />
                            : <Badge label="No revision" variant="soon" sm />}
                      </td>
                      <td className="px-3.5 py-3 text-right">
                        <Link
                          to={`drawings/${d.id}`}
                          className="text-[12px] font-bold text-brand-accent no-underline inline-flex items-center min-h-[44px] px-2"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards — the whole card is the tap target. */}
            <div className="md:hidden flex flex-col">
              {rows.map(d => (
                <Link
                  key={d.id}
                  to={`drawings/${d.id}`}
                  className="px-4 py-4 border-b border-brand-border no-underline block active:bg-brand-card"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[16px] font-bold text-brand-text m-0">{d.drawingNumber}</p>
                      <p className="text-[13px] text-brand-text mt-0.5 mb-0 break-words">{d.title}</p>
                      <p className="text-[12px] text-brand-muted mt-1 mb-0">
                        {formatDiscipline(d.discipline)}
                        {d.currentRevisionIssuedDate ? ` · issued ${d.currentRevisionIssuedDate}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className="text-[15px] font-bold text-brand-text">
                        {d.currentRevisionCode ? `Rev ${d.currentRevisionCode}` : '—'}
                      </span>
                      {isWithdrawnDrawing(d)
                        ? <Badge label="Withdrawn" variant="danger" sm />
                        : d.currentRevisionId
                          ? <Badge label="Current" variant="active" sm />
                          : <Badge label="No revision" variant="soon" sm />}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </Card>

      {showEditor && (
        <DrawingEditorModal
          drawing={null}
          drawings={drawings}
          onClose={() => setShowEditor(false)}
          onSave={handleCreate}
        />
      )}
    </div>
  )
}
