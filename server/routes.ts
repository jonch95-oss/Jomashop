import type { Express } from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { storage } from "./storage";
import {
  getJomashopConfig,
  jomashopConfigured,
  jomashopRequest,
  getCategories,
  resolveCategorySchema,
  clearToken,
  currentToken,
  getManufacturers,
  getCategoriesI1,
  getCategoryPropertiesI1,
  resolveManufacturer,
  resolveCategoryRecord,
  createManufacturer,
  clearI1Cache,
  clearV1SchemaCache,
  getV1CategoryDescriptors,
} from "./jomashop";
import {
  FALLBACK_CATEGORY_SCHEMAS,
  SUPPORTED_CATEGORIES,
  canonicalJomashopCategory,
  type SupportedCategory,
} from "@shared/schema";
import {
  mapShopifyToJomashop,
  buildJomashopProductPayload,
  buildI1ProductEnvelope,
  isSampleProduct,
  normalizeCategoryCode,
  normalizeI1CategorySchema,
  SAMPLE_SHOPIFY_PRODUCTS,
  type PushOverrides,
  type ShopifyProduct,
  type SchemaPropertyDescriptor,
} from "./mapping";
import {
  encryptToken,
  fetchShopifyProductImages,
  fetchShopifyProducts,
  getActiveShopifyConnection,
  MAPPER_VERSION,
} from "./shopify";
import { registerBulkRepairRoutes } from "./bulk_repair";
import { registerCategoryMappingRoutes, lookupCategoryOverride } from "./category_mapping";
import { registerBrandMappingRoutes, lookupBrandOverride, normalizeBrandKey } from "./brand_mapping";
import {
  registerEnumMappingRoutes,
  lookupEnumOverride,
  normalizeEnumSourceValue,
  normalizeEnumCategoryKey,
  normalizeEnumFieldKey,
  BUILT_IN_ENUM_OVERRIDES,
  listBuiltInSeeds,
} from "./enum_mapping";
import { registerResolutionAuditRoutes } from "./resolution_audit";
import { registerJomashopMappingExcelRoutes } from "./jomashop_mapping_excel";
import {
  productFieldSessionStats,
  registerJomashopProductFieldExcelRoutes,
} from "./jomashop_product_field_excel";
import { registerInlineFieldRepairRoutes } from "./inline_field_repair";
import { pushInventoryUpdate, registerWebhookRoutes, registerShopifyWebhooks } from "./webhooks";
import { heapMb, logMemory, rssMb } from "./memlog";
import { lockStatus, releaseLock, withLockOr409 } from "./stability";
import { compactifyMapped, type CompactMappedProduct } from "./compact_mapped";

// -------------------- helpers --------------------

// Server-side caps for product list endpoints. These keep responses small
// enough to render in the operator UI without ever shipping the full 3000+
// item array over the wire (which is what was driving the Render OOM during
// initial cache load). Heavy per-product detail (raw metafields, full image
// list, debug echo) is moved behind /api/products/full/:id so a list view
// only ever ships the compact projection.
const DEFAULT_LIST_LIMIT = 200;
// Raised from 500 → 5000 so ?limit=all on /api/products/cache returns the
// full cached catalog for shops with thousands of products. The cache stores
// "compact" rows (no debug payloads, no image arrays), so a 3000+ product
// store fits comfortably in a single JSON response. Operators on multi-
// thousand stores can still keep the default 200/page if they prefer.
const MAX_LIST_LIMIT = 5000;

function clampLimit(raw: unknown, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const s = String(raw).toLowerCase();
  if (s === "all") return max;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 1), max);
}

function clampOffset(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Build a vendor-sku → live push-status overlay so cached rows reflect the
 * latest push state without requiring a full /api/products/refresh. The push
 * handler upserts into the push_statuses table on every success/failure;
 * this lets the cache fast-path surface "pushed" / "rejected" as soon as
 * the next list fetch happens.
 */
function buildPushStatusOverlay(shopDomain: string | null): Map<
  string,
  {
    state: string;
    jomashopSku: string | null;
    lastError: string | null;
    lastPushedAt: number | null;
    lastInvalidParams: string[] | null;
    lastRejectedCategory: string | null;
    lastRejectedBrand: string | null;
  }
> {
  const overlay = new Map<
    string,
    {
      state: string;
      jomashopSku: string | null;
      lastError: string | null;
      lastPushedAt: number | null;
      lastInvalidParams: string[] | null;
      lastRejectedCategory: string | null;
      lastRejectedBrand: string | null;
    }
  >();
  for (const ps of storage.listPushStatuses(shopDomain ?? undefined)) {
    let invalidParams: string[] | null = null;
    if (ps.lastInvalidParams) {
      try {
        const parsed = JSON.parse(ps.lastInvalidParams);
        if (Array.isArray(parsed)) invalidParams = parsed.map(String);
      } catch {
        // ignore
      }
    }
    overlay.set(ps.shopifySku, {
      state: ps.state,
      jomashopSku: ps.jomashopSku,
      lastError: ps.lastError,
      lastPushedAt: ps.lastPushedAt,
      lastInvalidParams: invalidParams,
      lastRejectedCategory: ps.lastRejectedCategory,
      lastRejectedBrand: ps.lastRejectedBrand,
    });
  }
  return overlay;
}

/**
 * Slice + project a cache payload for transport. Always returns compact
 * mapped rows (never debug_raw / full metafields), and applies pagination so
 * we don't ship the full 3000-item list to a single client.
 *
 * Overlays the latest push_statuses table contents over the cached payload
 * so a freshly-pushed SKU moves to the "Pushed" group on the very next
 * fetch without needing a full Shopify refresh.
 */
function paginateCachePayload(
  payload: any,
  opts: { limit: number; offset: number; cachedAt: number | null; shopDomain: string | null },
): Record<string, unknown> {
  const allMapped: any[] = Array.isArray(payload?.mapped) ? payload.mapped : [];
  const totalCount = allMapped.length;
  const start = Math.min(opts.offset, totalCount);
  const end = Math.min(start + opts.limit, totalCount);
  const overlay = buildPushStatusOverlay(opts.shopDomain);
  const slice = allMapped
    .slice(start, end)
    .map((m) => {
      const compact = compactifyMapped(m);
      const live = overlay.get(compact.vendor_sku);
      if (!live) return compact;
      return {
        ...compact,
        push_state: live.state ?? compact.push_state,
        jomashop_sku: live.jomashopSku ?? compact.jomashop_sku,
        last_push_error: live.lastError ?? null,
        last_pushed_at: live.lastPushedAt ?? compact.last_pushed_at,
        last_invalid_params: live.lastInvalidParams ?? compact.last_invalid_params,
        last_rejected_category: live.lastRejectedCategory ?? compact.last_rejected_category,
        last_rejected_brand: live.lastRejectedBrand ?? compact.last_rejected_brand,
      };
    });
  return {
    mapperVersion: payload?.mapperVersion ?? null,
    schemas: payload?.schemas ?? null,
    mapped: slice,
    count: slice.length,
    totalCount,
    page: { offset: start, limit: opts.limit, hasMore: end < totalCount },
    usingSamples: Boolean(payload?.usingSamples),
    shopifyConnected: Boolean(payload?.shopifyConnected),
    dataSource: payload?.dataSource ?? "sample",
    shopDomain: payload?.shopDomain ?? opts.shopDomain,
    fetchedCount: payload?.fetchedCount ?? totalCount,
    pageCount: payload?.pageCount ?? 0,
    hasMore: payload?.hasMore ?? false,
    fallbackReason: payload?.fallbackReason ?? null,
    fetchError: payload?.fetchError ?? null,
    liveCategoryNames: payload?.liveCategoryNames ?? null,
    jomashopManufacturers: payload?.jomashopManufacturers ?? null,
    jomashopI1Categories: payload?.jomashopI1Categories ?? null,
    note: payload?.note ?? null,
    fromCache: true,
    lastRefreshedAt: opts.cachedAt,
  };
}

function envBool(key: string): boolean {
  return Boolean(process.env[key] && process.env[key]!.trim().length > 0);
}

function envValue(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v : undefined;
}

function appBaseUrl(req?: { protocol?: string; get?: (h: string) => string | undefined }): string {
  const fromEnv = envValue("APP_URL");
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (req?.get) {
    const host = req.get("host");
    const proto = (req.protocol || "https") as string;
    if (host) return `${proto}://${host}`;
  }
  return "http://localhost:5000";
}

function refreshCredentialStatus(): void {
  const now = Date.now();
  const keys = [
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
    "SHOPIFY_APP_URL",
    "SHOPIFY_SCOPES",
    "JOMASHOP_API_BASE_URL",
    "JOMASHOP_EMAIL",
    "JOMASHOP_PASSWORD",
    "APP_URL",
    "SESSION_SECRET",
  ];
  for (const k of keys) {
    storage.upsertCredentialStatus({
      key: k.toLowerCase(),
      source: envBool(k) ? "env" : "missing",
      configured: envBool(k),
      lastCheckedAt: now,
    });
  }
}

// In-memory OAuth state store (state → { createdAt, shop }). Replaces cookies/sessions
// for the scaffold. Persist to DB or signed JWT in production.
const oauthStates = new Map<string, { createdAt: number; shop: string }>();
const STATE_TTL_MS = 10 * 60 * 1000;

function newState(shop: string): string {
  // Periodic cleanup
  const now = Date.now();
  oauthStates.forEach((v, k) => {
    if (now - v.createdAt > STATE_TTL_MS) oauthStates.delete(k);
  });
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, { createdAt: now, shop });
  return state;
}

function consumeState(state: string): { ok: boolean; shop?: string } {
  const entry = oauthStates.get(state);
  if (!entry) return { ok: false };
  oauthStates.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return { ok: false };
  return { ok: true, shop: entry.shop };
}

/** Verify Shopify HMAC of query parameters (placeholder: requires SHOPIFY_CLIENT_SECRET). */
function verifyShopifyHmac(query: Record<string, string | string[] | undefined>): boolean {
  const secret = envValue("SHOPIFY_CLIENT_SECRET");
  if (!secret) return false;
  const { hmac, ...rest } = query;
  if (!hmac || typeof hmac !== "string") return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? (rest[k] as string[]).join(",") : rest[k]}`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

// -------------------- routes --------------------

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  refreshCredentialStatus();

  // ---------- Config status (never exposes raw secrets) ----------
  app.get("/api/config/status", (req, res) => {
    refreshCredentialStatus();
    const base = appBaseUrl(req);
    const scopes =
      envValue("SHOPIFY_SCOPES") ||
      "read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_locations,read_fulfillments,write_fulfillments,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders";

    res.json({
      app: {
        baseUrl: base,
        env: process.env.NODE_ENV || "development",
      },
      shopify: {
        clientIdConfigured: envBool("SHOPIFY_CLIENT_ID"),
        clientSecretConfigured: envBool("SHOPIFY_CLIENT_SECRET"),
        appUrlConfigured: envBool("SHOPIFY_APP_URL"),
        scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean),
        callbackUrl: `${base}/auth/shopify/callback`,
        startUrl: `${base}/auth/shopify/start`,
        embeddedAppPlaceholder: !envBool("SHOPIFY_APP_URL"),
      },
      jomashop: {
        baseUrl: envValue("JOMASHOP_API_BASE_URL") || "https://api.vendor.jomashop.com",
        emailConfigured: envBool("JOMASHOP_EMAIL"),
        passwordConfigured: envBool("JOMASHOP_PASSWORD"),
        sessionActive: Boolean(currentToken()),
      },
      credentialStatuses: storage.listCredentialStatuses(),
    });
  });

  // ---------- Diagnostics (admin-token protected; health stays public/lightweight) ----------
  app.get("/api/diagnostics/status", (_req, res) => {
    const stores = storage.listStores();
    const connectedStore = stores.find((s) => s.oauthStatus === "connected");
    const cache = connectedStore ? storage.getProductCache(connectedStore.shopDomain) : undefined;
    const locks = [
      "products.refresh",
      "productFieldExport",
      "productFieldSummary",
      "import.product-fields",
      "bulkRepair.export",
      "import.bulk-repair",
    ];
    res.json({
      ok: true,
      time: new Date().toISOString(),
      env: process.env.NODE_ENV || "development",
      memory: {
        rssMb: rssMb(),
        heapMb: heapMb(),
      },
      locks: locks.map((name) => ({ name, ...lockStatus(name) })),
      sessions: {
        productFields: productFieldSessionStats(),
      },
      shopify: {
        activeConnection: Boolean(getActiveShopifyConnection()),
        connectedStore: connectedStore?.shopDomain ?? null,
        storeCount: stores.length,
      },
      cache: cache
        ? {
            shopDomain: connectedStore?.shopDomain ?? null,
            fetchedCount: cache.fetchedCount,
            pageCount: cache.pageCount,
            hasMore: cache.hasMore,
            fetchedAt: cache.fetchedAt,
            payloadBytes: Buffer.byteLength(cache.payloadJson, "utf8"),
          }
        : null,
      jomashop: {
        configured: jomashopConfigured(),
        sessionActive: Boolean(currentToken()),
      },
    });
  });

  // ---------- Shopify OAuth ----------
  // /auth/shopify/start?shop=luxesupply.myshopify.com
  app.get("/auth/shopify/start", (req, res) => {
    const shop = String(req.query.shop || "herbiemissry.myshopify.com");
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
      return res.status(400).json({ error: "Invalid shop domain" });
    }
    const clientId = envValue("SHOPIFY_CLIENT_ID");
    if (!clientId) {
      return res.status(500).json({
        error:
          "SHOPIFY_CLIENT_ID not configured. Set it in .env, then restart the server.",
      });
    }
    const scopes =
      envValue("SHOPIFY_SCOPES") ||
      "read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_locations,read_fulfillments,write_fulfillments,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders";
    const redirectUri = `${appBaseUrl(req)}/auth/shopify/callback`;
    const state = newState(shop);

    // Record the in-progress store
    storage.upsertStore({
      shopDomain: shop,
      displayName: "LuxeSupply",
      oauthStatus: "pending",
      scopes,
      installedAt: null,
      tokenStorage: "env",
    });

    storage.appendLog({
      level: "info",
      message: `Shopify OAuth start for ${shop}`,
      detailsJson: JSON.stringify({ redirectUri }),
      createdAt: Date.now(),
    });

    const authUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&grant_options[]=`;
    res.redirect(authUrl);
  });

  app.get("/auth/shopify/callback", async (req, res) => {
    const { shop, code, state, hmac } = req.query as Record<string, string>;
    if (!shop || !code || !state || !hmac) {
      return res.status(400).send("Missing required Shopify OAuth params.");
    }
    const stateCheck = consumeState(state);
    if (!stateCheck.ok || stateCheck.shop !== shop) {
      storage.appendLog({
        level: "error",
        message: `OAuth state mismatch for ${shop}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      return res.status(400).send("OAuth state mismatch. Please retry the install.");
    }
    if (!verifyShopifyHmac(req.query as Record<string, string>)) {
      storage.appendLog({
        level: "error",
        message: `OAuth HMAC verification failed for ${shop}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      return res.status(400).send("HMAC verification failed.");
    }

    const clientId = envValue("SHOPIFY_CLIENT_ID");
    const clientSecret = envValue("SHOPIFY_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return res
        .status(500)
        .send("Server is missing Shopify client credentials. Set env vars and retry.");
    }

    // Exchange code for access token (scaffold — token NOT persisted to disk).
    try {
      const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        storage.appendLog({
          level: "error",
          message: `Shopify token exchange failed (${tokenRes.status}) for ${shop}`,
          detailsJson: JSON.stringify({ body: text }),
          createdAt: Date.now(),
        });
        return res.status(502).send("Shopify token exchange failed.");
      }
      const body = (await tokenRes.json()) as { access_token: string; scope: string };
      // Persist the access token encrypted at rest (AES-256-GCM keyed off
      // SESSION_SECRET) so the Products preview can query the Shopify Admin
      // API on subsequent requests. The plaintext token is never written to
      // disk and never leaves this process in a response body.
      const encrypted = encryptToken(body.access_token);
      storage.upsertStore({
        shopDomain: shop,
        displayName: "LuxeSupply",
        oauthStatus: "connected",
        scopes: body.scope,
        installedAt: Date.now(),
        tokenStorage: "db_encrypted",
        accessTokenEnc: encrypted,
      });
      storage.appendLog({
        level: "info",
        message: `Shopify OAuth completed for ${shop}`,
        detailsJson: JSON.stringify({ scopes: body.scope }),
        createdAt: Date.now(),
      });
      // Redirect back into the admin dashboard
      return res.redirect(`/#/setup?installed=${encodeURIComponent(shop)}`);
    } catch (err) {
      storage.appendLog({
        level: "error",
        message: `Shopify OAuth callback error: ${(err as Error).message}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      return res.status(500).send("OAuth callback error.");
    }
  });

  // ---------- Jomashop ----------
  app.get("/api/jomashop/session/test", async (_req, res) => {
    if (!jomashopConfigured()) {
      return res.json({
        configured: false,
        ok: false,
        message: "Set JOMASHOP_EMAIL and JOMASHOP_PASSWORD in .env to enable Jomashop login.",
      });
    }
    // Force a fresh login by clearing any cached token.
    clearToken();
    const cfg = getJomashopConfig()!;
    const startedAt = Date.now();
    const job = storage.createSyncJob({
      jobType: "session_test",
      status: "running",
      startedAt,
      finishedAt: null,
      totalItems: 1,
      successItems: 0,
      errorItems: 0,
      summary: null,
    });
    const result = await jomashopRequest({ path: "/v1/categories" });
    if (result.ok) {
      storage.updateSyncJob(job.id, {
        status: "success",
        finishedAt: Date.now(),
        successItems: 1,
        summary: "Login + /v1/categories OK",
      });
      storage.appendLog({
        level: "info",
        message: "Jomashop session test succeeded",
        detailsJson: JSON.stringify({ baseUrl: cfg.baseUrl }),
        createdAt: Date.now(),
      });
      return res.json({ configured: true, ok: true, message: "Login + categories fetch succeeded." });
    }
    storage.updateSyncJob(job.id, {
      status: "failed",
      finishedAt: Date.now(),
      errorItems: 1,
      summary: result.error || "Unknown error",
    });
    storage.appendLog({
      level: "error",
      message: "Jomashop session test failed",
      detailsJson: JSON.stringify({ error: result.error, status: result.status }),
      createdAt: Date.now(),
    });
    return res.json({
      configured: true,
      ok: false,
      status: result.status,
      message: result.error,
    });
  });

  // ---------- /i1 (live manufacturer + category records) ----------
  //
  // The portal calls these to populate the brand and category dropdowns. We
  // expose them so the Products UI can render exact ids alongside names
  // ("Jomashop category: Footwear (id: 12)") and so the brand mapping flow
  // can show "did you mean Tod's?" fuzzy matches against the real list.
  app.get("/api/jomashop/manufacturers", async (req, res) => {
    if (!jomashopConfigured()) {
      return res.status(503).json({ ok: false, configured: false, error: "Jomashop not configured" });
    }
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const result = await getManufacturers({ refresh });
    if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
    res.json({
      ok: true,
      configured: true,
      count: result.items.length,
      fromCache: result.fromCache,
      items: result.items.map((m) => ({ id: m.id, name: m.name })),
    });
  });

  app.get("/api/jomashop/i1-categories", async (req, res) => {
    if (!jomashopConfigured()) {
      return res.status(503).json({ ok: false, configured: false, error: "Jomashop not configured" });
    }
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const result = await getCategoriesI1({ refresh });
    if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
    res.json({
      ok: true,
      configured: true,
      count: result.items.length,
      fromCache: result.fromCache,
      items: result.items.map((c) => ({ id: c.id, name: c.name })),
    });
  });

  app.get("/api/jomashop/i1-categories/:id/properties", async (req, res) => {
    if (!jomashopConfigured()) {
      return res.status(503).json({ ok: false, error: "Jomashop not configured" });
    }
    const result = await getCategoryPropertiesI1(req.params.id);
    if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
    res.json({ ok: true, data: result.data });
  });

  app.get("/api/jomashop/resolve-brand", async (req, res) => {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Missing ?name=" });
    const result = await resolveManufacturer(name);
    if (!("ok" in result) || !result.ok) {
      return res.status(502).json(result);
    }
    res.json(result);
  });

  app.get("/api/jomashop/resolve-category", async (req, res) => {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Missing ?name=" });
    const result = await resolveCategoryRecord(name);
    if (!("ok" in result) || !result.ok) {
      return res.status(502).json(result);
    }
    res.json(result);
  });

  // Guarded: explicit confirm required. Creates a manufacturer record on
  // Jomashop's side. The operator must type the exact spelling and click
  // confirm in the UI before this fires.
  app.post("/api/jomashop/manufacturers", async (req, res) => {
    if (!jomashopConfigured()) {
      return res.status(503).json({ ok: false, error: "Jomashop not configured" });
    }
    const { name, confirm } = (req.body ?? {}) as { name?: string; confirm?: boolean };
    if (!confirm) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing confirmation. Set `confirm: true` to acknowledge this will create a brand on Jomashop's catalog.",
      });
    }
    const trimmed = (name || "").trim();
    if (!trimmed) {
      return res.status(400).json({ ok: false, error: "Missing brand name" });
    }
    const result = await createManufacturer(trimmed);
    storage.appendLog({
      level: result.ok ? "info" : "error",
      message: result.ok
        ? `Created Jomashop manufacturer "${trimmed}"`
        : `Failed to create Jomashop manufacturer "${trimmed}" (${result.status})`,
      detailsJson: JSON.stringify({ result }),
      createdAt: Date.now(),
    });
    if (!result.ok) {
      return res.status(502).json({ ok: false, status: result.status, error: result.error });
    }
    // Bust the cache so subsequent resolves see the new record.
    clearI1Cache();
    res.json({ ok: true, data: result.data });
  });

  app.get("/api/jomashop/categories", async (_req, res) => {
    if (!jomashopConfigured()) {
      return res.json({
        source: "fallback",
        configured: false,
        categories: SUPPORTED_CATEGORIES.map((c) => ({ name: c })),
        message: "Jomashop credentials not configured. Showing supported categories only.",
      });
    }
    const result = await getCategories();
    if (result.ok) return res.json({ source: "live", configured: true, data: result.data });
    return res.status(502).json({ source: "error", configured: true, error: result.error });
  });

  // Debug: invalidate the in-memory v1 schema cache so the next resolve
  // re-fetches /v1/categories/:name. Use this when Jomashop has published an
  // updated category schema (new accepted enum options) and the app is still
  // returning the stale list.
  app.post("/api/jomashop/clear-schema-cache", async (_req, res) => {
    clearV1SchemaCache();
    res.json({ ok: true });
  });

  app.get("/api/jomashop/categories/:name", async (req, res) => {
    const name = String(req.params.name);
    if (!SUPPORTED_CATEGORIES.includes(name as SupportedCategory)) {
      return res.status(400).json({ error: `Unsupported category. Use one of: ${SUPPORTED_CATEGORIES.join(", ")}` });
    }
    const canonical = canonicalJomashopCategory(name as SupportedCategory) as SupportedCategory;
    const { source, schema } = await resolveCategorySchema(canonical);
    res.json({ source, name, canonicalName: canonical, aliased: canonical !== name, schema });
  });

  // Debug: report which schema source the push path would use for a category.
  // Returns the canonical (aliased) name, the resolved source (live-v1 /
  // live-i1 / fallback), and a flag for whether the source matches the live
  // /api/jomashop/category-enum-options/:name path. Lets operators verify
  // mismatches without burning a push round-trip.
  app.get("/api/jomashop/push-schema-source/:name", async (req, res) => {
    const rawName = String(req.params.name);
    const supported = SUPPORTED_CATEGORIES.includes(rawName as SupportedCategory);
    if (!supported) {
      return res.status(400).json({
        ok: false,
        error: `Unsupported category. Use one of: ${SUPPORTED_CATEGORIES.join(", ")}`,
      });
    }
    const canonical = canonicalJomashopCategory(rawName as SupportedCategory) as SupportedCategory;
    const v1 = await getV1CategoryDescriptors(canonical).catch((e: unknown) => ({
      ok: false as const,
      status: 0,
      error: (e as Error).message,
      fromCache: false,
    }));
    const i1Record = await resolveCategoryRecord(canonical).catch(() => null);
    const i1Id =
      i1Record && "configured" in i1Record && i1Record.configured && i1Record.exact
        ? i1Record.exact.id
        : null;
    let i1Schema: SchemaPropertyDescriptor[] = [];
    if (i1Id !== null) {
      const propsResp = await getCategoryPropertiesI1(i1Id).catch(() => null);
      if (propsResp && "ok" in propsResp && propsResp.ok && propsResp.data) {
        i1Schema = normalizeI1CategorySchema(propsResp.data);
      }
    }
    let pushSchemaSource: "live-v1" | "live-i1" | "fallback" = "fallback";
    if (v1.ok && v1.descriptors.length > 0) pushSchemaSource = "live-v1";
    else if (i1Schema.length > 0) pushSchemaSource = "live-i1";
    res.json({
      ok: true,
      requested: rawName,
      canonicalName: canonical,
      aliased: canonical !== rawName,
      pushSchemaSource,
      v1: v1.ok
        ? { ok: true, descriptorsCount: v1.descriptors.length, fromCache: v1.fromCache }
        : { ok: false, status: v1.status, error: v1.error, fromCache: v1.fromCache },
      i1: { categoryId: i1Id, schemaPropsCount: i1Schema.length },
      note:
        pushSchemaSource === "fallback"
          ? "Push would use the bundled fallback schema for this category — required enum fields tagged options_unverified will block preflight until the live schema is loaded or an operator-verified mapping is added."
          : "Push uses the live schema — same source as /api/jomashop/category-enum-options/" +
            canonical,
    });
  });

  // Admin/debug: list accepted enum options for every enum field of a
  // category. Surfaces both the live-schema options (when available) and the
  // bundled fallback options, plus a per-field `verified` flag that is true
  // when the option list came from Jomashop (live) or is explicitly trusted
  // in the bundled schema. Fields tagged `options_unverified: true` (e.g.
  // Apparel "Article") return `verified: false` so the operator knows the
  // push will be blocked until the live list is loaded or a mapping is
  // supplied. Used by the Products page debug panel to render the accepted
  // options next to each field.
  app.get("/api/jomashop/category-enum-options/:name", async (req, res) => {
    const name = String(req.params.name);
    if (!SUPPORTED_CATEGORIES.includes(name as SupportedCategory)) {
      return res.status(400).json({
        ok: false,
        error: `Unsupported category. Use one of: ${SUPPORTED_CATEGORIES.join(", ")}`,
      });
    }

    // 1. Bundled fallback — always present, gives us the field list and
    //    whether each field's options are verified or guessed.
    const fallback = FALLBACK_CATEGORY_SCHEMAS[name as SupportedCategory] || [];
    type EnumFieldOut = {
      field: string;
      required: boolean;
      type: string;
      options: string[];
      source: "live" | "fallback" | "fallback-unverified";
      verified: boolean;
      preflightBlocking: boolean;
      note?: string;
    };
    const byField = new Map<string, EnumFieldOut>();
    for (const f of fallback) {
      if (f.type !== "enum" || !f.options || f.options.length === 0) continue;
      byField.set(f.field, {
        field: f.field,
        required: f.required,
        type: f.type,
        options: [...f.options],
        source: f.options_unverified ? "fallback-unverified" : "fallback",
        verified: !f.options_unverified,
        preflightBlocking: Boolean(f.options_unverified && f.required),
        note: f.options_unverified
          ? "Bundled list is a best-guess; Jomashop has not confirmed it. Load the live category schema to verify."
          : undefined,
      });
    }

    // 2. Live category record + schema — if reachable.
    //    Preferred: GET /v1/categories/:name, which returns properties with
    //    key/designation/kind and data.values (the exact accepted enum
    //    options Jomashop validates against). v1 options are the canonical
    //    verified source.
    //    Secondary: fall back to /i1/categories/:id when v1 is unreachable
    //    or doesn't carry the property list (legacy tenants).
    let liveCategoryId: number | string | null = null;
    let liveError: string | null = null;
    let v1Error: string | null = null;
    let v1Source = false;
    if (jomashopConfigured()) {
      const v1 = await getV1CategoryDescriptors(name).catch((e: unknown) => ({
        ok: false as const,
        status: 0,
        error: (e as Error).message,
        fromCache: false,
      }));
      if (v1.ok && v1.descriptors.length > 0) {
        for (const p of v1.descriptors) {
          if (!p.options || p.options.length === 0) continue;
          byField.set(p.field, {
            field: p.field,
            required: p.required,
            type: p.type || "enum",
            options: [...p.options],
            source: "live",
            verified: true,
            preflightBlocking: false,
            note: "Verified against /v1/categories/" + name + " data.values",
          });
        }
        v1Source = v1.descriptors.length > 0;
      } else if (!v1.ok) {
        v1Error = v1.error;
      }

      // /i1 secondary — only populate fields v1 didn't already verify.
      const catResolve = await resolveCategoryRecord(name).catch(() => null);
      if (catResolve && "ok" in catResolve && catResolve.ok && "configured" in catResolve && catResolve.configured && catResolve.exact) {
        liveCategoryId = catResolve.exact.id;
      }
      if (liveCategoryId !== null) {
        const propsResp = await getCategoryPropertiesI1(liveCategoryId).catch((e: unknown) => ({
          ok: false as const,
          status: 0,
          error: (e as Error).message,
        }));
        if (propsResp.ok && propsResp.data) {
          const liveSchema = normalizeI1CategorySchema(propsResp.data);
          for (const p of liveSchema) {
            if (!p.options || p.options.length === 0) continue;
            // Don't overwrite a v1-verified entry — v1 is canonical.
            const existing = byField.get(p.field);
            if (existing && existing.source === "live") continue;
            byField.set(p.field, {
              field: p.field,
              required: p.required,
              type: p.type || "enum",
              options: [...p.options],
              source: "live",
              verified: true,
              preflightBlocking: false,
            });
          }
        } else if (!propsResp.ok) {
          liveError = propsResp.error || `HTTP ${propsResp.status}`;
        }
      }
    }

    res.json({
      ok: true,
      category: name,
      liveCategoryId,
      v1Source,
      v1Error,
      liveError,
      fields: Array.from(byField.values()),
    });
  });

  app.get("/api/jomashop/products", async (req, res) => {
    if (!jomashopConfigured()) return res.json({ configured: false, items: [] });
    const result = await jomashopRequest({
      path: "/v1/products",
      query: { page: String(req.query.page ?? "1"), per_page: String(req.query.per_page ?? "20") },
    });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ configured: true, data: result.data });
  });

  app.get("/api/jomashop/inventory", async (_req, res) => {
    if (!jomashopConfigured()) return res.json({ configured: false, items: [] });
    const result = await jomashopRequest({ path: "/v1/inventory" });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ configured: true, data: result.data });
  });

  app.get("/api/jomashop/orders", async (req, res) => {
    if (!jomashopConfigured()) return res.json({ configured: false, items: [] });
    const status = String(req.query.status || "new");
    const result = await jomashopRequest({ path: "/v1/orders", query: { status } });
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ configured: true, data: result.data });
  });

  // ---------- Sync previews ----------
  //
  // POST /api/sync/preview-products
  //   body: { products?, limit?, pageSize?, useCache?, forceRefresh? }
  //
  // By default this returns the cached preview for the connected shop if
  // available — that lets the Products page render instantly without
  // paginating every Shopify product. Pass `forceRefresh: true` (or call the
  // dedicated POST /api/products/refresh route) to re-fetch from Shopify and
  // overwrite the cache.
  async function buildPreview(opts: {
    suppliedProducts?: ShopifyProduct[];
    forceRefresh: boolean;
    pageSize: number;
    maxProducts: number | undefined;
  }) {
    const { suppliedProducts, forceRefresh, pageSize, maxProducts } = opts;
    const conn = getActiveShopifyConnection();
    const storesList = storage.listStores();
    const connectedStore = storesList.find(
      (s) => s.oauthStatus === "connected" && s.accessTokenEnc,
    );
    const shopifyConnected = conn !== null || Boolean(connectedStore);
    const shopDomain = conn?.shopDomain ?? connectedStore?.shopDomain ?? null;

    let products: ShopifyProduct[];
    let dataSource: "live" | "sample" = "sample";
    let fallbackReason: string | null = null;
    let fetchError: string | null = null;
    let fetchedCount = 0;
    let pageCount = 0;
    let hasMore = false;

    if (Array.isArray(suppliedProducts) && suppliedProducts.length > 0) {
      products = suppliedProducts;
      dataSource = "live";
      fetchedCount = suppliedProducts.length;
    } else if (conn) {
      const result = await fetchShopifyProducts({ pageSize, maxProducts });
      if (result.ok && result.products.length > 0) {
        products = result.products;
        dataSource = "live";
        fetchedCount = result.count;
        pageCount = result.pageCount;
        hasMore = result.hasMore;
        if (result.partialError) {
          fetchError = result.partialError;
          storage.appendLog({
            level: "warn",
            message: `Partial Shopify product fetch from ${result.shopDomain}: ${result.partialError}`,
            detailsJson: JSON.stringify({
              fetchedCount: result.count,
              pageCount: result.pageCount,
              status: result.partialStatus,
            }),
            createdAt: Date.now(),
          });
        }
        storage.appendLog({
          level: "info",
          message: `Fetched ${result.count} live Shopify products from ${result.shopDomain} across ${result.pageCount} page(s)`,
          detailsJson: JSON.stringify({ hasMore: result.hasMore, forceRefresh }),
          createdAt: Date.now(),
        });
      } else if (result.ok) {
        products = SAMPLE_SHOPIFY_PRODUCTS;
        dataSource = "sample";
        fallbackReason =
          "Shopify Admin API returned 0 products. Make sure the connected store has at least one published product in scope.";
      } else {
        products = SAMPLE_SHOPIFY_PRODUCTS;
        dataSource = "sample";
        fetchError = result.error;
        fallbackReason = `Shopify Admin API call failed${result.status ? ` (${result.status})` : ""}: ${result.error}`;
        storage.appendLog({
          level: "error",
          message: "Live Shopify product fetch failed; serving sample fixtures",
          detailsJson: JSON.stringify({ error: result.error, status: result.status }),
          createdAt: Date.now(),
        });
      }
    } else {
      products = SAMPLE_SHOPIFY_PRODUCTS;
      dataSource = "sample";
      fallbackReason = shopifyConnected
        ? "Shopify store is connected but the access token could not be decrypted. Re-run the OAuth install."
        : "No Shopify store is connected yet. Complete /#/setup → Begin install to load live products.";
    }

    // Resolve live category schemas + the canonical category-name list so we
    // can label readiness ("Needs category verification" when the live list
    // isn't available, "Rejected" when previously failed).
    const schemas: Partial<Record<SupportedCategory, any>> = {};
    for (const cat of SUPPORTED_CATEGORIES) {
      const { source, schema } = await resolveCategorySchema(cat);
      schemas[cat] = { source, schema };
    }
    const liveCategoriesResult = await getCategories();
    const liveCategoryNames: string[] | null = (() => {
      if (!liveCategoriesResult.ok) return null;
      const raw = liveCategoriesResult.data as unknown;
      const arr =
        (Array.isArray(raw) ? raw : (raw as { data?: unknown }).data) ||
        (raw as { categories?: unknown }).categories;
      if (!Array.isArray(arr)) return null;
      const names = arr
        .map((c) => (typeof c === "string" ? c : (c as { name?: string }).name))
        .filter((s): s is string => Boolean(s));
      return names.length > 0 ? names : null;
    })();

    // Live /i1 manufacturer + category records — used by readiness to flip a
    // row out of "ready" when the outbound brand/category isn't on the live
    // Jomashop list. When /i1 is unavailable we degrade gracefully: readiness
    // falls back to the legacy /v1/categories name comparison only.
    const i1Categories = await getCategoriesI1().catch(() => null);
    const i1Manufacturers = await getManufacturers().catch(() => null);
    const i1CategoryByKey = new Map<string, { id: number | string; name: string }>();
    if (i1Categories && i1Categories.ok) {
      for (const c of i1Categories.items) {
        i1CategoryByKey.set(
          String(c.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, ""),
          { id: c.id, name: c.name },
        );
      }
    }
    const i1ManufacturerByKey = new Map<string, { id: number | string; name: string }>();
    if (i1Manufacturers && i1Manufacturers.ok) {
      for (const m of i1Manufacturers.items) {
        i1ManufacturerByKey.set(
          String(m.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, ""),
          { id: m.id, name: m.name },
        );
      }
    }
    const i1ManufacturerNames: string[] = i1Manufacturers && i1Manufacturers.ok
      ? i1Manufacturers.items.map((m) => m.name)
      : [];
    const i1Available = i1CategoryByKey.size > 0 || i1ManufacturerByKey.size > 0;

    // Cache of live /i1/categories/:id property schemas keyed by category id.
    // Filled on demand from inside the per-product loop below so we only
    // fetch each schema once per preview build.
    const i1SchemaCache = new Map<string, SchemaPropertyDescriptor[] | null>();
    async function loadI1Schema(categoryId: number | string): Promise<SchemaPropertyDescriptor[] | null> {
      const key = String(categoryId);
      if (i1SchemaCache.has(key)) return i1SchemaCache.get(key) ?? null;
      try {
        const resp = await getCategoryPropertiesI1(categoryId);
        if (resp.ok && resp.data) {
          const norm = normalizeI1CategorySchema(resp.data);
          i1SchemaCache.set(key, norm.length > 0 ? norm : null);
          return norm.length > 0 ? norm : null;
        }
      } catch {
        // network issue — silently fall back
      }
      i1SchemaCache.set(key, null);
      return null;
    }

    // Push-status index by Shopify SKU so we can attach pushed/rejected/etc
    // metadata to each mapped product.
    const pushIndex = new Map<
      string,
      {
        state: string;
        jomashopSku: string | null;
        lastError: string | null;
        lastPushedAt: number;
        lastInvalidParams: string[] | null;
        lastRejectedCategory: string | null;
        lastRejectedBrand: string | null;
      }
    >();
    for (const ps of storage.listPushStatuses(shopDomain ?? undefined)) {
      let invalidParams: string[] | null = null;
      if (ps.lastInvalidParams) {
        try {
          const parsed = JSON.parse(ps.lastInvalidParams);
          if (Array.isArray(parsed)) invalidParams = parsed.map(String);
        } catch {
          // ignore — stored as best-effort JSON only
        }
      }
      pushIndex.set(ps.shopifySku, {
        state: ps.state,
        jomashopSku: ps.jomashopSku,
        lastError: ps.lastError,
        lastPushedAt: ps.lastPushedAt,
        lastInvalidParams: invalidParams,
        lastRejectedCategory: ps.lastRejectedCategory,
        lastRejectedBrand: ps.lastRejectedBrand,
      });
    }

    // Process products sequentially. The previous Promise.all spawned one
    // promise per product (3,000+ on a typical store), each holding a closure
    // over the full mapping context. Sequential mapping keeps the working
    // set bounded — each iteration releases its temporaries before the next.
    const mapped: any[] = [];
    let mappedIndex = 0;
    for (const p of products) {
      mappedIndex += 1;
      if (mappedIndex % 500 === 0) {
        logMemory("buildPreview.mapped", { done: mappedIndex, total: products.length });
      }
      const mappedRow = await (async (p: ShopifyProduct) => {
      const tmp = mapShopifyToJomashop(p, []);
      // Apply operator-supplied category override (XLSX-driven). When set, the
      // override pins the SupportedCategory used for schema resolution AND the
      // suggested_category surfaced to the UI / readiness check. This is how a
      // single mapping for "DRSH" → "Dress Shirts" flips every dress shirt to
      // ready without a full Shopify re-pagination.
      const override = lookupCategoryOverride(tmp.raw_category);
      // Schema cat: lift legacy aliases (Clothing→Apparel) to the canonical
      // Jomashop name so the bundled fallback we trust AND the live v1 lookup
      // both target what Jomashop actually publishes.
      const cat = canonicalJomashopCategory(
        (override?.supportedCategory ?? tmp.category) as SupportedCategory,
      ) as SupportedCategory;
      // Determine the outbound category name early so we can resolve to a
      // live /i1 category id and fetch the EXACT schema. We try the
      // override → suggested → mapped category in that order.
      const outboundCategoryName =
        override?.jomashopCategory || tmp.suggested_category || tmp.category || "";
      const outboundCategoryKey = String(outboundCategoryName)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "");
      const resolvedI1Cat = outboundCategoryKey
        ? i1CategoryByKey.get(outboundCategoryKey) ?? null
        : null;
      // Resolve a schema property list with an unambiguous source label so
      // the UI / debug surfaces can distinguish "live" from "fallback". A
      // supported category with an exact-label bundled fallback ALWAYS has
      // a usable schema even when the live /i1 + /v1 lookups fail.
      const bundledForCat = FALLBACK_CATEGORY_SCHEMAS[cat];
      const bundledPropsForCat: Array<any> = Array.isArray(bundledForCat)
        ? bundledForCat.map((f) => ({
            field: f.field,
            required: f.required,
            type: f.type,
            options: f.options,
            allow_omit: f.allow_omit,
            omit_when_unknown_enum: f.omit_when_unknown_enum,
            options_unverified: f.options_unverified,
          }))
        : [];
      const bundledIsExactForCat =
        bundledPropsForCat.length > 0 &&
        bundledPropsForCat.every(
          (p: any) => typeof p.field === "string" && (/[A-Z]/.test(p.field) || /\s/.test(p.field)),
        );
      let props: Array<any> = [];
      let schemaSource: "live-i1" | "live-v1" | "fallback" | "none" = "none";
      if (resolvedI1Cat) {
        const liveSchema = await loadI1Schema(resolvedI1Cat.id);
        if (liveSchema && liveSchema.length > 0) {
          const liveExact = liveSchema.some(
            (p: any) => p && typeof p.field === "string" && (/[A-Z]/.test(p.field) || /\s/.test(p.field)),
          );
          if (liveExact || !bundledIsExactForCat) {
            props = liveSchema;
            schemaSource = "live-i1";
          }
        }
      }
      if (props.length === 0) {
        const schemaWrap = schemas[cat];
        const wrapProps = (schemaWrap?.schema?.properties as Array<any>) || [];
        const wrapExact =
          Array.isArray(wrapProps) &&
          wrapProps.length > 0 &&
          wrapProps.some(
            (p: any) => p && typeof p.field === "string" && (/[A-Z]/.test(p.field) || /\s/.test(p.field)),
          );
        if (wrapProps.length > 0 && (wrapExact || !bundledIsExactForCat)) {
          props = wrapProps;
          schemaSource = schemaWrap?.source === "live" ? "live-v1" : "fallback";
        }
      }
      if (props.length === 0 && bundledPropsForCat.length > 0) {
        props = bundledPropsForCat;
        schemaSource = "fallback";
      }
      const m = mapShopifyToJomashop(p, props, override?.supportedCategory ?? undefined, {
        resolveEnumOverride: (cat, field, sourceValue, acceptedOptions) => {
          const hit = lookupEnumOverride(cat, field, sourceValue, acceptedOptions);
          return hit ? hit.jomashopOption : null;
        },
      });
      if (override) {
        m.suggested_category = override.jomashopCategory;
        // An operator-supplied override resolves the "ambiguous" flag — they
        // explicitly told us what this code maps to.
        m.ambiguous_category = false;
      }

      // Attach push status + readiness flag. Readiness is the stricter
      // signal the UI uses for the "Ready to push" filter:
      //   - no missing top-level fields
      //   - no missing required props
      //   - not a sample fixture
      //   - has a real SKU and category
      //   - category appears in the live Jomashop category list (or, when
      //     not available, surfaces a "Needs category verification" flag).
      //   - no "undefined" category property values present.
      //   - category code is not flagged ambiguous (e.g. "WALL").
      //   - category schema for this product was loaded from a live source
      //     OR the fallback schema has known fields (never an empty/unknown
      //     schema with undefined field names).
      const status = pushIndex.get(m.vendor_sku) || null;
      const hasUndefinedProp = Object.entries(m.properties).some(
        ([k, v]) =>
          !k ||
          k === "undefined" ||
          v === undefined ||
          (typeof v === "string" && v.trim().toLowerCase() === "undefined"),
      );
      const missingTopLevel = m.missing_top_level ?? [];
      const missingRequired = m.missing_required ?? [];
      const hasSku = Boolean(m.vendor_sku && m.vendor_sku.trim() !== "");
      const hasCategory = Boolean(m.category);
      // A category schema is considered "loaded" when we have at least one
      // schema property with a non-empty field name. Live schemas that come
      // back malformed (or fallback schemas that haven't been seeded) end
      // up as unknown and must not produce a "ready" verdict.
      const schemaLoaded = Array.isArray(props) && props.some(
        (p: any) => p && typeof p.field === "string" && p.field.trim() !== "" && p.field !== "undefined",
      );
      // Determine what brand/category WOULD be sent on the next push so a
      // rejection can be cleared automatically when the operator saves a
      // matching override. This mirrors the precedence inside the push
      // endpoint: explicit per-push override > saved brand_override > mapped
      // brand. We only consider saved overrides at preview time because the
      // per-push override is supplied only when the push modal is submitted.
      const outboundCategory =
        (m as any).suggested_category || m.category || "";
      const brandHit = lookupBrandOverride(m.brand);
      const outboundBrand = brandHit?.jomashopBrand || m.brand || "";
      const rejectedCategoryDiffers =
        status?.lastRejectedCategory != null &&
        normalizeCategoryCode(outboundCategory) !==
          normalizeCategoryCode(status.lastRejectedCategory);
      const rejectedBrandDiffers =
        status?.lastRejectedBrand != null &&
        normalizeBrandKey(outboundBrand) !==
          normalizeBrandKey(status.lastRejectedBrand);
      // A stale rejection is one where the next push will use a different
      // category or brand than the one that was rejected — the operator has
      // effectively addressed the issue via a saved override.
      const rejectionIsStale =
        status?.state === "rejected" &&
        (rejectedCategoryDiffers || rejectedBrandDiffers);

      // Resolve outbound brand + category against the live /i1 records so
      // readiness can require an exact manufacturer match (not just a
      // nonblank brand string). When /i1 isn't available we keep the legacy
      // behaviour — fall back to liveCategoryNames check only.
      const brandKeyForResolve = String(outboundBrand)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "");
      const categoryKeyForResolve = String(outboundCategory)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "");
      const resolvedManufacturer = brandKeyForResolve
        ? i1ManufacturerByKey.get(brandKeyForResolve) ?? null
        : null;
      const resolvedCategoryRecord = categoryKeyForResolve
        ? i1CategoryByKey.get(categoryKeyForResolve) ?? null
        : null;
      // Fuzzy "did you mean" — only computed when no exact match. Cheap
      // O(N) scan over the live name list. Capped to 1 suggestion to keep
      // the payload small.
      let manufacturerSuggestion: { id: number | string; name: string } | null = null;
      if (!resolvedManufacturer && brandKeyForResolve && i1Manufacturers && i1Manufacturers.ok) {
        let bestDist = Infinity;
        for (const m of i1Manufacturers.items) {
          const k = m.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
          if (!k) continue;
          let d = 0;
          // Cheap Levenshtein inline (small strings).
          if (k !== brandKeyForResolve) {
            const a = k;
            const b = brandKeyForResolve;
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
            d = dp[b.length];
          }
          if (d < bestDist) {
            bestDist = d;
            manufacturerSuggestion = { id: m.id, name: m.name };
          }
        }
        const maxAllowed = Math.max(2, Math.ceil(brandKeyForResolve.length * 0.25));
        if (manufacturerSuggestion && bestDist > maxAllowed) manufacturerSuggestion = null;
      }

      let readiness: "ready" | "missing" | "needs-category-verification" | "rejected" | "sample" = "missing";
      if (m.is_sample) readiness = "sample";
      else if (
        (status?.state === "rejected" || status?.state === "failed") &&
        !rejectionIsStale
      ) {
        readiness = "rejected";
      }
      else if (!schemaLoaded) {
        readiness = "needs-category-verification";
      } else if (m.ambiguous_category) {
        readiness = "needs-category-verification";
      } else if (
        missingTopLevel.length > 0 ||
        missingRequired.length > 0 ||
        !hasSku ||
        !hasCategory ||
        hasUndefinedProp
      ) {
        readiness = "missing";
      } else if (i1Available) {
        // /i1 records are available: require BOTH brand and category to
        // match a live record. Anything less goes to needs-category-
        // verification so the operator sees the row in the right bucket.
        const brandOk = i1ManufacturerByKey.size === 0 || Boolean(resolvedManufacturer);
        const categoryOk = i1CategoryByKey.size === 0 || Boolean(resolvedCategoryRecord);
        readiness = brandOk && categoryOk ? "ready" : "needs-category-verification";
      } else if (liveCategoryNames && liveCategoryNames.length > 0) {
        // Legacy /v1/categories fallback when /i1 isn't reachable.
        const proposed = (m.suggested_category || m.category || "").toLowerCase();
        const ok = liveCategoryNames.some((n) => n.toLowerCase() === proposed);
        readiness = ok ? "ready" : "needs-category-verification";
      } else {
        readiness = "needs-category-verification";
      }

      return {
        ...m,
        push_state: status?.state ?? "not_pushed",
        jomashop_sku: status?.jomashopSku ?? null,
        last_push_error: status?.lastError ?? null,
        last_pushed_at: status?.lastPushedAt ?? null,
        last_invalid_params: status?.lastInvalidParams ?? null,
        last_rejected_category: status?.lastRejectedCategory ?? null,
        last_rejected_brand: status?.lastRejectedBrand ?? null,
        // Live /i1 resolution context so the UI can render:
        //   "Jomashop category: Footwear (id: 12)"
        //   "Brand: Tods not found; did you mean Tod's?"
        jomashop_resolution: {
          outbound_brand: outboundBrand,
          outbound_category: outboundCategory,
          manufacturer: resolvedManufacturer,
          manufacturer_suggestion: resolvedManufacturer ? null : manufacturerSuggestion,
          category_record: resolvedCategoryRecord,
          i1_available: i1Available,
        },
        schema_source: schemaSource,
        schema_fields: props
          .filter(
            (p: any) =>
              p && typeof p.field === "string" && p.field.trim() !== "" && p.field !== "undefined",
          )
          .map((p: any) => ({ field: p.field as string, required: Boolean(p.required) })),
        readiness,
      };
      })(p);
      mapped.push(mappedRow);
    }

    const usingSamples = dataSource === "sample";
    return {
      mapperVersion: MAPPER_VERSION,
      schemas,
      mapped,
      count: mapped.length,
      usingSamples,
      shopifyConnected,
      dataSource,
      shopDomain,
      fetchedCount,
      pageCount,
      hasMore,
      fallbackReason,
      fetchError,
      liveCategoryNames,
      jomashopManufacturers: {
        available: i1Manufacturers !== null && i1Manufacturers.ok,
        count: i1ManufacturerByKey.size,
        sample: i1ManufacturerNames.slice(0, 50),
      },
      jomashopI1Categories: {
        available: i1Categories !== null && i1Categories.ok,
        count: i1CategoryByKey.size,
        sample: i1Categories && i1Categories.ok
          ? i1Categories.items.slice(0, 50).map((c) => ({ id: c.id, name: c.name }))
          : [],
      },
      note: usingSamples
        ? "Sample fixtures only — connect Shopify and load live products before pushing to Jomashop."
        : `Live Shopify products from ${shopDomain ?? "connected store"}. No data sent to Jomashop.`,
    };
  }

  app.post("/api/sync/preview-products", async (req, res) => {
    const supplied = req.body?.products as ShopifyProduct[] | undefined;
    const forceRefresh = req.body?.forceRefresh === true || req.body?.useCache === false;
    // Only the slow path (no supplied products + forceRefresh OR no cache
    // hit) needs serialization. The cache fast-path below short-circuits
    // before we'd reach the heavy code anyway, so we acquire the lock
    // lazily right before calling buildPreview.
    let heavyLockHeld = false;
    const rawLimit = req.body?.limit;
    const maxProducts =
      rawLimit === undefined || rawLimit === null || rawLimit === "" || rawLimit === "all"
        ? undefined
        : Math.max(parseInt(String(rawLimit), 10) || 0, 1);
    const pageSize = Math.min(
      Math.max(parseInt(String(req.body?.pageSize ?? "100"), 10) || 100, 1),
      250,
    );

    const limit = clampLimit(req.body?.limit ?? req.query.limit);
    const offset = clampOffset(req.body?.offset ?? req.query.offset);

    // Cache fast-path: when not forcing a refresh and no products were
    // supplied, return the latest cached preview if one exists AND it was
    // produced by the current mapper version. A bumped MAPPER_VERSION
    // automatically invalidates stale entries so old payloads (missing the
    // new color/metafield resolution) are never served.
    if (!forceRefresh && (!Array.isArray(supplied) || supplied.length === 0)) {
      const conn = getActiveShopifyConnection();
      const cacheDomain =
        conn?.shopDomain ?? storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ?? null;
      if (cacheDomain) {
        const cached = storage.getProductCache(cacheDomain);
        if (cached) {
          try {
            const payload = JSON.parse(cached.payloadJson);
            if (payload && payload.mapperVersion === MAPPER_VERSION) {
              const sliced = paginateCachePayload(payload, {
                limit,
                offset,
                cachedAt: cached.fetchedAt,
                shopDomain: cacheDomain,
              });
              return res.json(sliced);
            }
            // Stale cache (older mapper version) — drop it so we re-fetch.
            storage.clearProductCache(cacheDomain);
            storage.appendLog({
              level: "info",
              message: `Cleared product cache for ${cacheDomain} (mapperVersion ${payload?.mapperVersion ?? "<none>"} → ${MAPPER_VERSION})`,
              detailsJson: null,
              createdAt: Date.now(),
            });
          } catch {
            // fall through and refetch below
          }
        }
      }
    }

    // Heavy path: serialize concurrent refreshes so two simultaneous
    // requests don't both pull the full Shopify catalog into memory.
    if (!withLockOr409(res, "products.refresh")) return;
    heavyLockHeld = true;
    try {
    let preview;
    try {
      logMemory("preview-products.start", { forceRefresh, maxProducts, pageSize });
      preview = await buildPreview({
        suppliedProducts: supplied,
        forceRefresh,
        pageSize,
        maxProducts,
      });
      logMemory("preview-products.built", {
        mapped: preview.count,
        dataSource: preview.dataSource,
      });
    } catch (err) {
      releaseLock("products.refresh");
      heavyLockHeld = false;
      logMemory("preview-products.failed", { message: (err as Error)?.message });
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    // Cache successful live previews so the next page load is instant.
    // Sample/empty previews are not cached so we don't pin demo data.
    // We persist the COMPACT projection only — debug_raw / full metafields
    // never round-trip through the cache, which keeps the SQLite row well
    // under a megabyte even for catalogs in the thousands.
    if (preview.dataSource === "live" && preview.shopDomain) {
      try {
        const cachePayload = {
          mapperVersion: preview.mapperVersion,
          schemas: preview.schemas,
          mapped: preview.mapped.map((m) => compactifyMapped(m)),
          usingSamples: preview.usingSamples,
          shopifyConnected: preview.shopifyConnected,
          dataSource: preview.dataSource,
          shopDomain: preview.shopDomain,
          fetchedCount: preview.fetchedCount,
          pageCount: preview.pageCount,
          hasMore: preview.hasMore,
          fallbackReason: preview.fallbackReason,
          fetchError: preview.fetchError,
          liveCategoryNames: preview.liveCategoryNames,
          jomashopManufacturers: preview.jomashopManufacturers,
          jomashopI1Categories: preview.jomashopI1Categories,
          note: preview.note,
        };
        storage.upsertProductCache({
          shopDomain: preview.shopDomain,
          fetchedCount: preview.fetchedCount,
          pageCount: preview.pageCount,
          hasMore: preview.hasMore,
          payloadJson: JSON.stringify(cachePayload),
          fetchedAt: Date.now(),
        });
      } catch (err) {
        storage.appendLog({
          level: "warn",
          message: `Failed to persist product cache: ${(err as Error).message}`,
          detailsJson: null,
          createdAt: Date.now(),
        });
      }
    }

    // Always slice the response so a freshly-built preview is just as
    // memory-friendly as a cached one.
    const totalCount = preview.mapped.length;
    const start = Math.min(offset, totalCount);
    const end = Math.min(start + limit, totalCount);
    const sliced = preview.mapped.slice(start, end).map(compactifyMapped);
    res.json({
      mapperVersion: preview.mapperVersion,
      schemas: preview.schemas,
      mapped: sliced,
      count: sliced.length,
      totalCount,
      page: { offset: start, limit, hasMore: end < totalCount },
      usingSamples: preview.usingSamples,
      shopifyConnected: preview.shopifyConnected,
      dataSource: preview.dataSource,
      shopDomain: preview.shopDomain,
      fetchedCount: preview.fetchedCount,
      pageCount: preview.pageCount,
      hasMore: preview.hasMore,
      fallbackReason: preview.fallbackReason,
      fetchError: preview.fetchError,
      liveCategoryNames: preview.liveCategoryNames,
      jomashopManufacturers: preview.jomashopManufacturers,
      jomashopI1Categories: preview.jomashopI1Categories,
      note: preview.note,
      fromCache: false,
      lastRefreshedAt: Date.now(),
    });
    logMemory("preview-products.responded", { sent: sliced.length, totalCount });
    } finally {
      if (heavyLockHeld) releaseLock("products.refresh");
    }
  });

  // Read-only fast path: return a paginated slice of the cached preview
  // without ever calling Shopify. The Products page calls this on mount so
  // initial load is immediate. Returns `cached: false` if no cache exists
  // yet. Defaults to DEFAULT_LIST_LIMIT rows; pass ?limit=&offset= to page.
  app.get("/api/products/cache", (req, res) => {
    const conn = getActiveShopifyConnection();
    const shopDomain =
      conn?.shopDomain ??
      storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
      null;
    if (!shopDomain) return res.json({ cached: false, reason: "no-shopify-connection" });
    const cached = storage.getProductCache(shopDomain);
    if (!cached) return res.json({ cached: false, shopDomain });
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    try {
      const payload = JSON.parse(cached.payloadJson);
      if (!payload || payload.mapperVersion !== MAPPER_VERSION) {
        storage.clearProductCache(shopDomain);
        return res.json({
          cached: false,
          shopDomain,
          reason: "stale-mapper-version",
          cachedMapperVersion: payload?.mapperVersion ?? null,
          mapperVersion: MAPPER_VERSION,
        });
      }
      const sliced = paginateCachePayload(payload, {
        limit,
        offset,
        cachedAt: cached.fetchedAt,
        shopDomain,
      });
      return res.json({
        cached: true,
        shopDomain,
        lastRefreshedAt: cached.fetchedAt,
        fetchedCount: cached.fetchedCount,
        pageCount: cached.pageCount,
        hasMore: cached.hasMore,
        ...sliced,
      });
    } catch (err) {
      return res.json({ cached: false, shopDomain, error: (err as Error).message });
    }
  });

  // Single-product full detail. Returns the heavy fields (debug_raw, full
  // metafields echo, full image list) for ONE product, looked up by Shopify
  // product id. Backed by a live Shopify fetch — we do not persist heavy
  // per-product data in the cache. This is the dedicated endpoint for the
  // expandable debug panel in the UI; the list view never includes this
  // payload.
  app.get("/api/products/full/:id", async (req, res) => {
    const productId = String(req.params.id);
    if (!productId) return res.status(400).json({ ok: false, error: "Missing product id" });
    const conn = getActiveShopifyConnection();
    if (!conn) {
      return res.status(503).json({ ok: false, error: "No connected Shopify store with an access token." });
    }
    // We can't filter Admin GraphQL by id without the GID, so we stream
    // pages and stop as soon as we find the match. Worst case a few hundred
    // KB of working memory for the page, never the whole catalog.
    const { streamShopifyProducts } = await import("./shopify");
    let found: ShopifyProduct | null = null;
    const stream = await streamShopifyProducts((pageProducts) => {
      for (const p of pageProducts) {
        if (String(p.id) === productId) {
          found = p;
          return false; // stop pagination
        }
      }
    }, { pageSize: 100 });
    if (!stream.ok && !found) {
      return res.status(502).json({ ok: false, error: stream.error });
    }
    if (!found) {
      return res.status(404).json({ ok: false, error: "Product not found in connected Shopify store." });
    }
    // Resolve schema + map for the single product so the debug echo is in
    // the same shape as the list view's compact rows but with full detail.
    const tmp = mapShopifyToJomashop(found, []);
    const { schema, source } = await resolveCategorySchema(tmp.category);
    const props =
      ((schema as { properties?: Array<any> } | undefined)?.properties) ??
      FALLBACK_CATEGORY_SCHEMAS[tmp.category];
    const mapped = mapShopifyToJomashop(found, props, undefined, {
      resolveEnumOverride: (cat, field, sourceValue, acceptedOptions) => {
        const hit = lookupEnumOverride(cat, field, sourceValue, acceptedOptions);
        return hit ? hit.jomashopOption : null;
      },
    });
    res.json({
      ok: true,
      shopDomain: conn.shopDomain,
      schemaSource: source,
      product: found,
      mapped,
    });
  });

  // Force a full Shopify pagination + cache overwrite. The Products page
  // wires this to the "Refresh from Shopify" button.
  app.post("/api/products/refresh", async (req, res) => {
    const rawLimit = req.body?.limit;
    const maxProducts =
      rawLimit === undefined || rawLimit === null || rawLimit === "" || rawLimit === "all"
        ? undefined
        : Math.max(parseInt(String(rawLimit), 10) || 0, 1);
    const pageSize = Math.min(
      Math.max(parseInt(String(req.body?.pageSize ?? "100"), 10) || 100, 1),
      250,
    );
    const responseLimit = clampLimit(req.body?.responseLimit ?? req.query.limit);
    const responseOffset = clampOffset(req.body?.responseOffset ?? req.query.offset);

    // Serialize full refreshes; two concurrent Shopify catalog pulls can
    // double RSS and trigger the Render OOM (exit 134). Lock is always
    // released in finally so a crash mid-build can't permanently wedge the
    // endpoint at 409.
    if (!withLockOr409(res, "products.refresh")) return;
    try {
      let preview;
      try {
        logMemory("products-refresh.start", { maxProducts, pageSize });
        preview = await buildPreview({
          suppliedProducts: undefined,
          forceRefresh: true,
          pageSize,
          maxProducts,
        });
        logMemory("products-refresh.built", {
          mapped: preview.count,
          dataSource: preview.dataSource,
        });
      } catch (err) {
        logMemory("products-refresh.failed", { message: (err as Error)?.message });
        return res
          .status(500)
          .json({ ok: false, error: (err as Error).message || "Refresh failed" });
      }
      if (preview.dataSource === "live" && preview.shopDomain) {
        try {
          const cachePayload = {
            mapperVersion: preview.mapperVersion,
            schemas: preview.schemas,
            mapped: preview.mapped.map((m) => compactifyMapped(m)),
            usingSamples: preview.usingSamples,
            shopifyConnected: preview.shopifyConnected,
            dataSource: preview.dataSource,
            shopDomain: preview.shopDomain,
            fetchedCount: preview.fetchedCount,
            pageCount: preview.pageCount,
            hasMore: preview.hasMore,
            fallbackReason: preview.fallbackReason,
            fetchError: preview.fetchError,
            liveCategoryNames: preview.liveCategoryNames,
            jomashopManufacturers: preview.jomashopManufacturers,
            jomashopI1Categories: preview.jomashopI1Categories,
            note: preview.note,
          };
          storage.upsertProductCache({
            shopDomain: preview.shopDomain,
            fetchedCount: preview.fetchedCount,
            pageCount: preview.pageCount,
            hasMore: preview.hasMore,
            payloadJson: JSON.stringify(cachePayload),
            fetchedAt: Date.now(),
          });
        } catch (err) {
          storage.appendLog({
            level: "warn",
            message: `Failed to persist product cache: ${(err as Error).message}`,
            detailsJson: null,
            createdAt: Date.now(),
          });
        }
      }
      const totalCount = preview.mapped.length;
      const start = Math.min(responseOffset, totalCount);
      const end = Math.min(start + responseLimit, totalCount);
      const sliced = preview.mapped.slice(start, end).map(compactifyMapped);
      res.json({
        mapperVersion: preview.mapperVersion,
        schemas: preview.schemas,
        mapped: sliced,
        count: sliced.length,
        totalCount,
        page: { offset: start, limit: responseLimit, hasMore: end < totalCount },
        usingSamples: preview.usingSamples,
        shopifyConnected: preview.shopifyConnected,
        dataSource: preview.dataSource,
        shopDomain: preview.shopDomain,
        fetchedCount: preview.fetchedCount,
        pageCount: preview.pageCount,
        hasMore: preview.hasMore,
        fallbackReason: preview.fallbackReason,
        fetchError: preview.fetchError,
        liveCategoryNames: preview.liveCategoryNames,
        jomashopManufacturers: preview.jomashopManufacturers,
        jomashopI1Categories: preview.jomashopI1Categories,
        note: preview.note,
        fromCache: false,
        lastRefreshedAt: Date.now(),
      });
      logMemory("products-refresh.responded", { sent: sliced.length, totalCount });
    } finally {
      releaseLock("products.refresh");
    }
  });

  // Direct live Shopify product fetch (debug / admin use). Returns the
  // normalized ShopifyProduct[] without running through Jomashop mapping.
  // To prevent OOMs on stores with thousands of products + heavy metafields,
  // this endpoint defaults to a small capped response (DEFAULT_LIST_LIMIT).
  // Pass ?limit=all (clamped to MAX_LIST_LIMIT) to receive a larger slice;
  // there is no longer a way to ship the full uncapped catalog as one
  // response — use /api/products/cache or /api/products/full/:id instead.
  app.get("/api/shopify/products", async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const pageSize = Math.min(
      Math.max(parseInt(String(req.query.pageSize ?? "100"), 10) || 100, 1),
      250,
    );
    const conn = getActiveShopifyConnection();
    if (!conn) {
      return res.status(503).json({
        ok: false,
        error: "No connected Shopify store with an access token. Complete OAuth install first.",
      });
    }
    const result = await fetchShopifyProducts({ pageSize, maxProducts: limit });
    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        shopDomain: conn.shopDomain,
        status: result.status,
        error: result.error,
      });
    }
    res.json({
      ok: true,
      shopDomain: result.shopDomain,
      count: result.count,
      pageCount: result.pageCount,
      hasMore: result.hasMore,
      partialError: result.partialError ?? null,
      products: result.products,
      note: `Capped at ${limit} products. Use /api/products/cache for paginated mapped views or /api/products/full/:id for single-product detail.`,
    });
  });

  app.get("/api/sync/inventory-preview", (_req, res) => {
    const sample = SAMPLE_SHOPIFY_PRODUCTS.flatMap((p) =>
      (p.variants || []).map((v) => ({
        vendor_sku: v.sku,
        price: parseFloat(v.price || "0"),
        status:
          v.inventory_quantity === undefined || v.inventory_quantity === null
            ? "inactive"
            : v.inventory_quantity > 0
              ? "active"
              : "out_of_stock",
        quantity: v.inventory_quantity ?? 0,
      })),
    );
    res.json({
      headers: ["Vendor SKU", "Price", "Status", "Quantity"],
      rows: sample,
      note: "Preview of the bulk inventory CSV payload (PUT /v1/inventory/update-statuses).",
    });
  });

  // Manual inventory sync. Pushes the current Shopify inventory state to
  // Jomashop for one SKU or every pushed SKU. Inventory webhooks remain the
  // primary path (set up via /api/shopify/register-webhooks), but this
  // endpoint lets the operator force a reconciliation when:
  //
  //   - webhooks haven't propagated yet on a freshly-installed app,
  //   - a SKU's stock state drifted between Shopify and Jomashop,
  //   - the operator wants to roll a manual price/MSRP update.
  //
  // body: { shopifySku?: string }
  //   - shopifySku set: sync that one SKU.
  //   - shopifySku absent: sync ALL pushed SKUs (state === "pushed").
  app.post("/api/jomashop/inventory-sync", async (req, res) => {
    if (!jomashopConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Jomashop credentials not configured. Set JOMASHOP_EMAIL and JOMASHOP_PASSWORD.",
      });
    }
    const conn = getActiveShopifyConnection();
    if (!conn) {
      return res.status(503).json({
        ok: false,
        error: "No connected Shopify store with an access token.",
      });
    }
    const shopDomain = conn.shopDomain;
    const targetSku = typeof req.body?.shopifySku === "string" ? req.body.shopifySku.trim() : "";

    // Resolve the candidate rows. Single-SKU path is a fast lookup; bulk
    // path filters to "pushed" rows so we never try to push inventory for a
    // SKU we never created.
    type Candidate = { shopifySku: string; productId: string | null };
    let candidates: Candidate[] = [];
    if (targetSku) {
      const lookup = storage.getPushStatusBySku(shopDomain, targetSku);
      if (!lookup) {
        return res.status(404).json({
          ok: false,
          error: `No push_status row found for SKU ${targetSku} in store ${shopDomain}. Push the product first.`,
        });
      }
      candidates.push({ shopifySku: lookup.shopifySku, productId: lookup.shopifyProductId });
    } else {
      const all = storage.listPushStatuses(shopDomain);
      candidates = all
        .filter((p) => p.state === "pushed")
        .map((p) => ({ shopifySku: p.shopifySku, productId: p.shopifyProductId }));
    }
    if (candidates.length === 0) {
      return res.json({
        ok: true,
        attempted: 0,
        applied: 0,
        skipped: 0,
        rejected: 0,
        results: [],
        note: "No pushed SKUs to sync.",
      });
    }
    // Hard cap so we never spend an hour serializing through a few thousand
    // SKUs from a single HTTP request. The operator can paginate via repeated
    // calls; webhooks are still the long-term real-time path.
    const MAX_BULK = 250;
    if (candidates.length > MAX_BULK) {
      candidates = candidates.slice(0, MAX_BULK);
    }

    // Resolve current Shopify inventory state in bulk by paginating products
    // and indexing variants by SKU. We stop streaming as soon as we've found
    // every requested SKU.
    const wantedSkus = new Set(candidates.map((c) => c.shopifySku));
    const skuQuantities = new Map<string, number | null>();
    try {
      const { streamShopifyProducts } = await import("./shopify");
      await streamShopifyProducts((pageProducts) => {
        for (const p of pageProducts) {
          for (const v of p.variants || []) {
            const sku = (v.sku ?? "").trim();
            if (!sku || !wantedSkus.has(sku) || skuQuantities.has(sku)) continue;
            skuQuantities.set(
              sku,
              typeof v.inventory_quantity === "number" ? v.inventory_quantity : null,
            );
          }
        }
        if (skuQuantities.size >= wantedSkus.size) return false;
      });
    } catch (err) {
      // Fall through with whatever we resolved — push handler tolerates a
      // null quantity by reusing the cached value on the push_status row.
      void err;
    }

    const results: Array<{ sku: string; status: string; message: string }> = [];
    for (const c of candidates) {
      const qty = skuQuantities.get(c.shopifySku) ?? null;
      const r = await pushInventoryUpdate({
        shopifySku: c.shopifySku,
        quantity: qty,
        topic: "manual-sync",
        shopDomain,
      });
      results.push({ sku: c.shopifySku, status: r.status, message: r.message });
    }
    const applied = results.filter((r) => r.status === "applied").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    storage.appendLog({
      level: rejected > 0 ? "warn" : "info",
      message: `Manual inventory sync: ${applied} applied / ${skipped} skipped / ${rejected} rejected (${results.length} attempted)`,
      detailsJson: JSON.stringify({ targetSku: targetSku || "(all pushed)", results }),
      createdAt: Date.now(),
    });
    return res.json({
      ok: true,
      attempted: results.length,
      applied,
      skipped,
      rejected,
      truncated: candidates.length === MAX_BULK && !targetSku,
      results,
    });
  });

  app.get("/api/sync/orders-preview", (_req, res) => {
    const now = new Date();
    const samples = [
      {
        sales_order_number: "JM-2026-000123",
        status: "new",
        customer: "Anonymous",
        line_items: [
          { sku: "GG-ACE-WHT-10", quantity: 1, price: 650 },
        ],
        shipping: { method: "FedEx 2-Day", address: { city: "Brooklyn", state: "NY" } },
        placed_at: now.toISOString(),
      },
      {
        sales_order_number: "JM-2026-000124",
        status: "new",
        customer: "Anonymous",
        line_items: [
          { sku: "YSL-LOULOU-NOIR", quantity: 1, price: 2350 },
        ],
        shipping: { method: "UPS Ground", address: { city: "Miami", state: "FL" } },
        placed_at: now.toISOString(),
      },
    ];
    const fulfillExample = {
      url: "/v1/orders/JM-2026-000123/fulfill",
      method: "PUT",
      body: {
        fulfilled: [{ sku: "GG-ACE-WHT-10", quantity: 1 }],
        invoice_number: "LX-INV-1001",
        tracking_number: "1Z999AA10123456784",
        used_supplied_shipping_label: false,
        shipped_at: now.toISOString(),
      },
    };
    res.json({ samples, fulfillExample, note: "Preview only. No live Jomashop calls were made." });
  });

  // ---------- Live Jomashop push (single product/variant) ----------
  //
  // POST /api/jomashop/push-product
  //   body: { product: ShopifyProduct, variantSku?: string, confirm: true,
  //           pushInventory?: boolean, forcedCategory?: SupportedCategory }
  //
  // Pushes ONE Shopify product (optionally a specific variant) to Jomashop
  // using the live category schema and the current commercial-discount
  // pricing logic. After a successful product POST, optionally updates
  // inventory for the variant SKU. Bulk push is intentionally NOT exposed.
  app.post("/api/jomashop/push-product", async (req, res) => {
    const body = (req.body || {}) as {
      product?: ShopifyProduct;
      variantSku?: string;
      confirm?: boolean;
      pushInventory?: boolean;
      forcedCategory?: SupportedCategory;
      overrides?: PushOverrides;
    };

    if (!body.confirm) {
      return res.status(400).json({
        ok: false,
        error: "Missing confirmation. Set `confirm: true` to acknowledge this will create/update data in Jomashop.",
      });
    }
    if (!body.product) {
      return res.status(400).json({ ok: false, error: "Missing `product` in request body." });
    }
    if (isSampleProduct(body.product)) {
      storage.appendLog({
        level: "warn",
        message: "Push refused: sample/demo fixture cannot be pushed to Jomashop",
        detailsJson: JSON.stringify({
          productId: body.product.id,
          variantSku: body.variantSku,
        }),
        createdAt: Date.now(),
      });
      return res.status(400).json({
        ok: false,
        error:
          "This is sample/demo data. Connect Shopify and load a live product before pushing to Jomashop.",
        isSample: true,
      });
    }
    if (!jomashopConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Jomashop credentials not configured. Set JOMASHOP_EMAIL and JOMASHOP_PASSWORD.",
      });
    }

    // Helper bound to the live storage-backed enum override resolver so the
    // mapping module stays free of direct DB imports. Verifies the result
    // against the schema's accepted options when known.
    const enumResolver = (
      cat: string,
      field: string,
      sourceValue: string,
      acceptedOptions: string[] | undefined,
    ): string | null => {
      const hit = lookupEnumOverride(cat, field, sourceValue, acceptedOptions);
      return hit ? hit.jomashopOption : null;
    };

    // Hydrate the FULL image list before mapping. The compact list payload
    // only carries the first image (to keep cache + transport small), so on
    // push we fetch every available image directly from the Shopify Admin
    // API by product id. Deduped + stable order. Falls back to whatever the
    // client supplied on any failure.
    let imagesFetched: number | null = null;
    let imagesFetchError: string | null = null;
    const productIdForImages = (body.product as any)?.id;
    if (productIdForImages !== undefined && productIdForImages !== null && String(productIdForImages).trim() !== "") {
      try {
        const detail = await fetchShopifyProductImages(String(productIdForImages));
        if (detail && detail.images.length > 0) {
          // Preserve the client-supplied first image at the head when it
          // matches; otherwise just use the full list as Shopify ordered it.
          const existing = Array.isArray(body.product!.images) ? body.product!.images : [];
          const existingUrls = new Set(
            existing.map((i: any) => (typeof i?.src === "string" ? i.src.trim() : "")).filter(Boolean),
          );
          const merged: Array<{ src: string; alt?: string | null }> = [];
          const seen = new Set<string>();
          for (const img of detail.images) {
            if (seen.has(img.src)) continue;
            seen.add(img.src);
            merged.push({ src: img.src, alt: img.alt });
          }
          for (const img of existing) {
            const src = typeof img?.src === "string" ? img.src.trim() : "";
            if (!src || seen.has(src)) continue;
            seen.add(src);
            merged.push({ src, alt: (img as any)?.alt ?? null });
          }
          body.product = { ...body.product!, images: merged };
          imagesFetched = merged.length;
          // Suppress unused-variable lint while keeping the diagnostic info.
          void existingUrls;
        } else if (detail && detail.images.length === 0) {
          imagesFetched = 0;
        } else {
          imagesFetchError = "image detail lookup returned null";
        }
      } catch (err) {
        imagesFetchError = (err as Error).message;
      }
    }

    // Resolve live (or fallback) schema for the inferred/forced category.
    // Always lift to the canonical Jomashop name (Clothing→Apparel,
    // Shoes→Footwear) for schema and enum lookups. The internal mapper still
    // labels the product as the legacy name for backward compatibility, but
    // the live /v1 endpoint and bundled fallback we trust must be canonical.
    const tmpMap = mapShopifyToJomashop(body.product, [], body.forcedCategory);
    const schemaCategory = canonicalJomashopCategory(tmpMap.category) as SupportedCategory;
    const { source, schema } = await resolveCategorySchema(schemaCategory);
    const schemaProps = (schema as { properties?: Array<any> } | undefined)?.properties;
    const props =
      schemaProps ||
      (FALLBACK_CATEGORY_SCHEMAS[schemaCategory] ?? FALLBACK_CATEGORY_SCHEMAS[tmpMap.category]).map(
        (f) => ({
          field: f.field,
          required: f.required,
          type: f.type,
          options: f.options,
          allow_omit: f.allow_omit,
          omit_when_unknown_enum: f.omit_when_unknown_enum,
          options_unverified: f.options_unverified,
        }),
      );

    let mapped = mapShopifyToJomashop(body.product, props, body.forcedCategory, {
      resolveEnumOverride: enumResolver,
    });
    const overrides: PushOverrides = { ...(body.overrides || {}) };
    // Brand override precedence at push time:
    //   1. Explicit operator-supplied overrides.brand on this push call.
    //   2. Saved brand_overrides row for the resolved Shopify brand
    //      (e.g. operator saved Tods → "Tod's" after a previous rejection).
    //   3. The mapped brand from Shopify (current behaviour).
    if (!overrides.brand || !overrides.brand.trim()) {
      const brandHit = lookupBrandOverride(mapped.brand);
      if (brandHit && brandHit.jomashopBrand.trim()) {
        overrides.brand = brandHit.jomashopBrand;
      }
    }

    // Resolve the outbound brand against the live /i1/manufacturers list so
    // we can populate `manufacturer_id` on the payload AND short-circuit a
    // "Brand must exist" rejection before hitting the network. Same for the
    // outbound category against /i1/categories.
    const outboundBrandForResolve =
      (overrides.brand && overrides.brand.trim()) || mapped.brand || "";
    const outboundCategoryForResolve =
      (overrides.category && overrides.category.trim()) ||
      (mapped as any).suggested_category ||
      mapped.category ||
      "";
    let manufacturerResolution: Awaited<ReturnType<typeof resolveManufacturer>> | null = null;
    let categoryResolution: Awaited<ReturnType<typeof resolveCategoryRecord>> | null = null;
    if (outboundBrandForResolve) {
      manufacturerResolution = await resolveManufacturer(outboundBrandForResolve);
      if (
        manufacturerResolution.ok &&
        "configured" in manufacturerResolution &&
        manufacturerResolution.configured &&
        manufacturerResolution.exact
      ) {
        if (overrides.manufacturer_id === undefined || overrides.manufacturer_id === null) {
          overrides.manufacturer_id = manufacturerResolution.exact.id;
        }
        // Use the canonical Jomashop spelling so the payload's brand string
        // is exactly what Jomashop has on record.
        overrides.brand = manufacturerResolution.exact.name;
      }
    }
    if (outboundCategoryForResolve) {
      categoryResolution = await resolveCategoryRecord(outboundCategoryForResolve);
      if (
        categoryResolution.ok &&
        "configured" in categoryResolution &&
        categoryResolution.configured &&
        categoryResolution.exact
      ) {
        if (overrides.category_id === undefined || overrides.category_id === null) {
          overrides.category_id = categoryResolution.exact.id;
        }
        overrides.category = categoryResolution.exact.name;
      }
    }

    // Schema-driven property mapping: prefer the published v1 schema
    // (`GET /v1/categories/:name`) because its `data.values` carry the
    // canonical verified enum option list (e.g. the real Apparel "Article"
    // accepted values). Falls back to /i1/categories/:id by category id when
    // v1 is unavailable, and finally to the bundled exact-label schema.
    let liveSchemaSource: "live-i1" | "live-v1" | "fallback" = source === "live" ? "live-v1" : "fallback";
    // Prefer the canonical-name fallback (Apparel) over the legacy (Clothing)
    // fallback — Article options on Apparel are verified, on Clothing they
    // were tagged options_unverified.
    const bundledFallback =
      FALLBACK_CATEGORY_SCHEMAS[schemaCategory] ?? FALLBACK_CATEGORY_SCHEMAS[tmpMap.category];
    const bundledIsExact =
      Array.isArray(bundledFallback) &&
      bundledFallback.length > 0 &&
      bundledFallback.every((p) => /[A-Z]/.test(p.field) || /\s/.test(p.field));
    let v1SchemaUsed = false;
    // The resolved Jomashop category name (from /i1/categories) may differ from
    // both the legacy mapper name AND the static alias — e.g. operator mapped
    // a Shopify product to category record "Apparel" via overrides. Try the
    // override name first when present, then fall back to the static alias.
    const v1CandidateNames = Array.from(
      new Set(
        [overrides.category, schemaCategory, tmpMap.category]
          .filter((c): c is string => Boolean(c && String(c).trim())),
      ),
    );
    try {
      let v1Resp: Awaited<ReturnType<typeof getV1CategoryDescriptors>> | null = null;
      for (const cand of v1CandidateNames) {
        const r = await getV1CategoryDescriptors(cand);
        if (r.ok && r.descriptors.length > 0) {
          v1Resp = r;
          break;
        }
        if (!v1Resp) v1Resp = r;
      }
      if (!v1Resp) v1Resp = await getV1CategoryDescriptors(schemaCategory);
      if (v1Resp.ok && v1Resp.descriptors.length > 0) {
        const v1Exact = v1Resp.descriptors.some(
          (p) => p && typeof p.field === "string" && (/[A-Z]/.test(p.field) || /\s/.test(p.field)),
        );
        if (v1Exact || !bundledIsExact) {
          mapped = mapShopifyToJomashop(body.product, v1Resp.descriptors, body.forcedCategory, {
            resolveEnumOverride: enumResolver,
          });
          liveSchemaSource = "live-v1";
          v1SchemaUsed = true;
        }
      }
    } catch {
      // network issue — fall through to /i1
    }
    if (!v1SchemaUsed && overrides.category_id !== undefined && overrides.category_id !== null) {
      try {
        const i1SchemaResp = await getCategoryPropertiesI1(overrides.category_id);
        if (i1SchemaResp.ok && i1SchemaResp.data) {
          const liveSchema = normalizeI1CategorySchema(i1SchemaResp.data);
          if (liveSchema.length > 0) {
            const liveSchemaExact = liveSchema.some(
              (p) => p && typeof p.field === "string" && (/[A-Z]/.test(p.field) || /\s/.test(p.field)),
            );
            if (liveSchemaExact || !bundledIsExact) {
              mapped = mapShopifyToJomashop(body.product, liveSchema, body.forcedCategory, {
                resolveEnumOverride: enumResolver,
              });
              liveSchemaSource = "live-i1";
            }
          }
        }
      } catch {
        // network issue — keep bundled schema mapping
      }
    }

    let { payload, variant, missingRequired, missingTopLevel, pushDebug } =
      buildJomashopProductPayload(mapped, body.variantSku, overrides);
    // Expose the schema source on pushDebug so the UI / debug routes can
    // distinguish "push used live Apparel schema" from "push fell back to
    // bundled Clothing options" — the exact mismatch this fix addresses.
    (pushDebug as any).schemaSource = liveSchemaSource;
    (pushDebug as any).schemaCategoryName = schemaCategory;
    (pushDebug as any).imagesFetched = imagesFetched;
    (pushDebug as any).imagesFetchError = imagesFetchError;
    (pushDebug as any).imagesCount = Array.isArray((payload as any)?.images)
      ? (payload as any).images.length
      : 0;

    // If the chosen schema produced an unsafe (lowercase-only) payload but we
    // have a Title Case bundled fallback for this category, re-map against
    // the bundled fallback so the push can proceed with exact labels.
    if (pushDebug.fallbackUnsafe && bundledIsExact) {
      const bundledProps = bundledFallback.map((f) => ({
        field: f.field,
        required: f.required,
        type: f.type,
        options: f.options,
        allow_omit: f.allow_omit,
        omit_when_unknown_enum: f.omit_when_unknown_enum,
        options_unverified: f.options_unverified,
      }));
      mapped = mapShopifyToJomashop(body.product, bundledProps, body.forcedCategory, {
        resolveEnumOverride: enumResolver,
      });
      ({ payload, variant, missingRequired, missingTopLevel, pushDebug } =
        buildJomashopProductPayload(mapped, body.variantSku, overrides));
      liveSchemaSource = "fallback";
    }

    const startedAt = Date.now();
    const job = storage.createSyncJob({
      jobType: "products_push",
      status: "running",
      startedAt,
      finishedAt: null,
      totalItems: 1,
      successItems: 0,
      errorItems: 0,
      summary: `Push ${mapped.vendor_sku} (${mapped.category})`,
    });

    // Pre-flight validation: refuse to call the API when the brand/category
    // can't be matched to a live record. Surfacing this as a 422 (with the
    // resolution context) lets the UI render "Brand 'Tods' not found in
    // Jomashop manufacturers; did you mean 'Tod's'?" without burning a push.
    const brandUnresolved =
      manufacturerResolution !== null &&
      manufacturerResolution.ok &&
      "configured" in manufacturerResolution &&
      manufacturerResolution.configured &&
      !manufacturerResolution.exact;
    const categoryUnresolved =
      categoryResolution !== null &&
      categoryResolution.ok &&
      "configured" in categoryResolution &&
      categoryResolution.configured &&
      !categoryResolution.exact;
    if (brandUnresolved || categoryUnresolved) {
      const detail = [
        brandUnresolved ? `Brand not found in Jomashop manufacturers: ${outboundBrandForResolve}` : null,
        categoryUnresolved ? `Category not found in Jomashop categories: ${outboundCategoryForResolve}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `Pre-flight: ${detail}`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Push aborted before API call: ${detail}`,
        detailsJson: JSON.stringify({
          outboundBrand: outboundBrandForResolve,
          outboundCategory: outboundCategoryForResolve,
          brandSuggestion:
            manufacturerResolution &&
            "configured" in manufacturerResolution &&
            manufacturerResolution.configured
              ? manufacturerResolution.suggestion
              : null,
          categorySuggestion:
            categoryResolution &&
            "configured" in categoryResolution &&
            categoryResolution.configured
              ? categoryResolution.suggestion
              : null,
        }),
        createdAt: Date.now(),
      });
      // Persist rejection state so the Products UI flips to "Rejected — needs
      // fix" until the operator addresses the missing brand/category.
      if (mapped.source.shopify_product_id) {
        const shopDomainForPush =
          getActiveShopifyConnection()?.shopDomain ??
          storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
          "unknown";
        try {
          storage.upsertPushStatus({
            shopDomain: shopDomainForPush,
            shopifyProductId: String(mapped.source.shopify_product_id),
            shopifyVariantId: variant
              ? String(
                  body.product.variants?.find((v) => v.sku === variant.vendor_sku)?.id ??
                    mapped.source.shopify_variant_ids[0] ??
                    "",
                )
              : null,
            shopifySku: String(variant?.vendor_sku ?? mapped.vendor_sku),
            jomashopSku: String(payload.vendor_sku ?? mapped.vendor_sku),
            state: "rejected",
            lastStatus: 422,
            lastError: detail,
            lastPayloadJson: JSON.stringify({
              category: mapped.category,
              outbound_category: payload.category ?? null,
              outbound_brand: payload.brand ?? null,
              price: mapped.jomashop_price,
              msrp: mapped.msrp,
              variants: mapped.variants,
            }),
            lastInvalidParams: JSON.stringify(
              [brandUnresolved ? "brand" : null, categoryUnresolved ? "category" : null].filter(
                Boolean,
              ),
            ),
            lastRejectedCategory: payload.category ? String(payload.category) : null,
            lastRejectedBrand: payload.brand ? String(payload.brand) : null,
            lastPushedAt: Date.now(),
            updatedAt: Date.now(),
          });
        } catch {
          // non-fatal
        }
      }
      return res.status(422).json({
        ok: false,
        stage: "resolve",
        error: detail,
        brandResolution: manufacturerResolution,
        categoryResolution,
        payloadPreview: payload,
        mapped,
        schemaSource: liveSchemaSource,
      });
    }

    // Refuse the push when the schema lookup degraded to a lowercase-only
    // bundled fallback. The /i1/products/ endpoint validates property labels
    // against the live category schema and rejects lowercase keys with
    // "Invalid Record, schema fallback" — the exact error the operator
    // reported. Better to surface the missing schema clearly than to send
    // a payload Jomashop will reject.
    if (pushDebug.fallbackUnsafe) {
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `Pre-flight: live schema unavailable for ${pushDebug.category}`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Push aborted: live category schema for ${pushDebug.category} unavailable and bundled fallback would emit lowercase labels Jomashop rejects`,
        detailsJson: JSON.stringify({ pushDebug, schemaSource: liveSchemaSource }),
        createdAt: Date.now(),
      });
      return res.status(422).json({
        ok: false,
        stage: "preflight_schema",
        error: `Live category schema for "${pushDebug.category}" is unavailable and the bundled fallback for this category would emit lowercase property labels (${pushDebug.propertyKeys.join(", ")}) that Jomashop's /i1 endpoint rejects. Add the category to FALLBACK_CATEGORY_SCHEMAS with exact Title Case labels, or restore /i1/categories/${pushDebug.category} on the Jomashop side, before retrying.`,
        pushDebug,
        schemaSource: liveSchemaSource,
        payloadPreview: payload,
        envelopePreview: buildI1ProductEnvelope(payload, variant),
        mapped,
      });
    }

    // Preflight: refuse the push when a REQUIRED schema field's option list
    // is `options_unverified` — Jomashop's actual accepted set isn't known,
    // so any value we'd send is a guess that will likely trigger
    // "X is not included in the list". This is distinct from the
    // invalid-enum block below (which fires when we DO know the options and
    // none match). We block early with an actionable message so the operator
    // loads the live category schema (or supplies a mapping) before retrying.
    const unverifiedRequiredOptions = pushDebug.unverifiedRequiredOptions || [];
    if (unverifiedRequiredOptions.length > 0) {
      const detail = unverifiedRequiredOptions
        .map(
          (u) =>
            `${u.field}${u.value ? `: tried "${u.value}"` : ""} — Jomashop accepted options unknown`,
        )
        .join("; ");
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `Preflight unverified enum: ${detail.slice(0, 120)}`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Push aborted before API call: required field(s) have unverified Jomashop option list for ${payload.sku ?? mapped.vendor_sku}`,
        detailsJson: JSON.stringify({
          unverifiedRequiredOptions,
          schemaSource: liveSchemaSource,
        }),
        createdAt: Date.now(),
      });
      const fieldNames = unverifiedRequiredOptions.map((u) => u.field).join(", ");
      return res.status(422).json({
        ok: false,
        stage: "preflight_unverified_enum",
        error: `Jomashop accepted option list for required ${pushDebug.category} field(s) ${fieldNames} has not been loaded. Refusing to send a guess that would be rejected. ${detail}. Load the live category schema via /api/jomashop/i1-categories/${overrides.category_id ?? ":id"}/properties (or /api/jomashop/category-enum-options/${pushDebug.category}) and map the value, then retry.`,
        unverifiedRequiredOptions,
        invalidEnums: pushDebug.invalidEnums,
        omittedOptionalFields: pushDebug.omittedOptionalFields,
        missingRequired,
        missingTopLevel,
        warnings: mapped.warnings,
        payloadPreview: payload,
        pushDebug,
        mapped,
        schemaSource: liveSchemaSource,
      });
    }

    // Preflight: refuse the push when a REQUIRED schema field has an enum
    // value that doesn't match Jomashop's accepted list. We surface the
    // exact property, the source value we tried to send, and the accepted
    // options so the operator can fix the metafield or add a mapping
    // without burning a Jomashop rejection round-trip.
    const blockingInvalidEnums = (pushDebug.invalidEnums || []).filter((inv) =>
      missingRequired.includes(inv.field),
    );
    if (blockingInvalidEnums.length > 0) {
      const detail = blockingInvalidEnums
        .map(
          (inv) =>
            `${inv.field}: "${inv.value}" is not accepted (allowed: ${inv.options.slice(0, 12).join(", ")}${inv.options.length > 12 ? ", …" : ""})`,
        )
        .join("; ");
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `Preflight enum: ${detail.slice(0, 120)}`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Push aborted before API call: invalid enum value(s) for ${payload.sku ?? mapped.vendor_sku}`,
        detailsJson: JSON.stringify({
          blockingInvalidEnums,
          allInvalidEnums: pushDebug.invalidEnums,
          omittedOptionalFields: pushDebug.omittedOptionalFields,
          schemaSource: liveSchemaSource,
        }),
        createdAt: Date.now(),
      });
      return res.status(422).json({
        ok: false,
        stage: "preflight_enum",
        error: `Invalid value(s) for required Jomashop ${pushDebug.category} field(s). ${detail}`,
        invalidEnums: pushDebug.invalidEnums,
        omittedOptionalFields: pushDebug.omittedOptionalFields,
        missingRequired,
        missingTopLevel,
        warnings: mapped.warnings,
        payloadPreview: payload,
        pushDebug,
        mapped,
        schemaSource: liveSchemaSource,
      });
    }

    if (missingRequired.length > 0 || missingTopLevel.length > 0) {
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `Validation failed: ${missingRequired.length + missingTopLevel.length} field(s) missing`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Push aborted before API call: missing fields for ${payload.sku ?? mapped.vendor_sku}`,
        detailsJson: JSON.stringify({
          missingRequired,
          missingTopLevel,
          invalidEnums: pushDebug.invalidEnums,
          omittedOptionalFields: pushDebug.omittedOptionalFields,
          schemaSource: liveSchemaSource,
        }),
        createdAt: Date.now(),
      });
      return res.status(422).json({
        ok: false,
        error: "Required fields are missing. Fix the mapping or supply overrides and retry.",
        missingRequired,
        missingTopLevel,
        invalidEnums: pushDebug.invalidEnums,
        omittedOptionalFields: pushDebug.omittedOptionalFields,
        warnings: mapped.warnings,
        payloadPreview: payload,
        pushDebug,
        mapped,
        schemaSource: liveSchemaSource,
      });
    }

    storage.appendLog({
      jobId: job.id,
      level: "info",
      message: `POST /i1/products/ for ${mapped.vendor_sku} (${mapped.category})`,
      detailsJson: JSON.stringify({
        schemaSource: liveSchemaSource,
        vendorSku: payload.vendor_sku,
        manufacturerId: payload.manufacturer_id,
        categoryId: payload.category_id,
      }),
      createdAt: Date.now(),
    });

    // Try the new /i1/products/ envelope first (portal-style payload with
    // product.manufacturer_id + product.category_id + stock block). Fall
    // back to the legacy /v1/products flat payload only when /i1 returns
    // 404 (endpoint not deployed) so behaviour on existing tenants is
    // unchanged.
    const envelope = buildI1ProductEnvelope(payload, variant);
    let productResp = await jomashopRequest({
      method: "POST",
      path: "/i1/products/",
      body: envelope,
    });
    let pushPath = "/i1/products/";
    if (!productResp.ok && productResp.status === 404) {
      storage.appendLog({
        jobId: job.id,
        level: "warn",
        message: `/i1/products/ returned 404 — falling back to /v1/products`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      productResp = await jomashopRequest({
        method: "POST",
        path: "/v1/products",
        body: payload,
      });
      pushPath = "/v1/products";
    }

    if (!productResp.ok) {
      const errBody = productResp.errorData as
        | { error?: string; errors?: string[]; invalid_params?: string[] }
        | undefined;
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `POST ${pushPath} failed (${productResp.status})`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Jomashop product push failed (${productResp.status}) via ${pushPath}`,
        detailsJson: JSON.stringify({ error: productResp.error, errorData: errBody, payload, pushPath }),
        createdAt: Date.now(),
      });
      // Record rejected state so the Products UI can show "Rejected — needs
      // fix" and the user only sees this row on the "Rejected/Needs fix"
      // filter until the next retry succeeds.
      if (mapped.source.shopify_product_id) {
        const errStr = [
          errBody?.error,
          ...(errBody?.errors ?? []),
          ...(errBody?.invalid_params ?? []).map((p) => `invalid_param: ${p}`),
        ]
          .filter(Boolean)
          .join("; ");
        const shopDomainForPush =
          getActiveShopifyConnection()?.shopDomain ??
          storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
          "unknown";
        try {
          storage.upsertPushStatus({
            shopDomain: shopDomainForPush,
            shopifyProductId: String(mapped.source.shopify_product_id),
            shopifyVariantId: variant
              ? String(body.product.variants?.find((v) => v.sku === variant.vendor_sku)?.id ?? mapped.source.shopify_variant_ids[0] ?? "")
              : null,
            shopifySku: String(variant?.vendor_sku ?? mapped.vendor_sku),
            jomashopSku: String(payload.vendor_sku ?? mapped.vendor_sku),
            state: "rejected",
            lastStatus: productResp.status,
            lastError: errStr || productResp.error || `HTTP ${productResp.status}`,
            lastPayloadJson: JSON.stringify({
              category: mapped.category,
              outbound_category: payload.category ?? null,
              outbound_brand: payload.brand ?? null,
              price: mapped.jomashop_price,
              msrp: mapped.msrp,
              variants: mapped.variants,
            }),
            // Persist rejection context so the UI can render
            // "Jomashop rejected category=Footwear, brand=Tods" and the
            // readiness check can detect when the next attempt actually
            // changes the offending field.
            lastInvalidParams: errBody?.invalid_params && errBody.invalid_params.length > 0
              ? JSON.stringify(errBody.invalid_params)
              : null,
            lastRejectedCategory: payload.category ? String(payload.category) : null,
            lastRejectedBrand: payload.brand ? String(payload.brand) : null,
            lastPushedAt: Date.now(),
            updatedAt: Date.now(),
          });
        } catch {
          // non-fatal
        }
      }
      return res.status(502).json({
        ok: false,
        stage: "product_post",
        error: errBody?.error || productResp.error,
        errors: errBody?.errors,
        invalidParams: errBody?.invalid_params,
        status: productResp.status,
        payloadSent: payload,
        payloadPreview: payload,
        envelopePreview: envelope,
        pushPath,
        brandResolution: manufacturerResolution,
        categoryResolution,
        mapped,
        pushDebug,
        schemaSource: liveSchemaSource,
      });
    }

    // Persist the SKU mapping so subsequent operations can find it.
    if (mapped.source.shopify_product_id) {
      const variantId =
        (variant && body.product.variants?.find((v) => v.sku === variant.vendor_sku)?.id) ??
        mapped.source.shopify_variant_ids[0];
      storage.upsertSkuMapping({
        shopifyVariantId: String(variantId ?? variant?.vendor_sku ?? mapped.vendor_sku),
        shopifyProductId: String(mapped.source.shopify_product_id),
        shopifySku: String(variant?.vendor_sku ?? mapped.vendor_sku),
        jomashopSku: String(payload.vendor_sku),
        jomashopProductId: null,
        categoryKey: mapped.category.toLowerCase(),
        status: "active",
        lastError: null,
        updatedAt: Date.now(),
      });
      // Track pushed state so the Products UI can hide this row from the
      // "Not pushed" filter, label its button "Update on Jomashop", and so
      // the inventory webhook can target this SKU on future updates.
      const shopDomainForPush =
        getActiveShopifyConnection()?.shopDomain ??
        storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
        "unknown";
      try {
        storage.upsertPushStatus({
          shopDomain: shopDomainForPush,
          shopifyProductId: String(mapped.source.shopify_product_id),
          shopifyVariantId: String(variantId ?? mapped.source.shopify_variant_ids[0] ?? ""),
          shopifySku: String(variant?.vendor_sku ?? mapped.vendor_sku),
          jomashopSku: String(payload.vendor_sku),
          state: "pushed",
          lastStatus: productResp.status,
          lastError: null,
          lastPayloadJson: JSON.stringify({
            category: mapped.category,
            outbound_category: payload.category ?? null,
            outbound_brand: payload.brand ?? null,
            price: mapped.jomashop_price,
            msrp: mapped.msrp,
            variants: mapped.variants,
          }),
          // Clear stale rejection markers on successful push so the row
          // does not flicker back into "Rejected / Needs fix".
          lastInvalidParams: null,
          lastRejectedCategory: null,
          lastRejectedBrand: null,
          lastPushedAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch {
        // non-fatal
      }
    }

    // Optionally push inventory for this SKU.
    let inventoryResp: { ok: boolean; status: number; data?: unknown; error?: string } | null = null;
    if (body.pushInventory !== false && variant) {
      const invBody = {
        price: variant.jomashop_price ?? mapped.jomashop_price,
        status: variant.status,
        quantity: variant.quantity,
      };
      inventoryResp = await jomashopRequest({
        method: "PUT",
        path: `/v1/inventory/${encodeURIComponent(variant.vendor_sku)}`,
        body: invBody,
      });
      storage.appendLog({
        jobId: job.id,
        level: inventoryResp.ok ? "info" : "warn",
        message: inventoryResp.ok
          ? `PUT /v1/inventory/${variant.vendor_sku} ok`
          : `PUT /v1/inventory/${variant.vendor_sku} failed (${inventoryResp.status})`,
        detailsJson: JSON.stringify({ body: invBody, error: inventoryResp.error }),
        createdAt: Date.now(),
      });
    }

    storage.updateSyncJob(job.id, {
      status: "success",
      finishedAt: Date.now(),
      successItems: 1,
      summary: inventoryResp
        ? `Product POST ok; inventory PUT ${inventoryResp.ok ? "ok" : "failed"}`
        : "Product POST ok",
    });

    return res.json({
      ok: true,
      jobId: job.id,
      schemaSource: liveSchemaSource,
      mapped,
      payloadPreview: payload,
      envelopePreview: envelope,
      pushPath,
      brandResolution: manufacturerResolution,
      categoryResolution,
      pushDebug,
      product: { status: productResp.status, data: productResp.data },
      inventory: inventoryResp
        ? { status: inventoryResp.status, ok: inventoryResp.ok, data: inventoryResp.data, error: inventoryResp.error }
        : null,
      warnings: mapped.warnings,
    });
  });

  // ---------- Bulk repair workflow (XLSX export/import/apply/push) ----------
  registerBulkRepairRoutes(app);

  // ---------- Category mapping workflow (Shopify code → Jomashop category) ----------
  registerCategoryMappingRoutes(app);

  // ---------- Brand mapping workflow (Shopify brand → exact Jomashop brand) ----------
  registerBrandMappingRoutes(app);

  // ---------- Enum mapping workflow (source value → exact Jomashop option) ----------
  registerEnumMappingRoutes(app);

  // Debug + dashboard: walks the cached product preview and aggregates every
  // required enum field that is currently unresolved (no live option list AND
  // no verified operator-supplied mapping). For each unresolved (category,
  // field) pair it ALSO attempts to load the live Jomashop accepted option
  // list via /i1/categories/:id/properties so the operator/UI can pick an
  // exact accepted value when creating the verified override. Used by the
  // Products page "Fix mapping" panel and by the audit dashboard.
  app.get("/api/jomashop/required-enum-audit", async (_req, res) => {
    const stores = storage.listStores();
    const connected = stores.find((s) => s.oauthStatus === "connected");
    const shopDomain = connected?.shopDomain ?? null;
    const cache = shopDomain ? storage.getProductCache(shopDomain) : null;
    if (!cache) {
      return res.json({
        ok: true,
        shopDomain,
        totalProducts: 0,
        unresolvedFields: [],
        resolvedFields: [],
        note:
          "No cached product preview. Open the Products page (or POST /api/products/refresh) to populate the cache.",
      });
    }
    let payload: any = null;
    try {
      payload = JSON.parse(cache.payloadJson);
    } catch {
      return res.json({
        ok: false,
        error: "Cached payload is not valid JSON. Refresh from Shopify to rebuild.",
      });
    }
    const allMapped: any[] = Array.isArray(payload?.mapped) ? payload.mapped : [];
    type Entry = {
      jomashop_category: string;
      jomashop_field: string;
      source_value: string;
      normalized_source_value: string;
      product_count: number;
      sample_skus: string[];
      sample_titles: string[];
      current_override: string | null;
      current_override_source: "operator" | "built-in" | null;
      current_override_verified: boolean;
      accepted_options: string[] | null;
      accepted_options_source: "live" | "fallback" | "unknown";
      resolved: boolean;
      remediation: string;
    };
    const byKey = new Map<string, Entry>();
    for (const m of allMapped) {
      const cat = String(m.category || "").trim();
      const unverified = Array.isArray(m.unverified_required_options)
        ? m.unverified_required_options
        : [];
      for (const u of unverified) {
        const field = String((u as any)?.field || "").trim();
        const sourceValue =
          (u as any)?.value !== undefined && (u as any)?.value !== null
            ? String((u as any).value)
            : String(m.raw_category || "");
        if (!cat || !field) continue;
        const normValue = normalizeEnumSourceValue(sourceValue);
        const key = `${cat.toLowerCase()}|${field.toLowerCase()}|${normValue}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.product_count += 1;
          if (existing.sample_skus.length < 5 && m.vendor_sku) {
            existing.sample_skus.push(String(m.vendor_sku));
          }
          if (existing.sample_titles.length < 5 && m.name) {
            existing.sample_titles.push(String(m.name));
          }
        } else {
          const override = lookupEnumOverride(cat, field, sourceValue);
          byKey.set(key, {
            jomashop_category: cat,
            jomashop_field: field,
            source_value: sourceValue || "(empty)",
            normalized_source_value: normValue,
            product_count: 1,
            sample_skus: m.vendor_sku ? [String(m.vendor_sku)] : [],
            sample_titles: m.name ? [String(m.name)] : [],
            current_override: override?.jomashopOption ?? null,
            current_override_source: override?.source ?? null,
            current_override_verified: override?.verified ?? false,
            accepted_options: null,
            accepted_options_source: "unknown",
            resolved: Boolean(override),
            remediation: "",
          });
        }
      }
    }

    // Decorate every unique (category, field) with the live accepted options
    // list when available — folded into each entry. We cache the result per
    // category so we don't refetch /i1 for every grouped source value.
    type FieldAccepted = {
      options: string[];
      source: "live" | "fallback" | "unknown";
      v1Error?: string;
    };
    const acceptedByCatField = new Map<string, FieldAccepted>();
    async function loadAccepted(category: string): Promise<Map<string, FieldAccepted>> {
      const out = new Map<string, FieldAccepted>();
      const fallback = (FALLBACK_CATEGORY_SCHEMAS as any)[category] || [];
      for (const f of fallback) {
        if (f?.type === "enum" && Array.isArray(f.options) && f.options.length > 0) {
          const verified = f.options_unverified !== true;
          out.set(normalizeEnumFieldKey(f.field), {
            options: [...f.options],
            source: verified ? "fallback" : "unknown",
          });
        }
      }
      if (jomashopConfigured()) {
        // Primary verified source: GET /v1/categories/:name (data.values).
        const v1 = await getV1CategoryDescriptors(category).catch(() => null);
        if (v1 && v1.ok && v1.descriptors.length > 0) {
          for (const p of v1.descriptors) {
            if (Array.isArray(p.options) && p.options.length > 0) {
              out.set(normalizeEnumFieldKey(p.field), {
                options: [...p.options],
                source: "live",
              });
            }
          }
        } else if (v1 && !v1.ok) {
          // Surface the v1 error on every enum field for this category so the
          // operator can see why the verified list isn't available.
          for (const [k, existing] of Array.from(out.entries())) {
            out.set(k, { ...existing, v1Error: v1.error });
          }
        }
        // Secondary: /i1 by category id — only fills fields v1 didn't cover.
        const catResolve = await resolveCategoryRecord(category).catch(() => null);
        const liveId =
          catResolve && (catResolve as any).ok && (catResolve as any).configured && (catResolve as any).exact
            ? (catResolve as any).exact.id
            : null;
        if (liveId !== null) {
          const propsResp = await getCategoryPropertiesI1(liveId).catch(() => null);
          if (propsResp && (propsResp as any).ok && (propsResp as any).data) {
            const liveSchema = normalizeI1CategorySchema((propsResp as any).data);
            for (const p of liveSchema) {
              if (Array.isArray(p.options) && p.options.length > 0) {
                const key = normalizeEnumFieldKey(p.field);
                const existing = out.get(key);
                if (existing && existing.source === "live") continue;
                out.set(key, {
                  options: [...p.options],
                  source: "live",
                });
              }
            }
          }
        }
      }
      return out;
    }

    const seenCats = new Set<string>();
    for (const e of Array.from(byKey.values())) seenCats.add(e.jomashop_category);
    for (const c of Array.from(seenCats)) {
      try {
        const m = await loadAccepted(c);
        for (const [field, accepted] of Array.from(m.entries())) {
          acceptedByCatField.set(`${c.toLowerCase()}|${field}`, accepted);
        }
      } catch {
        // ignore — entries fall back to unknown
      }
    }

    for (const e of Array.from(byKey.values())) {
      const k = `${e.jomashop_category.toLowerCase()}|${normalizeEnumFieldKey(e.jomashop_field)}`;
      const accepted = acceptedByCatField.get(k);
      if (accepted) {
        e.accepted_options = accepted.options;
        e.accepted_options_source = accepted.source;
      }
      if (e.resolved) {
        e.remediation = `Resolved by ${e.current_override_source ?? "override"} → "${e.current_override}".`;
      } else if (e.accepted_options_source === "live") {
        e.remediation = `Add a verified mapping: POST /api/enum-mapping/overrides {jomashop_category: "${e.jomashop_category}", jomashop_field: "${e.jomashop_field}", source_value: "${e.source_value}", jomashop_option: "<pick one>", accepted_options: ${JSON.stringify(e.accepted_options)}}.`;
      } else {
        e.remediation = `Live accepted option list unavailable for ${e.jomashop_category}/${e.jomashop_field}. Add a verified mapping with operator_verified: true once you confirm the Jomashop-accepted target: POST /api/enum-mapping/overrides {jomashop_category: "${e.jomashop_category}", jomashop_field: "${e.jomashop_field}", source_value: "${e.source_value}", jomashop_option: "<exact Jomashop label>", operator_verified: true}.`;
      }
    }

    const entries = Array.from(byKey.values()).sort(
      (a, b) => b.product_count - a.product_count,
    );
    res.json({
      ok: true,
      shopDomain,
      totalProducts: allMapped.length,
      unresolvedFields: entries.filter((e) => !e.resolved),
      resolvedFields: entries.filter((e) => e.resolved),
      builtInSeedCount: Object.keys(BUILT_IN_ENUM_OVERRIDES).length,
      builtInSeeds: listBuiltInSeeds(),
    });
  });

  // ---------- Brand & category resolution audit (XLSX export / import / apply) ----------
  registerResolutionAuditRoutes(app);

  // ---------- Bulk Jomashop mapping XLSX workflow ----------
  // Aggregates every unresolved Jomashop required/recommended enum mapping
  // across the cached product preview into a single XLSX. Operator fills the
  // accepted Jomashop value (validated against the live v1 accepted-options
  // list on upload), then the apply step creates verified enum_overrides,
  // invalidates the product cache so the next preview rebuild picks up the
  // new mappings for ALL existing cached products in bulk, and optionally
  // writes the accepted value back to the Shopify product metafield.
  registerJomashopMappingExcelRoutes(app);

  // ---------- Per-product Jomashop field XLSX workflow ----------
  // Complementary to the grouped enum-override workflow above. Exports a
  // workbook with one row per product (or variant) and one sheet per
  // Jomashop category; operator fills the live-schema fields and uploads.
  // Valid values are written to Shopify metafields (jomashop.<key>) and the
  // cached preview is invalidated.
  registerJomashopProductFieldExcelRoutes(app);
  registerInlineFieldRepairRoutes(app);

  // ---------- Shopify webhooks (public, HMAC-verified) ----------
  registerWebhookRoutes(app);

  // ---------- Webhook registration (operator-triggered) ----------
  //
  // POST /api/shopify/register-webhooks
  //   body: { confirm: true }
  //
  // Registers the inventory_levels/update and products/update webhooks
  // against the connected store using the live APP_URL. Existing
  // identical (topic, address) webhooks are detected and reported instead
  // of duplicated.
  app.post("/api/shopify/register-webhooks", async (req, res) => {
    if (!req.body?.confirm) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing confirmation. Set `confirm: true` to acknowledge this will register Shopify webhooks against the connected store.",
      });
    }
    const result = await registerShopifyWebhooks({ appUrl: appBaseUrl(req) });
    storage.appendLog({
      level: result.ok ? "info" : "warn",
      message: `Shopify webhook registration: ${result.created.length} created, ${result.existing.length} existing, ${result.errors.length} error(s)`,
      detailsJson: JSON.stringify(result),
      createdAt: Date.now(),
    });
    res.json(result);
  });

  // Surfaced for the Setup page so the operator can copy URLs / Powershell
  // them into Shopify Partners if they prefer manual setup.
  app.get("/api/shopify/webhook-urls", (req, res) => {
    const base = appBaseUrl(req).replace(/\/$/, "");
    res.json({
      hmacEnvVar: "SHOPIFY_CLIENT_SECRET",
      hmacHeader: "X-Shopify-Hmac-Sha256",
      topics: [
        { topic: "inventory_levels/update", url: `${base}/webhooks/shopify/inventory-levels-update` },
        { topic: "products/update", url: `${base}/webhooks/shopify/products-update` },
      ],
    });
  });

  // ---------- DB-backed read endpoints used by the UI ----------
  app.get("/api/sku-mappings", (_req, res) => res.json(storage.listSkuMappings()));
  app.get("/api/category-mappings", (_req, res) => res.json(storage.listCategoryMappings()));
  app.get("/api/sync-jobs", (_req, res) => res.json(storage.listSyncJobs()));
  app.get("/api/logs", (_req, res) => res.json(storage.listLogs()));
  app.get("/api/imported-orders", (_req, res) => res.json(storage.listImportedOrders()));
  app.get("/api/stores", (_req, res) => res.json(storage.listStores()));
  app.get("/api/push-statuses", (_req, res) => res.json(storage.listPushStatuses()));
  app.get("/api/webhook-events", (_req, res) => res.json(storage.listWebhookEvents()));

  return httpServer;
}
