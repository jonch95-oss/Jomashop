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

// Bump this whenever the normalization / mapping logic changes in a way that
// invalidates cached preview payloads (e.g. a new metafield extraction rule).
// Cached previews carrying a different mapperVersion are ignored on read.
export const MAPPER_VERSION = 2;

// We pass all metafields through the mapper rather than restricting to a
// namespace+key allowlist. Shopify shops use a wide range of namespaces
// (`custom`, `luxe`, `ff`, `global`, `app--*`, bare/default) and admin UI
// definitions often expose human-readable labels ("Color") whose backing key
// may differ ("primary_color", "color_value", ...). The mapper does the
// matching by normalized key/label/name/definition.

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

// Cap on metafields pulled per product. We fetch the full set and then filter
// to METAFIELD_IDENTIFIERS client-side because the `metafields(identifiers:)`
// argument is not available on Product in all Shopify Admin API schemas and
// fails GraphQL validation when it isn't.
const METAFIELDS_PER_PRODUCT = 100;

function buildProductsQuery(first: number, after: string | null): { query: string; variables: Record<string, unknown> } {
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
            metafields(first: ${METAFIELDS_PER_PRODUCT}) {
              edges {
                node {
                  namespace
                  key
                  value
                  type
                  definition { name }
                }
              }
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
  metafields: {
    edges: Array<{
      node: {
        namespace: string;
        key: string;
        value: string;
        type: string;
        definition?: { name: string | null } | null;
      } | null;
    }>;
  };
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

  // Pass all metafields through. The mapper does its own matching by
  // normalized key/label/name/definition so we don't pre-filter here — that
  // would drop fields the mapper could otherwise resolve (e.g. a "Color"
  // metafield whose backing key is `primary_color` in an unexpected
  // namespace, or one only addressable by its admin-UI definition name).
  const metafields = (p.metafields?.edges ?? [])
    .map((e) => e.node)
    .filter(
      (
        m,
      ): m is {
        namespace: string;
        key: string;
        value: string;
        type: string;
        definition?: { name: string | null } | null;
      } => m !== null,
    )
    .map((m) => {
      const defName = m.definition?.name ?? null;
      return {
        namespace: m.namespace,
        key: m.key,
        value: m.value,
        // Surface the admin-UI definition name as `name`/`label` so the
        // mapper's readMetafield can match against the human-readable
        // label (e.g. "Color") even when the backing key is something
        // else like "primary_color". Falls back to key when no
        // definition is attached.
        name: defName || m.key,
        label: defName || m.key,
      };
    });

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
  | {
      ok: true;
      products: ShopifyProduct[];
      shopDomain: string;
      count: number;
      pageCount: number;
      hasMore: boolean;
      partialError?: string;
      partialStatus?: number;
    }
  | { ok: false; error: string; status?: number; shopDomain?: string };

export type FetchProductsOptions = {
  /** Per-request GraphQL page size. Shopify caps at 250 for products. */
  pageSize?: number;
  /** Optional hard cap on total products. Omit to fetch all pages. */
  maxProducts?: number;
  /** Safety guard so we never spin forever on bad cursors. */
  maxPages?: number;
};

const DEFAULT_PAGE_SIZE = 100;
const SHOPIFY_MAX_PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 200;

/**
 * Fetch live products from the connected Shopify store using the Admin
 * GraphQL API, paginating through ALL pages until hasNextPage is false (or
 * the optional caps are reached). Returns normalized products plus
 * fetchedCount, pageCount, and hasMore so callers can show progress.
 *
 * If a single page fails mid-walk we return the products we already have
 * along with `partialError`/`partialStatus` so the UI can show partial data.
 */
export async function fetchShopifyProducts(
  options: FetchProductsOptions = {},
): Promise<FetchProductsResult> {
  const conn = getActiveShopifyConnection();
  if (!conn) {
    return { ok: false, error: "No connected Shopify store with an access token." };
  }
  const endpoint = `https://${conn.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const pageSize = Math.min(
    Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1),
    SHOPIFY_MAX_PAGE_SIZE,
  );
  const maxProducts = options.maxProducts ?? Number.POSITIVE_INFINITY;
  const maxPages = Math.max(options.maxPages ?? DEFAULT_MAX_PAGES, 1);

  const products: ShopifyProduct[] = [];
  let cursor: string | null = null;
  let hasMore = false;
  let pageCount = 0;
  let partialError: string | undefined;
  let partialStatus: number | undefined;

  while (pageCount < maxPages && products.length < maxProducts) {
    const remaining = maxProducts - products.length;
    const thisPageSize = Math.min(pageSize, Number.isFinite(remaining) ? remaining : pageSize);
    const { query, variables } = buildProductsQuery(thisPageSize, cursor);

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
      const msg = (err as Error).message;
      if (products.length === 0) {
        return { ok: false, error: msg, shopDomain: conn.shopDomain };
      }
      partialError = msg;
      hasMore = true;
      break;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = `Shopify Admin API ${res.status}: ${text.slice(0, 500)}`;
      if (products.length === 0) {
        return { ok: false, status: res.status, error: msg, shopDomain: conn.shopDomain };
      }
      partialError = msg;
      partialStatus = res.status;
      hasMore = true;
      break;
    }

    const body = (await res.json().catch(() => null)) as GraphQLResponse | null;
    if (!body) {
      if (products.length === 0) {
        return {
          ok: false,
          status: res.status,
          error: "Shopify Admin API returned non-JSON.",
          shopDomain: conn.shopDomain,
        };
      }
      partialError = "Shopify Admin API returned non-JSON.";
      partialStatus = res.status;
      hasMore = true;
      break;
    }
    if (body.errors && body.errors.length > 0) {
      const msg = `Shopify GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`;
      if (products.length === 0) {
        return {
          ok: false,
          status: res.status,
          error: msg,
          shopDomain: conn.shopDomain,
        };
      }
      partialError = msg;
      partialStatus = res.status;
      hasMore = true;
      break;
    }

    pageCount += 1;
    const edges = body.data?.products?.edges ?? [];
    for (const edge of edges) {
      products.push(normalizeProduct(edge.node));
      if (products.length >= maxProducts) break;
    }
    const pageInfo = body.data?.products?.pageInfo;
    if (!pageInfo || !pageInfo.hasNextPage || !pageInfo.endCursor) {
      hasMore = false;
      break;
    }
    if (products.length >= maxProducts) {
      hasMore = true;
      break;
    }
    if (pageInfo.endCursor === cursor) {
      partialError = "Shopify returned a repeating cursor — aborting to avoid infinite loop.";
      hasMore = true;
      break;
    }
    cursor = pageInfo.endCursor;
  }

  if (pageCount >= maxPages && hasMore) {
    partialError =
      partialError ??
      `Stopped after ${pageCount} pages (safety cap). Increase maxPages to fetch more.`;
  }

  return {
    ok: true,
    products,
    shopDomain: conn.shopDomain,
    count: products.length,
    pageCount,
    hasMore,
    ...(partialError ? { partialError } : {}),
    ...(partialStatus !== undefined ? { partialStatus } : {}),
  };
}
