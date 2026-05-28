// Jomashop Vendor API client. Handles JWT lifecycle (login, refresh, 401 retry).
// Tokens live in-memory only; nothing is persisted to disk.

import {
  FALLBACK_CATEGORY_SCHEMAS,
  canonicalJomashopCategory,
  type SupportedCategory,
} from "@shared/schema";
import { normalizeV1CategorySchema, type SchemaPropertyDescriptor } from "./mapping";

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
  const res = await fetch(`${cfg.baseUrl}/v1/sessions`, {
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
  const res = await fetch(`${cfg.baseUrl}/v1/sessions`, {
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

// Module-level cache for /v1/categories/:name responses. Same TTL as the /i1
// caches so a single push cycle reuses the schema instead of re-fetching.
const V1_SCHEMA_TTL_MS = 5 * 60 * 1000;
type V1SchemaCacheEntry = {
  fetchedAt: number;
  /** Normalized descriptors. Empty array signals "v1 returned data but it
   *  didn't carry recognizable properties" — distinct from null which means
   *  "v1 fetch failed entirely". */
  descriptors: SchemaPropertyDescriptor[];
  raw: unknown;
};
const v1SchemaCache = new Map<string, V1SchemaCacheEntry>();
const v1SchemaErrorCache = new Map<string, { fetchedAt: number; error: string; status: number }>();

export function clearV1SchemaCache(): void {
  v1SchemaCache.clear();
  v1SchemaErrorCache.clear();
}

/**
 * Fetch and normalize the live /v1/categories/:name schema. Returns the
 * normalized descriptor list (with verified enum options from `data.values`)
 * plus the raw payload for debug surfaces. Returns null when the fetch
 * failed or the response shape isn't recognizable as v1 properties — the
 * caller is expected to fall back to /i1 or the bundled schema.
 *
 * Cached for 5 minutes per category name. Failures cached too so a degraded
 * Jomashop API doesn't burn one round-trip per product in a 3,000-product
 * preview build.
 */
export async function getV1CategoryDescriptors(
  category: string,
  opts: { refresh?: boolean } = {},
): Promise<
  | { ok: true; descriptors: SchemaPropertyDescriptor[]; raw: unknown; fromCache: boolean }
  | { ok: false; status: number; error: string; fromCache: boolean }
> {
  const rawKey = String(category).trim();
  if (!rawKey) return { ok: false, status: 0, error: "Missing category name", fromCache: false };
  // Normalize legacy aliases (Clothing→Apparel, Shoes→Footwear). Jomashop's
  // live v1 endpoint only knows canonical names; without this, push and
  // preflight fall back to the bundled (unverified-options) schema even when
  // the live Apparel schema is reachable.
  const key = canonicalJomashopCategory(rawKey);
  if (!opts.refresh) {
    const cached = v1SchemaCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < V1_SCHEMA_TTL_MS) {
      return { ok: true, descriptors: cached.descriptors, raw: cached.raw, fromCache: true };
    }
    const cachedErr = v1SchemaErrorCache.get(key);
    if (cachedErr && Date.now() - cachedErr.fetchedAt < V1_SCHEMA_TTL_MS) {
      return { ok: false, status: cachedErr.status, error: cachedErr.error, fromCache: true };
    }
  }
  const live = await getCategorySchema(key);
  if (!live.ok || !live.data) {
    const error = live.error || `HTTP ${live.status}`;
    v1SchemaErrorCache.set(key, { fetchedAt: Date.now(), error, status: live.status });
    return { ok: false, status: live.status, error, fromCache: false };
  }
  const descriptors = normalizeV1CategorySchema(live.data);
  v1SchemaCache.set(key, { fetchedAt: Date.now(), descriptors, raw: live.data });
  return { ok: true, descriptors, raw: live.data, fromCache: false };
}

// Helper that the mapping preview uses: prefer the live /v1/categories/:name
// schema (verified by Jomashop — `data.values` carries the exact accepted
// enum options) over the bundled fallback for every supported category.
// Only falls back when v1 is unreachable OR its payload doesn't carry
// usable Title Case property labels.
export async function resolveCategorySchema(category: SupportedCategory) {
  // Always lift to the canonical Jomashop name (Clothing→Apparel) so the
  // bundled fallback we compare against is the one whose Article options
  // are NOT marked options_unverified, and so live v1 lookups hit the name
  // Jomashop actually publishes.
  const canonical = canonicalJomashopCategory(category) as SupportedCategory;
  const bundled =
    FALLBACK_CATEGORY_SCHEMAS[canonical] ?? FALLBACK_CATEGORY_SCHEMAS[category];
  const bundledIsExact =
    Array.isArray(bundled) &&
    bundled.length > 0 &&
    bundled.every((p) => /[A-Z]/.test(p.field) || /\s/.test(p.field));
  const v1 = await getV1CategoryDescriptors(canonical);
  if (v1.ok && v1.descriptors.length > 0) {
    const liveHasExactLabels = v1.descriptors.some(
      (p) => typeof p.field === "string" && (/[A-Z]/.test(p.field) || /\s/.test(p.field)),
    );
    if (liveHasExactLabels || !bundledIsExact) {
      return {
        source: "live" as const,
        schema: { name: category, properties: v1.descriptors },
      };
    }
  }
  // Legacy v1 shape (rare): the API responded with a `properties` array but
  // the new v1 normalizer didn't recognize it. Try the older /i1-style
  // normalization for backwards compatibility — same `live.data` from before.
  if (v1.ok && v1.descriptors.length === 0) {
    const props = (v1.raw as { properties?: Array<{ field: string }> } | undefined)?.properties;
    const liveHasExactLabels =
      Array.isArray(props) &&
      props.length > 0 &&
      props.some((p) => p && typeof p.field === "string" && (/[A-Z]/.test(p.field) || /\s/.test(p.field)));
    if (liveHasExactLabels || !bundledIsExact) {
      return { source: "live" as const, schema: v1.raw };
    }
  }
  return {
    source: "fallback" as const,
    schema: { name: category, properties: bundled },
  };
}

// ---------- /i1 endpoints (portal-style: id-based manufacturers/categories) ----------

/**
 * Normalized record returned by the /i1/manufacturers list endpoint. Real
 * payload shape varies across portal builds (sometimes wrapped in
 * `{ manufacturers: [...] }`, sometimes a bare array, sometimes
 * `{ data: [...] }`). This type captures the only two fields we care about.
 */
export type JomashopManufacturer = {
  id: number | string;
  name: string;
  /** Original record, for surfacing in UI debug panels. */
  raw?: unknown;
};

export type JomashopCategoryRecord = {
  id: number | string;
  name: string;
  raw?: unknown;
};

// Module-level cache so we don't paginate /i1/manufacturers on every push.
// Refreshed lazily after CACHE_TTL_MS or on explicit invalidation.
const I1_CACHE_TTL_MS = 5 * 60 * 1000;
type I1Cache<T> = { fetchedAt: number; items: T[] } | null;
let manufacturersCache: I1Cache<JomashopManufacturer> = null;
let categoriesI1Cache: I1Cache<JomashopCategoryRecord> = null;

function isCacheFresh<T>(cache: I1Cache<T>): cache is { fetchedAt: number; items: T[] } {
  return Boolean(cache && Date.now() - cache.fetchedAt < I1_CACHE_TTL_MS);
}

export function clearI1Cache(): void {
  manufacturersCache = null;
  categoriesI1Cache = null;
}

/**
 * Pluck `[{id, name, ...}]`-shaped records out of whatever the /i1 endpoints
 * return. Handles bare arrays, `{ data: [...] }`, `{ manufacturers: [...] }`,
 * `{ categories: [...] }`, and `{ items: [...] }`.
 */
function extractRecords(raw: unknown, listKeys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of listKeys) {
      const v = obj[key];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
    if (Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>;
  }
  return [];
}

function normalizeManufacturerRecord(rec: Record<string, unknown>): JomashopManufacturer | null {
  const id = rec.id ?? (rec as { manufacturer_id?: unknown }).manufacturer_id;
  const name =
    (rec as { name?: unknown }).name ??
    (rec as { manufacturer?: unknown }).manufacturer ??
    (rec as { title?: unknown }).title;
  if (id === undefined || id === null) return null;
  if (typeof name !== "string" || name.trim() === "") return null;
  return { id: id as number | string, name: name.trim(), raw: rec };
}

function normalizeCategoryRecord(rec: Record<string, unknown>): JomashopCategoryRecord | null {
  const id = rec.id ?? (rec as { category_id?: unknown }).category_id;
  const name =
    (rec as { name?: unknown }).name ??
    (rec as { title?: unknown }).title ??
    (rec as { label?: unknown }).label;
  if (id === undefined || id === null) return null;
  if (typeof name !== "string" || name.trim() === "") return null;
  return { id: id as number | string, name: name.trim(), raw: rec };
}

/**
 * Fetch the full manufacturer list from /i1/manufacturers. The portal JS uses
 * `per_page=99999` to one-shot the full list, which keeps client code simple
 * (no pagination loop). We mirror that and cache the result for 5 minutes.
 *
 * Returns the normalized record list plus the raw response so callers can
 * dump it into UI debug panels. Force a refresh by passing `{ refresh: true }`.
 */
export async function getManufacturers(
  opts: { refresh?: boolean } = {},
): Promise<
  | { ok: true; items: JomashopManufacturer[]; fromCache: boolean }
  | { ok: false; status: number; error: string }
> {
  if (!opts.refresh && isCacheFresh(manufacturersCache)) {
    return { ok: true, items: manufacturersCache.items, fromCache: true };
  }
  const result = await jomashopRequest<unknown>({
    path: "/i1/manufacturers",
    query: { per_page: "99999" },
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error || "Unknown error" };
  const records = extractRecords(result.data, ["manufacturers", "items"]);
  const items: JomashopManufacturer[] = [];
  for (const rec of records) {
    const norm = normalizeManufacturerRecord(rec);
    if (norm) items.push(norm);
  }
  manufacturersCache = { fetchedAt: Date.now(), items };
  return { ok: true, items, fromCache: false };
}

/**
 * Fetch the full category list from /i1/categories. Same caching contract as
 * getManufacturers.
 */
export async function getCategoriesI1(
  opts: { refresh?: boolean } = {},
): Promise<
  | { ok: true; items: JomashopCategoryRecord[]; fromCache: boolean }
  | { ok: false; status: number; error: string }
> {
  if (!opts.refresh && isCacheFresh(categoriesI1Cache)) {
    return { ok: true, items: categoriesI1Cache.items, fromCache: true };
  }
  const result = await jomashopRequest<unknown>({
    path: "/i1/categories",
    query: { per_page: "9999" },
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error || "Unknown error" };
  const records = extractRecords(result.data, ["categories", "items"]);
  const items: JomashopCategoryRecord[] = [];
  for (const rec of records) {
    const norm = normalizeCategoryRecord(rec);
    if (norm) items.push(norm);
  }
  categoriesI1Cache = { fetchedAt: Date.now(), items };
  return { ok: true, items, fromCache: false };
}

/**
 * Fetch the property schema for a specific Jomashop category by id. Used to
 * resolve the live attribute list (color, size, material, ...) that the push
 * payload's `properties` block needs to populate.
 */
export async function getCategoryPropertiesI1(categoryId: number | string) {
  return jomashopRequest<unknown>({ path: `/i1/categories/${encodeURIComponent(String(categoryId))}` });
}

// ---------- Brand/category resolution helpers ----------

/**
 * Canonical key used to compare brand strings ignoring case and punctuation.
 * Identical to normalizeBrandKey in brand_mapping but inlined here to avoid a
 * circular import — the resolver lives in the API client layer.
 */
function brandLookupKey(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

/** Levenshtein distance — small implementation for fuzzy "did you mean" matches. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev;
      else dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

export type ManufacturerResolution = {
  /** Exact match against the live manufacturer list (after normalization). */
  exact: JomashopManufacturer | null;
  /**
   * Best fuzzy suggestion if no exact match found. Same normalization
   * compares "Tods" vs "Tod's" as equal; this surfaces close-but-not-equal
   * suggestions (e.g. "Tods" → "Tod's" via apostrophe-stripping comparison).
   */
  suggestion: JomashopManufacturer | null;
  suggestionDistance: number | null;
  /** All manufacturers whose normalized prefix matches the query, capped at 5. */
  prefixMatches: JomashopManufacturer[];
};

export type CategoryResolution = {
  exact: JomashopCategoryRecord | null;
  suggestion: JomashopCategoryRecord | null;
  suggestionDistance: number | null;
};

/**
 * Resolve a Shopify-side brand name to the live Jomashop manufacturer record.
 *
 *   - Exact normalized match wins ("Tods" matches "Tod's" because both
 *     normalize to "tods").
 *   - When no exact match exists, the closest manufacturer by Levenshtein
 *     distance on the normalized form is returned as `suggestion` so the UI
 *     can render "Brand 'Tods' not found — did you mean 'Tod's'?".
 *   - Prefix matches surface a short pick-list for the operator.
 */
export async function resolveManufacturer(
  brand: string | null | undefined,
): Promise<
  | ({ ok: true; configured: true } & ManufacturerResolution)
  | { ok: true; configured: false; reason: string }
  | { ok: false; status: number; error: string }
> {
  if (!jomashopConfigured()) {
    return { ok: true, configured: false, reason: "Jomashop credentials not configured" };
  }
  const result = await getManufacturers();
  if (!result.ok) return result;
  const norm = brandLookupKey(brand);
  if (!norm) {
    return {
      ok: true,
      configured: true,
      exact: null,
      suggestion: null,
      suggestionDistance: null,
      prefixMatches: [],
    };
  }
  let exact: JomashopManufacturer | null = null;
  let suggestion: JomashopManufacturer | null = null;
  let bestDist = Infinity;
  const prefixMatches: JomashopManufacturer[] = [];
  for (const m of result.items) {
    const k = brandLookupKey(m.name);
    if (!k) continue;
    if (k === norm) {
      // Prefer the manufacturer whose raw name is closest to the input
      // (handles two records that normalize identically — rare but possible).
      if (!exact || m.name.length <= exact.name.length) exact = m;
      continue;
    }
    if (k.startsWith(norm) || norm.startsWith(k)) {
      if (prefixMatches.length < 5) prefixMatches.push(m);
    }
    const d = editDistance(k, norm);
    if (d < bestDist) {
      bestDist = d;
      suggestion = m;
    }
  }
  // Only surface a suggestion when reasonably close (≤2 edits or ≤25% of length).
  const maxAllowed = Math.max(2, Math.ceil(norm.length * 0.25));
  if (!exact && suggestion && bestDist > maxAllowed) {
    suggestion = null;
    bestDist = Infinity;
  }
  return {
    ok: true,
    configured: true,
    exact,
    suggestion,
    suggestionDistance: suggestion ? bestDist : null,
    prefixMatches,
  };
}

/**
 * Resolve a category name (e.g. "Footwear", "Boots", "Clothing") to the live
 * Jomashop category record. Same matching rules as resolveManufacturer.
 */
export async function resolveCategoryRecord(
  category: string | null | undefined,
): Promise<
  | ({ ok: true; configured: true } & CategoryResolution)
  | { ok: true; configured: false; reason: string }
  | { ok: false; status: number; error: string }
> {
  if (!jomashopConfigured()) {
    return { ok: true, configured: false, reason: "Jomashop credentials not configured" };
  }
  const result = await getCategoriesI1();
  if (!result.ok) return result;
  const norm = brandLookupKey(category);
  if (!norm) {
    return { ok: true, configured: true, exact: null, suggestion: null, suggestionDistance: null };
  }
  let exact: JomashopCategoryRecord | null = null;
  let suggestion: JomashopCategoryRecord | null = null;
  let bestDist = Infinity;
  for (const c of result.items) {
    const k = brandLookupKey(c.name);
    if (!k) continue;
    if (k === norm) {
      if (!exact || c.name.length <= exact.name.length) exact = c;
      continue;
    }
    const d = editDistance(k, norm);
    if (d < bestDist) {
      bestDist = d;
      suggestion = c;
    }
  }
  const maxAllowed = Math.max(2, Math.ceil(norm.length * 0.25));
  if (!exact && suggestion && bestDist > maxAllowed) {
    suggestion = null;
    bestDist = Infinity;
  }
  return {
    ok: true,
    configured: true,
    exact,
    suggestion,
    suggestionDistance: suggestion ? bestDist : null,
  };
}

/**
 * Create a manufacturer record on Jomashop. This is gated by the UI: the
 * operator must explicitly confirm because pushing the wrong brand name into
 * the global Jomashop catalog is hard to undo. Returns the same shape as
 * jomashopRequest so callers can branch on `ok`.
 */
export async function createManufacturer(
  name: string,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string; errorData?: unknown }> {
  clearI1Cache();
  return jomashopRequest({
    method: "POST",
    path: "/i1/manufacturers",
    body: { manufacturer: { name } },
  });
}
