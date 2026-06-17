export default function Stat({ label, value, sub, accent = false }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-brand-muted uppercase tracking-wider">{label}</span>
      <span className={`text-2xl font-semibold ${accent ? 'text-brand-accent' : 'text-brand-text'}`}>{value}</span>
      {sub && <span className="text-xs text-brand-muted">{sub}</span>}
    </div>
  )
}
