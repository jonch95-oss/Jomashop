// Shopify embedded-app session token verification.
//
// When the dashboard is loaded inside the Shopify admin iframe, App Bridge
// attaches a short-lived JWT ("session token") to every API request:
//   Authorization: Bearer <jwt>
// The token is signed HS256 with the app's client secret. Verifying it
// server-side lets embedded requests through WITHOUT the manual ADMIN_TOKEN,
// while standalone (Render) mode keeps the existing ADMIN_TOKEN gate.
//
// No new dependencies: verification is plain node:crypto HMAC + JSON.
// Reference: https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens

import crypto from "node:crypto";

export type SessionTokenCheck =
  | { ok: true; shop: string; subject: string | null }
  | { ok: false; reason: string };

/** Allowed clock skew (seconds) when checking exp/nbf. */
const CLOCK_SKEW_S = 10;

function b64urlToBuffer(segment: string): Buffer | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  const buf = b64urlToBuffer(segment);
  if (!buf) return null;
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract "myshop.myshopify.com" from a dest/iss URL-ish claim. */
function shopFromClaim(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const m = value.match(/^https:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)/i);
  return m ? m[1].toLowerCase() : null;
}

/** True when embedded session auth is configured (client id + secret set). */
export function embeddedAuthConfigured(): boolean {
  return Boolean(
    process.env.SHOPIFY_CLIENT_ID?.trim() && process.env.SHOPIFY_CLIENT_SECRET?.trim(),
  );
}

/**
 * Verify a Shopify App Bridge session token.
 *
 * Checks, in order:
 *  - client id + secret are configured;
 *  - JWT structure and HS256 algorithm (no alg-confusion downgrade);
 *  - HMAC-SHA256 signature against SHOPIFY_CLIENT_SECRET (timing-safe);
 *  - exp / nbf freshness (small skew allowance);
 *  - aud matches SHOPIFY_CLIENT_ID;
 *  - dest is a *.myshopify.com shop URL.
 */
export function verifyShopifySessionToken(token: string | null | undefined): SessionTokenCheck {
  const secret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  const apiKey = process.env.SHOPIFY_CLIENT_ID?.trim();
  if (!secret || !apiKey) {
    return { ok: false, reason: "SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not configured" };
  }
  if (!token || typeof token !== "string") return { ok: false, reason: "No token supplied" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "Not a JWT" };
  const [headerSeg, payloadSeg, sigSeg] = parts;

  const header = parseJsonSegment(headerSeg);
  if (!header) return { ok: false, reason: "Unparseable JWT header" };
  if (header.alg !== "HS256") return { ok: false, reason: `Unsupported alg ${String(header.alg)}` };

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerSeg}.${payloadSeg}`)
    .digest();
  const actualSig = b64urlToBuffer(sigSeg);
  if (!actualSig || actualSig.length !== expectedSig.length) {
    return { ok: false, reason: "Bad signature encoding" };
  }
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: "Signature mismatch" };
  }

  const payload = parseJsonSegment(payloadSeg);
  if (!payload) return { ok: false, reason: "Unparseable JWT payload" };

  const nowS = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : 0;
  if (!exp || exp < nowS - CLOCK_SKEW_S) return { ok: false, reason: "Token expired" };
  if (nbf && nbf > nowS + CLOCK_SKEW_S) return { ok: false, reason: "Token not yet valid" };

  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(apiKey) : aud === apiKey;
  if (!audOk) return { ok: false, reason: "aud does not match SHOPIFY_CLIENT_ID" };

  const shop = shopFromClaim(payload.dest) ?? shopFromClaim(payload.iss);
  if (!shop) return { ok: false, reason: "dest/iss is not a myshopify.com shop" };

  const subject = typeof payload.sub === "string" ? payload.sub : null;
  return { ok: true, shop, subject };
}

/** Pull the bearer value out of an Authorization header, if present. */
export function bearerFromAuthorization(header: string | undefined): string | null {
  if (!header || typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const v = header.slice("Bearer ".length).trim();
  return v || null;
}

/** Heuristic: bearer values with two dots are JWT-shaped (session tokens). */
export function looksLikeJwt(bearer: string | null): boolean {
  return Boolean(bearer && bearer.split(".").length === 3);
}

/**
 * Inject the Shopify App Bridge script into an index.html payload for
 * embedded requests.
 *
 * App Bridge v4 HARD-REQUIRES being a static, non-async, non-module script
 * loaded from Shopify's CDN as the FIRST <script> tag — dynamically injected
 * script tags abort with "must be included as the first <script> tag".
 * So the server splices the tag into the HTML right after <head> (before the
 * app bundle) — but ONLY when the request carries Shopify's embedded params
 * (host/embedded/shop). Standalone (Render) page loads get untouched HTML
 * and never load App Bridge.
 */
export function injectAppBridgeScript(html: string, query: Record<string, unknown>): string {
  const apiKey = process.env.SHOPIFY_CLIENT_ID?.trim();
  if (!apiKey) return html;
  const hasEmbedHint =
    typeof query.host === "string" ||
    typeof query.embedded === "string" ||
    typeof query.shop === "string";
  if (!hasEmbedHint) return html;
  if (html.includes("shopifycloud/app-bridge.js")) return html;
  const tag = `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>`;
  const headIdx = html.search(/<head[^>]*>/i);
  if (headIdx === -1) return html;
  const headEnd = html.indexOf(">", headIdx) + 1;
  return html.slice(0, headEnd) + "\n    " + tag + html.slice(headEnd);
}
