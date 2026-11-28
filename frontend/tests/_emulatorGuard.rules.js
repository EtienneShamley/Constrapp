import { assertEmulatorEnvironment, runtimeSummary } from './_emulatorGuard.js'

// vitest globalSetup for the Security Rules suite (vitest.rules.config.js).
export default function setup() {
  assertEmulatorEnvironment('rules')
  console.log(`[emulator guard] rules suite: ${runtimeSummary()}`)
}
