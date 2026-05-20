// Shopify Admin API client.
//
// - Persists OAuth access tokens to SQLite at rest using AES-256-GCM
//   keyed off SESSION_SECRET (no plaintext tokens on disk).
// - Fetches live products via the Admin GraphQL API including variants,
//   images, options, and the full set of metafields requested by the
//   integration (designer id, size scale, UPC, commercial discount, etc).

import crypto from "node:crypto";
import { storage } from "./storage";
import type { ShopifyProduct } from "./mapping";

const ADMIN_API_VERSION = "2024-10";

// Metafield identifiers the integration cares about. We pull these by both
// "namespace.key" form (preferred) and bare key form so older Shopify shops
// that put everything under "custom" or the unnamespaced default still match.
const METAFIELD_IDENTIFIERS: Array<{ namespace: string; key: string }> = [
  { namespace: "custom", key: "ff_designer_id" },
  { namespace: "luxe", key: "ff_designer_id" },
  { namespace: "ff", key: "designer_id" },
  { namespace: "custom", key: "designer_id" },
  { namespace: "custom", key: "size_scale" },
  { namespace: "luxe", key: "size_scale" },
  { namespace: "custom", key: "upc" },
  { namespace: "luxe", key: "upc" },
  { namespace: "custom", key: "commercial_discount" },
  { namespace: "luxe", key: "commercial_discount" },
  { namespace: "custom", key: "size" },
  { namespace: "luxe", key: "size" },
  { namespace: "custom", key: "color" },
  { namespace: "luxe", key: "color" },
  { namespace: "custom", key: "gender" },
  { namespace: "luxe", key: "gender" },
  { namespace: "custom", key: "ff_sku" },
  { namespace: "luxe", key: "ff_sku" },
  { namespace: "custom", key: "ff_country_of_origin" },
  { namespace: "luxe", key: "ff_country_of_origin" },
  { namespace: "custom", key: "country_of_origin" },
  { namespace: "luxe", key: "country_of_origin" },
  { namespace: "custom", key: "collection" },
  { namespace: "luxe", key: "collection" },
  { namespace: "custom", key: "season" },
  { namespace: "luxe", key: "season" },
  { namespace: "custom", key: "category" },
  { namespace: "luxe", key: "category" },
  { namespace: "custom", key: "composition" },
  { namespace: "luxe", key: "composition" },
  { namespace: "custom", key: "material" },
  { namespace: "luxe", key: "material" },
  { namespace: "custom", key: "style" },
  { namespace: "luxe", key: "style" },
  { namespace: "custom", key: "size_system" },
  { namespace: "luxe", key: "size_system" },
];

// ---------- AES-GCM helpers ----------

function deriveKey(): Buffer {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.SHOPIFY_CLIENT_SECRET ||
    "shopify-token-fallback-key-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptToken(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const parts = blob.split(".");
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    const ct = Buffer.from(parts[2], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

// ---------- Token lookup ----------

export type ShopifyConnection = {
  shopDomain: string;
  accessToken: string;
};

/**
 * Resolve a usable Shopify connection. Prefers a DB-persisted access token
 * for the most recently installed store, then falls back to the
 * SHOPIFY_ADMIN_ACCESS_TOKEN env var (paired with SHOPIFY_SHOP_DOMAIN) for
 * private-app / dev workflows.
 */
export function getActiveShopifyConnection(): ShopifyConnection | null {
  const stores = storage.listStores();
  const connected = stores
    .filter((s) => s.oauthStatus === "connected" && s.accessTokenEnc)
    .sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0));
  for (const s of connected) {
    const token = decryptToken(s.accessTokenEnc);
    if (token) return { shopDomain: s.shopDomain, accessToken: token };
  }
  const envToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (envToken && envShop) {
    return { shopDomain: envShop, accessToken: envToken };
  }
  return null;
}

// ---------- GraphQL fetch ----------

function buildProductsQuery(first: number, after: string | null): { query: string; variables: Record<string, unknown> } {
  const identifierLiteral = METAFIELD_IDENTIFIERS.map(
    (m) => `{namespace: "${m.namespace}", key: "${m.key}"}`,
  ).join(", ");
  const query = `
    query Products($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            descriptionHtml
            vendor
            productType
            status
            tags
            options { id name values }
            images(first: 10) { edges { node { url altText } } }
            metafields(identifiers: [${identifierLiteral}]) {
              namespace
              key
              value
              type
            }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  compareAtPrice
                  barcode
                  inventoryQuantity
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    }
  `;
  return { query, variables: { first, after } };
}

type GraphQLResponse = {
  data?: {
    products?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: ShopifyGraphProduct }>;
    };
  };
  errors?: Array<{ message: string }>;
};

type ShopifyGraphProduct = {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  status: string;
  tags: string[];
  options: Array<{ id: string; name: string; values: string[] }>;
  images: { edges: Array<{ node: { url: string; altText: string | null } }> };
  metafields: Array<{ namespace: string; key: string; value: string; type: string } | null>;
  variants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        sku: string | null;
        price: string;
        compareAtPrice: string | null;
        barcode: string | null;
        inventoryQuantity: number | null;
        selectedOptions: Array<{ name: string; value: string }>;
      };
    }>;
  };
};

function numericIdFromGid(gid: string): string {
  const m = gid.match(/\/(\d+)$/);
  return m ? m[1] : gid;
}

function normalizeProduct(p: ShopifyGraphProduct): ShopifyProduct {
  const images = p.images.edges.map((e) => ({ src: e.node.url, alt: e.node.altText }));
  const variants = p.variants.edges.map((e) => {
    const v = e.node;
    const selectedByName = new Map(v.selectedOptions.map((o) => [o.name.toLowerCase(), o.value]));
    const option1 = p.options[0] ? selectedByName.get(p.options[0].name.toLowerCase()) ?? null : null;
    const option2 = p.options[1] ? selectedByName.get(p.options[1].name.toLowerCase()) ?? null : null;
    const option3 = p.options[2] ? selectedByName.get(p.options[2].name.toLowerCase()) ?? null : null;
    return {
      id: numericIdFromGid(v.id),
      sku: v.sku ?? "",
      price: v.price,
      compare_at_price: v.compareAtPrice,
      inventory_quantity: v.inventoryQuantity ?? undefined,
      barcode: v.barcode ?? null,
      option1,
      option2,
      option3,
    };
  });

  const metafields = (p.metafields || [])
    .filter((m): m is { namespace: string; key: string; value: string; type: string } => m !== null)
    .map((m) => ({
      namespace: m.namespace,
      key: m.key,
      value: m.value,
      name: m.key,
      label: m.key,
    }));

  return {
    id: numericIdFromGid(p.id),
    title: p.title,
    body_html: p.descriptionHtml ?? "",
    vendor: p.vendor ?? "",
    product_type: p.productType ?? "",
    tags: p.tags,
    images,
    options: p.options.map((o) => ({ name: o.name, values: o.values })),
    variants,
    metafields,
  };
}

export type FetchProductsResult =
  | { ok: true; products: ShopifyProduct[]; shopDomain: string; count: number }
  | { ok: false; error: string; status?: number; shopDomain?: string };

/**
 * Fetch up to `limit` live products from the connected Shopify store using
 * the Admin GraphQL API. Returns a normalized payload that mapping.ts can
 * consume directly.
 */
export async function fetchShopifyProducts(limit = 25): Promise<FetchProductsResult> {
  const conn = getActiveShopifyConnection();
  if (!conn) {
    return { ok: false, error: "No connected Shopify store with an access token." };
  }
  const endpoint = `https://${conn.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const pageSize = Math.min(limit, 50);
  const { query, variables } = buildProductsQuery(pageSize, null);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": conn.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message, shopDomain: conn.shopDomain };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: `Shopify Admin API ${res.status}: ${text.slice(0, 500)}`,
      shopDomain: conn.shopDomain,
    };
  }
  const body = (await res.json().catch(() => null)) as GraphQLResponse | null;
  if (!body) {
    return { ok: false, status: res.status, error: "Shopify Admin API returned non-JSON.", shopDomain: conn.shopDomain };
  }
  if (body.errors && body.errors.length > 0) {
    return {
      ok: false,
      status: res.status,
      error: `Shopify GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
      shopDomain: conn.shopDomain,
    };
  }
  const edges = body.data?.products?.edges ?? [];
  const products = edges.slice(0, limit).map((e) => normalizeProduct(e.node));
  return { ok: true, products, shopDomain: conn.shopDomain, count: products.length };
}
