import { assertEmulatorEnvironment, runtimeSummary } from './_emulatorGuard.js'

// vitest globalSetup for the trusted-backend suite (vitest.functions.config.js).
export default function setup() {
  assertEmulatorEnvironment('functions')
  console.log(`[emulator guard] functions suite: ${runtimeSummary()}`)
}
