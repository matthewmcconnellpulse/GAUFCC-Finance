---
name: platform-build
description: Build and ship a client platform (React/Vite/TS/Tailwind on Vercel + Supabase backend, optional Xero integration) from a written brief and a Claude Design mockup. Use when asked to "build out" a client platform/portal/dashboard from a brief, or to repeat the GAUFCC-style build for a new Pulse client. Covers scaffold, schema+RLS, edge functions, parallel module build, adversarial review, deployment, and the secrets checklist.
---

# Platform build playbook (Pulse client platforms)

Battle-tested on the GAUFCC Finance Platform build. Follow the phases in
order; the guardrails exist because each one caught a real defect.

## Phase 0 — Intake & environment

1. Read the brief fully. Extract: modules, roles, sync/integration policy,
   open decisions (flag these back to Matthew rather than guessing).
2. If a Claude Design mockup (`.dc` HTML export) is supplied: split it per
   screen id (`dv-opt` divs) into `docs/design/*.html`, grep the hex palette
   and the tokens sheet, and distil `docs/DESIGN.md`. Copy the brief to
   `docs/BUILD_BRIEF.md`.
3. Check MCP connectivity early: `Supabase list_organizations`,
   `Vercel list_teams`. Create the Supabase project FIRST (get_cost →
   confirm_cost → create_project, region `eu-west-2`) — it provisions while
   you scaffold. Flag the monthly cost to the user in the next message.
4. Know the sandbox limits: the remote container usually CANNOT reach
   `*.supabase.co` (egress policy) — all DB work goes through MCP tools, and
   browser E2E against live Supabase will not work locally. Vercel CLI has no
   token — repo import is a user step; commit `vercel.json` + a public-safe
   `.env.production` so their one click just works.

## Phase 1 — Scaffold (do this inline, yourself)

The scaffold is the coordination contract for everything after it:

- Vite + React + TS (strict) + Tailwind. Design tokens from the mockup go in
  `tailwind.config.ts`; fonts via Google Fonts in `index.html`.
- **`src/types/db.ts` is the single data contract** — every table, enum and
  jsonb shape, snake_case exactly as the DB will have it. Migrations and all
  frontend agents build against it. Change it and the schema in one commit.
- Shared kit: `src/components/ui.tsx` (buttons/chips/cards/skeletons/charts),
  `src/lib/format.ts` (UK conventions), `src/lib/supabase.ts` (+ graceful
  "not configured" state), `src/lib/useSupabaseQuery.ts` (refetches on the
  sync refresh token), auth provider + invite-only sign-in, app shell.
- Router with **stub pages at fixed paths** for every module — agents
  overwrite stubs, `App.tsx` never changes, no merge conflicts.
- Edge function `_shared/` helpers: http (CORS/json), auth (getCaller +
  role check via service client), audit, and the integration client (for
  Xero: custom-connection client_credentials — see reference below).
- `npm run build` must be green, then commit the baseline before fan-out.

## Phase 2 — Parallel module build (Workflow tool, one agent per slice)

Fan out with **disjoint file ownership** — each agent owns whole directories;
shared files are read-only for everyone. Pin ALL cross-slice contracts in the
common prompt preamble:

- edge function names + exact request/response payloads
- database view names + columns, RPC names + `p_*` parameter names
- storage bucket names + path conventions (`<uid>/...`)

Typical slices: db-migrations · edge-sync/integration · edge-ai/platform ·
2–6 frontend module agents. Tell agents: no new npm deps, hand-rolled SVG
charts, typecheck only their own dir, never commit.

**Migrations agent house style** (this is the security architecture):
`app_private` schema for helpers; `get_role(uid)` SECURITY DEFINER used by
every policy (no recursive RLS, deactivated users return NULL and fail
closed); RLS enabled on every table, deny-by-default; column/transition rules
via guard triggers; views `security_invoker = true`; generic audit trigger
(strip `*_enc` keys); PII via pgcrypto + Vault key referenced BY NAME
(values inserted at deploy time); storage policies per bucket; pg_cron job
reads its shared secret from Vault. Final migration = sanity DO block that
raises if any table lacks RLS.

## Phase 3 — Integrate, review, fix

1. `npm run build` — cross-module type errors are yours to fix.
2. Grep every `.rpc('...')` / `.from('...')` / `invokeFunction('...')` string
   against the migrations — **name drift compiles fine and fails at runtime**
   (GAUFCC had `store_` vs `set_person_bank_details` and a missing
   `create_onboarding_token` RPC).
3. Run an adversarial review Workflow (find → verify per finding) over at
   least: RLS escalation, cross-slice **money sign conventions**, contract
   drift, integration API correctness, financial maths, edge auth. Real bugs
   this caught: money-out double-negated (bills INCREASED balances), Xero
   If-Modified-Since in RFC 1123 (silently full-syncs), VOIDED docs not
   excluded, `Math.ceil` FP artefact in VAT %, CEO able to approve own claim.
4. Apply confirmed fixes; redeploy any edge function whose shared modules
   changed (deploys bundle `_shared/` — fixing the repo file does nothing to
   the live function until redeployed).

## Phase 4 — Deploy & handover

1. Migrations: `apply_migration` per file, in order, name = stem. Vault
   secrets first (`select vault.create_secret(...)` via execute_sql).
2. Edge functions: upload `index.ts` with imports rewritten
   `../_shared/X.ts` → `./_shared/X.ts` plus `_shared/*.ts` entries
   (upload-only rewrite). `verify_jwt: false` ONLY for functions with their
   own auth (cron secret header, single-use tokens + rate limiting) — read
   the code to confirm before deploying.
3. Bootstrap the first admin via SQL insert into `auth.users` +
   `auth.identities` (random password; user claims via "Forgotten your
   password?"). The signup trigger assigns the role.
4. Verify with SQL RLS probes (`set_config('role','authenticated')` +
   `request.jwt.claims`) — attempt self-promotion, self-approval, cross-user
   reads. Run `get_advisors` (security) and triage.
5. Delete any temp test users. Push branch; merge to main when told.
6. Secrets: **Vercel gets only public `VITE_` config; real secrets go in
   Supabase → Edge Functions → Secrets.** Write `docs/SECRETS.md` with exact
   names, dashboard paths and where each value comes from.

## Xero integration reference

- **Custom connection** = machine-to-machine, one org, client_credentials
  grant against `identity.xero.com/connect/token` (Basic auth, 30-min tokens,
  no refresh token, no `xero-tenant-id` header). Paid Xero add-on.
- Custom-connection scope picker uses **granular scopes**, not
  `accounting.transactions`. Least-privilege set for a finance mirror +
  bill push: `accounting.invoices` (rw), `accounting.banktransactions.read`,
  `accounting.contacts` (rw), `accounting.settings.read` (chart of accounts +
  tracking categories). No files/attachments/payments/journals/reports unless
  actually used.
- Sync engine rules: If-Modified-Since in ISO 8601 UTC without zone
  (`2026-06-01T09:30:00`); exclude `Status=="DELETED"` AND `"VOIDED"`;
  Accounts/TrackingCategories do NOT paginate, document endpoints page at 100;
  60 calls/min with Retry-After backoff; flatten documents to line-level rows.
- **Pick ONE money sign convention and write it in both the engine header and
  the view migration**: document-natural storage (docs positive, credit notes
  negative) with income/expenditure classified by `xero_accounts.class`
  composes best with SQL views.

## House defaults

UK conventions (£1,250.00 · 12 May 2026 · FY from 1 April · sentence case).
Warnings amber, red only for breached policy. AI output always labelled +
editable before it ships. EML generation over SMTP integration. Board-pack
style artefacts print via CSS `@page`, not server PDF (edge runtimes have no
Puppeteer).
