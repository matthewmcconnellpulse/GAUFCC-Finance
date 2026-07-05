# GAUFCC Finance Platform — Build Brief & Sequenced Claude Code Prompts

**Client:** General Assembly of Unitarian and Free Christian Churches (GAUFCC)
**Prepared by:** Pulse Accountants & Tax Advisors Limited
**Date:** July 2026
**Purpose:** This document is the master brief. Section A goes to **Claude Code** (sequenced build prompts). Section B goes to **Claude Design**. Section C lists open decisions and dictation clarifications for Matthew to confirm.

---

## Project Summary

GAUFCC is a charity with ~£8m net reserves, ~4,500 transactions/year, and ~60 funds (restricted, designated/dormant, and general) managed via Xero tracking categories following a migration from Aqilla. Pulse manages the bookkeeping and payroll.

The platform is a **trustee-facing fund reporting and data-capture tool** sitting on top of Xero:

1. **Fund dashboard & reporting** — per-fund views built from Xero tracking categories, with data-integrity checks and board-pack generation.
2. **Expense capture & approval** — staff/volunteer/supplier portal with AI OCR on receipt batches, CEO sign-off deadline (default 10th), payment run (default 17th), then push to Xero as bills.
3. **Employee & volunteer onboarding** — structured data-capture forms.
4. **Import tools** — HSBC corporate bank statement drop-in (no feed available) converted to Xero-ready CSV with sense checks; Epworth monthly investment report mapped to funds (realised/unrealised gains, interest, dividends).
5. **VAT partial exemption module** — de minimis calculation, presented so trustees/CEO can see whether VAT registration makes sense.
6. **AI layer** — receipt extraction, report commentary enhancement, auto-generated highlights, fund flags/warnings.
7. **In-app project tracker** — Gantt/Karbon-style tracker for the build itself and future feature requests.

### Stack

| Layer | Choice |
|---|---|
| Frontend | React (Vite) on **Vercel**; possibly ported to Lovable later for ease of client-side edits |
| Backend | **Supabase** (Pulse's own org) — Postgres, Auth, Storage, Edge Functions, pg_cron |
| CI/CD | GitHub → Vercel auto-deploy. Claude Code pushes direct to main via GitHub (no PR approval gate) — repo and branch protection to be configured accordingly from day one |
| AI | Anthropic API (Claude) for OCR extraction, commentary, highlights, anomaly flags |
| Auth | Email + password (Supabase Auth), enforced RLS, full audit logging. The old Aqilla setup had poor data security — this build must be demonstrably watertight |
| Domain | Vercel custom domain. Note: `.pulse` is not a real TLD — recommended: **gaufcc-finance.pulseaccountants.co.uk** (CNAME to Vercel), or purchase gaufcc-finance.co.uk. Confirm in Section C |

### Roles

| Role | Access |
|---|---|
| Pulse Admin (partner) | Everything, settings, user management |
| Pulse Bookkeeper | Imports, expense processing, Xero sync, reports |
| Pulse Payroll Manager | Employee/volunteer records, onboarding |
| GAUFCC CEO | Expense approvals, all reports, fund flags |
| Trustee / Fund Manager | Read-only: whole-board pack or only funds they manage |
| Submitter (staff/volunteer/supplier) | Own expense claims and own profile only |

### Sync policy

- Nightly full sync from Xero at **04:00 UK** via pg_cron + edge function.
- Manual **"Refresh now"** button in the top corner of every screen (pulls latest reconciled data, debounced, shows last-synced timestamp).
- Xero scope: transaction data, general ledger, contacts, invoices, bills, and **both tracking category options** (read ongoing). Write: bills (approved expenses), imported bank CSV artefacts are downloaded not pushed. No bank feeds, no journals.

---

# SECTION A — Sequenced Claude Code Prompts

Run these in order. Each prompt assumes the previous ones are complete. Migrations for all DDL/DML; edge functions with `verify_jwt: false` only where webhook-triggered; everything else JWT-verified.

---

## Prompt 0 — Project scaffold

> Create a new project: React + Vite + TypeScript + Tailwind frontend deployed to Vercel, Supabase backend (existing Pulse Supabase org — I'll supply project ref and keys as env vars). Set up:
> - GitHub repo `gaufcc-finance` with Vercel Git integration, auto-deploy on push to `main`. No PR approval gates — Claude Code commits directly.
> - Env structure: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `ANTHROPIC_API_KEY`.
> - Vercel custom domain placeholder (gaufcc-finance.pulseaccountants.co.uk — DNS to follow).
> - App shell: sidebar navigation (Dashboard, Funds, Reports, Expenses, People, Imports, VAT, Projects, Settings), top bar with "Refresh now" sync button and last-synced timestamp, auth-gated routes.
> - Supabase Auth with email/password only. Session handling, password reset flow, and an invite-only signup (no open registration).

## Prompt 1 — Database schema and RLS

> Create Supabase migrations for the full schema. Core tables:
>
> **Identity & access**
> - `profiles` (extends auth.users): full_name, role enum (`pulse_admin`, `pulse_bookkeeper`, `pulse_payroll`, `ceo`, `trustee`, `submitter`), organisation ('pulse' | 'gaufcc'), active flag.
> - `fund_managers` (junction): profile_id, fund_id — drives per-fund trustee visibility.
>
> **Xero mirror (read model)**
> - `xero_connections`: tenant_id, tokens (encrypted), status, last_sync_at.
> - `xero_accounts`: code, name, type, class, reporting_code.
> - `xero_contacts`: contact_id, name, email, is_supplier, is_customer.
> - `xero_tracking_categories` and `xero_tracking_options` (both category options — funds live here).
> - `xero_transactions`: line-level mirror of invoices, bills, bank transactions, manual journals excluded; columns for date, account_code, contact_id, description, net, vat, gross, tracking_option_1_id, tracking_option_2_id, source_type, xero_id, status, updated_date_utc. Index heavily on (tracking_option_1_id, date) and (account_code, date).
> - `sync_runs`: started_at, finished_at, trigger ('cron' | 'manual'), records_upserted, errors jsonb.
>
> **Funds**
> - `funds`: linked 1:1 to a tracking option, plus: fund_type enum (`restricted`, `designated`, `general`, `dormant`), opening_balance, opening_balance_date, description, purpose, warning_rules jsonb (e.g. min balance, deficit flag, dormancy threshold).
>
> **Expenses**
> - `expense_claims`: submitter_id, status enum (`draft`, `submitted`, `approved`, `rejected`, `pushed_to_xero`, `paid`), period, total, ceo_approved_by, ceo_approved_at, xero_bill_id.
> - `expense_lines`: claim_id, date, description, category (maps to Xero account), fund_id, net, vat, gross, receipt_storage_path, ai_extraction jsonb, ai_confidence.
>
> **People**
> - `people`: type enum (`employee`, `volunteer`), personal details, bank details (encrypted columns via pgsodium), emergency contact, start_date, onboarding_status, linked profile_id nullable.
> - `onboarding_submissions`: person_id, form payload jsonb, submitted_at.
>
> **Imports**
> - `bank_imports`: file path, statement period, parsed rows jsonb, sense_check_results jsonb, status, generated_csv_path.
> - `epworth_imports`: file path, period, parsed jsonb, mapping_results jsonb, status.
> - `epworth_fund_mappings`: epworth_holding_ref → fund_id, income_type enum (`realised_gain`, `unrealised_gain`, `interest`, `dividend`).
>
> **VAT**
> - `vat_periods`: period, taxable_supplies, exempt_supplies, residual_input_vat, directly_attributable jsonb, de_minimis_result jsonb, narrative.
>
> **Platform**
> - `settings`: key/value with typed jsonb — includes `expense_approval_day` (default 10), `payment_run_day` (default 17), sync time, warning thresholds. Editable by pulse_admin and CEO.
> - `audit_log`: actor_id, action, entity, entity_id, before/after jsonb, ip, created_at. Populated by triggers on all sensitive tables.
> - `projects`, `project_tasks`: Karbon-style tracker — task, status, assignee, due date, dependencies (for Gantt rendering).
>
> **RLS (strict, deny-by-default):**
> - Pulse roles: full access per function.
> - CEO: read all funds/reports; write on expense approvals and settings (approval/payment days).
> - Trustees: read-only, restricted to funds in `fund_managers` unless flagged whole-board.
> - Submitters: CRUD own draft claims, read own submitted claims, read/write own person record during onboarding. Nothing else.
> - Service role only for sync and Xero writes.
> - Enable audit triggers, and storage bucket policies: `receipts` (submitter writes own folder), `imports` (Pulse only), `packs` (role-based read).

## Prompt 2 — Xero integration and sync engine

> Build the Xero layer:
> - OAuth 2.0 connect flow (edge function + settings page card) storing encrypted tokens in `xero_connections`, with automatic refresh.
> - `sync-xero` edge function: incremental sync using `If-Modified-Since` / UpdatedDateUTC where supported; upsert accounts, contacts, tracking categories/options (both), invoices, bills, bank transactions into the mirror tables; respect Xero rate limits (60/min) with backoff and use `EdgeRuntime.waitUntil()` so long syncs aren't cut off. Log every run to `sync_runs`.
> - pg_cron job at 04:00 Europe/London daily.
> - `POST /sync-now` endpoint wired to the top-bar Refresh button (JWT-verified, Pulse + CEO roles), debounced server-side to one run per 5 minutes.
> - Auto-create/refresh `funds` rows from tracking option 1, flagging new options for Pulse to classify (fund_type, opening balance).
> - Bill push function: on CEO approval of an expense claim, create a draft Bill in Xero (contact = submitter's supplier contact, lines with account codes, tracking options, VAT), store `xero_bill_id`, move claim to `pushed_to_xero`. Human trigger only — no autonomous pushes.

## Prompt 3 — Fund dashboard, integrity checks, and warnings

> Build the Funds module:
> - **Funds overview**: card/table of all ~60 funds — balance (opening + movements from mirrored transactions), fund_type, YTD income/expenditure, sparkline, warning badges. Filter by type/status; restricted vs general clearly distinguished.
> - **Fund detail**: period selector (month/quarter/year/custom), P&L for the fund from tracking option 1, transaction drill-down, balance history chart, notes.
> - **Data integrity screen** (Pulse-facing): (a) transactions in period with a missing tracking category, (b) transactions carrying conflicting/double tracking assignments, (c) tracking options with no matching fund record, (d) fund balances that don't reconcile to the GL control. Each check shows count, drill-down list, and deep links to the record in Xero. A period is stampable as "complete" once checks pass — stored with who/when for the audit trail.
> - **Warning engine**: evaluate `warning_rules` per fund on each sync (deficit, below-minimum balance, unusual movement vs trailing average, dormancy). Surface as badges, a notifications panel, and include in board packs.

## Prompt 4 — Import tools (HSBC bank statements & Epworth investments)

> Build the Imports module:
>
> **HSBC statement drop-in** (no bank feed available on HSBC corporate banking):
> - Drag-and-drop upload of statement files (PDF or CSV export). Parse with deterministic parsing first; fall back to Claude extraction for PDF layouts, storing raw + parsed rows in `bank_imports`.
> - Sense checks before output: opening balance matches prior import's closing balance, running balance recomputes correctly line by line, no date gaps or overlaps vs previous imports, duplicate detection against already-imported rows.
> - Output a Xero-ready bank statement CSV (Xero's manual import format) for download, plus a summary of check results. Block CSV generation until checks pass or a Pulse user overrides with a reason (logged).
>
> **Epworth monthly report**:
> - Upload the monthly Epworth report; parse holdings and per-fund figures for realised gains, unrealised gains, interest, and dividend income for the period.
> - Mapping table UI: Epworth holding/reference → fund, per income type (`epworth_fund_mappings`). Remember mappings month to month; only surface unmapped lines for attention.
> - Output: a review screen totalling by fund and income type, exportable as a Xero manual-journal-style CSV / posting summary for the bookkeeper, and feed the figures into fund reporting so investment income shows against the right funds.

## Prompt 5 — Expense portal, AI OCR, and approval workflow

> Build the Expenses module:
> - **Submitter portal** (staff, volunteers, suppliers): create a claim, add lines manually or by uploading a batch of receipt photos/PDFs. On upload, run each receipt through Claude vision extraction (date, merchant, description, net/VAT/gross, suggested category) into `ai_extraction` with a confidence score. Pre-fill lines; anything below the confidence threshold is highlighted for the submitter to confirm. Receipts stored in the `receipts` bucket against the line.
> - **Deadline logic** from settings: claims must be submitted and CEO-approved on/before the approval day (default 10th) to make that month's payment run (default 17th). Show a live banner ("Submit by 10 July to be paid on 17 July"); late claims roll to next run automatically. Both dates configurable in Settings and used dynamically everywhere.
> - **CEO approval queue**: list of submitted claims with receipt thumbnails, line detail, fund and category assignment, approve/reject with comment. Bulk approve. Approval writes ceo_approved_by/at and triggers (via Pulse review if flagged) the Xero bill push from Prompt 2.
> - **Pulse review layer**: bookkeeper can adjust coding (account, fund, VAT) before push; all edits audit-logged.
> - Email nudges generated as **EML files** (see Prompt 7) — e.g. "3 claims awaiting your approval, deadline in 2 days" for the CEO.

## Prompt 6 — People module (employee & volunteer onboarding)

> Build the People module:
> - Onboarding form links (tokenised, no login needed to start; converts to a submitter account on completion) capturing: personal details, contact info, bank details (encrypted at rest, masked in UI, visible only to Pulse payroll and admin), emergency contact, role/volunteer capacity, start date, right-to-work/DBS attachment upload where relevant.
> - Payroll manager dashboard: onboarding pipeline (invited → in progress → submitted → verified → complete), record detail with document viewer, export for payroll.
> - Volunteers and employees share the `people` table with type flag; volunteers skip payroll-specific fields.
> - Strict RLS: submitters see only their own record; bank details column-level restricted.

## Prompt 7 — Reporting, board packs, EML generation, and AI commentary

> Build the Reports module:
> - **Report builder**: period + scope (whole charity, fund group, single fund). Views: SOFA-style income & expenditure by fund, fund balance movements (opening → income → expenditure → transfers → closing), restricted vs unrestricted split, top movements, warning summary.
> - **Board pack generator**: one-click PDF pack — cover, contents, executive summary, charity-level financials, per-fund pages (auto-included for flagged funds; fund managers get packs limited to their funds), integrity-check status, and appendices. Rendered server-side (React-PDF or Puppeteer on an edge function), stored in the `packs` bucket, versioned.
> - **AI commentary**: draft commentary per report section via the Anthropic API — plain-English narrative of movements, drivers, and flags. Two modes: (a) generate from scratch with auto-highlights, (b) **enhance mode** — Pulse writes rough notes, Claude polishes into board-ready commentary. Always editable before the pack is finalised; nothing publishes without human confirmation.
> - **EML generation**: instead of integrating email, generate downloadable `.eml` files (RFC 5322, pack attached, pre-filled recipients/subject/body) that open in the staff member's desktop mail client for editing and sending. Use for pack distribution and approval nudges.

## Prompt 8 — VAT partial exemption module

> Build the VAT module:
> - Data model per `vat_periods`: taxable supplies, exempt supplies, directly attributable input VAT (taxable / exempt), residual input VAT.
> - Standard-method partial exemption calculation with **de minimis tests** (Test 1: total input VAT ≤ £625/month average and ≤ 50% of all input VAT; Test 2: exempt input VAT ≤ £625/month and ≤ 50%; plus the annual adjustment). Pull candidate figures from the Xero mirror by account mapping, editable before calculation.
> - Output a clear, trustee-friendly view: recoverable vs irrecoverable VAT, de minimis pass/fail, and a year-view showing the financial case for/against VAT registration, with AI-drafted plain-English explanation for the CEO and trustees. Include printable one-pager for board packs.
> - Flag: registration threshold monitoring against rolling 12-month taxable turnover.

## Prompt 9 — Settings, project tracker, audit, and hardening

> Finish the platform:
> - **Settings**: approval/payment days, sync time, warning thresholds, Xero connection management, user invitations and role assignment, fund classification queue.
> - **Project tracker**: Karbon-style board + Gantt view for platform features — task, status, assignee, due dates, dependencies. Pre-load with this build plan's phases so the client can watch delivery and Pulse can log future feature requests in-app.
> - **Audit & security pass**: verify RLS on every table with tests, audit-log coverage on sensitive actions (approvals, bank detail views, setting changes, overrides), storage policies, encrypted columns, rate limiting on public endpoints (onboarding tokens), session expiry. Produce a short security summary page (Settings → Security) that Pulse can show the trustees — this matters because the previous system's data security was poor.
> - Empty states, loading skeletons, error boundaries, and mobile-responsive layouts throughout.

---

# SECTION B — Claude Design Brief

**Product:** GAUFCC Finance Platform — charity fund reporting, expenses, and data capture, built by Pulse.

**Brand:** Pulse palette — dark purple, teal, magenta. Fraunces for display headings, Geist for body, JetBrains Mono for figures/code. The client is a 200-year-old charitable assembly: the tone should be professional, calm, and trustworthy — Pulse's modern edge, softened for trustees.

**Design priorities:**
1. **Management reports and board packs are the hero.** Extremely clean, professional, print-ready. Attractive, restrained charts (fund balance waterfalls, restricted/unrestricted splits, movement trends) — think high-end annual report, not SaaS dashboard clutter. Provide 2–3 pack layout concepts.
2. **Fund dashboard**: 60 funds must be scannable — strong hierarchy, warning badges that are visible without being alarming, clear restricted vs general distinction.
3. **Approval flows**: the CEO approval queue should be effortless on a phone — large receipt previews, one-tap approve.
4. **Forms** (onboarding, expenses): friendly and fast for volunteers who aren't technical; generous type sizes, clear progress.
5. **Data-density screens** (integrity checks, imports) for Pulse staff: denser, tabular, keyboard-friendly.
6. Consistent design system applied on **every page** — components, spacing, chart styles — so nothing looks bolted on. Deliver tokens + component examples Claude Code can implement directly.

---

# SECTION C — Decisions to confirm / dictation clarifications

1. **Domain**: `.pulse` isn't a purchasable TLD, so `gaufcc-finance.pulse` can't exist as-is. Recommended: **gaufcc-finance.pulseaccountants.co.uk** as a subdomain on Vercel (5-minute DNS job), or buy `gaufcc-finance.co.uk`. Which?
2. **CEO name**: dictation garbled ("get players, who is the CEO") — confirm the CEO's name for seeding the user list.
3. **"Microsoft Wallace designed on every page"** — interpreted as "make sure it's well designed on every page" and folded into the design brief. Correct?
4. **VAT**: interpreted "deus partial exemption" as the **de minimis** partial exemption tests, and "BNVAT registered makes sense" as demonstrating whether **being VAT registered** makes sense. Confirm whether GAUFCC is currently registered or this is a registration decision tool.
5. **17th deadline**: interpreted "impairment on the 17th" as the **payment run on the 17th**. Correct?
6. **Xero write scope**: bills only (from approved expenses). Bank statements and Epworth postings are generated as CSVs for manual import rather than pushed via API — safer for a charity audit trail. Happy with that, or push Epworth journals via API too?
7. **Member communication platform** (value-add comms to Assembly members) — parked as Phase 2, logged in the in-app project tracker.
8. **MVP sequencing suggestion**: Prompts 0–3 + 7 (funds, sync, reporting/packs) first so trustees see value immediately; then 5 (expenses), 4 (imports), 6 (people), 8 (VAT), 9 (polish).
