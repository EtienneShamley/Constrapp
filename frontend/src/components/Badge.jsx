const styles = {
  // semantic variants (used by existing pages)
  active:    'bg-brand-accent/15 text-brand-accent border border-brand-accent/25',
  pending:   'bg-brand-amber/15  text-brand-amber  border border-brand-amber/25',
  completed: 'bg-brand-purple/15 text-brand-purple border border-brand-purple/25',
  danger:    'bg-brand-red/15    text-brand-red    border border-brand-red/25',
  info:      'bg-brand-blue/15   text-brand-blue   border border-brand-blue/25',
  soon:      'bg-brand-muted/20  text-brand-muted  border border-brand-muted/25',
  // prototype status strings
  'In Progress':  'bg-brand-accent/15  text-brand-accent  border border-brand-accent/25',
  'Backlogged':   'bg-brand-amber/15   text-brand-amber   border border-brand-amber/25',
  'Planning':     'bg-brand-blue/15    text-brand-blue    border border-brand-blue/25',
  'Completed':    'bg-brand-accent/15  text-brand-accent  border border-brand-accent/25',
  'Complete':     'bg-brand-accent/15  text-brand-accent  border border-brand-accent/25',
  'Approved':     'bg-brand-accent/15  text-brand-accent  border border-brand-accent/25',
  'Pending':      'bg-brand-amber/15   text-brand-amber   border border-brand-amber/25',
  'Sent':         'bg-brand-blue/15    text-brand-blue    border border-brand-blue/25',
  'Delivered':    'bg-brand-purple/15  text-brand-purple  border border-brand-purple/25',
  'Rejected':     'bg-brand-red/15     text-brand-red     border border-brand-red/25',
  'Draft':        'bg-brand-muted/20   text-brand-muted   border border-brand-muted/25',
  'Current':      'bg-brand-accent/15  text-brand-accent  border border-brand-accent/25',
  'Superseded':   'bg-brand-muted/20   text-brand-muted   border border-brand-muted/25',
  'Subcontractor':'bg-brand-accent/15  text-brand-accent  border border-brand-accent/25',
  'Supplier':     'bg-brand-blue/15    text-brand-blue    border border-brand-blue/25',
  'Consultant':   'bg-brand-purple/15  text-brand-purple  border border-brand-purple/25',
}

export default function Badge({ label, variant, sm = false }) {
  const key = variant || label
  const cls = styles[key] || styles.info
  return (
    <span className={`inline-flex items-center rounded-md font-bold whitespace-nowrap ${sm ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs'} ${cls}`}>
      {label}
    </span>
  )
}
