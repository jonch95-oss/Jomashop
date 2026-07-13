// Embedded Shopify admin (App Bridge) bootstrap.
//
// When the dashboard is loaded inside the Shopify admin iframe, Shopify
// appends ?host=...&shop=...&embedded=1 to the App URL. We detect that,
// lazily load App Bridge from the Shopify CDN (keyed by the app's public
// client id, fetched from /api/public/embedded-config), and then attach a
// fresh session token (window.shopify.idToken()) to every API request in
// place of the manual ADMIN_TOKEN.
//
// Standalone (Render) mode is untouched: none of this activates without the
// Shopify iframe query params, and the ADMIN_TOKEN header remains the
// fallback everywhere.

declare global {
  interface Window {
    shopify?: {
      idToken?: () => Promise<string>;
      config?: unknown;
      environment?: unknown;
    };
  }
}

let initPromise: Promise<boolean> | null = null;
let embeddedActive = false;

// Most recently minted session token. Session tokens live ~60s; a 30s
// refresh loop keeps this cache fresh so SYNCHRONOUS call sites (the many
// existing `fetch(url, { headers: authHeaders() })` spots) can attach a
// valid token without being rewritten to async.
let cachedToken: string | null = null;
let refreshTimer: number | null = null;

async function refreshCachedToken(): Promise<void> {
  if (!embeddedActive || typeof window.shopify?.idToken !== "function") return;
  try {
    cachedToken = await window.shopify.idToken();
  } catch {
    // keep the previous token; the next tick will retry
  }
}

/** Cached session token for synchronous header builders. Null standalone. */
export function getCachedEmbeddedToken(): string | null {
  return embeddedActive ? cachedToken : null;
}

export function getEmbeddedParams(): { host: string | null; shop: string | null; embedded: string | null } {
  try {
    const p = new URLSearchParams(window.location.search);
    return { host: p.get("host"), shop: p.get("shop"), embedded: p.get("embedded") };
  } catch {
    return { host: null, shop: null, embedded: null };
  }
}

/**
 * Cheap synchronous check: does this page LOOK like it was loaded by the
 * Shopify admin? True when the App Bridge `host` param is present (Shopify
 * always sends it) — we also accept embedded=1 for manual testing.
 */
export function isEmbeddedCandidate(): boolean {
  const { host, embedded } = getEmbeddedParams();
  if (host) return true;
  if (embedded === "1") {
    try {
      return window.top !== window.self;
    } catch {
      return true; // cross-origin frame access throws → we ARE framed
    }
  }
  return false;
}

/** True once App Bridge has loaded and can mint session tokens. */
export function isEmbeddedActive(): boolean {
  return embeddedActive;
}

function loadAppBridgeScript(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.shopify && typeof window.shopify.idToken === "function") {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src^="https://cdn.shopify.com/shopifycloud/app-bridge.js"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("App Bridge failed to load")));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
    s.setAttribute("data-api-key", apiKey);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("App Bridge failed to load"));
    document.head.appendChild(s);
  });
}

/**
 * Initialize embedded mode. Idempotent — the first caller kicks it off and
 * everyone else awaits the same promise. Resolves true when App Bridge is
 * ready to mint session tokens, false in standalone mode or on any failure
 * (callers then fall back to ADMIN_TOKEN auth).
 */
export function initEmbedded(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isEmbeddedCandidate()) return false;
    try {
      const res = await fetch("/api/public/embedded-config");
      if (!res.ok) return false;
      const cfg = (await res.json()) as { embeddedEnabled?: boolean; apiKey?: string };
      if (!cfg?.embeddedEnabled || !cfg?.apiKey) return false;
      await loadAppBridgeScript(cfg.apiKey);
      embeddedActive = typeof window.shopify?.idToken === "function";
      if (embeddedActive) {
        await refreshCachedToken();
        if (refreshTimer === null) {
          refreshTimer = window.setInterval(refreshCachedToken, 30_000);
        }
      }
      return embeddedActive;
    } catch {
      return false;
    }
  })();
  return initPromise;
}

/**
 * Return an Authorization header carrying a fresh Shopify session token, or
 * null when not embedded / App Bridge unavailable. Session tokens expire
 * after ~60s, so we fetch one per request rather than caching.
 */
export async function getEmbeddedAuthHeader(): Promise<Record<string, string> | null> {
  if (!isEmbeddedCandidate()) return null;
  const ready = await initEmbedded();
  if (!ready || typeof window.shopify?.idToken !== "function") return null;
  try {
    const token = await window.shopify.idToken();
    return token ? { Authorization: `Bearer ${token}` } : null;
  } catch {
    return null;
  }
}
