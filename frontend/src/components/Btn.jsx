const base = 'inline-flex items-center justify-center gap-2 rounded-lg font-bold transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'

const variants = {
  primary: 'bg-gradient-to-r from-[#00C9A7] to-[#00A888] text-brand-bg hover:opacity-90',
  ghost:   'bg-transparent border border-brand-border text-brand-text hover:bg-brand-card',
  danger:  'bg-brand-red text-white hover:opacity-90',
  success: 'bg-brand-accent/10 text-brand-accent border border-brand-accent/25 hover:bg-brand-accent/20',
  gold:    'bg-gradient-to-r from-[#F5A623] to-[#D4880A] text-black hover:opacity-90',
}

export default function Btn({ children, variant = 'primary', sm = false, className = '', ...props }) {
  const size = sm ? 'min-h-[32px] px-3 py-1 text-[11px]' : 'min-h-[44px] px-4 text-sm'
  return (
    <button
      className={`${base} ${variants[variant] ?? variants.primary} ${size} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
