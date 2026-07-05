# GAUFCC Finance Platform

Trustee-facing fund reporting and data-capture tool for the General Assembly
of Unitarian and Free Christian Churches, built and operated by
[Pulse Accountants](https://pulseaccountants.co.uk). Sits on top of Xero
(tracking categories = funds).

## Modules

- **Funds** — dashboard over ~60 funds, per-fund P&L, data-integrity checks
  that gate board packs, warning engine
- **Reports** — SOFA-style report builder, one-click board packs, AI
  commentary (draft/enhance), `.eml` distribution
- **Expenses** — submitter portal with AI receipt OCR, CEO approval queue
  (deadline: 10th), payment run (17th), push to Xero as bills
- **People** — employee & volunteer onboarding via tokenised links, encrypted
  bank details
- **Imports** — HSBC statement drop-in → sense checks → Xero-ready CSV;
  Epworth monthly investment report → fund mapping
- **VAT** — partial exemption de minimis calculator, registration case view
- **Projects** — in-app tracker for the build and feature requests

## Stack

React + Vite + TypeScript + Tailwind on **Vercel** · **Supabase** (Postgres,
Auth, Storage, Edge Functions, pg_cron) · **Xero** custom connection ·
**Anthropic API** for OCR/commentary.

- Supabase project: `gaufcc-finance` (`uldtyqzchwkbitgnworq`, eu-west-2)
- Where secrets live: see [docs/SECRETS.md](docs/SECRETS.md)
- Design system: see [docs/DESIGN.md](docs/DESIGN.md) and mockups in
  `docs/design/`
- Full brief: [docs/BUILD_BRIEF.md](docs/BUILD_BRIEF.md)

## Development

```bash
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

`npm run build` type-checks and produces `dist/`. Vercel auto-deploys from
`main`.

## Database

Migrations live in `supabase/migrations/` and are the source of truth for the
schema. RLS is strict deny-by-default; roles are `pulse_admin`,
`pulse_bookkeeper`, `pulse_payroll`, `ceo`, `trustee`, `submitter`.
`src/types/db.ts` mirrors the schema — change both in the same commit.

## Edge functions

`supabase/functions/` — Xero sync engine (nightly 04:00 Europe/London +
manual "Refresh now", server-debounced), bill push on CEO approval, Claude
receipt extraction, AI commentary, board-pack rendering, onboarding token
endpoints.
