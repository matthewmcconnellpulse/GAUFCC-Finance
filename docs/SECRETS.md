# Where the env secrets live

Two homes, strictly separated. **Frontend config goes in Vercel; real secrets
go in Supabase edge function secrets.** Nothing secret is ever committed or
put in a `VITE_`-prefixed variable.

## 1. Vercel — frontend configuration (public-safe values only)

Vercel dashboard → project **gaufcc-finance** → **Settings → Environment
Variables** (apply to Production + Preview + Development):

| Variable | Value | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://uldtyqzchwkbitgnworq.supabase.co` | project API URL |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_…` | Supabase dashboard → Settings → API keys → publishable key. Safe to expose — RLS is the security boundary |

These are baked into the browser bundle — that is fine and by design. They are
not secrets.

## 2. Supabase — server secrets (never leave the backend)

Supabase dashboard → project **gaufcc-finance** → **Edge Functions →
Secrets** (or `supabase secrets set KEY=value --project-ref uldtyqzchwkbitgnworq`):

| Secret | Where to get it |
|---|---|
| `XERO_CLIENT_ID` | developer.xero.com → your custom connection app |
| `XERO_CLIENT_SECRET` | same page → Generate a secret |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected into every edge function automatically by Supabase — do not set them
by hand, and never put the service-role key anywhere else.

## 3. Xero custom connection — one-time setup

1. Sign in at **developer.xero.com** with an account that has admin access to
   GAUFCC's Xero organisation.
2. **New app** → choose **Custom connection** (not "Web app"). Custom
   connections are Xero's machine-to-machine product: one app = one
   organisation, no OAuth redirect dance, tokens via `client_credentials`.
3. Scopes to tick — exactly these four, nothing more (least privilege):
   - `accounting.transactions` (read/write — mirrors invoices/bills/bank
     transactions and pushes approved-expense bills)
   - `accounting.contacts` (read/write — supplier lookup/creation on bill push)
   - `accounting.settings.read` (chart of accounts + tracking categories,
     where the funds live)
   - `accounting.reports.read` (Financials → Profit & Loss and Balance Sheet
     are rendered live from Xero's Reports API; without this scope those two
     screens show a "needs the reports scope" error, everything else works)
   No journals, payments or budgets scopes — the platform never posts
   journals or payments.
4. Select the authorising user; they'll get an email to authorise the
   connection against the GAUFCC organisation.
5. Copy the **Client ID** and generate a **Client Secret** → save both as
   Supabase edge function secrets (table above).
6. In the app: Settings → Xero connection → "Test connection".

Note: custom connections are a paid Xero add-on (per connection, billed by
Xero). The alternative is a standard OAuth 2.0 app — the sync engine supports
both, but custom connection is simpler and is what this build assumes.

## 4. Local development

Copy `.env.example` → `.env` and fill in the two `VITE_` values. `.env` is
git-ignored. Edge functions read their secrets from the Supabase runtime, so
nothing else is needed locally unless you run `supabase functions serve`
(then use `supabase/functions/.env`, also git-ignored).
