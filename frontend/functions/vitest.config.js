import { defineConfig } from 'vitest/config'

// Pure-logic tests of the Functions package only (tokens, validation, state,
// email rendering/adapter). No emulator and no network. The emulator-backed
// suite lives in frontend/tests/functions/ (`npm run test:functions`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
