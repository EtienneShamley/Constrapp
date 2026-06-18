export default function Card({ children, className = '', padding = true }) {
  return (
    <div className={`relative overflow-hidden bg-brand-surface border border-brand-border rounded-xl ${padding ? 'p-5' : ''} ${className}`}>
      {children}
    </div>
  )
}
