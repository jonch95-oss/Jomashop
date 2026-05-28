// Shopify webhook endpoints.
//
// Webhooks are mounted outside the /api prefix so they bypass the admin
// token gate (Shopify must be able to deliver to them publicly). HMAC is
// verified against SHOPIFY_CLIENT_SECRET using the X-Shopify-Hmac-Sha256
// header against the raw request body.
//
// Topics handled:
//   - inventory_levels/update — updates Jomashop inventory for any SKU
//     previously marked "pushed" in push_statuses.
//   - products/update — refreshes price/quantity for pushed variants of the
//     given product.
//
// The endpoints NEVER create new Jomashop products from a webhook. Inventory
// auto-sync only fires for SKUs the operator already pushed.

import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { jomashopConfigured, jomashopRequest } from "./jomashop";
import { getActiveShopifyConnection } from "./shopify";

type RawBodyRequest = Request & { rawBody?: Buffer | string | unknown };

function rawBodyBuffer(req: RawBodyRequest): Buffer | null {
  const rb = req.rawBody;
  if (!rb) return null;
  if (Buffer.isBuffer(rb)) return rb;
  if (typeof rb === "string") return Buffer.from(rb, "utf8");
  return null;
}

function verifyShopifyWebhookHmac(req: RawBodyRequest): { ok: boolean; reason?: string } {
  const secret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!secret) return { ok: false, reason: "SHOPIFY_CLIENT_SECRET not set" };
  const headerHmac =
    (req.headers["x-shopify-hmac-sha256"] as string | undefined) ||
    (req.headers["X-Shopify-Hmac-Sha256"] as unknown as string | undefined);
  if (!headerHmac) return { ok: false, reason: "missing X-Shopify-Hmac-Sha256 header" };
  const buf = rawBodyBuffer(req);
  if (!buf) return { ok: false, reason: "raw request body unavailable" };
  const digest = crypto.createHmac("sha256", secret).update(buf).digest("base64");
  try {
    const a = Buffer.from(digest);
    const b = Buffer.from(headerHmac);
    if (a.length !== b.length) return { ok: false, reason: "hmac length mismatch" };
    return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "hmac mismatch" };
  } catch {
    return { ok: false, reason: "hmac comparison error" };
  }
}

function hashBody(req: RawBodyRequest): string | null {
  const buf = rawBodyBuffer(req);
  if (!buf) return null;
  return crypto.createHash("sha256").update(buf).digest("hex");
}

type PushStatusPayload = {
  price?: number | null;
  msrp?: number | null;
  category?: string;
  variants?: Array<{
    vendor_sku: string;
    price?: number | null;
    jomashop_price?: number | null;
    quantity?: number;
    status?: string;
  }>;
};

function inventoryStatusFor(qty: number | undefined | null): "active" | "out_of_stock" | "inactive" {
  if (qty === undefined || qty === null) return "inactive";
  if (qty <= 0) return "out_of_stock";
  return "active";
}

function numericShopifyId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).match(/(\d+)$/);
  return m ? m[1] : null;
}

async function syncShopifyProductVisibilityForInventory(opts: {
  shopDomain: string | null;
  shopifyProductId: string | number | null | undefined;
  fallbackQuantity: number | null;
}): Promise<{ ok: boolean; desiredStatus?: "ACTIVE" | "DRAFT"; currentStatus?: string; totalQuantity?: number; message: string; error?: string }> {
  const productId = numericShopifyId(opts.shopifyProductId);
  if (!productId) {
    return { ok: false, message: "No Shopify product id on pushed SKU; visibility unchanged." };
  }
  const conn = getActiveShopifyConnection();
  if (!conn) {
    return { ok: false, message: "No Shopify connection; visibility unchanged." };
  }
  if (opts.shopDomain && conn.shopDomain !== opts.shopDomain) {
    return { ok: false, message: `Active Shopify connection is ${conn.shopDomain}, not ${opts.shopDomain}; visibility unchanged.` };
  }

  let totalQuantity = opts.fallbackQuantity ?? 0;
  let currentStatus = "";
  try {
    const productResp = await fetch(
      `https://${conn.shopDomain}/admin/api/2024-10/products/${encodeURIComponent(productId)}.json?fields=id,status,variants`,
      { headers: { "X-Shopify-Access-Token": conn.accessToken } },
    );
    if (productResp.ok) {
      const body = (await productResp.json()) as {
        product?: { status?: string; variants?: Array<{ inventory_quantity?: number | null }> };
      };
      currentStatus = String(body.product?.status || "");
      const variants = Array.isArray(body.product?.variants) ? body.product!.variants! : [];
      if (variants.length > 0) {
        totalQuantity = variants.reduce((sum, v) => {
          const q = typeof v.inventory_quantity === "number" ? v.inventory_quantity : 0;
          return sum + q;
        }, 0);
      }
    }
  } catch {
    // Fall back to the webhook/manual-sync quantity for a best-effort status.
  }

  const desiredStatus: "ACTIVE" | "DRAFT" = totalQuantity > 0 ? "ACTIVE" : "DRAFT";
  const normalizedCurrent = currentStatus.toUpperCase();
  if (normalizedCurrent === desiredStatus) {
    return {
      ok: true,
      desiredStatus,
      currentStatus,
      totalQuantity,
      message: `Shopify product already ${desiredStatus.toLowerCase()} (total qty=${totalQuantity}).`,
    };
  }
  if (normalizedCurrent === "ARCHIVED") {
    return {
      ok: false,
      desiredStatus,
      currentStatus,
      totalQuantity,
      message: "Shopify product is archived; visibility unchanged.",
    };
  }

  const gid = `gid://shopify/Product/${productId}`;
  const mutation = `
    mutation UpdateProductStatus($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `;
  try {
    const resp = await fetch(`https://${conn.shopDomain}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": conn.accessToken,
      },
      body: JSON.stringify({ query: mutation, variables: { input: { id: gid, status: desiredStatus } } }),
    });
    const body = (await resp.json().catch(() => null)) as
      | { errors?: Array<{ message: string }>; data?: { productUpdate?: { userErrors?: Array<{ message: string }>; product?: { status?: string } } } }
      | null;
    const userErrors = body?.data?.productUpdate?.userErrors ?? [];
    if (!resp.ok || (body?.errors && body.errors.length > 0) || userErrors.length > 0) {
      const error =
        body?.errors?.map((e) => e.message).join("; ") ||
        userErrors.map((e) => e.message).join("; ") ||
        `Shopify productUpdate failed (${resp.status})`;
      return { ok: false, desiredStatus, currentStatus, totalQuantity, message: error, error };
    }
    return {
      ok: true,
      desiredStatus,
      currentStatus: body?.data?.productUpdate?.product?.status ?? desiredStatus,
      totalQuantity,
      message:
        desiredStatus === "DRAFT"
          ? `Shopify product drafted because total quantity is ${totalQuantity}.`
          : `Shopify product reactivated because total quantity is ${totalQuantity}.`,
    };
  } catch (err) {
    const error = (err as Error).message;
    return { ok: false, desiredStatus, currentStatus, totalQuantity, message: error, error };
  }
}

export async function pushInventoryUpdate(opts: {
  shopifySku: string;
  quantity: number | null;
  topic: string;
  shopDomain: string | null;
}): Promise<{ status: "applied" | "skipped" | "rejected"; message: string; details?: unknown }> {
  const { shopifySku, quantity, topic, shopDomain } = opts;
  if (!shopifySku) {
    return { status: "skipped", message: "Webhook had no SKU to map" };
  }
  const lookup =
    (shopDomain && storage.getPushStatusBySku(shopDomain, shopifySku)) ||
    storage.listPushStatuses().find((r) => r.shopifySku === shopifySku);
  if (!lookup) {
    return {
      status: "skipped",
      message: `SKU ${shopifySku} has not been pushed to Jomashop yet — skipping inventory update`,
    };
  }
  const stored = lookup.lastPayloadJson
    ? (JSON.parse(lookup.lastPayloadJson) as PushStatusPayload)
    : null;
  const variantSnapshot = stored?.variants?.find((v) => v.vendor_sku === shopifySku);
  const qty = quantity ?? variantSnapshot?.quantity ?? 0;
  const visibility = await syncShopifyProductVisibilityForInventory({
    shopDomain: lookup.shopDomain,
    shopifyProductId: lookup.shopifyProductId,
    fallbackQuantity: qty,
  });
  if (!jomashopConfigured()) {
    return {
      status: "skipped",
      message: "Jomashop credentials not configured — cannot apply inventory webhook",
      details: { shopifyVisibility: visibility },
    };
  }
  const price =
    variantSnapshot?.jomashop_price ??
    variantSnapshot?.price ??
    stored?.price ??
    null;
  const status = inventoryStatusFor(qty);
  const body: Record<string, unknown> = { status, quantity: qty };
  if (price !== null && price !== undefined && Number.isFinite(Number(price))) {
    body.price = price;
  }
  // Persist MSRP across inventory updates so the Jomashop portal keeps a
  // populated MSRP column when only stock/price changes are pushed. The
  // Jomashop inventory API calls this field `map_price` (while product create
  // uses `msrp`).
  const msrp = stored?.msrp;
  if (msrp !== null && msrp !== undefined && Number.isFinite(Number(msrp))) {
    body.map_price = msrp;
  }
  const targetSku = lookup.jomashopSku || lookup.shopifySku;
  const resp = await jomashopRequest({
    method: "PUT",
    path: `/v1/inventory/${encodeURIComponent(targetSku)}`,
    body,
  });
  // Update the stored push status row so subsequent webhooks have a current
  // snapshot.
  storage.upsertPushStatus({
    shopDomain: lookup.shopDomain,
    shopifyProductId: lookup.shopifyProductId,
    shopifyVariantId: lookup.shopifyVariantId,
    shopifySku: lookup.shopifySku,
    jomashopSku: lookup.jomashopSku,
    state: resp.ok ? lookup.state : "failed",
    lastStatus: resp.status,
    lastError: resp.ok ? null : resp.error ?? null,
    lastPayloadJson: lookup.lastPayloadJson,
    lastPushedAt: lookup.lastPushedAt,
    updatedAt: Date.now(),
  });
  return {
    status: resp.ok ? "applied" : "rejected",
    message: resp.ok
      ? `PUT /v1/inventory/${targetSku} ok (qty=${qty}, status=${status}); ${visibility.message}`
      : `PUT /v1/inventory/${targetSku} failed (${resp.status}): ${resp.error ?? "unknown"}`,
    details: { topic, body, response: resp.data ?? resp.error, shopifyVisibility: visibility },
  };
}

export function registerWebhookRoutes(app: Express): void {
  // Inventory level update — fires whenever Shopify changes a variant's
  // on-hand quantity at any location. Payload format (Admin REST):
  //   { inventory_item_id, location_id, available, ... }
  // The product/variant we need is fetched via the Shopify Admin API on
  // demand because the webhook doesn't include the variant SKU directly.
  app.post("/webhooks/shopify/inventory-levels-update", async (req: RawBodyRequest, res: Response) => {
    const hmac = verifyShopifyWebhookHmac(req);
    const shopDomain =
      (req.headers["x-shopify-shop-domain"] as string | undefined) ??
      (req.headers["X-Shopify-Shop-Domain"] as unknown as string | undefined) ??
      null;
    const topic =
      (req.headers["x-shopify-topic"] as string | undefined) ?? "inventory_levels/update";
    const bodyHash = hashBody(req);

    if (!hmac.ok) {
      storage.appendWebhookEvent({
        topic,
        shopDomain,
        bodyHash,
        hmacVerified: false,
        status: "rejected",
        message: `HMAC verification failed: ${hmac.reason}`,
        detailsJson: null,
        receivedAt: Date.now(),
      });
      return res.status(401).json({ ok: false, error: "HMAC verification failed" });
    }

    const payload = (req.body ?? {}) as {
      inventory_item_id?: number | string;
      available?: number | null;
    };

    const inventoryItemId = payload.inventory_item_id;
    const available =
      typeof payload.available === "number"
        ? payload.available
        : payload.available === null
          ? 0
          : null;

    if (!inventoryItemId) {
      storage.appendWebhookEvent({
        topic,
        shopDomain,
        bodyHash,
        hmacVerified: true,
        status: "skipped",
        message: "Payload missing inventory_item_id",
        detailsJson: JSON.stringify(payload),
        receivedAt: Date.now(),
      });
      return res.json({ ok: true, skipped: "missing inventory_item_id" });
    }

    // Resolve variant SKU from inventory_item_id by calling the Shopify
    // Admin API. Without a Shopify connection we cannot map the webhook to
    // a Jomashop SKU.
    const conn = getActiveShopifyConnection();
    if (!conn) {
      storage.appendWebhookEvent({
        topic,
        shopDomain,
        bodyHash,
        hmacVerified: true,
        status: "skipped",
        message: "No Shopify connection — cannot resolve inventory_item_id to SKU",
        detailsJson: JSON.stringify(payload),
        receivedAt: Date.now(),
      });
      return res.json({ ok: true, skipped: "no shopify connection" });
    }

    let sku: string | null = null;
    try {
      const r = await fetch(
        `https://${conn.shopDomain}/admin/api/2024-10/inventory_items/${encodeURIComponent(String(inventoryItemId))}.json`,
        { headers: { "X-Shopify-Access-Token": conn.accessToken } },
      );
      if (r.ok) {
        const j = (await r.json()) as { inventory_item?: { sku?: string } };
        sku = j.inventory_item?.sku ?? null;
      }
    } catch {
      sku = null;
    }

    if (!sku) {
      storage.appendWebhookEvent({
        topic,
        shopDomain,
        bodyHash,
        hmacVerified: true,
        status: "skipped",
        message: `Could not resolve inventory_item_id=${inventoryItemId} to a SKU`,
        detailsJson: JSON.stringify(payload),
        receivedAt: Date.now(),
      });
      return res.json({ ok: true, skipped: "sku lookup failed" });
    }

    const result = await pushInventoryUpdate({
      shopifySku: sku,
      quantity: available,
      topic,
      shopDomain,
    });

    storage.appendWebhookEvent({
      topic,
      shopDomain,
      bodyHash,
      hmacVerified: true,
      status: result.status,
      message: result.message,
      detailsJson: JSON.stringify({ payload, result: result.details ?? null, sku }),
      receivedAt: Date.now(),
    });
    storage.appendLog({
      level: result.status === "applied" ? "info" : "warn",
      message: `inventory webhook for ${sku}: ${result.message}`,
      detailsJson: JSON.stringify(result.details ?? null),
      createdAt: Date.now(),
    });

    return res.json({ ok: true, ...result });
  });

  // Product update — when a product changes (price/title/inventory baked in),
  // refresh inventory for any of its pushed variants. New products are NEVER
  // created automatically.
  app.post("/webhooks/shopify/products-update", async (req: RawBodyRequest, res: Response) => {
    const hmac = verifyShopifyWebhookHmac(req);
    const shopDomain =
      (req.headers["x-shopify-shop-domain"] as string | undefined) ?? null;
    const topic = (req.headers["x-shopify-topic"] as string | undefined) ?? "products/update";
    const bodyHash = hashBody(req);
    if (!hmac.ok) {
      storage.appendWebhookEvent({
        topic,
        shopDomain,
        bodyHash,
        hmacVerified: false,
        status: "rejected",
        message: `HMAC verification failed: ${hmac.reason}`,
        detailsJson: null,
        receivedAt: Date.now(),
      });
      return res.status(401).json({ ok: false, error: "HMAC verification failed" });
    }
    const product = (req.body ?? {}) as {
      id?: number | string;
      variants?: Array<{ sku?: string; inventory_quantity?: number; price?: string }>;
    };
    const variants = product.variants ?? [];
    const results: Array<{ sku: string; status: string; message: string }> = [];
    for (const v of variants) {
      const sku = (v.sku ?? "").trim();
      if (!sku) continue;
      const r = await pushInventoryUpdate({
        shopifySku: sku,
        quantity: v.inventory_quantity ?? null,
        topic,
        shopDomain,
      });
      results.push({ sku, status: r.status, message: r.message });
    }
    storage.appendWebhookEvent({
      topic,
      shopDomain,
      bodyHash,
      hmacVerified: true,
      status: results.some((r) => r.status === "applied") ? "applied" : "skipped",
      message: `products/update processed ${results.length} variant(s)`,
      detailsJson: JSON.stringify({ productId: product.id, results }),
      receivedAt: Date.now(),
    });
    return res.json({ ok: true, results });
  });
}

// ---------- Register webhooks via Shopify Admin API ----------
//
// Lets the user trigger webhook registration with one click from Setup
// instead of doing it via the Partner Dashboard / CLI. Idempotent: existing
// webhooks for the same topic+address are reused.
export async function registerShopifyWebhooks(opts: {
  appUrl: string;
}): Promise<{
  ok: boolean;
  shopDomain?: string;
  created: Array<{ topic: string; address: string; id?: string | number }>;
  existing: Array<{ topic: string; address: string; id?: string | number }>;
  errors: Array<{ topic: string; error: string }>;
}> {
  const conn = getActiveShopifyConnection();
  if (!conn) {
    return {
      ok: false,
      created: [],
      existing: [],
      errors: [{ topic: "*", error: "No connected Shopify store with an access token" }],
    };
  }
  const base = opts.appUrl.replace(/\/$/, "");
  const targets = [
    { topic: "inventory_levels/update", address: `${base}/webhooks/shopify/inventory-levels-update` },
    { topic: "products/update", address: `${base}/webhooks/shopify/products-update` },
  ];

  // List existing webhooks for this shop.
  const listResp = await fetch(
    `https://${conn.shopDomain}/admin/api/2024-10/webhooks.json`,
    { headers: { "X-Shopify-Access-Token": conn.accessToken } },
  );
  type ExistingWebhook = { id: number; topic: string; address: string };
  const existingList: ExistingWebhook[] = listResp.ok
    ? ((await listResp.json()) as { webhooks: ExistingWebhook[] }).webhooks ?? []
    : [];

  const created: Array<{ topic: string; address: string; id?: number }> = [];
  const existing: Array<{ topic: string; address: string; id?: number }> = [];
  const errors: Array<{ topic: string; error: string }> = [];

  for (const t of targets) {
    const match = existingList.find((w) => w.topic === t.topic && w.address === t.address);
    if (match) {
      existing.push({ ...t, id: match.id });
      continue;
    }
    const create = await fetch(
      `https://${conn.shopDomain}/admin/api/2024-10/webhooks.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": conn.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ webhook: { topic: t.topic, address: t.address, format: "json" } }),
      },
    );
    if (!create.ok) {
      const text = await create.text().catch(() => "");
      errors.push({ topic: t.topic, error: `${create.status}: ${text.slice(0, 300)}` });
      continue;
    }
    const j = (await create.json()) as { webhook?: { id?: number } };
    created.push({ ...t, id: j.webhook?.id });
  }

  return {
    ok: errors.length === 0,
    shopDomain: conn.shopDomain,
    created,
    existing,
    errors,
  };
}
