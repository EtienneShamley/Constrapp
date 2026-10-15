import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Auth surface guards (Login Redesign) ─────────────────────────────────────
//
// The login page was redesigned as a split-screen recreation of the v5
// prototype. The redesign was visual ONLY, and the prototype carried things
// Constrapp must never ship on its sign-in page (fake demo access, demo-account
// quick-fill, membership pricing, a non-functional "Remember Me", AI modules
// advertised as available, unsupported marketing claims). This file pins:
//
//   1. the Firebase sign-in / reset calls and redirects are untouched
//   2. account-enumeration protections are untouched
//   3. session behaviour is untouched (no persistence override)
//   4. the auth-route guards and the three auth routes still exist
//   5. the responsive split-screen structure
//   6. labelled inputs and accessibly announced errors
//   7. no fake demo / membership / pricing functionality
//   8. no claims about unfinished modules, no unsupported marketing claims
//   9. token-only styling (no hex, no inline style objects)
//
// These assert SOURCE STRUCTURE, not rendered DOM: the unit runner is plain
// Node with no jsdom and no testing-library (the ADR-26 convention; same shape
// as betaSurfaces.test.js).

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

// Strip JS line comments and JS/JSX block comments, so copy assertions look
// only at what renders. (None of these files contain a `//` inside a string.)
const code = (src) =>
  src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const LOGIN    = read('pages/Login.jsx')
const FORGOT   = read('pages/ForgotPassword.jsx')
const CREATE   = read('pages/CreateAccount.jsx')
const LAYOUT   = read('layouts/AuthLayout.jsx')
const FIELD    = read('components/AuthField.jsx')
const USE_AUTH = read('hooks/useAuth.jsx')
const GUARD    = read('components/ProtectedRoute.jsx')
const APP      = read('App.jsx')

const AUTH_FILES = { 'Login.jsx': LOGIN, 'ForgotPassword.jsx': FORGOT, 'CreateAccount.jsx': CREATE, 'AuthLayout.jsx': LAYOUT, 'AuthField.jsx': FIELD }

// ── 1. Firebase sign-in and reset ────────────────────────────────────────────

describe('Firebase sign-in is unchanged', () => {
  it('Login signs in with email + password through the Firebase Auth SDK', () => {
    expect(LOGIN).toMatch(/import\s*\{\s*signInWithEmailAndPassword\s*\}\s*from\s*'firebase\/auth'/)
    expect(LOGIN).toContain('await signInWithEmailAndPassword(auth, email, password)')
  })

  it('Login sends a successful sign-in to the app root, replacing history', () => {
    const signIn = LOGIN.indexOf('await signInWithEmailAndPassword(')
    const nav = LOGIN.indexOf("navigate('/', { replace: true })")
    expect(nav).toBeGreaterThan(signIn)
  })

  it('Login submits a real <form> (Enter key and password managers keep working)', () => {
    expect(LOGIN).toContain('<form onSubmit={handleSubmit}>')
    expect(LOGIN).toContain('e.preventDefault()')
    expect(LOGIN).toContain('type="submit"')
  })

  it('Login keeps native validation and autofill hints', () => {
    expect(LOGIN).toContain('type="email"')
    expect(LOGIN).toContain('type="password"')
    expect(LOGIN).toContain('autoComplete="email"')
    expect(LOGIN).toContain('autoComplete="current-password"')
    expect((LOGIN.match(/\brequired\b/g) || []).length).toBe(2)
    expect(LOGIN).not.toContain('noValidate')
  })

  it('password reset still calls sendPasswordResetEmail with the trimmed address', () => {
    expect(FORGOT).toMatch(/import\s*\{\s*sendPasswordResetEmail\s*\}\s*from\s*'firebase\/auth'/)
    expect(FORGOT).toContain('await sendPasswordResetEmail(auth, email.trim())')
    expect(FORGOT).not.toContain('actionCodeSettings,')
  })

  it('no other auth-layer file imports Firebase', () => {
    for (const src of [CREATE, LAYOUT, FIELD]) expect(src).not.toMatch(/from\s*'firebase\//)
  })
})

// ── 2. Account-enumeration protections ───────────────────────────────────────

describe('account enumeration stays closed', () => {
  it('Login collapses unknown user, wrong password and invalid credential into one message', () => {
    expect(LOGIN).toMatch(
      /case 'auth\/user-not-found':\s*case 'auth\/wrong-password':\s*case 'auth\/invalid-credential':\s*return 'Incorrect email or password\.'/,
    )
  })

  it('reset treats an unknown address exactly like a real one', () => {
    expect(FORGOT).toMatch(/if \(err\?\.code === 'auth\/user-not-found'\) \{\s*setSent\(true\)/)
    const fe = FORGOT.slice(FORGOT.indexOf('function friendlyError'))
    expect(fe).not.toContain('user-not-found')
    expect(FORGOT).toContain('If an account exists for that address, a reset link is on its way.')
  })
})

// ── 3. Session behaviour ─────────────────────────────────────────────────────

describe('session behaviour is untouched', () => {
  it('auth state still comes from onAuthStateChanged', () => {
    expect(USE_AUTH).toContain('onAuthStateChanged(auth,')
  })

  it('no auth file overrides Firebase persistence (no "remember me" wiring)', () => {
    for (const src of [...Object.values(AUTH_FILES), USE_AUTH]) {
      expect(src).not.toMatch(/setPersistence|browserSessionPersistence|inMemoryPersistence/)
    }
  })
})

// ── 4. Redirects and routes ──────────────────────────────────────────────────

describe('auth guards and routes', () => {
  it('AuthLayout waits for auth, then redirects a signed-in user, before rendering anything', () => {
    const wait = LAYOUT.indexOf('if (loading) return <Spinner />')
    const redirect = LAYOUT.indexOf('if (user) return <Navigate to="/" replace />')
    const render = LAYOUT.indexOf('<Outlet />')
    expect(wait).toBeGreaterThan(-1)
    expect(redirect).toBeGreaterThan(wait)
    expect(render).toBeGreaterThan(redirect)
  })

  it('ProtectedRoute still sends a signed-out user to /login', () => {
    expect(GUARD).toContain('if (!user)   return <Navigate to="/login" replace />')
  })

  it('/login, /create-account and /forgot-password all still render inside AuthLayout', () => {
    const open = APP.indexOf('<Route element={<AuthLayout />}>')
    const close = APP.indexOf('</Route>', open)
    expect(open).toBeGreaterThan(-1)
    const block = APP.slice(open, close)
    expect(block).toContain('path="login"           element={<Login />}')
    expect(block).toContain('path="create-account"  element={<CreateAccount />}')
    expect(block).toContain('path="forgot-password" element={<ForgotPassword />}')
  })

  it('/create-account stays a non-functional stub (no public registration)', () => {
    expect(CREATE).not.toMatch(/<form|<input|createUser/)
  })
})

// ── 5. Responsive structure ──────────────────────────────────────────────────

describe('split-screen layout is responsive', () => {
  it('two columns from lg: ≈55% product panel / ≈45% sign-in panel', () => {
    expect(LAYOUT).toContain('lg:grid lg:grid-cols-[minmax(0,55fr)_minmax(0,45fr)]')
  })

  it('the form is centred in its panel at a readable max width (420px)', () => {
    expect(LAYOUT).toContain('mx-auto my-auto lg:max-w-[420px]')
  })

  it('the product panel is a labelled landmark hidden below lg', () => {
    expect(LAYOUT).toMatch(/<aside\s+aria-label="About Constrapp"\s+className="hidden lg:flex /)
  })

  it('the form lives in <main>, with compact branding shown only below lg', () => {
    expect(LAYOUT).toContain('<main ')
    expect(LAYOUT).toContain('lg:hidden flex flex-col items-center')
  })

  it('uses small-viewport height (no 100vh jump under mobile browser chrome)', () => {
    const shell = LAYOUT.slice(LAYOUT.indexOf('export default function AuthLayout'))
    expect(shell).toContain('min-h-svh')
    expect(shell.slice(shell.indexOf('return (', shell.indexOf('if (user)')))).not.toMatch(/100vh|h-screen/)
  })

  it('centres with my-auto, not justify-center, so a tall form never clips at the top', () => {
    expect(LAYOUT).toContain('mx-auto my-auto')
  })
})

// ── 6. Labels and accessible errors ──────────────────────────────────────────

describe('labelled inputs and announced errors', () => {
  it('AuthField binds a real <label htmlFor> to the input id', () => {
    expect(FIELD).toContain('htmlFor={id}')
    expect(FIELD).toContain('id={id}')
  })

  it('an error marks the input invalid and describes it', () => {
    expect(FIELD).toContain('aria-invalid={errorId ? true : undefined}')
    expect(FIELD).toContain('aria-describedby={errorId || undefined}')
  })

  it('error messages are announced (role="alert")', () => {
    expect(FIELD).toMatch(/export function AuthError[\s\S]*role="alert"/)
  })

  it('inputs are 16px below sm (no iOS focus zoom) and keep a forced-colors outline', () => {
    expect(FIELD).toContain('text-base sm:text-sm')
    expect(FIELD).toContain('outline-hidden')
    expect(code(FIELD)).not.toContain('outline-none')
    expect(FIELD).toContain('focus:ring-2')
  })

  it('every auth page input goes through AuthField with an id and a label', () => {
    for (const src of [LOGIN, FORGOT]) {
      expect(code(src)).not.toMatch(/<input\b/)
      const fields = code(src).match(/<AuthField[\s\S]*?\/>/g) || []
      expect(fields.length).toBeGreaterThan(0)
      for (const f of fields) {
        expect(f).toMatch(/\bid=\{/)
        expect(f).toMatch(/\blabel="/)
        expect(f).toContain('errorId={errorId}')
      }
    }
  })

  it('the error id handed to inputs is the id rendered on the alert', () => {
    for (const src of [LOGIN, FORGOT]) expect(src).toContain('<AuthError id={errorId}>')
  })

  it('each auth page has exactly one <h1>, and the layout has none', () => {
    for (const src of [LOGIN, FORGOT, CREATE]) expect((code(src).match(/<h1\b/g) || []).length).toBe(1)
    expect(code(LAYOUT)).not.toMatch(/<h1\b/)
  })

  it('"No account?" guidance is plain copy, not a link (no self-serve signup, ADR-27)', () => {
    const at = LOGIN.indexOf('No account?')
    expect(at).toBeGreaterThan(-1)
    expect(LOGIN.slice(LOGIN.lastIndexOf('<', at), at)).toMatch(/^<p\b/)
    expect(LOGIN).not.toContain('to="/create-account"')
  })
})

// ── 7 & 8. No fake functionality, no unsupported claims ──────────────────────

describe('no fake functionality or unsupported claims on the auth surface', () => {
  for (const [name, src] of Object.entries(AUTH_FILES)) {
    const body = code(src)

    it(`${name}: no demo, membership, pricing or subscription surface`, () => {
      expect(body).not.toMatch(/demo|membership|pricing|subscri|per year|\/year|\bAUD\b|\$\s?\d|free trial|buy\b/i)
      expect(body).not.toMatch(/remember me|type="checkbox"/i)
    })

    it(`${name}: does not advertise planned modules`, () => {
      expect(body).not.toMatch(/PULSE|SHIELD|\bIQ\b|Quant\b|Quant™|™/)
      expect(body).not.toMatch(/\bAI\b|artificial intelligence/i)
    })

    it(`${name}: no unsupported marketing claims`, () => {
      expect(body).not.toMatch(/world[- ]first|patent|only platform|the only|100%|reimagined|no other app|& owned/i)
    })

    it(`${name}: token-only styling (no hex colours, no inline style objects)`, () => {
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(body).not.toMatch(/style=\{\{/)
    })
  }

  it('the five feature highlights are exactly the approved, implemented areas', () => {
    const titles = [...LAYOUT.matchAll(/title: '([^']+)'/g)].map(m => m[1])
    expect(titles).toEqual([
      'Budgets & Cost Codes',
      'Purchasing & Claims',
      'Supplier Cost Control',
      'Forecasting & Cash Flow',
      'Project Documentation',
    ])
  })

  it('no one-click BOQ → Budget promise (the transfer is deferred)', () => {
    expect(code(LAYOUT)).not.toMatch(/one click|BOQ → Budget|BOQ to Budget/i)
  })
})
