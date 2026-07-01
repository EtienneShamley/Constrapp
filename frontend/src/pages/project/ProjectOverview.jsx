import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import ProgBar from '../../components/ProgBar'
import { currency, formatDate } from '../../lib/formatters'

export default function ProjectOverview() {
  const { project } = useOutletContext()

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
      <Card>
        <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Budget</p>
        <p className="text-lg font-bold text-brand-text">{project.budget ? currency(project.budget) : '—'}</p>
      </Card>
      <Card>
        <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Start Date</p>
        <p className="text-lg font-bold text-brand-text">{formatDate(project.startDate)}</p>
      </Card>
      <Card>
        <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Progress</p>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1"><ProgBar value={project.progress ?? 0} /></div>
          <span className="text-[11px] text-brand-muted w-8 text-right">{project.progress ?? 0}%</span>
        </div>
      </Card>
    </div>
  )
}
