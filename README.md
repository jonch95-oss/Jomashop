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
| GET    | `/api/sync/inventory-preview`                   | Bulk inventory CSV preview for the real pushed SKUs |
| GET    | `/api/sync/orders-preview`                      | Orders + fulfill payload preview                 |
| POST   | `/api/jomashop/reconcile-push-state`            | Rebuild local push state from Jomashop's live inventory or an imported portal export (`dryRun` defaults to true) |
| POST   | `/api/portal/import`                            | Import a Vendor Portal export (CSV / XLSX / XLSM upload, or JSON `{rows}`/`{csv}`) |
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
Manage Inventory list (or copy the rows), import it here, and the app
reconciles each style against the cached Shopify catalog.

### File formats

Upload the portal download **as-is**. Format is detected from the file's
contents, not its extension, so the macro-enabled `.xlsm` workbook the portal
hands out works alongside `.xlsx` / `.xltx` / `.csv`. Inside a workbook the
importer *finds* its data rather than assuming a layout:

- the **data sheet** is chosen by looking for a header row with a SKU column,
  so the workbook's leading `Instructions` sheet is skipped;
- the **header row** is located by scanning the top of the sheet, so title and
  banner blocks above it don't shift the columns;
- the template's two annotation rows directly under the header (the prose
  descriptions, and the `required` / `readonly` flags) are dropped instead of
  being imported as phantom styles;
- **unnamed columns are kept**. The workbook ships the style/parent number in a
  column with a blank header; a cell there whose value is a prefix of the
  vendor SKU (`L1833LCL395X1N001` for `L1833LCL395X1N001-OS`) is read as the
  style number, which is what matches a Shopify `manufacturer_number`.

### Expected columns

Headers are matched loosely (case/spacing/punctuation insensitive). The portal
export typically includes:

| Column                 | Maps to        | Notes                                         |
| ---------------------- | -------------- | --------------------------------------------- |
| `Status`               | portal status  | `Active` / `Inactive`                         |
| `Joma Status`          | live status    | `Live` ⇒ confirmed live on Jomashop           |
| `SKU` / `Vendor SKU`   | vendor SKU     | **required** — rows without a SKU are skipped  |
| `Jomashop SKU` / `Joma SKU` | jomashop SKU | secondary match key; the workbook uses the short spelling |
| `Style` / `Manufacturer #` / unnamed column | style number | matches Shopify `manufacturer_number` |
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

When the export carries **no status columns at all** — the `.xlsm` Manage
Inventory workbook has none — a blank status is not "unknown", it means "this
row is in the portal". Those rows resolve on the Jomashop SKU instead: a row
that already has one is **Confirmed Live**, a row still waiting for one is
**Active in Portal**. An export that *does* have status columns is unaffected;
a blank status there still means **Needs Review**.
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

1. In the Vendor Portal, export Manage Inventory.
2. Open `/#/portal-styles`, **Upload CSV / XLSX / XLSM** (or paste rows) —
   the downloaded file needs no cleanup first. Import replaces the prior
   snapshot by default (`replace=false` to append).
3. Review the reconciliation table — filter by status, check matched Shopify
   SKU/product and confidence, and confirm inventory eligibility before pushing.

### Not pushing the same style twice

Once an export is imported, every product row carries a `portal_state` derived
from it, independent of this app's own push history:

- **`live`** — the portal has already assigned the style a Jomashop SKU.
- **`in_portal`** — the portal knows the style; Jomashop has not listed it yet.
- **`unknown`** — no portal row matched, or nothing has been imported.

A product is matched on any of its identifiers — vendor SKU, style/parent
number, Jomashop SKU, or any variant SKU — so a style is recognized even when
the individual size SKU isn't in the export.

This drives three things:

- **Products** shows a **Live on Jomashop** / **In portal, not live** badge per
  card, with matching filter chips.
- **`live` products are excluded from "Ready to push"** and from the bulk
  **Push filtered** count, so they can't be swept up in a batch.
- **`POST /api/jomashop/push-product` refuses them** with HTTP 409 and
  `blocked: "already_live"`, on every push path including dry runs. Override
  deliberately with `allowDuplicate: true`.

Local `push_state` alone cannot prevent duplicates, because it is empty for
anything pushed before the app's database was last reset — which is exactly
when duplicate pushes happen. The portal export is the independent check.

Nothing has been imported yet means `portal_state` is `unknown` everywhere and
no push is blocked — the guard never guesses that an item is absent.

---

## "It's live on Jomashop but the app says it was never pushed"

`push_state` is derived **entirely** from this app's own `push_statuses` table
— nothing reads back from Jomashop to confirm it. That table lives in the
SQLite file at `DATA_DB_PATH`, which defaults to a relative `data.db` in the
working directory. Most hosts give a fresh container on every redeploy, so
unless `DATA_DB_PATH` points at a **mounted persistent disk** the push history
is wiped while the products stay live on Jomashop. The symptoms:

- the Inventory page lists no pushed SKUs,
- Products shows items as needing a push when they are already on Jomashop,
- inventory webhooks skip those SKUs (`has not been pushed to Jomashop yet`),
- Portal Styles reports them under **Portal Missing**.

Two things to do:

1. **Stop it recurring** — set `DATA_DB_PATH` to a path on a persistent disk
   (e.g. `/var/data/data.db`) and redeploy.
2. **Recover what was lost** — Inventory page → **Rebuild push state**, or
   `POST /api/jomashop/reconcile-push-state`. It reads what is actually there
   (Jomashop's live `GET /v1/inventory`, or an imported Vendor Portal export),
   matches it against the cached Shopify catalog with the same matcher the
   Portal Styles page uses, and re-creates the missing `push_statuses` rows.
   It runs as a **dry run by default** — send `{"dryRun": false}` to write —
   and never pushes anything to Jomashop.

```bash
# preview
curl -X POST "$APP_URL/api/jomashop/reconcile-push-state" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"source":"jomashop"}'

# apply
curl -X POST "$APP_URL/api/jomashop/reconcile-push-state" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"source":"jomashop","dryRun":false}'
```

A product cache is required (Products → **Refresh from Shopify**), since the
match is made against it.

---

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

---

## Embedded Shopify admin app

The dashboard can now run **inside the Shopify admin** (App Bridge session-token
auth, no manual token) while the standalone Render dashboard keeps working with
`ADMIN_TOKEN`. Setup steps (App URL, callback URL, scopes, embedded=true) are in
[docs/SHOPIFY_EMBEDDED_SETUP.md](docs/SHOPIFY_EMBEDDED_SETUP.md); `shopify.app.toml`
mirrors the Dev Dashboard configuration.

## Automation (auto-sync foundation)

A Farfetch-style scheduler (see the **Automation** page in the UI) adds:

- **Inventory sync (Shopify → Jomashop)** for styles confirmed live/active by
  the Portal Styles reconciliation only, with a per-SKU `MAX_INVENTORY_DELTA`
  guard.
- **Order pull (Jomashop → preview)** that matches order lines to Shopify
  variants via SKU / Jomashop SKU / portal reconciliation and flags unmatched
  lines. The scheduler **never creates Shopify orders** — live import stays
  behind `POST /api/jomashop/orders/import-to-shopify { confirm: true }`.

Everything defaults to **disabled + dry-run**:

```
AUTO_SYNC_ENABLED=false
AUTO_SYNC_DRY_RUN=true
INVENTORY_SYNC_INTERVAL_MINUTES=30
ORDER_PULL_INTERVAL_MINUTES=15
MAX_INVENTORY_DELTA=25
ORDER_IMPORT_ENABLED=false
```

Manual dry-runs: `POST /api/automation/inventory-sync-now`,
`POST /api/automation/pull-orders-now`; status + audit:
`GET /api/automation/status`, `GET /api/automation/audit`. Every run is
recorded in `sync_jobs` / `sync_logs`.
