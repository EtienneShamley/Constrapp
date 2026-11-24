// Test fixture (scripts.test.js): preloaded into an operator-script child via
// NODE_OPTIONS=--import. The Nth Firestore transaction of the process
// (REFUSE_TRANSACTION, default 1) runs its callback NORMALLY — so it takes its
// reads, and with them its locks — and then throws, exactly as a business
// refusal thrown inside a transaction does. Every attempt is reported on
// stderr, so a test can prove the refusal was not retried.
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../../functions/package.json', import.meta.url))
const { Firestore } = require('firebase-admin/firestore')

const target = Number(process.env.REFUSE_TRANSACTION ?? '1')
let n = 0
const original = Firestore.prototype.runTransaction
Firestore.prototype.runTransaction = function runTransaction(fn, opts) {
  n += 1
  if (n !== target) return original.call(this, fn, opts)
  const which = n
  let attempts = 0
  return original.call(this, async (tx) => {
    attempts += 1
    process.stderr.write(`[fixture] transaction ${which} attempt ${attempts}\n`)
    await fn(tx)
    throw new Error('simulated refusal inside the transaction (test fixture)')
  }, opts)
}
