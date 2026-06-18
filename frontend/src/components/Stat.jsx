export default function Stat({ label, value, sub, icon, color, accent = false }) {
  const valueColor = color || (accent ? '#00C9A7' : '#E8F0F7')
  const overlayColor = color || '#00C9A7'

  return (
    <div>
      <div
        className="absolute top-0 right-0 w-[60px] h-[60px] pointer-events-none"
        style={{ background: overlayColor + '0A', borderRadius: '0 12px 0 60px' }}
      />
      {icon && <div className="text-[22px] mb-2 leading-none">{icon}</div>}
      <p className="text-[11px] text-brand-muted font-bold uppercase tracking-[0.5px] m-0 mb-1">{label}</p>
      <p className="text-[26px] font-black m-0 leading-none" style={{ color: valueColor }}>{value}</p>
      {sub && <p className="text-[11px] text-brand-muted mt-1 m-0">{sub}</p>}
    </div>
  )
}
