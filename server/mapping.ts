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
  /** Names of required category properties that are missing/empty (e.g. "color", "material"). */
  missing_required?: string[];
  /** Names of required top-level fields that are missing (e.g. "sku", "manufacturer_number"). */
  missing_top_level?: string[];
  category: SupportedCategory;
  /** True when this mapping was produced from a built-in demo fixture rather
   *  than a real Shopify product. The UI uses this to block pushes and label
   *  the row as sample data; the push endpoint refuses such products outright. */
  is_sample: boolean;
  /** Free-form category label resolved from Shopify (raw vendor type/tag/metafield).
   *  Distinct from `category`, which is one of the SUPPORTED_CATEGORIES enum
   *  values. Surfaced so the UI can show what Shopify provided before the user
   *  picks a Jomashop category name. */
  raw_category: string | null;
  /** Heuristic mapping from raw_category → plausible Jomashop category name
   *  (e.g. "SNEK" → "Sneakers"). The UI uses this as the prefilled value of
   *  the category override field. */
  suggested_category: string;
  vendor_sku: string;
  /** SKU used for the product/variant on Jomashop side. Currently equals
   *  vendor_sku, but kept separate so the UI can override it independently. */
  sku: string;
  manufacturer_number: string | null;
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

export type PushOverrides = {
  category?: string;
  brand?: string;
  sku?: string;
  manufacturer_number?: string;
};

/**
 * IDs reserved for built-in demo fixtures returned by SAMPLE_SHOPIFY_PRODUCTS.
 * A product is considered "sample" when its id is in this set OR when the
 * id has the shopify-1xxx pattern emitted by the fixture file. Sample
 * products are surfaced as previews only — the push endpoint rejects them so
 * the operator can never accidentally ship demo SKUs to Jomashop.
 */
export const SAMPLE_PRODUCT_IDS = new Set<string>([
  "shopify-1001",
  "shopify-1002",
  "shopify-1003",
]);

export function isSampleProduct(p: ShopifyProduct): boolean {
  if (!p) return false;
  const id = p.id === undefined || p.id === null ? "" : String(p.id);
  if (SAMPLE_PRODUCT_IDS.has(id)) return true;
  if (/^shopify-1\d{3}$/.test(id)) return true;
  const sku = (p.variants && p.variants[0]?.sku) || "";
  if (/^(GG-ACE-WHT|YSL-LOULOU-NOIR|BB-VC-SHIRT)/i.test(String(sku))) return true;
  const firstImg = (p.images && p.images[0]?.src) || "";
  if (/cdn\.shopify\.com\/sample\//i.test(String(firstImg))) return true;
  return false;
}

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

/**
 * Normalize a metafield identifier into a single comparable token so that
 * "ff_designer_id", "Designer Id", "designer-id", and "ff.designer_id" all
 * collapse to the same string. Used by readMetafieldAny to look up Shopify
 * metafields by any of the common shapes the admin UI exposes.
 */
function normKey(s: string | undefined | null): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readMetafield(p: ShopifyProduct, key: string): string | undefined {
  const target = normKey(key);
  const mf = (p.metafields || []).find((m) => {
    if (!m) return false;
    if (normKey(m.key) === target) return true;
    if (normKey(`${m.namespace ?? ""}.${m.key ?? ""}`) === target) return true;
    if (normKey(m.name) === target) return true;
    if (normKey(m.label) === target) return true;
    return false;
  });
  if (mf?.value === undefined || mf?.value === null) return undefined;
  const v = String(mf.value).trim();
  return v === "" ? undefined : v;
}

/** First non-empty metafield value across the given candidate keys/labels. */
function readMetafieldAny(p: ShopifyProduct, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = readMetafield(p, k);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
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

  const sampleFixture = isSampleProduct(product);
  const firstVariant = product.variants?.[0];
  // SKU precedence: real Shopify variant.sku → real ff_sku metafield →
  // generic sku/vendor_sku metafields. No demo fallback is generated — if
  // nothing real is found the SKU is left empty and the push endpoint will
  // reject the payload at validation.
  const resolvedSku =
    (firstVariant?.sku && firstVariant.sku.trim()) ||
    readMetafieldAny(product, [
      "ff_sku",
      "luxe.ff_sku",
      "custom.ff_sku",
      "sku",
      "vendor_sku",
    ]);
  const vendorSku = resolvedSku || "";
  if (!resolvedSku) {
    warnings.push(
      "No real SKU found — set variant.sku or a ff_sku/sku metafield. Push will be rejected.",
    );
  }

  // manufacturer_number precedence: real ff_designer_id metafield →
  // manufacturer_number / designer_id metafields → resolved SKU. Never a
  // synthesized demo value.
  const manufacturerNumber =
    readMetafieldAny(product, [
      "ff_designer_id",
      "luxe.ff_designer_id",
      "custom.ff_designer_id",
      "manufacturer_number",
      "designer_id",
      "Designer Id",
    ]) ||
    (resolvedSku ? resolvedSku : null);

  // Build a properties object using the category schema. For each schema
  // property we look first at metafields (namespaced), then at common Shopify
  // fields, then leave it null and emit a warning if required.
  const properties: Record<string, string | number | boolean | null> = {};
  const missingRequiredProps: string[] = [];
  for (const prop of schemaProperties) {
    let value: string | undefined | null = readMetafield(product, prop.field);

    if (!value) {
      // Common mappings
      switch (prop.field) {
        case "brand":
          // Prefer designer-style metafields ("Designer Id", "designer_id")
          // over Shopify vendor — the vendor field is often a generic code
          // (e.g. "SNEK") that Jomashop will not recognize.
          value =
            readMetafieldAny(product, [
              "Designer Id",
              "designer_id",
              "ff_designer",
              "brand",
            ]) ||
            product.vendor;
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
      missingRequiredProps.push(prop.field);
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
      vendor_sku: (v.sku && v.sku.trim()) || (vendorSku ? `${vendorSku}-V${v.id ?? ""}` : ""),
      price: variantPrice,
      jomashop_price: computeJomashopPrice(variantPrice, commercialDiscount),
      quantity: v.inventory_quantity ?? 0,
      status: inventoryStatus(v.inventory_quantity),
      options,
    };
  });

  const shopifyPrice = parsePrice(firstVariant?.price);

  const rawCategory =
    readMetafieldAny(product, ["category", "Category", "ff_category"]) ||
    product.product_type ||
    null;

  const brand = (properties.brand as string | null) || product.vendor || "";

  const missingTopLevelFields: string[] = [];
  if (!category) missingTopLevelFields.push("category");
  if (!brand || String(brand).trim() === "") missingTopLevelFields.push("brand");
  if (!vendorSku || vendorSku.trim() === "") {
    missingTopLevelFields.push("sku");
    missingTopLevelFields.push("vendor_sku");
  }
  if (!manufacturerNumber || String(manufacturerNumber).trim() === "") {
    missingTopLevelFields.push("manufacturer_number");
  }

  return {
    missing_required: missingRequiredProps,
    missing_top_level: missingTopLevelFields,
    category,
    is_sample: sampleFixture,
    raw_category: rawCategory,
    suggested_category: suggestJomashopCategory(rawCategory, category),
    vendor_sku: vendorSku,
    sku: vendorSku,
    manufacturer_number: manufacturerNumber,
    name: product.title || "Untitled product",
    description: (product.body_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    brand,
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

/**
 * Build the JSON payload sent to Jomashop `POST /v1/products`.
 *
 * Picks the requested variant (or the first one) and produces a flat
 * product-level payload that includes the dynamic category properties as
 * top-level fields plus a `properties` block. Real Jomashop accepts the
 * dynamic schema fields at the top level; we send both so the API can pick
 * whichever shape matches the live schema.
 *
 * Returns `{ payload, variant, missingRequired }` so the caller can surface
 * validation issues before hitting the network.
 */
export function buildJomashopProductPayload(
  mapped: MappedProduct,
  variantSku?: string,
  overrides: PushOverrides = {},
): {
  payload: Record<string, unknown>;
  variant: MappedProduct["variants"][number] | null;
  missingRequired: string[];
  missingTopLevel: string[];
} {
  const variant =
    (variantSku && mapped.variants.find((v) => v.vendor_sku === variantSku)) ||
    mapped.variants[0] ||
    null;

  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mapped.properties)) {
    if (v !== null && v !== undefined && v !== "") properties[k] = v;
  }
  if (variant) {
    for (const [k, v] of Object.entries(variant.options)) {
      const key = k.toLowerCase();
      if (key === "size" || key === "color" || key === "colour") {
        properties[key === "colour" ? "color" : key] = v;
      }
    }
  }

  const price = variant?.jomashop_price ?? mapped.jomashop_price;
  const msrp = mapped.msrp ?? null;

  const sku =
    (overrides.sku && overrides.sku.trim()) ||
    (variant?.vendor_sku && variant.vendor_sku.trim()) ||
    (mapped.sku && mapped.sku.trim()) ||
    (mapped.vendor_sku && mapped.vendor_sku.trim()) ||
    "";

  const manufacturerNumber =
    (overrides.manufacturer_number && overrides.manufacturer_number.trim()) ||
    (mapped.manufacturer_number && String(mapped.manufacturer_number).trim()) ||
    (sku ? sku : "");

  const category =
    (overrides.category && overrides.category.trim()) || mapped.category;

  const brand =
    (overrides.brand && overrides.brand.trim()) || mapped.brand;

  const payload: Record<string, unknown> = {
    category,
    sku,
    vendor_sku: sku,
    manufacturer_number: manufacturerNumber,
    name: mapped.name,
    description: mapped.description,
    brand,
    price,
    msrp,
    images: mapped.images,
    properties,
    ...properties,
  };

  const missingRequired = mapped.warnings.filter((w) => /Missing required/.test(w));
  const missingTopLevel: string[] = [];
  for (const k of ["category", "brand", "sku", "manufacturer_number"] as const) {
    const v = payload[k];
    if (v === null || v === undefined || String(v).trim() === "") missingTopLevel.push(k);
  }
  return { payload, variant, missingRequired, missingTopLevel };
}

/**
 * Heuristic Shopify-category-code → Jomashop category-name layer. Most
 * Shopify product types are short codes (SNEK, HBAG, CLTH) or the noun
 * itself ("Sneakers"). This maps the common shoe/handbag/clothing codes to
 * plausible Jomashop category names so the push payload doesn't ship the
 * raw vendor code. The UI still lets the operator override before push.
 */
const CATEGORY_CODE_MAP: Record<string, string> = {
  snek: "Sneakers",
  sneakers: "Sneakers",
  sneaker: "Sneakers",
  shoes: "Shoes",
  shoe: "Shoes",
  boot: "Boots",
  boots: "Boots",
  loafer: "Loafers",
  loafers: "Loafers",
  heel: "Heels",
  heels: "Heels",
  sandal: "Sandals",
  sandals: "Sandals",
  hbag: "Handbags",
  handbag: "Handbags",
  handbags: "Handbags",
  bag: "Handbags",
  tote: "Handbags",
  clutch: "Handbags",
  crossbody: "Handbags",
  clth: "Clothing",
  clothing: "Clothing",
  apparel: "Clothing",
  shirt: "Clothing",
  pant: "Clothing",
  pants: "Clothing",
  jacket: "Clothing",
  coat: "Clothing",
  dress: "Clothing",
};

export function suggestJomashopCategory(
  rawCategory: string | null | undefined,
  fallback: SupportedCategory,
): string {
  if (!rawCategory) return fallback;
  const norm = rawCategory.toLowerCase().trim();
  if (CATEGORY_CODE_MAP[norm]) return CATEGORY_CODE_MAP[norm];
  for (const [code, name] of Object.entries(CATEGORY_CODE_MAP)) {
    if (norm.includes(code)) return name;
  }
  return fallback;
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
