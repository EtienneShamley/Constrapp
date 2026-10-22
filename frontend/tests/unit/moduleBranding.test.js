import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MODULE_NAMES } from '../../src/lib/moduleBranding.js'
import { PROJECT_TABS } from '../../src/lib/projectTabs.js'

// ── Advanced module branding (ADR-48) ───────────────────────────────────────
//
// Presentation only: the approved names, the module marks in their tabs, the
// continuous header dot (CSS, motion-safe, pausable) on every live module page
// — PULSE™ (ADR-47), SHIELD™ (ADR-50) and Quant™ 1A (ADR-51) — the hidden
// pointer pages, brand colours through tokens, and no claim that an unbuilt
// module (IQ™) is running. Source-level pins in the Node-only runner (no
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
const shieldPage = stripComments(read('pages/project/ProjectShield.jsx'))
const quantPage  = stripComments(read('pages/project/ProjectQuant.jsx'))
const pointer   = stripComments(read('pages/Pulse.jsx'))
const shield    = stripComments(read('pages/Shield.jsx'))
const quant     = stripComments(read('pages/Quant.jsx'))
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

  it('the module tab headings and the /pulse, /shield and /quant pointers use the shared names', () => {
    expect(pulsePage).toContain('{MODULE_NAMES.pulse}</h2>')
    expect(shieldPage).toContain('{MODULE_NAMES.shield}</h2>')
    expect(quantPage).toContain('{MODULE_NAMES.quant}</h2>')
    expect(pointer).toContain('title={MODULE_NAMES.pulse}')
    expect(shield).toContain('title={MODULE_NAMES.shield}')
    expect(quant).toContain('title={MODULE_NAMES.quant}')
  })

  it('the project name stays the page <h1>; the PULSE module heading is an <h2> inside the tab', () => {
    expect(layout).toContain('<h1 className="text-xl font-semibold text-brand-text">{project.name}</h1>')
    expect(pulsePage).not.toContain('<h1')
  })

  // ADR-51: Quant™ gained its mark (a scale rule) with its page; IQ™ stays deferred.
  it('PULSE, SHIELD and Quant have a mark — IQ™ is deferred', () => {
    const glyphs = mark.slice(mark.indexOf('const GLYPHS'), mark.indexOf('const TONE'))
    expect(glyphs).toMatch(/pulse:/)
    expect(glyphs).toMatch(/shield:/)
    expect(glyphs).toMatch(/quant:/)
    expect(glyphs).not.toMatch(/\biq:/i)
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

  // ADR-50: SHIELD joined as the third tab with its static mark (15 → 16 tabs).
  // ADR-51: Quant joined as the fourth, immediately after SHIELD (16 → 17 tabs).
  it('PULSE, SHIELD and Quant are the only tabs with a mark, and there are 17 tabs', () => {
    expect(PROJECT_TABS[2]).toEqual({ to: 'shield', label: 'SHIELD', mark: 'shield' })
    expect(PROJECT_TABS[3]).toEqual({ to: 'quant', label: 'Quant', mark: 'quant' })
    expect(PROJECT_TABS.filter(t => t.mark).map(t => t.to)).toEqual(['pulse', 'shield', 'quant'])
    expect(PROJECT_TABS).toHaveLength(17)
  })

  it('no IQ project tab, and no sidebar module entry for any module', () => {
    for (const t of PROJECT_TABS) expect(t.to).not.toMatch(/\biq\b|takeoff/i)
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

  it('routes: project pulse, shield and quant tabs, hidden /pulse, /shield and /quant pointers, no iq route', () => {
    expect(app).toContain('<Route path="pulse" element={<ProjectPulse />} />')
    expect(app).toContain('<Route path="shield" element={<ProjectShield />} />')
    expect(app).toContain('<Route path="quant" element={<ProjectQuant />} />')
    expect(app).toContain('<Route path="pulse"          element={<Pulse />} />')
    expect(app).toContain('<Route path="shield"         element={<Shield />} />')
    expect(app).toContain('<Route path="quant"          element={<Quant />} />')
    expect(app).not.toMatch(/path="iq"/)
  })
})

describe('design tokens — module colours', () => {
  it('pink, cyan and lime are defined once, as module brand tokens', () => {
    expect(css).toContain('--color-brand-pulse:     #FF6B9D;')
    expect(css).toContain('--color-brand-shield:    #00D4FF;')
    expect(css).toContain('--color-brand-quant:     #A3E635;')
    expect(css.match(/--color-brand-quant:/g)).toHaveLength(1)
  })

  it('the branded files carry no hex colour and no inline style object', () => {
    for (const [f, src] of [['ModuleMark', mark], ['PageHeader', header], ['ProjectDetailLayout', layout],
      ['ProjectPulse', pulsePage], ['Pulse', pointer], ['Shield', shield], ['ProjectQuant', quantPage], ['Quant', quant]]) {
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
      expect(src, f).not.toMatch(/style=\{\{/)
    }
  })

  it('module colours come from the tokens', () => {
    expect(mark).toContain("pulse:  'text-brand-pulse'")
    expect(mark).toContain("shield: 'text-brand-shield'")
    expect(mark).toContain("quant:  'text-brand-quant'")
    expect(pointer).toContain('text-brand-pulse')
    expect(shield).toContain('text-brand-shield')
    expect(quant).toContain('text-brand-quant')
  })

  it('lime is never a Quant status colour — errors stay brand-red, review flags brand-amber', () => {
    const list = stripComments(read('pages/project/quant/MeasurementList.jsx'))
    const workspace = stripComments(read('pages/project/quant/TakeoffWorkspace.jsx'))
    expect(list).not.toContain('brand-quant')
    expect(quantPage.match(/brand-quant/g) ?? []).toHaveLength(0) // only via ModuleTile
    expect(workspace).toContain("tone === 'error' ? 'text-brand-red'")
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
    expect(quant).toContain('{MODULE_NAMES.quant}</h3>')
  })

  it('no emoji stands in for a module mark', () => {
    for (const src of [pointer, shield, quant, pulsePage, shieldPage, quantPage]) expect(src).not.toMatch(/💓|🛡|📐|🧠/u)
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
    // ONE keyframe for every advanced module: the glow colour is the
    // `--module-glow` custom property each tile sets from its own token, and
    // PULSE's pink is the fallback so the PULSE dot renders exactly as before.
    for (const f of frames.match(/box-shadow:[^;]+;/g)) expect(f).toContain('var(--module-glow, var(--color-brand-pulse))')
    expect(css.match(/@keyframes module-beat/g)).toHaveLength(1)
  })

  it('the glow is permanent: the static dot carries the same glow as the rest frame, in the module colour', () => {
    expect(tile).toContain('shadow-[0_0_6px_var(--module-glow)]')
    expect(frames).toMatch(/0%, 50%, 100% \{ transform: scale\(1\);\s+box-shadow: 0 0 6px\s+var\(--module-glow, var\(--color-brand-pulse\)\); \}/)
  })

  it('each module dot is its own token — PULSE pink, SHIELD cyan, Quant lime — set through the shared glow property', () => {
    const dots = mark.slice(mark.indexOf('const DOT'), mark.indexOf('export function ModuleMark'))
    expect(dots).toContain("pulse:  'bg-brand-pulse [--module-glow:var(--color-brand-pulse)]'")
    expect(dots).toContain("shield: 'bg-brand-shield [--module-glow:var(--color-brand-shield)]'")
    expect(dots).toContain("quant:  'bg-brand-quant [--module-glow:var(--color-brand-quant)]'")
    expect(dots).not.toMatch(/\biq:/i)
  })

  it('the dot animates only under motion-safe and only while not paused', () => {
    expect(tile).toContain("${paused ? '' : 'motion-safe:animate-module-beat'}")
    expect(mark.match(/animate-module-beat/g)).toHaveLength(1)
  })

  it('only the dot animates — the mark itself is static', () => {
    const svg = mark.slice(mark.indexOf('export function ModuleMark'), mark.indexOf('export function ModuleTile'))
    expect(svg).not.toMatch(/animate|animation/)
  })

  // The shared advanced-module convention: every branded module PAGE heading
  // carries the beat beside its pause control — PULSE (pink) and SHIELD (cyan)
  // — exactly once each; the pointer pages and the tab bar stay static.
  it('the beat is used once per module page heading — PULSE and SHIELD — beside a pause control, never on a pointer', () => {
    expect(pulsePage).toContain('<ModuleTile module="pulse" beat paused={beatPaused} />')
    expect(pulsePage).toContain('<BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} />')
    expect(pulsePage.match(/<ModuleTile[^>]*\bbeat\b/g)).toHaveLength(1)
    expect(shieldPage).toContain('<ModuleTile module="shield" beat paused={beatPaused} />')
    expect(shieldPage).toContain('<BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} subject="glow animation" />')
    expect(shieldPage.match(/<ModuleTile[^>]*\bbeat\b/g)).toHaveLength(1)
    expect(quantPage).toContain('<ModuleTile module="quant" beat paused={beatPaused} />')
    expect(quantPage).toContain('<BeatToggle paused={beatPaused} onToggle={() => setBeatPaused(p => !p)} subject="glow animation" />')
    expect(quantPage.match(/<ModuleTile[^>]*\bbeat\b/g)).toHaveLength(1)
    expect(pointer).not.toMatch(/\bbeat\b|BeatToggle/)
    expect(shield).not.toMatch(/\bbeat\b|animate|BeatToggle/)
    expect(quant).not.toMatch(/\bbeat\b|animate|BeatToggle/)
  })

  it('the pause state lives in each heading, not in the workspace that owns the subscriptions', () => {
    const pulseHeading = pulsePage.slice(pulsePage.indexOf('function PulseHeading'), pulsePage.indexOf('function PulseWorkspace'))
    expect(pulseHeading).toContain('const [beatPaused, setBeatPaused] = useState(false)')
    expect(pulsePage.slice(pulsePage.indexOf('function PulseWorkspace'))).not.toMatch(/useState|beatPaused/)
    const shieldHeading = shieldPage.slice(shieldPage.indexOf('function ShieldHeading'), shieldPage.indexOf('function ShieldWorkspace'))
    expect(shieldHeading).toContain('const [beatPaused, setBeatPaused] = useState(false)')
    expect(shieldPage.slice(shieldPage.indexOf('function ShieldWorkspace'))).not.toMatch(/useState|beatPaused/)
    // Quant's workspace is its own file; the page component holds no state at all.
    const quantHeading = quantPage.slice(quantPage.indexOf('function QuantHeading'))
    expect(quantHeading).toContain('const [beatPaused, setBeatPaused] = useState(false)')
    expect(quantPage.slice(quantPage.indexOf('export default function ProjectQuant'), quantPage.indexOf('function QuantHeading'))).not.toMatch(/useState|beatPaused/)
  })

  it('no React timer, frame loop or canvas on the branded headings', () => {
    expect(mark).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|useEffect|useState|<canvas/)
    expect(pulsePage).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|<canvas/)
    expect(shieldPage).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|<canvas/)
    // The Quant PAGE (gate + heading) has none either; the <canvas> that renders a
    // PDF sheet lives in pages/project/quant/PageViewer.jsx, not beside the dot.
    expect(quantPage).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|<canvas/)
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

  it('names its current action and subject, with the visible word inside the accessible name', () => {
    // `subject` defaults to PULSE's wording, so the PULSE control is announced
    // exactly as before; SHIELD passes "glow animation".
    expect(toggle).toContain("subject = 'heartbeat animation'")
    expect(toggle).toContain("aria-label={paused ? `Resume ${subject}` : `Pause ${subject}`}")
    expect(toggle).toContain("{paused ? 'Resume' : 'Pause'}")
    expect(toggle).not.toContain('aria-pressed') // label changes, so no pressed state as well
    expect(pulsePage).toMatch(/<BeatToggle paused=\{beatPaused\} onToggle=\{\(\) => setBeatPaused\(p => !p\)\} \/>/)
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

  it('the pointers and headings make no live, AI or IP claim', () => {
    for (const [f, src] of [['Shield', shield], ['Pulse', pointer], ['Quant', quant], ['ModuleMark', mark]]) {
      expect(src, f).not.toMatch(claims)
    }
    const heading = pulsePage.slice(pulsePage.indexOf('<ModuleTile'), pulsePage.indexOf('ex-GST unless stated'))
    expect(heading).not.toMatch(claims)
    const quantHeading = quantPage.slice(quantPage.indexOf('function QuantHeading'))
    expect(quantHeading).not.toMatch(claims)
  })

  // ADR-51: Quant™ 1A is MANUAL measurement. Its pointer and page say so and
  // never describe recognition, detection or automation.
  it('Quant describes manual takeoff, never AI or automatic recognition, and no BOQ write', () => {
    expect(quant).toContain('Manual quantity takeoff')
    expect(quantPage).toContain('Manual quantity takeoff')
    for (const src of [quant, quantPage]) {
      expect(src).not.toMatch(/\bAI\b|automatic|recogni[sz]e|detect|machine learning/i)
    }
    // ADR-52: a measurement may be LINKED to a BOQ item, but the Quant tab still
    // never changes a BOQ quantity itself — that is the BOQ tab's explicit step.
    expect(quantPage).toMatch(/never changes a BOQ quantity by itself/)
    expect(quantPage).toMatch(/explicit,\s*confirmed step on the BOQ tab/)
  })

  // ADR-50: the /shield route became a pointer to the project tab (the /pulse
  // precedent). Coming Soon is gone; the copy names the five checks and still
  // describes commercial assurance, never safety.
  it('SHIELD is a pointer to the project tab, describes commercial assurance, not safety, and no longer says Coming Soon', () => {
    expect(shield).not.toContain('Coming Soon')
    expect(shield).toContain('to="/projects"')
    expect(shield).toContain('Commercial assurance checks')
    expect(shield).not.toMatch(/safety|HSEQ|hazard|incident/i)
  })
})

describe('no new data flow or dependency', () => {
  it('branding files read no data: no hook, no Firebase, no subscription', () => {
    for (const src of [mark, header, read('lib/moduleBranding.js'), pointer, shield, quant]) {
      expect(src).not.toMatch(/from 'firebase|onSnapshot|from '\.\.\/hooks\/|from '\.\.\/\.\.\/hooks\//)
    }
  })

  it('ProjectPulse still opens exactly its eleven subscriptions', () => {
    const calls = pulsePage.match(/= use(BudgetLines|PurchaseOrders|ProgressClaims|SupplierInvoices|SupplierCreditNotes|Variations|ForecastLines|ProjectCommercial|SupplierPayments|RetentionReleases|ProjectActivities)\(/g)
    expect(calls).toHaveLength(11)
  })

  // ADR-51 approved exactly ONE runtime dependency for Quant™: pdfjs-dist, pinned.
  it('the only added runtime dependency is the pinned pdfjs-dist (ADR-51)', () => {
    const pkg = JSON.parse(readRoot('package.json'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@tailwindcss/vite', 'firebase', 'pdfjs-dist', 'react', 'react-dom', 'react-router-dom', 'recharts', 'tailwindcss',
    ])
    expect(pkg.dependencies['pdfjs-dist']).toMatch(/^\d+\.\d+\.\d+$/) // exact pin, no range
  })
})
