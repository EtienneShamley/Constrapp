import { defineConfig } from 'vitest/config'

// Dedicated config for the TRUSTED-BACKEND tests (ADR-72). They run in Node
// against the Auth, Firestore and Functions emulators — handlers called
// directly with the Admin SDK, plus a real callable through the Functions
// emulator — via `npm run test:functions`:
//
//   firebase emulators:exec --only auth,firestore,functions …
//
// Separate from vitest.config.js (pure unit) and vitest.rules.config.js
// (Security Rules) so the three suites can never bleed into each other.
export default defineConfig({
  test: {
    include: ['tests/functions/**/*.test.js'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
})
