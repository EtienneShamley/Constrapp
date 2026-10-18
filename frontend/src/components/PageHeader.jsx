// `mark` is an optional leading visual (a module's ModuleTile, ADR-48) shown
// beside the title block; the title itself stays the page's single <h1>.
// Without a mark the header renders exactly as before.
export default function PageHeader({ title, sub, mark, children }) {
  const heading = (
    <div>
      <h1 className="text-xl font-semibold text-brand-text">{title}</h1>
      {sub && <p className="text-sm text-brand-muted mt-0.5">{sub}</p>}
    </div>
  )
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
      {mark ? <div className="flex items-center gap-3">{mark}{heading}</div> : heading}
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}
