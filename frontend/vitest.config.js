import { defineConfig } from 'vitest/config'

// Dedicated config for the UNIT tests of pure domain logic in src/lib. These
// run in plain Node with no React, no Firebase, no emulator, and none of the
// app's build plugins.
//
// The Firestore Security Rules suite is entirely separate — it lives in
// tests/rules/, uses vitest.rules.config.js, requires the Firestore emulator
// (plus a JDK), and runs via `npm run test:rules`. This config deliberately
// discovers only tests/unit/ so the two suites can never bleed into each other:
//
//   npm run test:unit    → tests/unit/**   (this file; no emulator)
//   npm run test:rules   → tests/rules/**  (vitest.rules.config.js; emulator)
//
// CREDENTIAL-FREE BY CONSTRUCTION (Azure #20261128.1). `envDir: false` stops
// Vite loading ANY `.env*` file for the unit suite, so a developer's git-ignored
// `.env.local` (real Firebase web config) can no longer make a suite pass
// locally that fails in CI. A unit test that reaches `src/lib/firebase.js`
// without mocking it now fails here exactly as it does on the Azure agent
// (`auth/invalid-api-key` at import). tests/unit/unitIsolation.test.js pins
// this and also refuses shell-exported VITE_FIREBASE_* values, which Vite
// passes through regardless of envDir.
export default defineConfig({
  envDir: false,
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
})
