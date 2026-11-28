import { defineConfig } from 'vitest/config'

// Dedicated config for the Firestore Security Rules tests. It deliberately does
// NOT extend vite.config.js: these tests run in Node against the Firestore
// emulator and need none of the app's React/Tailwind build plugins.
export default defineConfig({
  test: {
    include: ['tests/rules/**/*.test.js'],
    // Fails closed unless the emulator hosts and a non-production project id
    // are in the environment (tests/_emulatorGuard.js; tracker D3 #17).
    globalSetup: ['tests/_emulatorGuard.rules.js'],
    environment: 'node',
    // Emulator round-trips are slower than unit tests.
    testTimeout: 20000,
    hookTimeout: 30000,
    // One emulator, one rules environment — run files serially.
    fileParallelism: false,
  },
})
