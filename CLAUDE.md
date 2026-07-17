# CLAUDE.md — Task Routing

Before working in this repository, read in order:

1. [AGENT.md](AGENT.md) — mandatory conventions, guardrails, and architectural invariants
2. [PRODUCT.md](PRODUCT.md) — what the product is, roles, module status
3. [ROADMAP.md](ROADMAP.md) — what is current, done, and out of scope
4. The relevant detailed docs for the area you are touching (below)

## Rules of Engagement

- **Inspect before editing.** Read the actual files (pages, hooks, `frontend/firestore.rules`) before changing them; never assume structure or behaviour.
- **Preserve existing architecture.** Hooks-only Firestore access, client-SDK-only backend, read-time financial derivation. Do not introduce new patterns without approval.
- **Design tasks stop for approval.** After proposing UI/UX or architectural designs, wait for explicit approval before implementing.
- **Never commit automatically.** Only commit or push when explicitly asked.
- **No unrelated changes.** Keep diffs scoped to the task; flag anything else instead of fixing it silently.
- **Financial invariant:** Purchase Orders and Progress Claims never write financial values onto Budget Lines (see AGENT.md → Financial Invariants).

## Canonical Documentation

| Topic | Document |
|---|---|
| Conventions & guardrails | [AGENT.md](AGENT.md) |
| Product scope & roles | [PRODUCT.md](PRODUCT.md) |
| Sprint status | [ROADMAP.md](ROADMAP.md) |
| Setup & repo overview | [README.md](README.md) |
| Stack, layout, routing, providers | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Firestore collections & fields | [docs/DATA_MODEL.md](docs/DATA_MODEL.md) |
| Budgets, POs, claims, formulas | [docs/FINANCIAL_WORKFLOWS.md](docs/FINANCIAL_WORKFLOWS.md) |
| Auth, rules, deferred controls | [docs/SECURITY.md](docs/SECURITY.md) |
| Manual acceptance tests | [docs/TESTING.md](docs/TESTING.md) |
| Tokens, components, UI conventions | [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) |
| Architectural decision records | [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md) |
| Build, env vars, rules publishing | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
