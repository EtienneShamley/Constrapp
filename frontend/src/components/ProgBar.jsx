const colourVar = {
  'brand-accent': 'var(--color-brand-accent)',
  'brand-amber':  'var(--color-brand-amber)',
  'brand-red':    'var(--color-brand-red)',
  'brand-blue':   'var(--color-brand-blue)',
  'brand-purple': 'var(--color-brand-purple)',
}

export default function ProgBar({ value = 0, colour = 'brand-accent' }) {
  const clamped = Math.min(100, Math.max(0, value))
  return (
    <div className="w-full h-1.5 bg-brand-border rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${clamped}%`, backgroundColor: colourVar[colour] ?? colourVar['brand-accent'] }}
      />
    </div>
  )
}
