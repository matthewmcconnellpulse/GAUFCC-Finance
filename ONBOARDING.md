# GAUFCC Finance — team onboarding for Claude Code

Charity finance portal for the General Assembly of Unitarian and Free
Christian Churches, built by Pulse Accountants. React/Vite/TS/Tailwind
frontend on Vercel; Supabase backend (Postgres + RLS, edge functions,
storage, pg_cron); Xero custom connection for the books.

Open this repo in a Claude Code session (claude.ai/code) and you can make
changes end-to-end: the workflow below is how every change ships.

## The one workflow that matters

1. **Develop on branch `claude/platform-vercel-xero-setup-bwhdqi`** — never
   another branch. **Vercel auto-deploys the frontend from every push** to
   it. There is no separate frontend deploy step.
2. Before pushing: `npx tsc --noEmit` and `npm run build` must both pass.
3. Backend changes are deployed with the Supabase MCP connector against
   project **`uldtyqzchwkbitgnworq`** (see access section below).

## Access a teammate needs

- **GitHub**: collaborator on `matthewmcconnellpulse/GAUFCC-Finance`.
- **Supabase**: membership of the org that owns project
  `uldtyqzchwkbitgnworq` (gaufcc-finance), and the Supabase connector
  authorised on their own claude.ai account.
- **Vercel**: nothing needed for normal work (deploys ride on git pushes).
- Secrets never live in this repo — Xero and Anthropic keys are Supabase
  edge-function secrets. See `docs/SECRETS.md` before touching any of that.

## Hard-won rules — do not relearn these the painful way

### Edge functions
- Deploy via the Supabase MCP `deploy_edge_function` tool, and **always pass
  `verify_jwt` explicitly**: `sync-xero` is **false** (pg_cron authenticates
  with the `x-cron-secret` header, checked against the vault secret); every
  other function is **true**. Omitting it silently flips sync-xero to true
  and breaks the nightly sync with 401s.
- Source of truth lives in `supabase/functions/`; shared helpers in
  `supabase/functions/_shared/`. In deploy payloads each function bundles
  its own copy of the `_shared` files and imports are rewritten
  `../_shared/` → `./_shared/`.
- After deploying, fetch the function back (`get_edge_function`) and diff
  against the local file if anything behaves oddly.

### Database
- Every schema change is BOTH applied to the live DB (MCP `apply_migration`)
  AND saved as a numbered file in `supabase/migrations/` (currently 0001–0034).
- RLS is the security boundary. Helpers live in `app_private`
  (`get_role`, `is_pulse`, `is_pulse_admin`, `manages_fund`); views are
  `security_invoker`. Verify role behaviour by impersonation:
  `set local role authenticated; select set_config('request.jwt.claims',
  json_build_object('sub','<uuid>','role','authenticated')::text, true);`

### The mirror's sign convention (breaks reports if violated)
- `xero_transactions.net` is stored **document-natural**: invoices, bills
  and bank lines positive; credit notes negative. Income vs expenditure is
  decided downstream by `xero_accounts.class` (REVENUE → income, EXPENSE →
  expenditure). Fund balance = opening + Σ(REVENUE net) − Σ(EXPENSE net).
- Manual journals (`source_type MANJOURNAL` — payroll lives here) are
  debit-positive/credit-negative at source, so REVENUE-class lines are
  sign-flipped on sync; journal lines have positional ids, so edited or
  voided journals REPLACE their rows (delete-then-insert), never upsert.

### Xero quirks
- Custom connection: client_credentials grant, 30-minute tokens, no tenant
  header. On 401/403 mint a fresh token and retry once (handled in
  `_shared/xero.ts`).
- GET responses routinely **omit `TrackingOptionID`** on line items — the
  sync resolves tracking by name via the TrackingIndex. Never assume the ID
  is present.
- Rate limits 60/min: sync stages run strictly sequentially.

### Domain conventions
- **Financial year is 1 October – 30 September** (FY 25/26 ends 30.09.2026).
  `FY_START_MONTH = 9` (0-indexed) in the frontend libs; SQL uses the
  "latest 1 October" expression. Anything date-window-shaped must respect it.
- Funds ARE Xero tracking options (category 1, named "Fund"); the fund label
  equals the tracking option name. SORP categories map per account via
  `xero_accounts.sorp_category`.
- Roles: `pulse_admin`, `pulse_bookkeeper`, `pulse_payroll`, `ceo`,
  `trustee`, `submitter`. Submitters/trustees must never see fund financials
  beyond their scope — check RLS when adding tables.

## Module map (each module owns its directory; don't cross-import lib.ts)

- `src/modules/funds` — register, fund detail (statement-style transactions
  with running balance), integrity checks, warnings.
- `src/modules/imports` — HSBC statements + **Epworth monthly workbook**
  (xlsx parsed deterministically in the `parse-import` edge function via
  SheetJS; unrealised gains are computed as the delta of Epworth's
  CUMULATIVE gain vs the prior import, less the month's income net of fees).
  Journal export mappings persist in `epworth_journal_settings` (P&L codes
  per income type + a balance-sheet asset code per Epworth account ref).
- `src/modules/investments` — charts built from `epworth_imports` history.
- `src/modules/cashflow` — weekly→monthly forecast grid
  (`cashflow_config/lines/cells`), Xero actuals fills.
- `src/modules/financials` — P&L/Balance Sheet proxied live from Xero's
  Reports API (`xero-report` function), Transactions browser.
- `src/modules/expenses` — claims, approvals (CEO + pulse_admin), push to
  Xero as draft bills with receipt attachments (`xero-push-bill`).
- `src/modules/people` — employees/volunteers, portal login links
  (`person-login-link`: invite for new logins, recovery link for existing).
- `src/components/charts.tsx` — shared SVG chart primitives (validated
  categorical palette; series colours are keyed to entities, never re-flowed).

## Conventions

- Match the existing code style: module-owned `lib.ts` data layers,
  `useSupabaseQuery`, design tokens from `tailwind.config.ts` (indigo/mint/
  paper), mono figures, hand-rolled SVG charts.
- UK English in all user-facing copy; money via `formatMoney`/`formatMovement`.
- Nothing is ever pushed to Xero automatically except approved expense
  bills; imports generate CSVs for the bookkeeper.
