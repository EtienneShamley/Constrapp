# Deployment

What exists today: a Vite static build and manually published Firestore rules.
**Not implemented:** `firebase.json`, `.firebaserc`, Firebase Hosting
configuration, Cloud Functions, and CI deployment — all future work. Do not
run `firebase deploy`; there is nothing configured for it to do.

## Prerequisites

- Node.js 20+
- A Firebase project with **Authentication** (Email/Password) and **Firestore**
  enabled. (Storage is initialised in code but unused; Hosting is not set up.)
- Users provisioned manually: an Auth user plus a matching `users/{uid}`
  document — see [SECURITY.md](SECURITY.md).

## Environment Variables

Copy `frontend/.env.example` to `frontend/.env.local` and fill in the Firebase
web app config (Console → Project settings → Your apps → SDK setup):

| Variable | Source |
|---|---|
| `VITE_FIREBASE_API_KEY` | `apiKey` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `VITE_FIREBASE_APP_ID` | `appId` |

These are read by `frontend/src/lib/firebase.js`. `.env.local` is git-ignored —
never commit it. (A root-level `.env.example` also exists with a few extra placeholders the
app never reads; the frontend one is canonical.)

## Build

All commands run from `frontend/` — the repository root has no `package.json`.

```bash
cd frontend
npm install
npm run build     # outputs static site to frontend/dist/
npm run preview   # serve the build locally
```

`frontend/dist/` can be served by any static host. No hosting target is
configured yet.

## Publishing Firestore Rules — Manual Process

The rules source of truth is `frontend/firestore.rules`, but **there is no CLI
wiring to deploy it**. Publishing is manual:

1. Edit `frontend/firestore.rules` in the repo (review against
   [SECURITY.md](SECURITY.md)).
2. Open Firebase console → Firestore Database → **Rules**.
3. Paste the full file contents over the editor content.
4. **Publish.**

Keep the console and the repo file identical — the repo copy is the reviewed
artifact; the console copy is what actually enforces.

## Future Work (not current functionality)

- `firebase.json` + `.firebaserc` so rules deploy via
  `firebase deploy --only firestore:rules`
- Firebase Hosting configuration for the built frontend
- Cloud Functions (server-side enforcement — see
  [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) ADR-14)
- CI: lint + build + rules deploy on merge
