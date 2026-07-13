# Embedded Shopify Admin App — Setup Guide

The dashboard now runs in two modes:

| Mode | Where | Auth |
| --- | --- | --- |
| **Standalone** (existing) | Render URL opened directly | `ADMIN_TOKEN` bearer token (manual modal) |
| **Embedded** (new) | Inside the Shopify admin iframe (`admin.shopify.com/store/<store>/apps/<handle>`) | Shopify App Bridge **session tokens** (JWT, verified server-side against `SHOPIFY_CLIENT_SECRET`) — no manual token |

Both modes hit the same API. Nothing about standalone mode changed.

## Shopify Dev Dashboard settings

In [dev.shopify.com](https://dev.shopify.com) (or the Partners dashboard) → your app → **Configuration**:

1. **App URL**
   `https://<your-render-app>.onrender.com`
   (must exactly match `APP_URL` / `SHOPIFY_APP_URL` in your environment)
2. **Allowed redirection URL(s)**
   `https://<your-render-app>.onrender.com/auth/shopify/callback`
3. **Embedded app** → **Embedded in Shopify admin: `true`** (App settings → Embed app in Shopify admin)
4. **Scopes** (Configuration → Access scopes) — same list as `SHOPIFY_SCOPES`:
   `read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_locations,read_fulfillments,write_fulfillments,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders`
5. Copy the **Client ID** → `SHOPIFY_CLIENT_ID` env var, and the **Client secret** → `SHOPIFY_CLIENT_SECRET` env var (never commit these).

A `shopify.app.toml` at the repo root mirrors these values so the app can also be managed with the Shopify CLI (`shopify app config link`). Replace the placeholder `client_id` and URLs.

## Environment variables

No new secrets are required for embedded mode. It activates when:

- `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are set, and
- the page is loaded with Shopify's iframe params (`?embedded=1&host=…&shop=…`).

Keep `ADMIN_TOKEN` set — it still protects standalone access.

## How it works

- **Server** (`server/embedded_auth.ts`): every `/api/*` request may carry
  `Authorization: Bearer <App Bridge session token>`. The JWT is verified
  (HS256 signature via `SHOPIFY_CLIENT_SECRET`, `aud` = client id, `exp`/`nbf`,
  `dest` = a `*.myshopify.com` shop) and accepted in place of `ADMIN_TOKEN`.
- **CSP**: responses to embedded requests get
  `Content-Security-Policy: frame-ancestors https://<shop> https://admin.shopify.com`
  (Shopify requirement). Standalone responses are untouched.
- **`/apps/<handle>` paths**: redirected to `/` with the query string preserved,
  so admin-style paths land on the SPA with App Bridge params intact.
- **Client** (`client/src/lib/embedded.ts`): detects the iframe params, fetches
  the public client id from `GET /api/public/embedded-config`, loads App Bridge
  from the Shopify CDN, and attaches a fresh session token to every API call
  (with a 30s refresh cache for synchronous call sites). The ADMIN_TOKEN modal
  is hidden in embedded mode.

## Install / verify flow

1. Deploy to Render with the env vars above.
2. Install the app on the store: open
   `https://<your-app>/auth/shopify/start?shop=<store>.myshopify.com`
   and approve the OAuth grant (unchanged flow).
3. In the Shopify admin, open **Apps → LuxeSupply Jomashop Sync**. The
   dashboard should load inside the admin without asking for a token.
4. Standalone check: open the Render URL directly — the ADMIN_TOKEN modal
   still gates the dashboard.

## Troubleshooting

- **Blank iframe / refused to connect** → the CSP `frame-ancestors` header is
  missing (check that the URL Shopify loads includes `?shop=`/`?host=`), or App
  URL mismatch in the Dev Dashboard.
- **401s inside the admin** → `SHOPIFY_CLIENT_SECRET` on the server doesn't
  match the app the store installed, or the server clock is skewed by more
  than ~10s.
- **Token modal appears inside the admin** → `GET /api/public/embedded-config`
  returned `embeddedEnabled: false` (client id/secret not set on the server).
