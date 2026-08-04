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
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
})
