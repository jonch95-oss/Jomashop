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
} from "./jomashop";
import {
  FALLBACK_CATEGORY_SCHEMAS,
  SUPPORTED_CATEGORIES,
  type SupportedCategory,
} from "@shared/schema";
import {
  mapShopifyToJomashop,
  buildJomashopProductPayload,
  isSampleProduct,
  normalizeCategoryCode,
  SAMPLE_SHOPIFY_PRODUCTS,
  type PushOverrides,
  type ShopifyProduct,
} from "./mapping";
import {
  encryptToken,
  fetchShopifyProducts,
  getActiveShopifyConnection,
  MAPPER_VERSION,
} from "./shopify";
import { registerBulkRepairRoutes } from "./bulk_repair";
import { registerCategoryMappingRoutes, lookupCategoryOverride } from "./category_mapping";
import { registerBrandMappingRoutes, lookupBrandOverride, normalizeBrandKey } from "./brand_mapping";
import { registerWebhookRoutes, registerShopifyWebhooks } from "./webhooks";

// -------------------- helpers --------------------

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

  // ---------- Health ----------
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

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

  app.get("/api/jomashop/categories/:name", async (req, res) => {
    const name = String(req.params.name);
    if (!SUPPORTED_CATEGORIES.includes(name as SupportedCategory)) {
      return res.status(400).json({ error: `Unsupported category. Use one of: ${SUPPORTED_CATEGORIES.join(", ")}` });
    }
    const { source, schema } = await resolveCategorySchema(name as SupportedCategory);
    res.json({ source, name, schema });
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
    const schemas: Record<SupportedCategory, any> = { Shoes: null, Handbags: null, Clothing: null };
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

    const mapped = products.map((p) => {
      const tmp = mapShopifyToJomashop(p, []);
      // Apply operator-supplied category override (XLSX-driven). When set, the
      // override pins the SupportedCategory used for schema resolution AND the
      // suggested_category surfaced to the UI / readiness check. This is how a
      // single mapping for "DRSH" → "Dress Shirts" flips every dress shirt to
      // ready without a full Shopify re-pagination.
      const override = lookupCategoryOverride(tmp.raw_category);
      const cat = (override?.supportedCategory ?? tmp.category) as SupportedCategory;
      const schemaWrap = schemas[cat];
      const props =
        (schemaWrap?.schema?.properties as Array<any>) ||
        FALLBACK_CATEGORY_SCHEMAS[cat].map((f) => ({ field: f.field, required: f.required, type: f.type, options: f.options }));
      const m = mapShopifyToJomashop(p, props, override?.supportedCategory ?? undefined);
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
      } else if (liveCategoryNames && liveCategoryNames.length > 0) {
        // The category override sent at push time may differ from the
        // inferred enum — but at preview time we only have m.category +
        // m.suggested_category. Treat ready iff one of those is in the list.
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
        readiness,
      };
    });

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
      note: usingSamples
        ? "Sample fixtures only — connect Shopify and load live products before pushing to Jomashop."
        : `Live Shopify products from ${shopDomain ?? "connected store"}. No data sent to Jomashop.`,
    };
  }

  app.post("/api/sync/preview-products", async (req, res) => {
    const supplied = req.body?.products as ShopifyProduct[] | undefined;
    const forceRefresh = req.body?.forceRefresh === true || req.body?.useCache === false;
    const rawLimit = req.body?.limit;
    const maxProducts =
      rawLimit === undefined || rawLimit === null || rawLimit === "" || rawLimit === "all"
        ? undefined
        : Math.max(parseInt(String(rawLimit), 10) || 0, 1);
    const pageSize = Math.min(
      Math.max(parseInt(String(req.body?.pageSize ?? "100"), 10) || 100, 1),
      250,
    );

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
              return res.json({
                ...payload,
                fromCache: true,
                lastRefreshedAt: cached.fetchedAt,
              });
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

    const preview = await buildPreview({
      suppliedProducts: supplied,
      forceRefresh,
      pageSize,
      maxProducts,
    });

    // Cache successful live previews so the next page load is instant.
    // Sample/empty previews are not cached so we don't pin demo data.
    if (preview.dataSource === "live" && preview.shopDomain) {
      try {
        storage.upsertProductCache({
          shopDomain: preview.shopDomain,
          fetchedCount: preview.fetchedCount,
          pageCount: preview.pageCount,
          hasMore: preview.hasMore,
          payloadJson: JSON.stringify(preview),
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

    res.json({ ...preview, fromCache: false, lastRefreshedAt: Date.now() });
  });

  // Read-only fast path: return the cached preview without ever calling
  // Shopify. The Products page calls this on mount so initial load is
  // immediate. Returns null payload if no cache exists yet.
  app.get("/api/products/cache", (_req, res) => {
    const conn = getActiveShopifyConnection();
    const shopDomain =
      conn?.shopDomain ??
      storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
      null;
    if (!shopDomain) return res.json({ cached: false, reason: "no-shopify-connection" });
    const cached = storage.getProductCache(shopDomain);
    if (!cached) return res.json({ cached: false, shopDomain });
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
      return res.json({
        cached: true,
        shopDomain,
        lastRefreshedAt: cached.fetchedAt,
        fetchedCount: cached.fetchedCount,
        pageCount: cached.pageCount,
        hasMore: cached.hasMore,
        ...payload,
        fromCache: true,
      });
    } catch (err) {
      return res.json({ cached: false, shopDomain, error: (err as Error).message });
    }
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
    const preview = await buildPreview({
      suppliedProducts: undefined,
      forceRefresh: true,
      pageSize,
      maxProducts,
    });
    if (preview.dataSource === "live" && preview.shopDomain) {
      storage.upsertProductCache({
        shopDomain: preview.shopDomain,
        fetchedCount: preview.fetchedCount,
        pageCount: preview.pageCount,
        hasMore: preview.hasMore,
        payloadJson: JSON.stringify(preview),
        fetchedAt: Date.now(),
      });
    }
    res.json({ ...preview, fromCache: false, lastRefreshedAt: Date.now() });
  });

  // Direct live Shopify product fetch (debug / admin use). Returns the
  // normalized ShopifyProduct[] without running through Jomashop mapping.
  // Paginates through ALL products by default; pass ?limit=N to cap.
  app.get("/api/shopify/products", async (req, res) => {
    const rawLimit = req.query.limit;
    const maxProducts =
      rawLimit === undefined || rawLimit === "" || rawLimit === "all"
        ? undefined
        : Math.max(parseInt(String(rawLimit), 10) || 0, 1);
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
    const result = await fetchShopifyProducts({ pageSize, maxProducts });
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

    // Resolve live (or fallback) schema for the inferred/forced category.
    const tmpMap = mapShopifyToJomashop(body.product, [], body.forcedCategory);
    const { source, schema } = await resolveCategorySchema(tmpMap.category);
    const schemaProps = (schema as { properties?: Array<any> } | undefined)?.properties;
    const props =
      schemaProps ||
      FALLBACK_CATEGORY_SCHEMAS[tmpMap.category].map((f) => ({
        field: f.field,
        required: f.required,
        type: f.type,
        options: f.options,
      }));

    const mapped = mapShopifyToJomashop(body.product, props, body.forcedCategory);
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
    const { payload, variant, missingRequired, missingTopLevel } = buildJomashopProductPayload(
      mapped,
      body.variantSku,
      overrides,
    );

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
        detailsJson: JSON.stringify({ missingRequired, missingTopLevel, schemaSource: source }),
        createdAt: Date.now(),
      });
      return res.status(422).json({
        ok: false,
        error: "Required fields are missing. Fix the mapping or supply overrides and retry.",
        missingRequired,
        missingTopLevel,
        warnings: mapped.warnings,
        payloadPreview: payload,
        mapped,
        schemaSource: source,
      });
    }

    storage.appendLog({
      jobId: job.id,
      level: "info",
      message: `POST /v1/products for ${mapped.vendor_sku} (${mapped.category})`,
      detailsJson: JSON.stringify({ schemaSource: source, vendorSku: payload.vendor_sku }),
      createdAt: Date.now(),
    });

    const productResp = await jomashopRequest({
      method: "POST",
      path: "/v1/products",
      body: payload,
    });

    if (!productResp.ok) {
      const errBody = productResp.errorData as
        | { error?: string; errors?: string[]; invalid_params?: string[] }
        | undefined;
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `POST /v1/products failed (${productResp.status})`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Jomashop product push failed (${productResp.status})`,
        detailsJson: JSON.stringify({ error: productResp.error, errorData: errBody, payload }),
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
        mapped,
        schemaSource: source,
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
      schemaSource: source,
      mapped,
      payloadPreview: payload,
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
