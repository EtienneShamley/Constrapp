# Design System

Dark-theme, utility-first UI built on Tailwind CSS v4. The token source of truth
is the `@theme` block in `frontend/src/index.css` — there is **no**
`tailwind.config.js`.

## Tailwind v4 Configuration

`frontend/src/index.css`:

- `@import "tailwindcss"` (plugin: `@tailwindcss/vite` in `vite.config.js`)
- `@theme { … }` defines the tokens below, which Tailwind exposes as utilities
  (`--color-brand-bg` → `bg-brand-bg`, `text-brand-bg`, `border-brand-bg`, …)
- Google Fonts import (Sora 300–700, DM Sans 400/500); `--font-sans` makes Sora
  the default `font-sans`
- Base styles: border-box reset, body background/colour/font, full-height
  `#root`, and a `pulse-dot` keyframe used by the sidebar PULSE™/SHIELD™ dots

## Design Tokens (complete)

| Token | Value | Use |
|---|---|---|
| `brand-bg` | `#0B1629` | Page background, input backgrounds |
| `brand-sidebar` | `#0D1B2A` | Sidebar, topbar |
| `brand-surface` | `#112336` | Cards, panels, modals |
| `brand-card` | `#162C42` | Table header rows, hover rows, elevated surfaces |
| `brand-card-hov` | `#1A3350` | Hover state for elevated cards |
| `brand-border` | `#1E3248` | All borders, progress-bar track |
| `brand-accent` | `#00C9A7` | Primary teal — CTAs, active nav, success |
| `brand-amber` | `#F59E0B` | Warnings, pending, overclaim markers |
| `brand-red` | `#EF4444` | Errors, danger, rejected |
| `brand-blue` | `#3B82F6` | Info, planning, sent |
| `brand-purple` | `#8B5CF6` | Completed/closed/invoiced badges |
| `brand-text` | `#E8F0F7` | Body copy |
| `brand-text-soft` | `#94A9BE` | Secondary copy |
| `brand-muted` | `#546E84` | Labels, metadata, disabled |
| `--font-sans` | Sora, DM Sans, system-ui | Default font stack |

Do not add new colour values; map new needs onto these tokens.

## Shared Components (`frontend/src/components/`)

| Component | Contract |
|---|---|
| `Card` | Surface + border + rounded-xl; `padding={false}` for flush tables |
| `Btn` | Variants `primary` (teal gradient), `ghost`, `danger`, `success`, `gold`; `sm` prop; ≥44px tall by default (32px for `sm`) |
| `Badge` | Status chip — see below |
| `Stat` | KPI tile (label, value, sub, icon, optional colour) — place inside a `Card` |
| `ProgBar` | 1.5px-high track; `value` 0–100 clamped; `colour` = token name |
| `PageHeader` | Title + optional sub + right-aligned actions |
| `ProtectedRoute` | Auth gate with spinner |

### Status Badge usage

`<Badge label="…" variant="…" sm />`. Resolution: `variant` key first, else the
`label` itself (legacy prototype status strings like `"In Progress"`,
`"Planning"` are style keys), else falls back to `info`.

Semantic variants: `active` (teal), `pending` (amber), `completed` (purple),
`danger` (red), `info` (blue), `soon` (muted).

Domain mappings live beside the status machines — **reuse them, don't restyle**:

- `PO_BADGE_VARIANTS` (`lib/purchaseOrders.js`): draft→soon, pending_approval→pending, sent→info, closed→completed, cancelled→danger
- `CLAIM_BADGE_VARIANTS` (`lib/progressClaims.js`): draft→soon, submitted→info, under_review→pending, approved→active, rejected→danger, invoiced→completed

Documents & Drawings reuse the existing semantic variants without adding any new
Badge style: revisions map current→`active`, superseded→`soon`,
withdrawn→`danger`; documents map active→`active`, superseded→`soon`,
withdrawn→`danger`; a drawing with no revision yet reads "No revision"→`soon`.

### Status warnings — never colour alone

⚠️ **A badge is not sufficient where using the wrong file is dangerous.** Opening
a superseded or withdrawn drawing revision renders a **non-dismissible** banner
(`role="alert"`, 2px border, `brand-amber` for superseded / `brand-red` for
withdrawn) whose **text carries the whole meaning**:

```
SUPERSEDED — Revision B
Do not build from this drawing. Current revision is C.
```

Colour only reinforces what the words already say, so the warning survives
greyscale printing, a colour-blind reader and a low-contrast phone screen in
sunlight. The same rule governs document visibility: `internal` is labelled with
the **word "Internal"** plus a lock glyph, never by colour. Build the text first;
add the colour second. The warning strings themselves live in
`lib/drawings.js → revisionWarning()` so they are unit-tested rather than
scattered through JSX.

## UI Conventions

**Modals** — fixed inset-0 overlay (`bg-black/60`, click to close) + centred
panel: `bg-brand-surface`, `border-brand-border`, `rounded-xl`, `max-h-[90vh]
overflow-y-auto` for tall forms; header row with title + 44px `×` close button;
footer actions right-aligned above a top border (`ghost` Cancel + primary
submit); labels are 11px bold uppercase muted; required fields marked with a red
`*`; inline error text in `text-brand-red`.

**Tables** — inside `<Card padding={false}>`; header row `bg-brand-card` with
11px bold uppercase muted headers; body rows `border-b border-brand-border
hover:bg-brand-card`; wide tables wrapped in `overflow-x-auto`; row actions
right-aligned as `sm` buttons with `window.confirm` for state changes.

**Empty states** — centred in the card: muted explainer sentence + a primary
CTA; when blocked by a prerequisite, say so and link to it (e.g. "Create a cost
code before raising purchase orders" + "Go to Cost Codes").

**Responsive & mobile** — mobile-first; sidebar becomes an overlay drawer below
`md:` (hamburger in TopBar, tap overlay to dismiss); grids collapse via `sm:`/
`lg:` column steps; touch targets ≥44px; no hover-only interactions; verify at
375px / 768px / 1280px.

## Recorded Violations — Technical Debt

The rules are "no inline style objects" and "no hard-coded colours", but the
codebase does not fully comply today. These are **known debt, not approved
patterns** — do not copy them, and prefer migrating them opportunistically when
touching these files:

- `components/Stat.jsx` — inline styles; hard-coded `#00C9A7`, `#E8F0F7`
- `components/Btn.jsx` — gradient hexes `#00C9A7→#00A888` (primary), `#F5A623→#D4880A` (gold) in arbitrary-value classes
- `components/ProgBar.jsx` — inline `style` for width (legitimately dynamic) and colour (via token CSS vars)
- `pages/Dashboard.jsx` — chart tooltip styled inline with raw hexes; Recharts fills/ticks hard-coded (`#3B82F6`, `#00C9A7`, `#F59E0B`, `#EF4444`, `#546E84`)
- `pages/Projects.jsx` — `DOT_COLORS` hex map
- `layouts/Sidebar.jsx` / `layouts/TopBar.jsx` — inline `height: 56`, inline NavLink active styles; **off-token colours `#FF6B9D` (PULSE™) and `#00D4FF` (SHIELD™)** also used in `pages/Pulse.jsx` / `pages/Shield.jsx` — if these brand colours are permanent they should become tokens
- Logo SVGs (`Sidebar.jsx`, `AuthLayout.jsx`) — stroke `#00C9A7` hard-coded
- `frontend/src/index 2.css` — stray tracked duplicate of an old stylesheet, unused

Recharts requires JS colour values for fills, so chart code may read tokens via
CSS variables rather than Tailwind classes — but the values should still come
from the token set.

## Chart Convention

Established by the Cash Flow chart (`pages/project/cashFlow/CashFlowChart.jsx`,
ADR-26) and the pattern to follow for future charts. **No token value changes —
this records how existing tokens are used.**

- **Reference tokens as `var(--color-brand-*)`**, never a hard-coded hex. SVG
  `fill`/`stroke` resolve CSS custom properties directly, so this needs no
  `getComputedStyle` plumbing. Do not copy the `Dashboard.jsx` debt above.
- **Hue encodes the dimension; texture encodes state.** Cash In is
  `brand-accent`, Cash Out is `brand-purple`; actual is a solid fill and
  forecast a 45° hatch. **Never rely on colour alone** — texture keeps the
  distinction legible in greyscale, print and forced-colors, and every series
  also carries a text label in the legend.
- **`brand-red` and `brand-amber` stay reserved** for their status meanings
  (negative values, warnings/suppression) and are not used as series hues. Using
  red for an ordinary series would alarm on healthy data and collide with the
  genuine negative signal.
- **Text wears text tokens** (`brand-text` / `brand-text-soft` / `brand-muted`),
  never the series colour; a coloured swatch beside a label carries identity.
- **Never a dual Y axis.** Two measures of different magnitude become two panels
  sharing one X domain (ADR-26).
- **SVG pattern/gradient ids must be namespaced with React `useId()`**, not
  global constants, so a second mount cannot collide. Strip non-id-safe
  characters before use in `url(#…)`.
- Chart tooltips are ordinary Tailwind-classed elements (`bg-brand-surface`,
  `border-brand-border`) — not inline style objects.

⚠️ Known deviation, recorded honestly: `brand-accent` (`#00C9A7`) sits above the
lightness band a validator recommends for series fills on the dark chart surface
(`brand-surface`), so it reads slightly hot. Colourblind separation and contrast
both pass comfortably. Changing the token is an app-wide design decision and was
deliberately **not** made as part of a chart branch.
