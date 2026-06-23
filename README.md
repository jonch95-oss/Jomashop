# LuxeSupply × Jomashop Integration

Private operations dashboard that bridges LuxeSupply's Shopify store with the
Jomashop Vendor API. Covers shoes, handbags, and clothing — **not** watches.

This is a working **scaffold**: real Shopify OAuth flow, real Jomashop JWT
lifecycle, real mapping logic, real SQLite persistence. Mutating actions
(pushing products, updating inventory, fulfilling orders) are intentionally
stubbed with previews so nothing is sent to production until you say so.

---

## Quick start

```bash
cp .env.example .env       # fill in Shopify + Jomashop secrets
npm install
npm run dev                # http://localhost:5000
```

Build and run production:

```bash
npm run build
NODE_ENV=production node dist/index.cjs
```

---

## Environment variables

| Key                       | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `PORT`                    | Server port. Default `5000`.                                                           |
| `APP_URL`                 | Public HTTPS URL of this app. Used to build the Shopify redirect URL.                  |
| `SESSION_SECRET`          | Random 32+ char string (reserved for future signed-state helpers).                     |
| `SHOPIFY_CLIENT_ID`       | From your Shopify Dev Dashboard app named "Jomashop integration".                      |
| `SHOPIFY_CLIENT_SECRET`   | From the same app. Treat as a top-tier secret.                                         |
| `SHOPIFY_APP_URL`         | Must match `APP_URL`. Shopify enforces exact match against the Dev Dashboard field.    |
| `SHOPIFY_SCOPES`          | Comma-separated. Default list covers read/write across products, inventory, orders.    |
| `JOMASHOP_API_BASE_URL`   | Defaults to `https://api.vendor.jomashop.com`.                                         |
| `JOMASHOP_EMAIL`          | Vendor account email.                                                                  |
| `JOMASHOP_PASSWORD`       | Vendor account password. Only used at login; JWT is held in memory.                    |

The app **never** persists `SHOPIFY_CLIENT_SECRET`, `JOMASHOP_PASSWORD`, or the
Jomashop JWT to disk or to the SQLite DB. Status records (`credential_status`
table) track _whether_ each variable is configured, never the value.

---

## What to paste into the Shopify Dev Dashboard

After you deploy this app and have a stable HTTPS URL (call it `APP_URL`):

| Dev Dashboard field           | Value                                  |
| ----------------------------- | -------------------------------------- |
| App URL                       | `{APP_URL}`                            |
| Allowed redirection URL(s)    | `{APP_URL}/auth/shopify/callback`      |

Then in this app open `/#/setup`, click **Begin install**, and you'll land
back at `/#/setup?installed=…` on success.

Scopes selected on the Shopify side must match `SHOPIFY_SCOPES` exactly.

---

## Routes

### Frontend (hash-routed)

- `/#/` Overview
- `/#/setup` Setup (Shopify OAuth + Jomashop session test)
- `/#/mapping` Field mapping per category
- `/#/portal-styles` Vendor Portal reconciliation (import export, see live status)
- `/#/products` Shopify → Jomashop product mapping preview
- `/#/inventory` Bulk inventory CSV preview
- `/#/orders` New orders preview
- `/#/fulfillment` Fulfill payload preview
- `/#/logs` Sync jobs + event log

### Backend

| Method | Path                                            | Purpose                                          |
| ------ | ----------------------------------------------- | ------------------------------------------------ |
| GET    | `/auth/shopify/start`                           | Begin Shopify OAuth (`?shop=…`)                  |
| GET    | `/auth/shopify/callback`                        | Shopify redirect target, exchanges `code`        |
| GET    | `/api/health`                                   | Liveness probe                                   |
| GET    | `/api/config/status`                            | Env var configured/missing report (no secrets)   |
| GET    | `/api/jomashop/session/test`                    | Login + categories fetch, logged as a sync job   |
| GET    | `/api/jomashop/categories`                      | List categories (live if logged in)              |
| GET    | `/api/jomashop/categories/:name`                | Category schema (Shoes/Handbags/Clothing)        |
| GET    | `/api/jomashop/products`                        | Proxy `GET /v1/products`                         |
| GET    | `/api/jomashop/inventory`                       | Proxy `GET /v1/inventory`                        |
| GET    | `/api/jomashop/orders`                          | Proxy `GET /v1/orders?status=…`                  |
| POST   | `/api/sync/preview-products`                    | Shopify product → Jomashop payload mapping       |
| GET    | `/api/sync/inventory-preview`                   | Bulk inventory CSV preview                       |
| GET    | `/api/sync/orders-preview`                      | Orders + fulfill payload preview                 |
| POST   | `/api/portal/import`                            | Import a Vendor Portal export (CSV/XLSX upload, or JSON `{rows}`/`{csv}`) |
| GET    | `/api/portal/styles`                            | Reconciled portal styles (recomputed vs. cache)  |
| GET    | `/api/portal/summary`                           | Reconciliation counts + portal-missing list      |
| GET    | `/api/portal/inventory-eligibility`             | Push-eligibility guard (all, or `?sku=`)         |
| GET    | `/api/portal/order-match-preview`               | Match imported-order lines to confirmed styles   |
| GET    | `/api/stores`, `/api/sku-mappings`, `/api/category-mappings`, `/api/sync-jobs`, `/api/logs`, `/api/imported-orders` | DB read endpoints used by the UI |

The Jomashop client (`server/jomashop.ts`) handles:

- Login reading JWT from the **Authorization** response header. The vendor API
  has shipped the session endpoint as both `/v1/sessions` (plural) and
  `/v1/session` (singular); the client tries `/v1/sessions` first and falls back
  to `/v1/session` on a **404**, then remembers whichever answered. Set
  `JOMASHOP_SESSION_PATH` to pin one path and skip the probe.
- Refresh via `PUT` on the resolved session path before the 5-day TTL expires
- Automatic re-login on **401** (and re-probe on **404**) at any time
- Single-flight refresh: concurrent requests share one in-flight refresh promise

---

## Vendor Portal reconciliation (`/#/portal-styles`)

The Jomashop **Vendor Portal** ("Manage Inventory") is the source of truth for
what is actually live on Jomashop. It has no public API, so this feature is
**import/export driven** — no scraping, no portal credentials. Export the
Manage Inventory list to CSV/XLSX (or copy the rows), import it here, and the
app reconciles each style against the cached Shopify catalog.

### Expected columns

Headers are matched loosely (case/spacing/punctuation insensitive). The portal
export typically includes:

| Column                 | Maps to        | Notes                                         |
| ---------------------- | -------------- | --------------------------------------------- |
| `Status`               | portal status  | `Active` / `Inactive`                         |
| `Joma Status`          | live status    | `Live` ⇒ confirmed live on Jomashop           |
| `SKU`                  | vendor SKU     | **required** — rows without a SKU are skipped  |
| `Jomashop SKU`         | jomashop SKU   | secondary match key                            |
| `Name`                 | title          | brand+title fallback match                     |
| `Category`             | category       | informational                                  |
| `Qty`                  | quantity       | integer                                        |
| `Price (USD)`          | price          | stored as integer cents                        |
| `MSRP (USD)`           | msrp           | stored as integer cents                        |
| `Date Created`         | dateCreated    | kept as text                                   |
| `Date Updated`         | dateUpdated    | kept as text                                   |
| `Product ID` / `UPC`   | productId      | UPC/barcode/GTIN match key (if present)        |

Extra columns are preserved in a raw-row JSON snapshot.

### Match keys & statuses

Each portal row is matched to a Shopify product/variant in descending trust
order: **Exact SKU → Jomashop SKU → UPC/Product ID → Style/Parent SKU
(manufacturer #) → Brand+Title**. The resulting **reconciliation status**:

- **Confirmed Live** — matched and `Joma Status = Live`
- **Active in Portal** — matched and `Status = Active`
- **Inactive in Portal** — matched and `Status = Inactive`
- **Needs Review** — matched only by Brand+Title (low confidence) or status unknown
- **Unmatched Portal Row** — no catalog match
- **Portal Missing** — a product pushed to Jomashop that has **no** portal row
  (surfaced separately as a gap to investigate)

### Guardrails

- **Inventory pushes** should be gated on
  `GET /api/portal/inventory-eligibility?sku=…` — only **Confirmed Live** and
  **Active in Portal** styles are `eligible`. The UI shows an Eligible/Blocked
  badge per row.
- **Order pulls**: `GET /api/portal/order-match-preview` matches imported-order
  line SKUs against confirmed-live styles and flags `unmatched` /
  `portal_unconfirmed` lines so you don't fulfill against an unverified mapping.

### Workflow

1. In the Vendor Portal, export Manage Inventory (CSV/XLSX).
2. Open `/#/portal-styles`, **Upload CSV / XLSX** (or paste rows). Import
   replaces the prior snapshot by default (`replace=false` to append).
3. Review the reconciliation table — filter by status, check matched Shopify
   SKU/product and confidence, and confirm inventory eligibility before pushing.

## Data model

SQLite + Drizzle ORM. Tables (`shared/schema.ts`):

- `stores` — connected Shopify stores, OAuth status, granted scopes
- `credential_status` — per-env-var configured/missing flag (no values)
- `sku_mappings` — Shopify variant SKU ↔ Jomashop vendor SKU
- `category_mappings` — Shopify product type → Jomashop category
- `sync_jobs` + `sync_logs` — operation history
- `imported_orders` — JSON snapshots of orders pulled from Jomashop
- `portal_styles` — imported Vendor Portal rows + computed match status/confidence

DB file is `data.db` in the project root. Add it to `.gitignore` for production
(already ignored).

---

## Security notes

1. **Never paste passwords or client secrets into chat or screenshots.** If a
   value was ever exposed (even briefly), rotate it from the Shopify Dev
   Dashboard or the Jomashop vendor portal before continuing.
2. **Secrets live in environment variables only.** This app does not write
   `SHOPIFY_CLIENT_SECRET`, `JOMASHOP_PASSWORD`, or Shopify access tokens to
   disk. Acquired Shopify access tokens are deliberately discarded after the
   OAuth callback completes — configure a secret manager or DB encryption
   before persisting them.
3. **HTTPS only in production.** Shopify will reject OAuth callbacks served
   over HTTP. Always use the deployed HTTPS `APP_URL`.
4. **Restrict scopes.** The default scope list is broad. Trim
   `SHOPIFY_SCOPES` to the minimum your workflow actually needs.
5. **Rotate on suspicion.** If a screenshot, chat log, repository, or backup
   may have leaked a secret, treat it as compromised and rotate immediately.
6. **HMAC + state verification.** The OAuth callback validates Shopify's HMAC
   signature and the `state` parameter (in-memory store, 10-minute TTL). State
   validation is intentionally pluggable so production can swap to signed JWTs.
7. **No browser storage.** Frontend uses React state only — no
   `localStorage`, `sessionStorage`, `indexedDB`, or cookies.

---

## Build / dev commands

```bash
npm install
npm run dev      # dev server (Express + Vite on port 5000)
npm run build    # production bundle (server: dist/index.cjs, client: dist/public/)
npm run check    # tsc
npm start        # production server
```

---

## What's left to wire (intentional gaps)

- **Persistent Shopify access tokens.** Wire to a secret manager (Doppler, AWS
  Secrets Manager, etc.) before going live. The scaffold's `stores` table
  intentionally has `tokenStorage='env'` and no token column.
- **Mutating push endpoints.** `POST /v1/products`, `PUT /v1/inventory/:sku`,
  `PUT /v1/orders/:n/fulfill` are reachable via the same `jomashopRequest`
  helper but no UI button triggers them yet. Plug them in once mapping is
  reviewed for the live catalog.
- **Webhook receiver for Shopify order/inventory changes.** Add a
  `/webhooks/shopify/:topic` route with HMAC verification when needed.
- **Field mapping editor.** The UI currently shows the live (or fallback)
  schema in read-only form. Backend already has an `upsertCategoryMapping`
  storage method — wire a form when needed.
