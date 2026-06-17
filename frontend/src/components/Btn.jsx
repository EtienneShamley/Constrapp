const variants = {
  primary: 'bg-brand-accent text-brand-bg hover:opacity-90',
  ghost:   'bg-transparent border border-brand-border text-brand-text hover:bg-brand-card',
  danger:  'bg-brand-red text-white hover:opacity-90',
}

export default function Btn({ children, variant = 'primary', className = '', ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-lg text-sm font-medium transition-opacity cursor-pointer ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
