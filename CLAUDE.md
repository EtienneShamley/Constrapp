# CLAUDE.md — Task Routing

## Strategic Positioning

**Constrapp is the connected commercial operating system for construction projects.** Every session must preserve:

- **The connected commercial lifecycle** — Drawing → Quantity → BOQ → Estimate → Tender → Award → Approved Budget → Commitment → PO → Variation → Progress Claim → Supplier Invoice → Actual Cost → Forecast → Cash Flow → Final Project Margin → Final Account.
- **The cost-code spine** — Cost Codes join every commercial stage; new commercial modules integrate through them.
- **The field-feeds-commercial principle** — field features exist to serve a commercial outcome, never as standalone reporting.
- **An opinionated commercial workflow for small and mid-sized contractors** — not a configurable, form-first toolkit.
- **No form-first scope drift** — no generic form builders, HSEQ libraries, payroll, fleet, or broad integrations before product-market fit without an approved strategy change.

Full detail: [PRODUCT.md](PRODUCT.md) and [AGENT.md](AGENT.md) → Strategic Invariants.

## Reading Order

Before working in this repository, read in order:

1. [AGENT.md](AGENT.md) — mandatory conventions, guardrails, and architectural invariants
2. [docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) — binding engineering & security standards, checklists, control matrix
3. [PRODUCT.md](PRODUCT.md) — what the product is, roles, module status
4. [ROADMAP.md](ROADMAP.md) — what is current, done, and out of scope
5. The relevant detailed docs for the area you are touching (below)

## Rules of Engagement

- **Inspect before editing.** Read the actual files (pages, hooks, `frontend/firestore.rules`) before changing them; never assume structure or behaviour.
- **Preserve existing architecture.** Hooks-only Firestore access, client-SDK-only backend, read-time financial derivation. Do not introduce new patterns without approval.
- **Design tasks stop for approval.** After proposing UI/UX or architectural designs, wait for explicit approval before implementing.
- **Never commit automatically.** Only commit or push when explicitly asked.
- **No unrelated changes.** Keep diffs scoped to the task; flag anything else instead of fixing it silently.
- **Financial invariant:** Purchase Orders and Progress Claims never write financial values onto Budget Lines (see AGENT.md → Financial Invariants).
- **Run the checklists.** Before writing code, complete the pre-implementation checklist in [docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md); before finishing, complete its validation and security-review checklists.
- **Report security limitations honestly.** Firestore Security Rules are the only trust boundary; client-side role/lifecycle checks are UX only. Never claim a feature is secure or a control is enforced when it is client-side only — follow the reporting protocol in ENGINEERING_STANDARDS.md §7.

## Canonical Documentation

| Topic | Document |
|---|---|
| Conventions & guardrails | [AGENT.md](AGENT.md) |
| Engineering & security standards | [docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) |
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
