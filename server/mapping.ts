// Mapping logic: Shopify product objects → Jomashop product payloads.
// Uses dynamic category properties (live schema if available, fallback otherwise).

import {
  FALLBACK_CATEGORY_SCHEMAS,
  SUPPORTED_CATEGORIES,
  type SupportedCategory,
} from "@shared/schema";

export type ShopifyVariant = {
  id?: string | number;
  sku?: string;
  price?: string;
  compare_at_price?: string | null;
  inventory_quantity?: number;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  barcode?: string | null;
};

export type ShopifyProduct = {
  id?: string | number;
  title?: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string | string[];
  images?: Array<{ src: string; alt?: string | null }>;
  options?: Array<{ name: string; values: string[] }>;
  variants?: ShopifyVariant[];
  metafields?: Array<{
    namespace?: string;
    key?: string;
    value?: string | number | null;
    name?: string;
    label?: string;
    description?: string;
  }>;
};

export type MappedProduct = {
  category: SupportedCategory;
  vendor_sku: string;
  name: string;
  description: string;
  brand: string;
  price: number | null;
  msrp: number | null;
  commercial_discount: number;
  jomashop_price: number | null;
  images: string[];
  properties: Record<string, string | number | boolean | null>;
  variants: Array<{
    vendor_sku: string;
    price: number | null;
    jomashop_price: number | null;
    quantity: number;
    status: "active" | "out_of_stock" | "inactive";
    options: Record<string, string>;
  }>;
  warnings: string[];
  source: { shopify_product_id?: string | number; shopify_variant_ids: Array<string | number> };
};

/** Infer the Jomashop category for a Shopify product. */
export function inferCategory(p: ShopifyProduct): SupportedCategory | null {
  const haystack = [
    p.product_type || "",
    Array.isArray(p.tags) ? p.tags.join(" ") : p.tags || "",
    p.title || "",
  ]
    .join(" ")
    .toLowerCase();

  if (/(handbag|bag|tote|clutch|crossbody|satchel|backpack|hobo)/.test(haystack)) return "Handbags";
  if (/(shoe|sneaker|boot|loafer|heel|sandal|pump|moccasin|oxford|derby)/.test(haystack)) return "Shoes";
  if (
    /(shirt|dress|jacket|coat|pant|trouser|sweater|hoodie|t-shirt|tee|blouse|skirt|jean|short|clothing|apparel)/.test(
      haystack,
    )
  )
    return "Clothing";

  // Direct match against supported categories
  for (const c of SUPPORTED_CATEGORIES) {
    if (haystack.includes(c.toLowerCase())) return c;
  }
  return null;
}

/** Resolve option index for a named option, e.g. "Size" → option2. */
function resolveOption(p: ShopifyProduct, names: string[]): "option1" | "option2" | "option3" | null {
  const opts = p.options || [];
  for (let i = 0; i < opts.length; i++) {
    if (names.some((n) => opts[i].name.toLowerCase().includes(n))) {
      return (`option${i + 1}`) as "option1" | "option2" | "option3";
    }
  }
  return null;
}

function readMetafield(p: ShopifyProduct, key: string): string | undefined {
  const mf = (p.metafields || []).find(
    (m) => m.key === key || `${m.namespace ?? ""}.${m.key ?? ""}` === key,
  );
  if (mf?.value === undefined || mf?.value === null) return undefined;
  return String(mf.value);
}

const DISCOUNT_KEY_CANDIDATES = [
  "custom.commercial_discount",
  "commercial_discount",
  "commercialDiscount",
  "commercial-discount",
];
const DISCOUNT_LABEL_PATTERN = /^\s*commercial[\s_-]*discount\s*$/i;

/**
 * Locate the Commercial Discount metafield on a Shopify product across the
 * common shapes Shopify returns (namespaced key, bare key, camelCase, or
 * human-readable name/label/description). Returns the raw string value or
 * undefined when nothing usable is present.
 */
function readCommercialDiscountRaw(p: ShopifyProduct): string | undefined {
  const mfs = p.metafields || [];
  for (const candidate of DISCOUNT_KEY_CANDIDATES) {
    const hit = readMetafield(p, candidate);
    if (hit !== undefined && hit !== "") return hit;
  }
  for (const m of mfs) {
    const labelish = m.name || m.label || m.description;
    if (labelish && DISCOUNT_LABEL_PATTERN.test(labelish)) {
      if (m.value !== undefined && m.value !== null && String(m.value) !== "") {
        return String(m.value);
      }
    }
  }
  return undefined;
}

/**
 * Normalize a Commercial Discount value into a 0..1 decimal fraction.
 * - Blank / missing / non-numeric → 0
 * - Values > 1 are interpreted as percentages (30 → 0.30)
 * - Values between 0 and 1 are kept as decimals (0.3 → 0.30)
 * - Result is clamped to [0, 1].
 */
export function normalizeCommercialDiscount(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const s = typeof raw === "string" ? raw.trim().replace(/%$/, "") : raw;
  if (s === "" || s === undefined || s === null) return 0;
  const n = typeof s === "number" ? s : parseFloat(String(s));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const fraction = n > 1 ? n / 100 : n;
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(fraction, 1);
}

/** Compute Jomashop price = shopify_price * (1 - discount), rounded to 2 decimals. */
export function computeJomashopPrice(shopifyPrice: number | null, discountFraction: number): number | null {
  if (shopifyPrice === null || !Number.isFinite(shopifyPrice)) return null;
  const raw = shopifyPrice * (1 - discountFraction);
  return Math.round(raw * 100) / 100;
}

function inventoryStatus(qty: number | undefined): "active" | "out_of_stock" | "inactive" {
  if (qty === undefined || qty === null) return "inactive";
  if (qty <= 0) return "out_of_stock";
  return "active";
}

function parsePrice(s: string | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  const n = parseFloat(String(s));
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a Shopify product to a Jomashop product payload.
 * `properties` schema is either fetched live or falls back to FALLBACK_CATEGORY_SCHEMAS.
 */
export function mapShopifyToJomashop(
  product: ShopifyProduct,
  schemaProperties: Array<{ field: string; required: boolean; type?: string; options?: string[] }>,
  forcedCategory?: SupportedCategory,
): MappedProduct {
  const category = forcedCategory || inferCategory(product) || "Clothing";
  const warnings: string[] = [];

  const sizeOpt = resolveOption(product, ["size"]);
  const colorOpt = resolveOption(product, ["color", "colour"]);

  const firstVariant = product.variants?.[0];
  const vendorSku =
    firstVariant?.sku ||
    (product.id ? `LX-${product.id}` : `LX-${Date.now()}`);

  // Build a properties object using the category schema. For each schema
  // property we look first at metafields (namespaced), then at common Shopify
  // fields, then leave it null and emit a warning if required.
  const properties: Record<string, string | number | boolean | null> = {};
  for (const prop of schemaProperties) {
    let value: string | undefined | null = readMetafield(product, prop.field);

    if (!value) {
      // Common mappings
      switch (prop.field) {
        case "brand":
          value = product.vendor || readMetafield(product, "brand");
          break;
        case "model":
          value = product.title;
          break;
        case "color":
          if (colorOpt && firstVariant) {
            value = (firstVariant[colorOpt] as string | null) || undefined;
          }
          break;
        case "size":
          if (sizeOpt && firstVariant) {
            value = (firstVariant[sizeOpt] as string | null) || undefined;
          }
          break;
        case "size_system":
          value = readMetafield(product, "size_system") || "US";
          break;
        case "gender":
          value =
            readMetafield(product, "gender") ||
            (Array.isArray(product.tags) ? product.tags : (product.tags || "").split(","))
              .map((t) => t.trim())
              .find((t) => /^(Men|Women|Unisex|Kids)$/i.test(t));
          break;
        case "material":
          value = readMetafield(product, "material");
          break;
        case "style":
          value = readMetafield(product, "style") || product.product_type;
          break;
        case "category_type":
          value = readMetafield(product, "category_type") || product.product_type;
          break;
        case "country_of_origin":
          value = readMetafield(product, "country_of_origin");
          break;
        case "hardware":
          value = readMetafield(product, "hardware");
          break;
        case "dimensions":
          value = readMetafield(product, "dimensions");
          break;
        case "interior_material":
          value = readMetafield(product, "interior_material");
          break;
      }
    }

    if (!value && prop.required) {
      warnings.push(`Missing required ${category} field "${prop.field}" — add via metafield, product option, or vendor field.`);
      properties[prop.field] = null;
    } else {
      properties[prop.field] = value ?? null;
    }
  }

  // Commercial discount: Jomashop price = Shopify price * (1 - discount).
  const discountRaw = readCommercialDiscountRaw(product);
  const commercialDiscount = normalizeCommercialDiscount(discountRaw);
  if (discountRaw !== undefined && commercialDiscount === 0 && String(discountRaw).trim() !== "" && String(discountRaw).trim() !== "0") {
    warnings.push(
      `Commercial Discount value "${discountRaw}" could not be parsed — treating as 0%.`,
    );
  }

  // Variants
  const mappedVariants = (product.variants || []).map((v) => {
    const options: Record<string, string> = {};
    (product.options || []).forEach((opt, idx) => {
      const key = (`option${idx + 1}`) as "option1" | "option2" | "option3";
      const val = v[key];
      if (val) options[opt.name] = String(val);
    });
    const variantPrice = parsePrice(v.price);
    return {
      vendor_sku: v.sku || `${vendorSku}-V${v.id ?? ""}`,
      price: variantPrice,
      jomashop_price: computeJomashopPrice(variantPrice, commercialDiscount),
      quantity: v.inventory_quantity ?? 0,
      status: inventoryStatus(v.inventory_quantity),
      options,
    };
  });

  const shopifyPrice = parsePrice(firstVariant?.price);

  return {
    category,
    vendor_sku: vendorSku,
    name: product.title || "Untitled product",
    description: (product.body_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    brand: (properties.brand as string | null) || product.vendor || "Unknown",
    price: shopifyPrice,
    msrp: parsePrice(firstVariant?.compare_at_price),
    commercial_discount: commercialDiscount,
    jomashop_price: computeJomashopPrice(shopifyPrice, commercialDiscount),
    images: (product.images || []).map((i) => i.src).filter(Boolean),
    properties,
    variants: mappedVariants,
    warnings,
    source: {
      shopify_product_id: product.id,
      shopify_variant_ids: (product.variants || []).map((v) => v.id).filter(Boolean) as Array<string | number>,
    },
  };
}

/** Sample fixtures used by /api/sync/preview-products when no real Shopify products are available. */
export const SAMPLE_SHOPIFY_PRODUCTS: ShopifyProduct[] = [
  {
    id: "shopify-1001",
    title: "Gucci Ace Low-Top Sneaker",
    body_html: "<p>Iconic low-top sneaker with embroidered bee detail.</p>",
    vendor: "Gucci",
    product_type: "Shoes",
    tags: ["Men", "Sneaker", "Luxury"],
    images: [{ src: "https://cdn.shopify.com/sample/ace-1.jpg" }],
    options: [
      { name: "Size", values: ["9", "10", "11"] },
      { name: "Color", values: ["White"] },
    ],
    variants: [
      { id: 2001, sku: "GG-ACE-WHT-10", price: "650.00", compare_at_price: "780.00", inventory_quantity: 4, option1: "10", option2: "White" },
      { id: 2002, sku: "GG-ACE-WHT-11", price: "650.00", compare_at_price: "780.00", inventory_quantity: 0, option1: "11", option2: "White" },
    ],
    metafields: [
      { namespace: "luxe", key: "gender", value: "Men" },
      { namespace: "luxe", key: "size_system", value: "US" },
      { namespace: "luxe", key: "material", value: "Calfskin leather" },
      { namespace: "luxe", key: "country_of_origin", value: "Italy" },
      { namespace: "custom", key: "commercial_discount", value: "30" },
    ],
  },
  {
    id: "shopify-1002",
    title: "Saint Laurent Loulou Small Shoulder Bag",
    body_html: "<p>Quilted calfskin shoulder bag with YSL monogram.</p>",
    vendor: "Saint Laurent",
    product_type: "Handbags",
    tags: ["Women", "Handbag", "Shoulder"],
    images: [{ src: "https://cdn.shopify.com/sample/loulou-1.jpg" }],
    options: [{ name: "Color", values: ["Noir"] }],
    variants: [
      { id: 2101, sku: "YSL-LOULOU-NOIR", price: "2350.00", inventory_quantity: 2, option1: "Noir" },
    ],
    metafields: [
      { namespace: "luxe", key: "material", value: "Calfskin leather" },
      { namespace: "luxe", key: "style", value: "Shoulder" },
      { namespace: "luxe", key: "hardware", value: "Gold" },
      { namespace: "luxe", key: "country_of_origin", value: "Italy" },
      { namespace: "custom", key: "commercial_discount", value: "0.25" },
    ],
  },
  {
    id: "shopify-1003",
    title: "Burberry Vintage Check Cotton Shirt",
    body_html: "<p>Classic check pattern cotton poplin shirt.</p>",
    vendor: "Burberry",
    product_type: "Clothing",
    tags: ["Men", "Shirt", "Tops"],
    images: [{ src: "https://cdn.shopify.com/sample/burberry-1.jpg" }],
    options: [
      { name: "Size", values: ["M", "L"] },
      { name: "Color", values: ["Beige"] },
    ],
    variants: [
      { id: 2201, sku: "BB-VC-SHIRT-M", price: "490.00", inventory_quantity: 7, option1: "M", option2: "Beige" },
      { id: 2202, sku: "BB-VC-SHIRT-L", price: "490.00", inventory_quantity: 3, option1: "L", option2: "Beige" },
    ],
    metafields: [
      { namespace: "luxe", key: "gender", value: "Men" },
      { namespace: "luxe", key: "size_system", value: "US" },
      { namespace: "luxe", key: "material", value: "Cotton" },
      { namespace: "luxe", key: "category_type", value: "Tops" },
    ],
  },
];
