const colours = {
  active:    'bg-brand-accent/15 text-brand-accent',
  pending:   'bg-brand-amber/15 text-brand-amber',
  completed: 'bg-brand-purple/15 text-brand-purple',
  danger:    'bg-brand-red/15 text-brand-red',
  info:      'bg-brand-blue/15 text-brand-blue',
  soon:      'bg-brand-muted/20 text-brand-muted',
}

export default function Badge({ label, variant = 'info' }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colours[variant]}`}>
      {label}
    </span>
  )
}
