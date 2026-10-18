import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MODULE_NAMES } from '../../src/lib/moduleBranding.js'
import { PROJECT_TABS } from '../../src/lib/projectTabs.js'

// ── Advanced module branding (ADR-48) ───────────────────────────────────────
//
// Presentation only: the approved names, the PULSE mark in its tab, the PULSE
// header dot (three CSS beats, motion-safe, then still), static SHIELD™
// placeholder branding, brand colours through tokens, and no claim that an
// unbuilt module is running. Source-level pins in the Node-only runner (no
// jsdom), like betaSurfaces.test.js and pulse.test.js.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const readRoot = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const css       = read('index.css')
const mark      = stripComments(read('components/ModuleMark.jsx'))
const header    = stripComments(read('components/PageHeader.jsx'))
const layout    = stripComments(read('layouts/ProjectDetailLayout.jsx'))
const pulsePage = stripComments(read('pages/project/ProjectPulse.jsx'))
const pointer   = stripComments(read('pages/Pulse.jsx'))
const shield    = stripComments(read('pages/Shield.jsx'))
const app       = read('App.jsx')

describe('exact module branding', () => {
  it('the four approved full product names, and no others', () => {
    expect(MODULE_NAMES).toEqual({
      pulse:  'Constrapp PULSE™',
      shield: 'Constrapp SHIELD™',
      quant:  'Constrapp Quant™',
      iq:     'Constrapp IQ™',
    })
  })

  it('the PULSE tab heading, the /pulse pointer and the /shield placeholder use the shared names', () => {
    expect(pulsePage).toContain('{MODULE_NAMES.pulse}</h2>')
    expect(pointer).toContain('title={MODULE_NAMES.pulse}')
    expect(shield).toContain('title={MODULE_NAMES.shield}')
  })

  it('the project name stays the page <h1>; the PULSE module heading is an <h2> inside the tab', () => {
    expect(layout).toContain('<h1 className="text-xl font-semibold text-brand-text">{project.name}</h1>')
    expect(pulsePage).not.toContain('<h1')
  })

  it('only PULSE and SHIELD have a mark — Quant™ and IQ™ are deferred', () => {
    const glyphs = mark.slice(mark.indexOf('const GLYPHS'), mark.indexOf('const TONE'))
    expect(glyphs).toMatch(/pulse:/)
    expect(glyphs).toMatch(/shield:/)
    expect(glyphs).not.toMatch(/quant|iq:/i)
  })

  it('PageHeader renders exactly as before when no mark is passed', () => {
    expect(header).toContain('{mark ? <div className="flex items-center gap-3">{mark}{heading}</div> : heading}')
  })
})

describe('navigation — PULSE tab, no unbuilt module surfaces', () => {
  it('PULSE remains the second project tab, with its compact label and mark', () => {
    expect(PROJECT_TABS[0].to).toBe('overview')
    expect(PROJECT_TABS[1]).toEqual({ to: 'pulse', label: 'PULSE', mark: 'pulse' })
  })

  it('PULSE is the only tab with a mark, and still 15 tabs', () => {
    expect(PROJECT_TABS.filter(t => t.mark).map(t => t.to)).toEqual(['pulse'])
    expect(PROJECT_TABS).toHaveLength(15)
  })

  it('no SHIELD, Quant or IQ project tab, and no sidebar module entry', () => {
    for (const t of PROJECT_TABS) expect(t.to).not.toMatch(/shield|quant|iq|takeoff/i)
    const nav = read('lib/nav.js')
    expect(nav).not.toMatch(/to:\s*'\/(pulse|shield|quant|iq)'/)
  })

  it('the tab renders the static mark, keeps the shared active styling, and animates nothing', () => {
    expect(layout).toContain('{mark && <ModuleMark module={mark} />}')
    expect(layout).toContain("isActive ? 'text-brand-accent border-brand-accent'")
    expect(layout).toContain('px-3 py-2 text-[12.5px]') // touch target not reduced
    expect(layout).toContain('flex flex-wrap gap-1')    // tabs still wrap
    expect(layout).not.toMatch(/animate|animation|ModuleTile/)
  })

  it('existing routes are unchanged: project pulse tab, hidden /pulse and /shield, no quant / iq route', () => {
    expect(app).toContain('<Route path="pulse" element={<ProjectPulse />} />')
    expect(app).toContain('<Route path="pulse"          element={<Pulse />} />')
    expect(app).toContain('<Route path="shield"         element={<Shield />} />')
    expect(app).not.toMatch(/path="(quant|iq)"/)
  })
})

describe('design tokens — module colours', () => {
  it('pink and cyan are defined once, as module brand tokens', () => {
    expect(css).toContain('--color-brand-pulse:     #FF6B9D;')
    expect(css).toContain('--color-brand-shield:    #00D4FF;')
  })

  it('the branded files carry no hex colour and no inline style object', () => {
    for (const [f, src] of [['ModuleMark', mark], ['PageHeader', header], ['ProjectDetailLayout', layout],
      ['ProjectPulse', pulsePage], ['Pulse', pointer], ['Shield', shield]]) {
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
      expect(src, f).not.toMatch(/style=\{\{/)
    }
  })

  it('module colours come from the tokens', () => {
    expect(mark).toContain("pulse:  'text-brand-pulse'")
    expect(mark).toContain("shield: 'text-brand-shield'")
    expect(pointer).toContain('text-brand-pulse')
    expect(shield).toContain('text-brand-shield')
  })

  it('pink is never a PULSE status colour — findings stay brand-red', () => {
    const card = read('pages/project/pulse/IndicatorCard.jsx')
    expect(card).not.toContain('brand-pulse')
    expect(pulsePage.match(/brand-pulse/g) ?? []).toHaveLength(0) // only via ModuleTile
    expect(pulsePage).toContain("[PULSE_STATE.FINDING]:     'text-brand-red'")
  })
})

describe('decorative mark accessibility', () => {
  it('the SVG is hidden from assistive technology and never focusable', () => {
    const svg = mark.slice(mark.indexOf('export function ModuleMark'), mark.indexOf('export function ModuleTile'))
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).toContain('focusable="false"')
    expect(svg).not.toMatch(/<title|aria-label|role="img"/)
  })

  it('the indicator dot is decorative too', () => {
    const dot = mark.slice(mark.indexOf('{beat && ('))
    expect(dot).toContain('aria-hidden="true"')
  })

  it('every mark sits beside its module name in text', () => {
    expect(pointer).toContain('{MODULE_NAMES.pulse}</h3>')
    expect(shield).toContain('{MODULE_NAMES.shield}</h3>')
  })

  it('no emoji stands in for a module mark', () => {
    for (const src of [pointer, shield, pulsePage]) expect(src).not.toMatch(/💓|🛡|📐|🧠/u)
  })
})

describe('the PULSE indicator dot — continuous, gentle, pausable, motion-safe, CSS only', () => {
  const tile   = mark.slice(mark.indexOf('export function ModuleTile'), mark.indexOf('export function BeatToggle'))
  const frames = css.slice(css.indexOf('@keyframes module-beat'), css.indexOf('}', css.indexOf('36%')) + 1)

  it('the animation token is a continuous heartbeat of 1.5–2s per cycle', () => {
    expect(css).toContain('--animate-module-beat: module-beat 1.8s ease-in-out infinite;')
    const theme = css.slice(css.indexOf('@theme'), css.indexOf('*, *::before'))
    expect(theme.match(/infinite/g)).toHaveLength(1) // only the dot's beat loops
  })

  it('gentle: scale and glow vary, opacity never animates — the dot cannot disappear or flash', () => {
    expect(frames).not.toMatch(/opacity/)
    const scales = [...frames.matchAll(/scale\(([\d.]+)\)/g)].map(m => Number(m[1]))
    expect(Math.min(...scales)).toBe(1)
    expect(Math.max(...scales)).toBeLessThanOrEqual(1.25)
    const glows = [...frames.matchAll(/0 0 (\d+)px/g)].map(m => Number(m[1]))
    expect(Math.min(...glows)).toBe(6)
    for (const g of glows) expect(g).toBeLessThanOrEqual(12)
    for (const f of frames.match(/box-shadow:[^;]+;/g)) expect(f).toContain('var(--color-brand-pulse)')
  })

  it('the glow is permanent: the static dot carries the same glow as the rest frame', () => {
    expect(tile).toContain('shadow-[0_0_6px_var(--color-brand-pulse)]')
    expect(frames).toMatch(/0%, 50%, 100% \{ transform: scale\(1\);\s+box-shadow: 0 0 6px\s+var\(--color-brand-pulse\); \}/)
  })

  it('the dot animates only under motion-safe and only while not paused', () => {
    expect(tile).toContain("${paused ? '' : 'motion-safe:animate-module-beat'}")
    expect(mark.match(/animate-module-beat/g)).toHaveLength(1)
  })

  it('only the dot animates — the mark itself is static', () => {
    const svg = mark.slice(mark.indexOf('export function ModuleMark'), mark.indexOf('export function ModuleTile'))
    expect(svg).not.toMatch(/animate|animation/)
  })

  it('the beat is used once — the project PULSE heading, beside its pause control — never on SHIELD or the pointer', () => {
    expect(pulsePage).toContain('<ModuleTile module="pulse" beat paused={beatPaused} />')
    expect(pulsePage).toContain('<BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} />')
    expect(pulsePage.match(/<ModuleTile[^>]*\bbeat\b/g)).toHaveLength(1)
    expect(pointer).not.toMatch(/\bbeat\b|BeatToggle/)
    expect(shield).not.toMatch(/\bbeat\b|animate|BeatToggle/)
  })

  it('the pause state lives in the heading, not in the workspace that owns the subscriptions', () => {
    const heading = pulsePage.slice(pulsePage.indexOf('function PulseHeading'), pulsePage.indexOf('function PulseWorkspace'))
    expect(heading).toContain('const [beatPaused, setBeatPaused] = useState(false)')
    expect(pulsePage.slice(pulsePage.indexOf('function PulseWorkspace'))).not.toMatch(/useState|beatPaused/)
  })

  it('no React timer, frame loop or canvas', () => {
    expect(mark).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|useEffect|useState|<canvas/)
    expect(pulsePage).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|<canvas/)
  })
})

describe('pause / resume control (WCAG 2.2.2)', () => {
  const toggle = mark.slice(mark.indexOf('export function BeatToggle'))

  it('is a real button, keyboard-operable by default', () => {
    expect(toggle).toContain('<button')
    expect(toggle).toContain('type="button"')
    expect(toggle).toContain('onClick={onToggle}')
    expect(toggle).not.toMatch(/tabIndex|onMouseDown|onPointerDown/)
  })

  it('names its current action, with the visible word inside the accessible name', () => {
    expect(toggle).toContain("aria-label={paused ? 'Resume heartbeat animation' : 'Pause heartbeat animation'}")
    expect(toggle).toContain("{paused ? 'Resume' : 'Pause'}")
    expect(toggle).not.toContain('aria-pressed') // label changes, so no pressed state as well
  })

  it('is discreet but keeps the 44px touch target and a visible keyboard focus', () => {
    expect(toggle).toContain('min-h-[44px] min-w-[44px]')
    expect(toggle).toContain('text-[11px]')
    expect(toggle).toContain('text-brand-muted')
    expect(toggle).toContain('focus-visible:outline-2 focus-visible:outline-brand-accent')
  })

  it('its glyph is decorative', () => {
    expect(toggle).toMatch(/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/)
  })

  it('is hidden under reduced motion, where nothing moves and the dot stays lit', () => {
    expect(toggle).toContain('motion-reduce:hidden')
  })
})

describe('no misleading claims', () => {
  const claims = /\bLIVE\b|real-time|realtime|monitoring|patent|proprietary|world-first|world's first|\bAI\b|\bscore\b/i

  it('SHIELD placeholder, PULSE pointer and PULSE heading make no live or IP claim', () => {
    for (const [f, src] of [['Shield', shield], ['Pulse', pointer], ['ModuleMark', mark]]) {
      expect(src, f).not.toMatch(claims)
    }
    const heading = pulsePage.slice(pulsePage.indexOf('<ModuleTile'), pulsePage.indexOf('ex-GST unless stated'))
    expect(heading).not.toMatch(claims)
  })

  it('SHIELD keeps its Coming Soon status and describes commercial assurance, not safety', () => {
    expect(shield).toContain('<Badge label="Coming Soon" variant="soon" />')
    expect(shield).toContain('Commercial audit and assurance')
    expect(shield).not.toMatch(/safety|HSEQ|hazard|incident/i)
  })
})

describe('no new data flow or dependency', () => {
  it('branding files read no data: no hook, no Firebase, no subscription', () => {
    for (const src of [mark, header, read('lib/moduleBranding.js'), pointer, shield]) {
      expect(src).not.toMatch(/from 'firebase|onSnapshot|from '\.\.\/hooks\/|from '\.\.\/\.\.\/hooks\//)
    }
  })

  it('ProjectPulse still opens exactly its eleven subscriptions', () => {
    const calls = pulsePage.match(/= use(BudgetLines|PurchaseOrders|ProgressClaims|SupplierInvoices|SupplierCreditNotes|Variations|ForecastLines|ProjectCommercial|SupplierPayments|RetentionReleases|ProjectActivities)\(/g)
    expect(calls).toHaveLength(11)
  })

  it('no dependency was added', () => {
    const pkg = JSON.parse(readRoot('package.json'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@tailwindcss/vite', 'firebase', 'react', 'react-dom', 'react-router-dom', 'recharts', 'tailwindcss',
    ])
  })
})
