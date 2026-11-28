import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// ── App Check on the local Functions emulator (D3 #38) ──────────────────────
//
// Source-contract pins (the ADR-26 convention — no jsdom). The browser build
// started by `npm run test:team` supplies an UNSIGNED, emulator-only App Check
// token through the supported `CustomProvider` API, because the Functions
// emulator still refuses an enforced v2 callable that carries no token. These
// pins hold the three properties that keep that from ever being a production
// bypass: the path lives inside the emulator guard, enforcement on the server
// is unconditional, and no token that production would accept is in the repo.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const FIREBASE = stripComments(read('src/lib/firebase.js'))
const LAUNCHER_RAW = read('scripts/team-dev.mjs')
const LAUNCHER = stripComments(LAUNCHER_RAW)
const FN_INDEX = stripComments(read('functions/src/index.js'))

// The body of the `if (<cond>) { … }` that starts at `open` (brace-matched).
function blockAt(src, open) {
  const start = src.indexOf('{', open)
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return { start, end: i + 1, body: src.slice(start, i + 1) }
  }
  throw new Error('unbalanced block')
}

// Every top-level `if (useFunctionsEmulator) { … }` block in firebase.js.
function functionsEmulatorBlocks() {
  const blocks = []
  let from = 0
  for (;;) {
    const at = FIREBASE.indexOf('\nif (useFunctionsEmulator) {', from)
    if (at === -1) return blocks
    const b = blockAt(FIREBASE, at)
    blocks.push(b)
    from = b.end
  }
}

describe('the emulator App Check path is inside the emulator guard', () => {
  it('the guard is every Firestore-emulator condition AND both Functions/Auth opt-ins', () => {
    expect(FIREBASE).toContain(
      "const useFirestoreEmulator =\n  import.meta.env.DEV &&\n  import.meta.env.MODE === 'emulator' &&\n  import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'",
    )
    expect(FIREBASE).toContain(
      "const useFunctionsEmulator =\n  useFirestoreEmulator &&\n  import.meta.env.VITE_USE_FUNCTIONS_EMULATOR === 'true' &&\n  import.meta.env.VITE_USE_AUTH_EMULATOR === 'true'",
    )
    // Declared once each, as constants — never reassigned or widened later.
    expect(FIREBASE.match(/\buseFirestoreEmulator\s*=[^=]/g)).toHaveLength(1)
    expect(FIREBASE.match(/\buseFunctionsEmulator\s*=[^=]/g)).toHaveLength(1)
    expect(FIREBASE).not.toMatch(/\blet\s+use(Firestore|Functions)Emulator\b/)
  })

  it('CustomProvider, the unsigned token and its marker appear ONLY inside `if (useFunctionsEmulator)`', () => {
    const blocks = functionsEmulatorBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    const inside = blocks.map((b) => b.body).join('\n')
    let outside = FIREBASE
    for (const b of [...blocks].reverse()) outside = outside.slice(0, b.start) + outside.slice(b.end)

    expect(inside).toContain('new CustomProvider({')
    expect(inside).toContain("alg: 'none'")
    expect(inside).toContain('iss: EMULATOR_APP_CHECK_ISSUER')
    // Outside the guard: only the import and the marker constant's declaration.
    expect(outside.match(/CustomProvider/g)).toHaveLength(1)
    expect(outside).toMatch(/import \{[^}]*\bCustomProvider\b[^}]*\} from 'firebase\/app-check'/)
    expect(outside).not.toMatch(/alg:\s*'none'/)
    expect(outside.match(/EMULATOR_APP_CHECK_ISSUER/g)).toHaveLength(1)
    expect(outside).toContain("const EMULATOR_APP_CHECK_ISSUER = 'constrap-local-emulator-unsigned-app-check'")
  })

  it('exactly two App Check initialisations: reCAPTCHA Enterprise off the emulator, the unsigned provider on it', () => {
    expect(FIREBASE.match(/initializeAppCheck\(/g)).toHaveLength(2)
    expect(FIREBASE).toMatch(
      /if \(appCheckConfigured && !useFunctionsEmulator\) \{\s*initializeAppCheck\(app,\s*\{\s*provider:\s*new ReCaptchaEnterpriseProvider\(appCheckSiteKey\)/,
    )
    const inside = functionsEmulatorBlocks().map((b) => b.body).join('\n')
    expect(inside.match(/initializeAppCheck\(/g)).toHaveLength(1)
    expect(inside).not.toContain('ReCaptchaEnterpriseProvider')
  })

  it('the token is unsigned (empty signature segment) and the debug provider is never armed on the emulator', () => {
    const inside = functionsEmulatorBlocks().map((b) => b.body).join('\n')
    // header.payload. — nothing after the second dot.
    expect(inside).toContain("token: `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`,")
    expect(inside).not.toMatch(/FIREBASE_APPCHECK_DEBUG_TOKEN/)
    expect(FIREBASE).toContain(
      'if (import.meta.env.DEV && import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN && !useFunctionsEmulator) {',
    )
    expect(FIREBASE.match(/self\.FIREBASE_APPCHECK_DEBUG_TOKEN\s*=/g)).toHaveLength(1)
    // The debug token is only ever an env reference, never a literal.
    expect(FIREBASE).toContain('self.FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN')
  })

  it('no other source file touches App Check', () => {
    const offenders = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(js|jsx|mjs)$/.test(name) && /firebase\/app-check|FIREBASE_APPCHECK_DEBUG_TOKEN/.test(readFileSync(p, 'utf8'))) {
          offenders.push(p.slice(ROOT.length))
        }
      }
    }
    walk(join(ROOT, 'src'))
    expect(offenders).toEqual(['src/lib/firebase.js'])
  })
})

describe('server enforcement is unconditional', () => {
  it('every onCall takes a named options constant whose enforceAppCheck is the literal true', () => {
    const calls = [...FN_INDEX.matchAll(/\bonCall\(\s*([^,)]*)/g)].map((m) => m[1].trim())
    expect(calls.length).toBeGreaterThanOrEqual(4)
    for (const name of calls) {
      expect(name, `onCall(${name}, …)`).toMatch(/^([A-Z][A-Z0-9_]*_)?CALL_OPTIONS$/)
      const decl = FN_INDEX.indexOf(`const ${name} = {`)
      expect(decl, `${name} is declared as an object literal`).toBeGreaterThan(-1)
      const { body } = blockAt(FN_INDEX, decl)
      expect(body, name).toMatch(/^\s*enforceAppCheck: true,$/m)
      expect(body, name).not.toMatch(/\.\.\./)   // no spread that could override it
    }
    // One declaration per distinct options object, and nothing else mentions the key.
    const distinct = new Set(calls)
    expect(FN_INDEX.match(/enforceAppCheck/g)).toHaveLength(distinct.size)
    expect(FN_INDEX.match(/^\s*enforceAppCheck: true,$/gm)).toHaveLength(distinct.size)
  })

  it('no options object is mutated, and no Functions source reads an emulator/debug switch for App Check', () => {
    expect(FN_INDEX).not.toMatch(/CALL_OPTIONS\s*(\.|\[)[^\n]*=[^=]/)
    expect(FN_INDEX).not.toMatch(/Object\.assign\([A-Z_]*CALL_OPTIONS/)
    const offenders = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(js|mjs)$/.test(name)) {
          const s = stripComments(readFileSync(p, 'utf8'))
          if (/\bonCall\(|\bonRequest\(/.test(s) && !p.endsWith('functions/src/index.js')) offenders.push(`${p.slice(ROOT.length)}: declares a function`)
          if (/enforceAppCheck|skipTokenVerification|FIREBASE_DEBUG_FEATURES|FIREBASE_DEBUG_MODE/.test(s) && !p.endsWith('functions/src/index.js')) {
            offenders.push(`${p.slice(ROOT.length)}: App Check switch`)
          }
        }
      }
    }
    walk(join(ROOT, 'functions/src'))
    expect(offenders).toEqual([])
    expect(FN_INDEX).not.toMatch(/skipTokenVerification|FIREBASE_DEBUG_FEATURES|FIREBASE_DEBUG_MODE|FUNCTIONS_EMULATOR/)
  })
})

describe('the launcher isolates the emulator configuration and says what is true', () => {
  it('opts the CHILD process only, in emulator mode, and blanks both real-project App Check inputs', () => {
    expect(LAUNCHER).toContain("['--mode', 'emulator', '--host', HOST")
    for (const flag of ['VITE_USE_FIREBASE_EMULATOR', 'VITE_USE_AUTH_EMULATOR', 'VITE_USE_FUNCTIONS_EMULATOR']) {
      expect(LAUNCHER).toContain(`${flag}: 'true'`)
    }
    expect(LAUNCHER).toContain("VITE_FIREBASE_APPCHECK_SITE_KEY: ''")
    expect(LAUNCHER).toContain("VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: ''")
    // D3 #17: the project is the ONE demo project, taken from the isolation
    // module (never a literal here, never a real project) …
    expect(LAUNCHER).toContain("import { prepareIsolation, TEST_PROJECT_ID } from './emulatorIsolation.mjs'")
    expect(LAUNCHER).toMatch(/const PROJECT_ID = TEST_PROJECT_ID\b/)
    expect(read('scripts/emulatorIsolation.mjs')).toContain("export const TEST_PROJECT_ID = 'demo-constrap-test'")
    expect(LAUNCHER).toContain('VITE_FIREBASE_PROJECT_ID: PROJECT_ID')
    // … and the emulators, the Functions runtime and the bootstrap script run
    // in the ISOLATED environment (no credential file, CLI sign-in or
    // credential variable), under that project.
    // Final release batch: `--storage` (local drawings / Quant acceptance) adds the Storage emulator to the
    // SAME isolated child; the default set and the isolated env are unchanged.
    expect(LAUNCHER).toContain("['emulators:start', '--only', WITH_STORAGE ? 'auth,firestore,functions,storage' : 'auth,firestore,functions', '--project', PROJECT_ID], { env: isolation.env }")
    expect(LAUNCHER).toContain('env: { ...isolation.env, GCLOUD_PROJECT: PROJECT_ID,')
    expect(LAUNCHER).not.toContain('constrapp-69b5d')
    expect(LAUNCHER).not.toContain('constrapp-rules-test')
    expect(LAUNCHER).not.toMatch(/writeFileSync|appendFileSync/)
  })

  it('no longer claims the emulator skips App Check', () => {
    expect(LAUNCHER_RAW).not.toMatch(/App Check is skipped/i)
    expect(LAUNCHER).toMatch(/App Check stays ENFORCED on every callable here/)
    expect(LAUNCHER).toMatch(/unsigned emulator-only token/)
    for (const f of ['boq-dev.mjs', 'tender-dev.mjs', 'quant-dev.mjs', 'credit-notes-dev.mjs']) {
      expect(read(`scripts/${f}`), f).not.toMatch(/App Check is skipped/i)
    }
  })

  it('no emulator opt-in or App Check input is committed to an env file or an npm script', () => {
    const pkg = read('package.json')
    expect(pkg).not.toMatch(/VITE_USE_(FIREBASE|AUTH|FUNCTIONS)_EMULATOR|APPCHECK_DEBUG_TOKEN/)
    for (const f of ['.env', '.env.example', '.env.development', '.env.emulator', '.env.production']) {
      if (!existsSync(join(ROOT, f))) continue
      const s = read(f)
      expect(s, f).not.toMatch(/^\s*VITE_USE_(FIREBASE|AUTH|FUNCTIONS)_EMULATOR\s*=/m)
      expect(s, f).not.toMatch(/^\s*VITE_FIREBASE_APPCHECK_DEBUG_TOKEN\s*=\s*\S/m)
    }
  })
})

describe('no token that production would accept is in the repository', () => {
  // A SIGNED JWT literal (three non-empty base64url segments, JSON header) or
  // a literal App Check debug token (a UUID assigned to the debug variable).
  // The emulator token is built at run time and has an EMPTY signature, so it
  // matches neither.
  const SIGNED_JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/
  const DEBUG_LITERAL = /APPCHECK_DEBUG_TOKEN\w*['"]?\s*[:=]\s*['"]?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', '.git', 'coverage', '.firebase'])
  // Git-ignored, machine-local files are not part of the repository.
  const ignored = (name) => /\.local$/.test(name) || /\.log$/.test(name) || name === '.DS_Store'
  const TEXT = /\.(js|jsx|mjs|cjs|json|rules|md|yml|yaml|html|css|txt|example)$|^\.env/

  it('no signed JWT literal and no literal debug token anywhere in frontend/', () => {
    const hits = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name) || ignored(name)) continue
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) { walk(p); continue }
        if (!TEXT.test(name) || name === 'package-lock.json' || st.size > 2_000_000) continue
        const s = readFileSync(p, 'utf8')
        if (SIGNED_JWT.test(s)) hits.push(`${p.slice(ROOT.length)}: signed JWT literal`)
        if (DEBUG_LITERAL.test(s)) hits.push(`${p.slice(ROOT.length)}: literal App Check debug token`)
      }
    }
    walk(ROOT)
    expect(hits).toEqual([])
  })

  it('the scan really detects what it claims to (self-check on synthetic strings built at run time)', () => {
    const seg = (n) => 'A'.repeat(n)
    expect(SIGNED_JWT.test(`eyJ${seg(12)}.eyJ${seg(12)}.${seg(32)}`)).toBe(true)
    expect(SIGNED_JWT.test(`eyJ${seg(12)}.eyJ${seg(12)}.`)).toBe(false)   // unsigned: not a production token
    expect(DEBUG_LITERAL.test(`VITE_FIREBASE_APPCHECK_DEBUG_TOKEN=${'0'.repeat(8)}-${'0'.repeat(4)}-`)).toBe(true)
    expect(DEBUG_LITERAL.test('VITE_FIREBASE_APPCHECK_DEBUG_TOKEN=')).toBe(false)
  })
})
