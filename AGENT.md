# Constrapp — Agent & Contributor Guide

This file governs how AI agents and contributors should approach work in this codebase.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite |
| Styling | Tailwind CSS (utility-first, dark theme) |
| State | React Context + hooks (no Redux) |
| Charts | Recharts |
| Backend | Firebase (Auth, Firestore, Storage, Hosting) |
| Font | Sora (Google Fonts), fallback DM Sans |

## Project Structure

```
src/
  components/     Reusable UI primitives
  layouts/        AppShell (Sidebar + TopBar), AuthLayout
  pages/          One file per sidebar route (Dashboard, Projects, etc.)
  hooks/          useAuth, useProjects, useCompany
  lib/            firebase.js, formatters.js (currency, percentages)
  styles/         tailwind.config.js tokens
```

## Design Tokens

Map all colours through Tailwind config — do not hardcode hex values in components.

| Token name | Value | Use |
|---|---|---|
| `brand-bg` | `#0B1629` | Page background |
| `brand-sidebar` | `#0D1B2A` | Sidebar, topbar |
| `brand-surface` | `#112336` | Cards, panels |
| `brand-card` | `#162C42` | Hover/elevated card |
| `brand-border` | `#1E3248` | All borders |
| `brand-accent` | `#00C9A7` | Primary teal — CTAs, active nav |
| `brand-amber` | `#F59E0B` | Warnings, pending |
| `brand-red` | `#EF4444` | Errors, danger |
| `brand-blue` | `#3B82F6` | Info, planning |
| `brand-purple` | `#8B5CF6` | Delivered, invoiced |
| `brand-text` | `#E8F0F7` | Body copy |
| `brand-muted` | `#546E84` | Labels, metadata |

## Component Conventions

- Primitives live in `src/components/` — `Card`, `Btn`, `Badge`, `Field`, `Stat`, `ProgBar`, `PageHeader`
- Pages are thin — they compose primitives, not define styles inline
- No inline style objects. Use Tailwind classes only
- Responsive: mobile-first (`sm:` breakpoints for sidebar collapse, grid columns)

## Firebase Conventions

- All Firestore reads go through custom hooks (`useProjects`, `useCompany`, etc.)
- Collection structure: `companies/{companyId}/projects/{projectId}`
- Multi-tenancy is enforced by `companyId` on every document and in Firestore security rules
- Auth token custom claims carry `role` and `companyId` — use these in security rules and UI guards
- Never call `firebase/*` directly from a page component — always via a hook or lib function

## Firestore Data Model (Sprint 1)

```
companies/
  {companyId}/
    name, createdAt, plan

users/
  {uid}/
    name, email, role, companyId, avatarInitials

projects/
  {companyId}/projects/{projectId}/
    name, status, budget, spent, revenue,
    startDate, location, manager, progress
```

## Naming

- Files: `PascalCase` for components, `camelCase` for hooks and lib files
- Firestore collections: `camelCase` plural (`projects`, `costCodes`, `purchaseOrders`)
- Tailwind class order: layout → spacing → colour → typography → interactive

## What Not To Do

- Do not write inline style objects — use Tailwind classes
- Do not add Stripe, AI, or billing code until Sprint 6
- Do not install native mobile packages in the web repo
- Do not use any Firestore document without a `companyId` scope — security rules will reject it
- Do not put business logic in page components — extract to hooks
- Do not create new colour values — use the token map above

## Inspection Workflow

Before starting any task, an agent must:

1. Read `AGENT.md` (this file) in full
2. Read `PRODUCT.md` to understand scope and role model
3. Read `ROADMAP.md` to confirm which sprint is active and what is in/out of scope
4. Inspect the existing repository structure and relevant files before making changes. Do not assume a specific folder layout. Determine the relevant files for the task before editing.
5. Read the relevant page component and its hooks before editing either
6. Check Firestore security rules before adding any new collection or field
7. Confirm the task falls within the active sprint — if not, flag it rather than build it

## Web-First / Mobile-Ready Philosophy

- Build every layout mobile-first using Tailwind breakpoints (`sm:`, `md:`, `lg:`)
- The sidebar must collapse to a bottom nav or drawer on small screens
- Touch targets must be at least 44px tall on interactive elements
- No hover-only interactions — every action must also work on tap
- Do not add React Native, Capacitor, or Expo dependencies to this repo
- PWA manifest and service worker will be added in a later sprint — do not anticipate them now
- Test responsive behaviour at 375px, 768px, and 1280px widths before marking a task done

## AI Feature Placeholder Rule

PULSE™, IQ™, Quant™, and SHIELD™ are reserved proprietary features.

- Do not implement any AI, ML, scoring, or hashing logic for these features
- If a screen references one of these features, render a placeholder card:
  - Show the feature name, a one-line description, and a "Coming Soon" badge
  - Do not wire up any data, calculations, or API calls behind it
- Never import an AI/ML library (TensorFlow, OpenAI SDK, LangChain, etc.) into this repo without explicit instruction

## Git Workflow

- Branch from `main` for every piece of work: `feature/`, `fix/`, `chore/` prefixes
- Branch names are lowercase kebab-case: `feature/projects-list`, `fix/auth-redirect`
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- One logical change per commit — do not bundle unrelated edits
- Open a PR against `main`; do not push directly to `main`
- PRs require at least one passing CI check before merge (once CI is configured)
- Do not commit `.env.local`, Firebase service account keys, or any secret file
- Keep `firebase.json` and `.firebaserc` committed — they are not secrets
