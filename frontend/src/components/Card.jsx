export default function Card({ children, className = '' }) {
  return (
    <div className={`bg-brand-surface border border-brand-border rounded-xl p-5 ${className}`}>
      {children}
    </div>
  )
}
