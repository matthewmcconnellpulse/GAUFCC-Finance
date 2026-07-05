# GAUFCC Finance — design system

Distilled from the Claude Design mockup (`docs/design/`). The client is a
200-year-old charitable assembly: professional, calm, trustworthy — Pulse's
modern edge, softened for trustees.

## Colour (Tailwind tokens in `tailwind.config.ts`)

| Token | Hex | Use |
|---|---|---|
| `indigo` | `#211951` | anchor · sidebar · ink accents |
| `indigo-deep` | `#15103a` | dark spreads (board pack covers) |
| `ink` | `#0d0a26` | primary text |
| `mint` | `#08f2c7` | **money moments only** — approve, submit, live sync |
| `mint-700` | `#04b894` | primary chart series |
| `mint-900` | `#036c57` | General fund chip text |
| `cyan` | `#1de4ff` | data · links |
| `cyan-600` | `#16b6ce` | secondary chart series |
| `cyan-800` | `#0e7c8c` | Designated fund chip text |
| `pink` / `pink-600` | `#ff80e3` / `#f25cce` | the one hot data point — never decoration |
| `paper` / `paper-2` / `paper-3` | `#fbfaf7` / `#f6f4ee` / `#f3f1ea` | backgrounds |
| `stone-150…900` | warm greys | borders `#ebe9e3`, hairlines `#d6d3c9`, muted text `#807c70` / `#4a4740` |
| `warn` / `warn-ink` | `#f5a524` / `#8a5200` | warnings — amber and quiet |
| `danger` / `danger-ink` | `#e5484d` / `#c03538` | breached policy only |

**Fund-type coding — used on every surface** (component `FundTypeChip`):
Restricted = indigo chip · Designated = cyan chip · General = mint chip ·
Dormant = stone chip. Warning flags are amber, never red unless breached.

## Type

- **Fraunces** (`font-display`) — display and report titles, weights 300–500.
- **Geist** (`font-sans`) — body, UI labels, microcopy. Plain-spoken, sentence
  case, no exclamation marks.
- **JetBrains Mono** (`font-mono`, class `figure`) — every figure, table
  number, reference. Figures never render in Fraunces except report hero
  numerals.

## Rules of the product

1. Mint is spent only on money moments — approve, submit, live sync.
2. Warnings are amber and quiet; red is reserved for a breached policy.
3. Every screen carries "Refresh now" + last-synced in the top bar (AppShell
   provides this — modules never add their own).
4. AI output is always labelled (`AiBadge`) and always editable before it
   ships.
5. Radii 8–12px (`rounded-card`, `rounded-control`) · 1px hairline borders ·
   soft indigo-tinted shadows (`shadow-card`).
6. UK conventions: £1,250.00 · 12 May 2026 · FY 2025/26 · sentence case
   (helpers in `src/lib/format.ts`).

## Charts

Hand-rolled SVG (no chart library). mint-700 primary series · cyan-600
secondary (dashed) · pink highlights the one point that matters · indigo
gridlines at 12% opacity. `Sparkline` lives in `src/components/ui.tsx`.

## Patterns per surface

- **Registers** (fund lists, queues, ledgers): `.th-register` headers,
  `.td-register` cells, figures right-aligned in mono. Dense, keyboard-friendly
  for Pulse ops screens.
- **Board packs**: high-end annual report, not SaaS dashboard. White paper,
  Fraunces headings, hairline rules, restrained charts, print-ready
  (`@media print` styles, `.no-print` on chrome).
- **CEO approvals**: effortless on a phone — large receipt previews, one-tap
  approve (mint), reject is quiet outline.
- **Forms** (onboarding, expenses): generous type sizes, clear progress,
  friendly for non-technical volunteers.
- **Empty states / skeletons / error boundaries** on every module page
  (shared components in `src/components/ui.tsx`).

## Reference mockups (`docs/design/`)

- `1a/1b/1c` — three board-pack concepts (Ledger / Waveform / Minute Book)
- `1d/1e` — fund dashboard: table-led register + card-led grouping
- `1f` — CEO approval queue (desk + phone)
- `1g` — expense claim with AI receipt reading and low-confidence checks
- `1h` — volunteer onboarding via tokenised link
- `1i` — data integrity: the four checks that gate every board pack
- `1j` — imports: HSBC drop-in with sense checks, Epworth mapping
- `1k` — tokens & components sheet
