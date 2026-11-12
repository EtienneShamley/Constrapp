import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getStorage } from 'firebase-admin/storage'

// ── Firebase Admin SDK — ONE app per process ─────────────────────────────────
//
// `initializeApp()` with no arguments reads the project from the runtime
// (GCLOUD_PROJECT) and the credential from Application Default Credentials:
// the Cloud Functions service account in production, the operator's
// `gcloud auth application-default login` for the scripts, and nothing at all
// against the emulators (FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST,
// which `firebase emulators:exec` exports).
//
// ⚠️ The Admin SDK BYPASSES Firestore Security Rules. Nothing in this package
// may touch Firestore or Auth before `authz.js` has established who is calling
// and which company they administer.

export function adminApp() {
  return getApps()[0] ?? initializeApp()
}

export const getDb = () => getFirestore(adminApp())
export const getAdminAuth = () => getAuth(adminApp())

// Cloud Storage, for the file-link revocation worker ONLY (ADR-74). The Admin
// SDK bypasses Storage Rules too: lib/fileLinkTokens.js confines every call to
// one `companies/{companyId}/` prefix and changes one metadata key. With no
// name, the project's default bucket (FIREBASE_CONFIG) is used.
export const getBucket = (name = '') => (name ? getStorage(adminApp()).bucket(name) : getStorage(adminApp()).bucket())

export { FieldValue, Timestamp }
