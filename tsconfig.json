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
| GET    | `/api/stores`, `/api/sku-mappings`, `/api/category-mappings`, `/api/sync-jobs`, `/api/logs`, `/api/imported-orders` | DB read endpoints used by the UI |

The Jomashop client (`server/jomashop.ts`) handles:

- Login via `POST /v1/session` reading JWT from the **Authorization** response header
- Refresh via `PUT /v1/session` before the 5-day TTL expires
- Automatic re-login on **401** at any time
- Single-flight refresh: concurrent requests share one in-flight refresh promise

---

## Data model

SQLite + Drizzle ORM. Tables (`shared/schema.ts`):

- `stores` — connected Shopify stores, OAuth status, granted scopes
- `credential_status` — per-env-var configured/missing flag (no values)
- `sku_mappings` — Shopify variant SKU ↔ Jomashop vendor SKU
- `category_mappings` — Shopify product type → Jomashop category
- `sync_jobs` + `sync_logs` — operation history
- `imported_orders` — JSON snapshots of orders pulled from Jomashop

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
