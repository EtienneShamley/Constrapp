# CLAUDE.md — Task Routing

## Strategic Positioning

**Constrap is the connected commercial operating system for construction projects.** Every session must preserve:

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
- **Preserve existing architecture.** Hooks-only Firestore access, client-SDK access for all project and financial data (the ONLY trusted backend is the ADR-72 team-management Functions in `frontend/functions/` — no financial logic there, except these approved, narrowly scoped exceptions: the ADR-77 `approveFinalAccount` callable, which recomputes and finalises a Final Account revision, records one audit event, and performs no other financial write; and the ADR-81 `transferBoqToBudget` callable, which recomputes the BOQ-to-budget proposal from records it reads itself and creates or refreshes WORKING budget lines only, records one audit event, and never writes an approved budget version, a budget approval, a snapshot or an adjustment; and, from ADR-89, the client-finance callables `postClientCreditNote`, `voidClientCreditNote`, `postClientRetentionRelease`, `voidClientRetentionRelease`, `postClientReceipt` and `voidClientReceipt`, which re-derive an entry or a receipt's totals from the invoice and its ledger, write the entry or receipt, the per-invoice ledger(s) and one audit event, and nothing else; and, from ADR-90 (implemented, not deployed), the variation callables `createVariation`, `updateVariationDraft`, `approveVariation` and `applyVariationCommitment`, which take authored content and identifiers only, derive every stored figure under the document's calculation version (ADR-91), verify stored lines before anything becomes authoritative, and write the variation — plus, on create, its number counter and the project currency lock — and (except for a draft edit) one audit event, and nothing else; and, from ADR-93 / ADR-94 / ADR-95 / ADR-96 (Phase 2 steps 3–6, implemented, not deployed), `progressClaimOperation`, `supplierInvoiceOperation` and `supplierSettlementOperation` (claims, supplier invoices, supplier credit notes, retention releases and supplier payments — derived and verified figures, the per-PO claim ledger and the per-invoice supplier ledgers with their one-time historical baseline, one audit event per financial fact), the client-finance callables `postClientRefund`, `voidClientRefund`, `postClientReceiptApplication`, `voidClientReceiptApplication` and `voidClientInvoice`, and `contractValueOperation` (propose / approve / withdraw a correction of the original contract value); every approval among them applies the company approval-segregation policy (ADR-96), which is changed only by the operator tool), read-time financial derivation. **ADR-89 also sets the direction: a NEW mutation that reads an array or a register, holds a cumulative or cross-document invariant, or derives stored financial figures is built as a trusted callable, not as Rules-validated client logic — see docs/ARCHITECTURE.md → Trusted transaction boundary and the ten permanent engineering principles in docs/ENGINEERING_STANDARDS.md §9.** Do not introduce new patterns without approval.
- **Design tasks stop for approval.** After proposing UI/UX or architectural designs, wait for explicit approval before implementing.
- **Never commit automatically.** Only commit or push when explicitly asked.
- **No unrelated changes.** Keep diffs scoped to the task; flag anything else instead of fixing it silently.
- **Financial invariant:** Purchase Orders and Progress Claims never write financial values onto Budget Lines (see AGENT.md → Financial Invariants).
- **Run the checklists.** Before writing code, complete the pre-implementation checklist in [docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md); before finishing, complete its validation and security-review checklists.
- **Keep the ChatGPT handover current.** Update [docs/CHATGPT_HANDOVER.md](docs/CHATGPT_HANDOVER.md) at meaningful checkpoints — not after every minor change — following [AGENT.md](AGENT.md) → *Development Continuity*; say in every implementation report whether it needs updating.
- **Report security limitations honestly.** Firestore (and Storage) Security Rules are the only trust boundary for client-SDK data; the ADR-72 team-management Functions bypass rules and must authorise every call themselves; client-side role/lifecycle checks are UX only. Never claim a feature is secure or a control is enforced when it is client-side only — follow the reporting protocol in ENGINEERING_STANDARDS.md §7.

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
| ChatGPT handover & current checkpoint | [docs/CHATGPT_HANDOVER.md](docs/CHATGPT_HANDOVER.md) |
