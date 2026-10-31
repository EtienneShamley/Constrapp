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
  `#root`, and a `pulse-dot` keyframe referenced only by the sidebar's unused
  PULSE™/SHIELD™ branches (neither module is in `lib/nav.js`)
- `@theme` also defines the continuous `--animate-module-beat` animation and its
  one `module-beat` keyframe (ADR-48) — see **Module Branding** below

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
| `brand-pulse` | `#FF6B9D` | Constrapp PULSE™ mark and indicator dot only — never a status (ADR-48) |
| `brand-shield` | `#00D4FF` | Constrapp SHIELD™ mark only — never a status (ADR-48) |
| `brand-quant` | `#A3E635` | Constrapp Quant™ mark, header dot, active tool and saved-measurement geometry on the sheet — never a status (ADR-51); errors stay `brand-red`, review flags `brand-amber`, selection `brand-accent` |
| `brand-gantt` | `#FB923C` | Constrapp GANTT™ mark, tile and header dot ONLY — never a bar, status or overdue colour (ADR-64): on the chart in progress stays `brand-blue`, on hold `brand-amber`, completed `brand-accent`, not started / cancelled `brand-muted`, overdue `brand-red`, milestones `brand-purple`, the today line `brand-accent`, recorded (actual) dates `brand-text-soft` |
| `--font-sans` | Sora, DM Sans, system-ui | Default font stack |

Do not add new colour values; map new needs onto these tokens. The module
brand tokens are the only exception: `brand-pulse` and `brand-shield` were
approved narrowly by ADR-48 to replace existing hard-coded module colours,
`brand-quant` by ADR-51 when the Quant™ page shipped (the convention ADR-48
recorded for a module's own token), and `brand-gantt` by ADR-64 when the
programme tab became Constrapp GANTT™.

## Module Branding (ADR-48)

- **Names** come from `lib/moduleBranding.js` → `MODULE_NAMES`: *Constrapp
  PULSE™*, *Constrapp SHIELD™*, *Constrapp Quant™*, *Constrapp GANTT™*
  (ADR-64), *Constrapp IQ™*. Headers use the full name; navigation uses a
  compact label ("PULSE", "GANTT", no ™).
- **Marks** — `components/ModuleMark.jsx`: `ModuleMark` is a 24-unit, 2px,
  round-capped `currentColor` line SVG (PULSE: heartbeat line; SHIELD: shield
  outline; Quant: a diagonal scale rule with three graduations, ADR-51; GANTT:
  three staggered programme bars on a timeline, ADR-64), coloured by
  `text-brand-pulse` / `text-brand-shield` / `text-brand-quant` /
  `text-brand-gantt`. Always **decorative** — `aria-hidden="true"`,
  `focusable="false"`, no `<title>` — and always beside the module name in
  text. No emoji. IQ™ has no mark until its milestone.
- **Tile** — `ModuleTile`: the v5 feature tile (36px, `rounded-[10px]`, token
  fill at /10 and border at /20, 18px mark). Pass it to `PageHeader`'s optional
  `mark` prop on a module page.
- **Motion — the shared advanced-module convention.** Every *live* advanced
  module's **page heading** carries the same luminous dot at its tile's corner
  (`<ModuleTile module="…" beat paused={…} />`): PULSE™ in `brand-pulse`,
  SHIELD™ in `brand-shield`, Quant™ in `brand-quant` (ADR-51), GANTT™ in
  `brand-gantt` (ADR-64), and IQ™ in its own token when it ships. The dot uses `motion-safe:animate-module-beat`, a gentle continuous
  lub-dub (1.8s, `infinite`) that varies only scale (≤1.25) and glow
  (6–11px), never opacity, and always carries a static 6px glow so it stays lit
  between pulses and when paused. There is **one** `module-beat` keyframe: its
  colour is the `--module-glow` custom property, which each tile sets from its
  own token through a Tailwind arbitrary-property class
  (`[--module-glow:var(--color-brand-shield)]`), with `brand-pulse` as the
  fallback — never a second keyframe per module. A continuous beat **must** sit
  beside a `BeatToggle` (WCAG 2.2.2): a muted 11px Pause / Resume button with a
  44px target, an accessible name that states its subject (`heartbeat
  animation` for PULSE, `glow animation` for SHIELD, Quant and GANTT), hidden
  under reduced motion where the dot is still but lit. The beat is **decorative** and never
  a claim of background monitoring. Never animate the mark itself, never
  animate the tab bar or a pointer page, and never give an unbuilt module
  (IQ™) a dot before its page exists. Always gate motion with
  `motion-safe:`.
- **Tabs** — a project tab may carry `mark` in `lib/projectTabs.js` (PULSE,
  SHIELD since ADR-50, Quant since ADR-51 and GANTT since ADR-64 — the only
  four; GANTT is the existing `timeline` route relabelled, not a new tab); the
  layout renders a 14px static mark before the label and keeps the shared
  active styling.
- **Constrapp GANTT™ chart (ADR-64).** The programme chart
  (`pages/project/timeline/TimelineGantt.jsx` over the pure
  `lib/timelineGantt.js` + `lib/ganttGrouping.js`) is ONE `overflow-auto`
  scroller (`max-h-[70vh]`) with the 240 px label column `sticky left-0` and
  the two-line header `sticky top-0`; weekly gridlines (`brand-border/40`) and
  the today line (`border-l-2 border-brand-accent`) sit behind the rows. A
  toolbar row holds the **Day / Week / Month** zoom (real buttons with
  `aria-pressed`, the shared tool-button class, active tint `brand-accent/15`),
  a labelled **Group by** select, **Collapse all / Expand all** when grouped,
  and **Today** (disabled when today is off-window). Every planned bar and
  milestone is a real `<button>` (≥ 6 px wide at month zoom, 14 px tall bar,
  24 px milestone target) with `focus-visible:outline-brand-accent` and an
  accessible name carrying activity · status · % · planned dates · recorded
  dates · plan comparison · overdue · what opens; group headers are buttons
  with `aria-expanded` and their counts (`· n overdue` in `text-brand-red`).
  Colours are the ADR-29 status tokens unchanged (see the `brand-gantt` row);
  the **recorded-dates overlay** is a 4 px `brand-text-soft` line beneath the
  planned bar (a 2 px tick for a start-only or finish-only record, and for a
  reached milestone) and is `aria-hidden` — its facts live in the button name.
  The textual legend names every colour plus *Actual (recorded dates)* and
  states that comparisons are against the current plan, not a baseline.
  Above `md:` a pressed-state **Chart / List** toggle (`role="group"`) switches
  between the chart and the existing activity table over the same filtered
  set; below `md:` the grouped cards remain the programme and the chart is not
  rendered. Nothing is draggable.
  **Dependencies (ADR-65).** Finish-to-start links are ONE `<svg>` overlay in
  the gridline layer behind the rows (`pointer-events-none`, `aria-hidden`,
  `focusable="false"`), sized to the canvas: an elbow path from the end of the
  predecessor bar to the start of the successor bar with a chevron head,
  `stroke-width` 1.5, in `brand-muted` for a well-formed link, **red dashed
  (`5 3`)** for a schedule conflict and **amber dashed (`3 3`)** for a link
  requiring review (cycle, cancelled, missing, malformed); a successor that
  starts at or before the predecessor's end routes the path below the row so
  it never crosses its own bar. The legend names the three line styles in
  words. Colour never carries the meaning alone: the row label shows
  **Blocked / Conflict / Review** as text (red for Blocked and Conflict, amber
  for Review) plus `← n` for the predecessor count; a blocked bar or
  milestone gets the red ring, a bar needing review the amber ring; the bar's
  accessible name ends with the full dependency sentence
  (`dependencyLabel`); the List and the cards show the same flag and count;
  the read-only detail lists every predecessor with its state and the
  activity's successors. An arrow is drawn only when both rows are visible —
  the chart discloses *n dependencies are not drawn …* in `brand-amber` under
  the legend (`role="status"`) and never draws more than 1,500 (then none,
  with the same disclosure). Arrows never intercept a bar.
  **Baselines (ADR-66).** The SELECTED approved baseline is a GHOST behind
  each bar: a `rounded-md border border-dashed` outline in `brand-text-soft`
  (top 3 px, 18 px tall, so it shows exactly where the plan has moved and
  disappears under an unchanged bar), and a hollow 12 px `rotate-45 border`
  diamond in the same token for a baseline milestone — never a fill, never a
  status colour, never `brand-gantt`, no animation. The ghost is `aria-hidden`
  and decorative: the baseline dates, the planned variance (*Planned start +2
  days, finish +6 days against baseline*) and the recorded-finish variance
  (*Finished 3 days after the baseline finish*) are in the bar's accessible
  name, in the List's *vs baseline* column (`+6 d` in `brand-amber` when
  later, `brand-text-soft` when earlier, muted when unchanged, with the full
  sentence as its title), on the mobile cards and in the detail's *Against
  baseline* row. Two legend entries name the outline and the hollow diamond;
  the legend states either what the outline is or that no approved baseline
  is shown. The **baseline panel** above the filters holds the *Compare with*
  select (`aria-label="Baseline version to compare with"`), the *Show / Hide
  baseline* button (`aria-pressed`), *Capture baseline* for authors, the
  drafts awaiting review (amber-bordered rows with *Review draft*) and the
  summary of counts — `Later`, `Milestones later` and `Completed late` tinted
  `brand-amber` when non-zero, every figure also named in text. The capture
  and review dialogs render through `ActivityDialog`; the review dialog's
  drift acknowledgement is a labelled checkbox bound to the drift it lists.
- **Quant™ takeoff workspace (ADR-51).** The sheet is a `<canvas>` (PDF) or
  `<img>` filling the box of an `<svg>` whose `viewBox` is the page in canonical
  units and whose `width`/`height` attributes are the CSS size — so geometry
  lines up at every zoom with no inline style. Saved geometry is
  `stroke-brand-quant` with `vector-effect="non-scaling-stroke"`; the selected
  measurement is `brand-accent`; the in-progress draft is dashed `brand-amber`;
  the calibration segment is dashed `brand-blue`. Tool buttons are real
  `<button>`s ≥44px with `aria-pressed`; the active tool is tinted
  `brand-quant/15` and the label carries the meaning. Enter finishes, Backspace
  undoes, Escape cancels — on the focused viewer region only.
  **Interaction (ADR-53).** The `<svg>` is `touch-none` and owns one pointer
  model; the overlay beneath it is `pointer-events: none`. A tap (press and
  release within 6 px) acts for the tool — Select hit-tests the shapes,
  measuring tools add a point, edit mode inserts on an edge or selects a
  vertex; a drag pans for any touch and for a mouse with Select
  (`cursor-grab` / `cursor-grabbing`), and is ignored while measuring with a
  mouse; two fingers pinch; Ctrl/⌘ + wheel zooms; every zoom is anchored on the
  pointer (toolbar −/+ on the centre) through `lib/quant.js → zoomAboutPoint`.
  Edit handles stay 7 px; their **hit target is 22 px around the nearest
  vertex** (half a 44 px target, in screen pixels at every zoom), and the
  selected vertex shows a dashed ring of that radius plus a `brand-text` stroke.
  A quantity that cannot be derived shows its reason in `text-brand-red` under
  the "—" (list, editor, draft and edit strips) with `role="alert"`. The
  selection bar (`border-brand-accent/30 bg-brand-accent/5`) repeats the
  existing Details / Geometry / Void controls for the selected measurement —
  and, for an area, **Deduct** (ADR-54).
  Discard confirmations use `window.confirm` (the register convention).
  **Deductions (ADR-54).** An area with openings is ONE shape: the fill is a
  single path with `fill-rule: evenodd` (the holes are cut out of the
  `brand-quant/15` or, selected, `brand-accent/15` fill), the outer outline is
  solid and the hole outlines are **dashed** (`5 4`) in the same stroke token
  — meaning is carried by the list beside the sheet, never by colour alone. A
  hole being traced is the amber draft with a tighter dash (`3 3`); a hole
  being edited shows the parent outline and the other holes in a thin
  `brand-quant` stroke for context. Quantities are shown as the **net** with a
  muted breakdown line beneath — *gross 30.000 m² − 2 deductions 5.000 m²* —
  in the list, the selection bar, the page status, the details dialog, the
  project summary and the BOQ apply dialog; the deductions themselves are a
  sub-list under their parent row (`− label · area`, offending holes in
  `text-brand-red` with *see note*), never rows of their own, with
  *Edit outline · Rename · Remove* as 44 px text buttons (equal cells on
  cards). The **Finish deduction** strip previews *gross · this deduction ·
  net* and names a containment problem in `text-brand-red` with `role="alert"`.
  **Project summary (ADR-53, 1C-B).** A *Measure / Project summary* toggle
  (the shared `toolBtnCls` with `aria-pressed`, inside a `role="group"`) above
  the workspace; the summary is a stack of `Card`s: a header with four count
  `Badge`s (*Current & valid* `active`, *Needs attention* `pending` when
  non-zero, *Historical* and *Voided* `soon`) and two per-kind total panels
  (`bg-brand-bg/60`) that keep Length / Area / Count in separate cells and
  current apart from historical; tables above `md` and cards below, with the
  list's `thCls` / `tdCls`; issue badges reuse the status variants (`danger`
  for what blocks a quantity, `pending` for review and link problems, `soon`
  for informational); *Open* / *Open sheet* are 44 px text buttons; historical
  and voided are `<details>` with the same ▸ summary row as the page list's
  Voided group. Loading is `role="status"`, unavailable is a `role="alert"`
  red banner — never an empty "no issues".

## Shared Components (`frontend/src/components/`)

| Component | Contract |
|---|---|
| `Card` | Surface + border + rounded-xl; `padding={false}` for flush tables |
| `Btn` | Variants `primary` (teal gradient), `ghost`, `danger`, `success`, `gold`; `sm` prop; ≥44px tall by default (32px for `sm`) |
| `Badge` | Status chip — see below |
| `Stat` | KPI tile (label, value, sub, icon, optional colour) — place inside a `Card` |
| `ProgBar` | 1.5px-high track; `value` 0–100 clamped; `colour` = token name |
| `PageHeader` | Title + optional sub + optional leading `mark` (ADR-48) + right-aligned actions |
| `ProtectedRoute` | Auth gate with spinner |
| `ModuleMark` / `ModuleTile` | Decorative module line mark / v5 tile (+ optional PULSE dot) — see Module Branding |

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
`*`; inline error text in `text-brand-red`. Form dialogs `autoFocus` their first
field. A dialog with no field (the Quant 1B *Apply Quant measurements* dialog)
gives its panel `tabIndex={-1}` and focuses it on open, returns focus to the
opening control on close, closes on Escape (not while saving) and contains
Tab / Shift+Tab with `lib/dialogFocus.js` — a pure helper (`tabbableWithin`,
`tabTarget`) rather than a focus-trap dependency; reuse it for any new dialog
instead of adding one. The Quant™ calibration, measurement-details, void and
(since ADR-54) deduction dialogs render through
`pages/project/quant/QuantDialog.jsx` (ADR-53), which
packages exactly that contract for a form dialog: `role="dialog"`,
`aria-modal`, `aria-labelledby` the title, the form's own `autoFocus` field
first (else the panel), Escape and the backdrop ignored while `busy`, Tab
containment, focus returned to the opener on close, and the × button disabled
while busy. New Quant dialogs use it; other modules may adopt the same shape.
The programme adopted it in ADR-64: `pages/project/timeline/ActivityDialog.jsx`
packages the identical contract for the activity editor (`autoFocus` on the
name), the cancel dialog (`autoFocus` on the reason) and the read-only
`ActivityDetailModal` (panel focus, Close only); focus returns to the Gantt
bar, table button or card button that opened them. **ADR-65:** the editor's
*Predecessors (finish to start)* `<fieldset>` lists each link as a bordered
row (name · FS · a 76 px lag `<input type="number" min="0" max="365">` · a
44 px *Remove* button) with its earliest permitted start or its review reason
beneath in `brand-amber`; the *Add predecessor* `<select>` keeps unavailable
candidates visible but `disabled` with the reason appended to the option text;
a schedule conflict renders a `role="alert"` panel (`border-brand-amber/50
bg-brand-amber/5`) listing the offending links and a 44 px acknowledgement
checkbox that must be ticked before Save — it unticks itself whenever the
start date or the links change. A stale save keeps the whole draft, shows the
conflict sentence in `text-brand-red` under the form and offers a *Reload
latest* ghost button that re-seeds the form from the current record; an
offline or failed save reports the failure the same way and never claims
success.

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

**Auth pages** — `layouts/AuthLayout.jsx` owns the shell for `/login`,
`/forgot-password` and `/create-account` (a recreation of the v5 prototype's
login): from `lg:` a flexible product panel (`<aside aria-label="About
Constrapp">`, `brand-bg` under a `black/…` diagonal wash with two faint
`brand-accent`/`brand-blue` circles) beside a `brand-sidebar` sign-in panel, split ≈55/45
(`grid-cols-[minmax(0,55fr)_minmax(0,45fr)]`) with the form centred at
`max-w-[420px]`; below
`lg:` a compact logo + tagline above the form on a `brand-sidebar` card. Pages
render **content only** — no card of their own — and own the single `<h1>`. Form
controls come from `components/AuthField.jsx`: `AuthField` (label bound by
`htmlFor`, `aria-invalid`/`aria-describedby` on error, 16px text below `sm:` so
iOS does not zoom, `outline-hidden` + `focus:ring-2` so focus survives
forced-colors), `AuthError` (`role="alert"`, icon + text) and `authLinkCls`
(teal text link with a 44px target). Auth copy names only implemented modules —
never a planned one, a price, a demo, or an unsupported claim (pinned by
`tests/unit/authSurface.test.js`). Vertical rhythm uses an arbitrary
`[@media(min-height:900px)]:` variant so a 1280×800 laptop does not scroll.

## Recorded Violations — Technical Debt

The rules are "no inline style objects" and "no hard-coded colours", but the
codebase does not fully comply today. These are **known debt, not approved
patterns** — do not copy them, and prefer migrating them opportunistically when
touching these files:

- `components/Stat.jsx` — inline styles; hard-coded `#00C9A7`, `#E8F0F7`
- `components/Btn.jsx` — gradient hexes `#00C9A7→#00A888` (primary), `#F5A623→#D4880A` (gold) in arbitrary-value classes
- `components/ProgBar.jsx` — inline `style` for width (legitimately dynamic) and colour (via token CSS vars)
- ~~`pages/Dashboard.jsx` — chart tooltip styled inline with raw hexes; Recharts fills/ticks hard-coded~~ **resolved** — the Dashboard charts were fabricated data and were removed entirely (Beta Launch Readiness), taking the inline hexes with them
- `pages/Projects.jsx` — `DOT_COLORS` hex map
- `layouts/Sidebar.jsx` / `layouts/TopBar.jsx` — inline `height: 56`, inline NavLink active styles; `Sidebar.jsx` still hard-codes `#FF6B9D` / `#00D4FF` and an `infinite` `pulse-dot` animation in its **unused** PULSE™/SHIELD™ branches (never rendered — `lib/nav.js` lists neither). `pages/Pulse.jsx` / `pages/Shield.jsx` were migrated to the `brand-pulse` / `brand-shield` tokens by ADR-48 (`pages/Shield.jsx` became a pointer page under ADR-50; `pages/project/ProjectShield.jsx` and `pages/project/shield/ShieldCheckCard.jsx` use tokens only — cyan is the SHIELD mark, never a status colour)
- `layouts/ProjectDetailLayout.jsx` — project tabs are ≈34px tall (`px-3 py-2`), below the 44px touch-target rule; recorded, not redesigned by ADR-48
- Logo SVG (`Sidebar.jsx`) — stroke `#00C9A7` hard-coded. (`AuthLayout.jsx` was migrated to `stroke="currentColor"` + `text-brand-accent` by the Login Redesign — copy that.)
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

### Dashboard v2 patterns (ADR-45)

- **Plain-SVG bars and donuts** where the data is a handful of values: shapes
  use percentage `x`/`width` attributes and `fill-brand-*` / `stroke-brand-*`
  classes; all geometry comes from a pure `lib/` function
  (`performanceLayout`, `statusBarSegments`, `donutSegments`), never inline
  arithmetic in JSX. Recharts stays for time series (Cash Flow).
- **One scale per chart, exact figures listed beneath it** — the list is the
  accessible equivalent and the record whenever a bar cannot be drawn honestly
  (negative component, nothing recorded, failed source).
- **Reference bars are neutral, composition bars carry hue**: Current Contract
  Sum `brand-text-soft`, Approved Budget `brand-muted` (+ a `brand-text`
  reference line across the cost bar); Actual `brand-accent`, Remaining
  Committed `brand-blue`, Uncommitted CTC `brand-purple` (unchanged from v1).
- **KPI card** (`pages/dashboard/KpiCard.jsx`): the prototype `Stat` motif
  (quarter-circle `brand-accent/5` corner tint, 11px uppercase label, 26px/900
  value) rebuilt with classes only. It receives formatted text, never a number.
  Supporting lines state direction in **words** ("Over budget", "vs original
  plan") — the ▲/▼ glyph and colour only reinforce them. The shared `Stat`
  component keeps its recorded inline-style debt; migrate it separately.
- **Hero panel**: `bg-linear-to-br from-brand-surface to-brand-bg` with a faint
  `brand-accent/5` circle — tokens only, no new colour value.
- **Programme donut colours follow `ACTIVITY_STATUS_BADGE`** so the Dashboard
  and the Timeline tab agree; every status is named in the legend.

⚠️ Known deviation, recorded honestly: `brand-accent` (`#00C9A7`) sits above the
lightness band a validator recommends for series fills on the dark chart surface
(`brand-surface`), so it reads slightly hot. Colourblind separation and contrast
both pass comfortably. Changing the token is an app-wide design decision and was
deliberately **not** made as part of a chart branch.
