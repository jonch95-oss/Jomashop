// Jomashop Vendor API client. Handles JWT lifecycle (login, refresh, 401 retry).
// Tokens live in-memory only; nothing is persisted to disk.

import { FALLBACK_CATEGORY_SCHEMAS, type SupportedCategory } from "@shared/schema";

type JomashopConfig = {
  baseUrl: string;
  email: string;
  password: string;
};

type TokenState = {
  jwt: string;
  // Expiry: tokens last 5 days. We refresh slightly before.
  expiresAt: number;
};

let token: TokenState | null = null;
let refreshInFlight: Promise<void> | null = null;

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const REFRESH_LEEWAY_MS = 6 * 60 * 60 * 1000; // refresh 6h early

export function getJomashopConfig(): JomashopConfig | null {
  const baseUrl = process.env.JOMASHOP_API_BASE_URL || "https://api.vendor.jomashop.com";
  const email = process.env.JOMASHOP_EMAIL;
  const password = process.env.JOMASHOP_PASSWORD;
  if (!email || !password) return null;
  return { baseUrl, email, password };
}

export function jomashopConfigured(): boolean {
  return getJomashopConfig() !== null;
}

export function currentToken(): TokenState | null {
  return token;
}

export function clearToken(): void {
  token = null;
}

async function loginInternal(cfg: JomashopConfig): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: { email: cfg.email, password: cfg.password } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jomashop login failed (${res.status}): ${text || res.statusText}`);
  }
  // JWT is returned in the Authorization response header.
  const auth = res.headers.get("authorization") || res.headers.get("Authorization");
  if (!auth) {
    throw new Error("Jomashop login: missing Authorization response header");
  }
  const jwt = auth.replace(/^Bearer\s+/i, "").trim();
  token = { jwt, expiresAt: Date.now() + FIVE_DAYS_MS };
}

async function refreshInternal(cfg: JomashopConfig): Promise<void> {
  if (!token) return loginInternal(cfg);
  const res = await fetch(`${cfg.baseUrl}/v1/session`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token.jwt}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401) {
    // Refresh failed, do a full login.
    token = null;
    return loginInternal(cfg);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jomashop refresh failed (${res.status}): ${text || res.statusText}`);
  }
  const auth = res.headers.get("authorization") || res.headers.get("Authorization");
  if (auth) {
    const jwt = auth.replace(/^Bearer\s+/i, "").trim();
    token = { jwt, expiresAt: Date.now() + FIVE_DAYS_MS };
  } else {
    // Some refresh endpoints keep the same token; just extend expiry.
    token = { ...token, expiresAt: Date.now() + FIVE_DAYS_MS };
  }
}

async function ensureToken(cfg: JomashopConfig): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  if (!token) {
    refreshInFlight = loginInternal(cfg).finally(() => (refreshInFlight = null));
    return refreshInFlight;
  }
  if (Date.now() > token.expiresAt - REFRESH_LEEWAY_MS) {
    refreshInFlight = refreshInternal(cfg).finally(() => (refreshInFlight = null));
    return refreshInFlight;
  }
}

export type JomashopRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // e.g. "/v1/products"
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export async function jomashopRequest<T = unknown>(
  opts: JomashopRequestOptions,
): Promise<{ ok: boolean; status: number; data?: T; error?: string; errorData?: unknown }> {
  const cfg = getJomashopConfig();
  if (!cfg) {
    return { ok: false, status: 0, error: "Jomashop credentials not configured" };
  }
  try {
    await ensureToken(cfg);
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }

  const url = new URL(cfg.baseUrl + opts.path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const doFetch = async (): Promise<Response> =>
    fetch(url.toString(), {
      method: opts.method || "GET",
      headers: {
        Authorization: `Bearer ${token!.jwt}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

  let res: Response;
  try {
    res = await doFetch();
    if (res.status === 401) {
      // Token expired or revoked. Re-login once and retry.
      token = null;
      await ensureToken(cfg);
      res = await doFetch();
    }
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }

  let data: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text as unknown;
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof data === "object" ? JSON.stringify(data) : String(data || res.statusText),
      errorData: data,
    };
  }
  return { ok: true, status: res.status, data: data as T };
}

// ---------- Categories ----------
export async function getCategories(): Promise<
  { ok: true; data: unknown } | { ok: false; status: number; error: string }
> {
  const result = await jomashopRequest({ path: "/v1/categories" });
  if (result.ok) return { ok: true, data: result.data };
  return { ok: false, status: result.status, error: result.error || "Unknown error" };
}

export async function getCategorySchema(name: string) {
  return jomashopRequest({ path: `/v1/categories/${encodeURIComponent(name)}` });
}

// Helper that the mapping preview uses: it tries to fetch a live schema
// but falls back to the bundled one if the API is unavailable.
export async function resolveCategorySchema(category: SupportedCategory) {
  const live = await getCategorySchema(category);
  if (live.ok && live.data) {
    return { source: "live" as const, schema: live.data };
  }
  return {
    source: "fallback" as const,
    schema: { name: category, properties: FALLBACK_CATEGORY_SCHEMAS[category] },
  };
}
