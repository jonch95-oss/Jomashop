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
  SAMPLE_SHOPIFY_PRODUCTS,
  type ShopifyProduct,
} from "./mapping";

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
    const shop = String(req.query.shop || "luxesupply.myshopify.com");
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
      // SECURITY NOTE: the scaffold does not persist the raw access_token by default.
      // Configure a secret manager or DB encryption before storing.
      storage.upsertStore({
        shopDomain: shop,
        displayName: "LuxeSupply",
        oauthStatus: "connected",
        scopes: body.scope,
        installedAt: Date.now(),
        tokenStorage: "env",
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
  app.post("/api/sync/preview-products", async (req, res) => {
    const products = (req.body?.products as ShopifyProduct[]) || SAMPLE_SHOPIFY_PRODUCTS;

    // Pull schemas (live if available) for the three supported categories.
    const schemas: Record<SupportedCategory, any> = { Shoes: null, Handbags: null, Clothing: null };
    for (const cat of SUPPORTED_CATEGORIES) {
      const { source, schema } = await resolveCategorySchema(cat);
      schemas[cat] = { source, schema };
    }

    const mapped = products.map((p) => {
      const cat = (mapShopifyToJomashop(p, []).category) as SupportedCategory;
      const schemaWrap = schemas[cat];
      const props =
        (schemaWrap?.schema?.properties as Array<any>) ||
        FALLBACK_CATEGORY_SCHEMAS[cat].map((f) => ({ field: f.field, required: f.required, type: f.type, options: f.options }));
      return mapShopifyToJomashop(p, props);
    });

    res.json({
      schemas,
      mapped,
      count: mapped.length,
      note: "Preview only. No data was sent to Jomashop.",
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
    const { payload, variant, missingRequired } = buildJomashopProductPayload(
      mapped,
      body.variantSku,
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

    if (missingRequired.length > 0) {
      storage.updateSyncJob(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        errorItems: 1,
        summary: `Validation failed: ${missingRequired.length} required field(s) missing`,
      });
      storage.appendLog({
        jobId: job.id,
        level: "error",
        message: `Push aborted before API call: missing required fields for ${mapped.vendor_sku}`,
        detailsJson: JSON.stringify({ missingRequired, schemaSource: source }),
        createdAt: Date.now(),
      });
      return res.status(422).json({
        ok: false,
        error: "Required category fields are missing. Fix the mapping and retry.",
        missingRequired,
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
        detailsJson: JSON.stringify({ error: productResp.error, payload }),
        createdAt: Date.now(),
      });
      return res.status(502).json({
        ok: false,
        stage: "product_post",
        error: productResp.error,
        status: productResp.status,
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

  // ---------- DB-backed read endpoints used by the UI ----------
  app.get("/api/sku-mappings", (_req, res) => res.json(storage.listSkuMappings()));
  app.get("/api/category-mappings", (_req, res) => res.json(storage.listCategoryMappings()));
  app.get("/api/sync-jobs", (_req, res) => res.json(storage.listSyncJobs()));
  app.get("/api/logs", (_req, res) => res.json(storage.listLogs()));
  app.get("/api/imported-orders", (_req, res) => res.json(storage.listImportedOrders()));
  app.get("/api/stores", (_req, res) => res.json(storage.listStores()));

  return httpServer;
}
