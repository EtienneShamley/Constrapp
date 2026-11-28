import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Unit-suite isolation: no Firebase configuration, ever ────────────────────
//
// Azure #20261128.1 failed on tests/unit/finalAccountPage.test.js with
// `auth/invalid-api-key`: a new hook (useApprovalPolicy) was not mocked, so the
// page imported src/lib/firebase.js and initialised real Firebase Auth. Locally
// it passed only because the developer's `.env.local` supplied a real API key.
//
// The unit suite must behave the same on every machine: no `.env*` file is
// loaded (vitest.config.js → envDir: false) and no Firebase web config may
// reach `import.meta.env` from the shell either. If this test fails locally,
// unset the VITE_FIREBASE_* variables in your shell — do not relax it.

describe('unit suite runs without Firebase configuration', () => {
  it('no VITE_FIREBASE_* value reaches import.meta.env', () => {
    const leaked = Object.keys(import.meta.env).filter((k) => k.startsWith('VITE_FIREBASE_'))
    expect(leaked).toEqual([])
  })

  it('vitest.config.js disables .env file loading', () => {
    const config = readFileSync(fileURLToPath(new URL('../../vitest.config.js', import.meta.url)), 'utf8')
    expect(config).toMatch(/^\s*envDir:\s*false,/m)
  })
})
