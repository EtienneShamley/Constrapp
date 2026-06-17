# Constrapp

Australian-built construction project management platform.

Web-first · Firebase backend · React + Vite + Tailwind

---

## Local Setup

### Prerequisites

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`

### Install

```bash
npm install
```

### Environment

Copy `.env.example` to `.env.local` and fill in your Firebase project values:

```bash
cp .env.example .env.local
```

### Run

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Deploy (Firebase Hosting)

```bash
firebase deploy --only hosting
```

---

## Firebase Setup

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication** (Email/Password provider)
3. Enable **Firestore** (start in production mode)
4. Enable **Storage**
5. Enable **Hosting**
6. Copy config values into `.env.local`

---

## Project Structure

```
src/
  components/   UI primitives (Card, Btn, Badge, etc.)
  layouts/      AppShell, AuthLayout
  pages/        One component per route
  hooks/        Firebase data hooks
  lib/          firebase.js, formatters.js
docs/           Design reference files (prototype, screenshots)
```

Cloud Functions and additional backend services will be added in a later sprint under a `functions/` directory when needed.

---

## Roles

`super_admin` · `company_admin` · `project_manager` · `qs` · `subcontractor` · `client`

Role is stored as a Firestore user document field and as a Firebase Auth custom claim.

---

## Docs

- `PRODUCT.md` — Vision, modules, pricing
- `ROADMAP.md` — Sprint plan
- `AGENT.md` — Coding conventions for contributors and AI agents
