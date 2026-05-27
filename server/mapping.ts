// Mapping logic: Shopify product objects → Jomashop product payloads.
// Uses dynamic category properties (live schema if available, fallback otherwise).

import {
  FALLBACK_CATEGORY_SCHEMAS,
  SUPPORTED_CATEGORIES,
  type SupportedCategory,
} from "@shared/schema";
import { resolveCategorySynonym } from "./synonym_resolver";

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
  /** Schema-driven enum coercion failures captured during mapping. Surfaced
   *  in preflight so the UI / push response can list the offending field,
   *  the canonical value we tried to send, and the accepted options. */
  invalid_enums?: Array<{ field: string; value: string; options: string[] }>;
  /** Optional schema fields that were dropped from the outgoing properties
   *  because their canonical value could not be mapped (allow_omit). */
  omitted_optional_fields?: string[];
  /** Required schema fields whose option list is `options_unverified` —
   *  the push must be blocked because Jomashop's accepted set isn't known.
   *  Each entry includes the canonical value (if any) we'd have sent. */
  unverified_required_options?: Array<{ field: string; value?: string }>;
  /** Enum coercions performed automatically by the category-code synonym
   *  resolver. Each entry surfaces the live schema field, the chosen
   *  accepted option, and the source code that drove the resolution. The
   *  UI shows these as "auto-resolved" so the operator can audit / override
   *  the choice. */
  auto_resolved_enums?: Array<{ field: string; chosen: string; sourceCode: string; reason: string }>;
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
  /** True when the Shopify category code is ambiguous (e.g. "WALL" for
   *  wallets) and must not be silently mapped to a Supported category. The
   *  UI shows "Jomashop category: needs verification" until the operator
   *  picks one. */
  ambiguous_category: boolean;
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
  /** Compact echo of the raw Shopify metafields + product options + variant
   *  selectedOptions that the mapper saw for this product. Surfaced to the UI
   *  as an expandable debug panel so the operator can confirm what Shopify
   *  data was actually fetched (and diagnose missing-field complaints
   *  without round-tripping through the Admin API). */
  debug_raw: {
    metafields: Array<{
      namespace?: string;
      key?: string;
      name?: string;
      label?: string;
      value: string;
    }>;
    options: Array<{ name: string; values: string[] }>;
    variants: Array<{
      sku?: string;
      options: Record<string, string>;
    }>;
  };
};

export type PushOverrides = {
  category?: string;
  brand?: string;
  sku?: string;
  manufacturer_number?: string;
  /** Live Jomashop manufacturer record id (from /i1/manufacturers). When
   *  present the payload sends `product.manufacturer_id` so the new
   *  /i1/products/ endpoint can accept the create without a name lookup. */
  manufacturer_id?: number | string;
  /** Live Jomashop category record id (from /i1/categories). Same role as
   *  manufacturer_id for the category side. */
  category_id?: number | string;
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

  // Shoes
  if (/(\bshoe|sneaker|boot|loafer|heel|sandal|pump|moccasin|oxford|derby)/.test(haystack)) return "Shoes";
  // Handbags — be conservative: match clear handbag nouns, but NOT "wallet"
  // (which only superficially looks like a small leather good — Jomashop
  // classifies wallets separately and the operator must confirm the target
  // category before push).
  if (/(handbag|tote|clutch|crossbody|satchel|backpack|hobo|shoulder bag|top.?handle|\bbag\b)/.test(haystack)) {
    return "Handbags";
  }
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

/**
 * Categories that we recognize as "small leather goods" (wallets, card
 * holders, belts, etc.) — these are NOT automatically mapped to Handbags
 * even though the operator may later choose to push them as such. We track
 * them so the UI can render "needs Jomashop category verification".
 */
const SMALL_LEATHER_GOODS_CODES = new Set([
  "wall",
  "wallet",
  "wallets",
  "card",
  "cardholder",
  "card-holder",
  "card_holder",
  "belt",
  "belts",
  "keychain",
  "pouch",
]);

export function isAmbiguousCategoryCode(rawCategory: string | null | undefined): boolean {
  if (!rawCategory) return false;
  const norm = rawCategory.toLowerCase().trim();
  if (!SMALL_LEATHER_GOODS_CODES.has(norm)) return false;
  // A built-in default mapping (e.g. WALL → Accessories, CARD → Accessories)
  // resolves the ambiguity — no operator decision needed.
  if (BUILT_IN_CATEGORY_OVERRIDES[normalizeCategoryCode(rawCategory)]) return false;
  return true;
}

/**
 * Canonical lookup key for a Shopify category code used by the operator-supplied
 * override table. Lowercases and strips non-alphanumerics so "DRSH", "drsh",
 * and "Dress-Shirts" can be matched without depending on the operator's exact
 * casing in the uploaded XLSX.
 */
export function normalizeCategoryCode(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

/**
 * Built-in Shopify category code → Jomashop category mappings. Keyed by the
 * canonical normalized code (lowercase, alphanumeric only). Operator-saved
 * overrides in the `category_overrides` SQLite table take precedence; these
 * defaults fill the rest so products with known codes don't show as
 * "Needs category verification" out of the box.
 *
 * Target names match the live Jomashop category list (Footwear, Accessories,
 * Clothing, Handbags).
 */
export const BUILT_IN_CATEGORY_OVERRIDES: Record<string, string> = {
  // Accessories
  card: "Accessories",
  wall: "Accessories",
  belt: "Accessories",
  pksq: "Accessories",
  tie1: "Accessories",
  phon: "Accessories",
  hat1: "Accessories",
  chol: "Accessories",
  luggage: "Accessories",
  kchn: "Accessories",
  strp: "Accessories",
  glve: "Accessories",
  bowt: "Accessories",
  // Apparel
  pant: "Apparel",
  jack: "Apparel",
  tshr: "Apparel",
  shir: "Apparel",
  shrt: "Apparel",
  tops: "Apparel",
  hood: "Apparel",
  dres: "Apparel",
  swtr: "Apparel",
  crew: "Apparel",
  skrt: "Apparel",
  trou: "Apparel",
  swsh: "Apparel",
  undw: "Apparel",
  jean: "Apparel",
  polo: "Apparel",
  swim: "Apparel",
  outw: "Apparel",
  blzr: "Apparel",
  coat: "Apparel",
  swpa: "Apparel",
  vest: "Apparel",
  drsh: "Apparel",
  mask: "Apparel",
  suit: "Apparel",
  tuxe: "Apparel",
  paja: "Apparel",
  scrf: "Apparel",
  tank: "Apparel",
  heac: "Apparel",
  sock: "Apparel",
  jogg: "Apparel",
  jump: "Apparel",
  legg: "Apparel",
  clth: "Apparel",
  scoat: "Apparel",
  actv: "Apparel",
  pull: "Apparel",
  bras: "Apparel",
  blou: "Apparel",
  robe: "Apparel",
  body: "Apparel",
  cbund: "Apparel",
  beanie: "Apparel",
  cape: "Apparel",
  // Eyewear
  sung: "Eyewear",
  opti: "Eyewear",
  // Jewelry
  neck: "Necklaces",
  ring: "Rings",
  pins: "Pins & Brooches",
  brac: "Bracelets",
  eari: "Earrings",
  // Home Decor
  blan: "Home Decor",
  home: "Home Decor",
  // Handbags
  pouc: "Handbags",
  hand: "Handbags",
  shld: "Handbags",
  tote: "Handbags",
  crbd: "Handbags",
  bpck: "Handbags",
  toph: "Handbags",
  bltb: "Handbags",
  // Footwear
  snek: "Footwear",
  loaf: "Footwear",
  sand: "Footwear",
  boot: "Footwear",
  pump: "Footwear",
  ball: "Footwear",
  heel: "Footwear",
  flip: "Footwear",
  derby: "Footwear",
  mule: "Footwear",
  slpr: "Footwear",
  dsho: "Footwear",
  flat: "Footwear",
  espa: "Footwear",
  wedg: "Footwear",
};

/**
 * Return the built-in default Jomashop category name for a raw Shopify
 * category code, or null when no default mapping exists.
 */
export function lookupBuiltInCategoryDefault(
  rawCategory: string | null | undefined,
): string | null {
  const norm = normalizeCategoryCode(rawCategory);
  if (!norm) return null;
  return BUILT_IN_CATEGORY_OVERRIDES[norm] ?? null;
}

/**
 * Coerce a Jomashop category name (which may be Footwear/Accessories outside
 * the SUPPORTED_CATEGORIES enum) into one of the SupportedCategory values
 * used for schema resolution. Footwear → Shoes, Accessories → Clothing,
 * everything else falls back to the closest exact / substring match.
 */
export function coerceJomashopToSupported(
  jomashopCategoryName: string | null | undefined,
): SupportedCategory | null {
  if (!jomashopCategoryName) return null;
  const lower = String(jomashopCategoryName).toLowerCase().trim();
  if (!lower) return null;
  // Direct match against the enum.
  const direct = SUPPORTED_CATEGORIES.find((c) => c.toLowerCase() === lower);
  if (direct) return direct;
  // Known Jomashop categories outside the enum.
  if (lower === "footwear") return "Shoes";
  if (lower === "accessories") return "Clothing";
  // Substring fallback (e.g. "Dress Shirts" → "Clothing"-adjacent? we keep
  // this conservative — prefer exact map above).
  const sub = SUPPORTED_CATEGORIES.find((c) => lower.includes(c.toLowerCase()));
  return sub ?? null;
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
    if (normKey(m.description) === target) return true;
    return false;
  });
  if (mf?.value === undefined || mf?.value === null) return undefined;
  let raw = String(mf.value).trim();
  if (raw === "") return undefined;
  // Shopify list-type metafields are JSON-encoded arrays; flatten to a
  // comma-joined string. Scalar metaobject_reference values may also be
  // wrapped in quotes — strip a surrounding pair when present.
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const flat = arr
          .map((x) => (x === null || x === undefined ? "" : String(x).trim()))
          .filter((s) => s !== "")
          .join(", ");
        if (flat) return flat;
      }
    } catch {
      // not JSON — fall through
    }
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1).trim();
    if (raw === "") return undefined;
  }
  return raw;
}

/** First non-empty metafield value across the given candidate keys/labels. */
function readMetafieldAny(p: ShopifyProduct, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = readMetafield(p, k);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Locate the (namespace, key) of the first metafield on `p` whose
 * key/namespace/name/label matches any of the candidate identifiers, and
 * whose value is non-empty. Used by the per-product XLSX writeback to
 * preserve the original metafield location instead of always writing to a
 * new `jomashop.*` namespace.
 *
 * Returns null if no candidate has a populated metafield, in which case
 * callers should fall back to a stable default (`jomashop.parent_sku`).
 */
export function findMetafieldSource(
  p: ShopifyProduct,
  keys: ReadonlyArray<string>,
): { namespace: string; key: string } | null {
  const targets = keys.map((k) => normKey(k)).filter((t) => t !== "");
  if (targets.length === 0) return null;
  for (const m of p.metafields || []) {
    if (!m) continue;
    const val = m.value === null || m.value === undefined ? "" : String(m.value).trim();
    if (val === "") continue;
    const candidateTokens = [
      normKey(m.key),
      normKey(`${m.namespace ?? ""}.${m.key ?? ""}`),
      normKey(m.name),
      normKey(m.label),
      normKey(m.description),
    ].filter((t) => t !== "");
    if (candidateTokens.some((tok) => targets.includes(tok))) {
      const ns = (m.namespace && String(m.namespace).trim()) || "custom";
      const k = (m.key && String(m.key).trim()) || "parent_sku";
      return { namespace: ns, key: k };
    }
  }
  return null;
}

/**
 * Read the Parent SKU value from `p` using the canonical candidate list.
 * Centralized so the canonical-field extractor, the per-product XLSX
 * exporter, and the upload writeback all agree on the same source set.
 */
export function readParentSku(p: ShopifyProduct): string | undefined {
  return readMetafieldAny(p, [...PARENT_SKU_METAFIELD_CANDIDATES]);
}

/**
 * Detect the existing (namespace, key) of the source metafield where a
 * product's Parent SKU lives, when present. The XLSX upload writeback
 * prefers this over the default `jomashop.parent_sku` so edits land on the
 * same metafield the value was read from. Returns null when no candidate
 * metafield exists.
 */
export function findParentSkuSource(
  p: ShopifyProduct,
): { namespace: string; key: string } | null {
  return findMetafieldSource(p, PARENT_SKU_METAFIELD_CANDIDATES);
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
 * Normalize Shopify "Size Scale" values to the Jomashop `size_system` enum.
 * Shopify shops commonly use long names ("USA", "European") where Jomashop
 * expects 2-letter codes ("US", "EU"). Anything we don't recognize is
 * returned untouched so the UI can show the raw value.
 */
function normalizeSizeSystem(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (v === "USA" || v === "US" || v === "AMERICAN") return "US";
  if (v === "EUR" || v === "EU" || v === "EUROPEAN") return "EU";
  if (v === "UK" || v === "BRITISH" || v === "GB") return "UK";
  if (v === "IT" || v === "ITALIAN") return "IT";
  if (v === "FR" || v === "FRENCH") return "FR";
  return raw;
}

/** Normalize gender values: "MENS"/"Men's"/"male" → "Men", etc. */
function normalizeGender(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/['']s$/, "").replace(/s$/, "");
  if (v === "men" || v === "male" || v === "man") return "Men";
  if (v === "women" || v === "female" || v === "woman") return "Women";
  if (v === "uni" || v === "unisex") return "Unisex";
  if (v === "kid" || v === "child" || v === "children") return "Kids";
  return raw;
}

/**
 * Canonical property bag we extract from a Shopify product before mapping
 * to a Jomashop category schema. Schema-driven mapping in
 * `buildSchemaProperties` reads these by name and writes them out under the
 * exact schema field labels — so a fixture that supplies `gender` here ends
 * up under the live Apparel "Gender" property, the Footwear "gender" key,
 * or whatever label the live schema uses.
 *
 * Every value is a trimmed string when present, or undefined when missing.
 */
export type CanonicalProductFields = {
  brand?: string;
  model?: string;
  name?: string;
  article?: string;
  gender?: string;
  age?: string;
  size?: string;
  size_system?: string;
  size_type?: string;
  color?: string;
  material?: string;
  composition?: string;
  category_type?: string;
  apparel_type?: string;
  style?: string;
  country_of_origin?: string;
  description?: string;
  pieces?: string;
  hardware?: string;
  dimensions?: string;
  interior_material?: string;
  raw_category_code?: string;
  /** "UPC" or "EAN" when the product carries a real UPC/EAN identifier on
   *  the first variant.barcode or a UPC/EAN metafield. Never derived from
   *  category code or product type — Jomashop's Product ID Type enum only
   *  accepts UPC / EAN, so any other source is dropped. */
  product_id_type?: string;
  /** The actual UPC/EAN value. Paired with product_id_type. */
  product_id?: string;
  /** ASIN value, when an explicit ASIN metafield is present. Never inferred. */
  asin?: string;
  /** "Yes" when the product carries a size variant (multiple sizes OR a
   *  single non-empty size), "No" when it does not. Never the literal size
   *  value (e.g. "4") — Jomashop's Variation Size enum is a Yes/No flag. */
  variation_size_yes_no?: string;
  /** Parent SKU — the upstream "group" SKU shared across all size/colour
   *  variants of a product. Sourced strictly from explicit Shopify
   *  metafields (parent_sku / Parent SKU / ff_parent_sku / parentSku across
   *  the common namespaces). Never derived from variant size, variant SKU,
   *  brand, or handle — those are not parent SKUs and silently substituting
   *  them would corrupt Jomashop's product grouping. */
  parent_sku?: string;
};

/**
 * Candidate metafield keys/labels for the Parent SKU value, in priority
 * order. Used both for reading the value into the canonical bag and for
 * detecting which namespace/key the value originally came from when the
 * per-product XLSX writeback wants to land back on the same metafield
 * (rather than always writing to `jomashop.parent_sku`).
 *
 * IMPORTANT: variant size, variant SKU, the product handle, manufacturer
 * number, and brand are intentionally NOT in this list. A "Parent SKU"
 * substituted from any of those is wrong by definition.
 */
export const PARENT_SKU_METAFIELD_CANDIDATES: ReadonlyArray<string> = [
  "Parent SKU",
  "parent_sku",
  "parentSku",
  "parent-sku",
  "ff_parent_sku",
  "FF Parent SKU",
  "custom.parent_sku",
  "custom.ff_parent_sku",
  "luxe.parent_sku",
  "luxe.ff_parent_sku",
  "jomashop.parent_sku",
  "global.parent_sku",
  "ff.parent_sku",
];

/**
 * A normalized view of a single live Jomashop schema property. Different
 * portal builds put the human-readable label under different keys
 * (`label`, `name`, `title`, `field`). This shape captures all of them in
 * one place so the downstream label-matcher doesn't have to peer into the
 * raw payload again.
 */
export type SchemaPropertyDescriptor = {
  /** Outgoing key sent to Jomashop. Exact label-cased when live, lowercase
   *  for the fallback bundled schemas. */
  field: string;
  /** Human-readable label shown in the portal UI, if distinct from the
   *  outgoing field key. */
  label?: string;
  required: boolean;
  type?: string;
  options?: string[];
  /** When true and the field is not required, the field is OMITTED entirely
   *  from the payload when no value can be safely mapped. */
  allow_omit?: boolean;
  /** When true and the canonical value cannot be coerced to any of `options`,
   *  the field is dropped from the payload rather than sent with an invalid
   *  value. Avoids Jomashop's "X is not included in the list" rejections. */
  omit_when_unknown_enum?: boolean;
  /** When true, the `options` list is a best-guess from the bundled fallback
   *  rather than confirmed by Jomashop. The payload builder refuses to emit
   *  ANY value for this field until live options arrive — optional fields
   *  are dropped, required fields surface as a preflight blocker. Set on
   *  enum fields like Apparel's "Article" where the public guess list does
   *  not match Jomashop's actual accepted set. */
  options_unverified?: boolean;
  /** Live-schema hint: the field accepts multiple values (comma-separated on
   *  the wire). Surfaces in the per-product XLSX as a header note so the
   *  operator knows to comma-separate, and tells the upload validator to
   *  validate each token against the accepted-options list. */
  multiple?: boolean;
  /** Live-schema string-length hints (mirrors v1 `data.min_length` /
   *  `max_length`). Surfaced as header notes and enforced on upload. */
  min_length?: number;
  max_length?: number;
  /** Live-schema numeric hints. */
  min_value?: number;
  max_value?: number;
  only_integer?: boolean;
};

/** Collapse a label/field to a single comparable token. */
function labelToken(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Extract canonical product fields from a Shopify product. Reads metafields
 * (namespaced or definition-name), product options, vendor, and tags. The
 * resulting bag is fed to `buildSchemaProperties` which writes the values
 * out under the exact Jomashop schema labels.
 */
export function buildCanonicalProductFields(p: ShopifyProduct): CanonicalProductFields {
  const sizeOpt = resolveOption(p, ["size"]);
  const colorOpt = resolveOption(p, ["color", "colour"]);
  const firstVariant = p.variants?.[0];
  const tagList = (Array.isArray(p.tags) ? p.tags : (p.tags || "").split(","))
    .map((t) => t.trim())
    .filter(Boolean);

  const brand =
    readMetafieldAny(p, ["Designer Id", "designer_id", "ff_designer", "brand", "Brand"]) ||
    p.vendor ||
    undefined;

  const color =
    readMetafieldAny(p, [
      "Color",
      "color",
      "Colour",
      "colour",
      "primary_color",
      "Primary Color",
      "ff_color",
      "FF Color",
      "custom.color",
      "luxe.color",
      "ff.color",
      "global.color",
      "custom.colour",
      "luxe.colour",
      "custom.primary_color",
      "luxe.primary_color",
      "custom.ff_color",
      "luxe.ff_color",
    ]) ||
    (colorOpt && firstVariant ? ((firstVariant[colorOpt] as string | null) || undefined) : undefined);

  const size =
    readMetafieldAny(p, ["Size", "size", "custom.size", "luxe.size"]) ||
    (sizeOpt && firstVariant ? ((firstVariant[sizeOpt] as string | null) || undefined) : undefined);

  const rawSizeSystem = readMetafieldAny(p, [
    "size_system",
    "Size Scale",
    "size_scale",
    "custom.size_scale",
    "luxe.size_scale",
    "Size System",
    "size type",
    "Size Type",
    "Apparel Size Type",
  ]);
  const size_system = rawSizeSystem ? normalizeSizeSystem(rawSizeSystem) : undefined;

  const rawGender =
    readMetafieldAny(p, ["Gender", "gender", "custom.gender", "luxe.gender"]) ||
    tagList.find((t) => /^(Men|Mens|Women|Womens|Unisex|Kids|Kid|Boy|Boys|Girl|Girls|Child|Children|Baby|Infant|Toddler)s?$/i.test(t));
  const gender = rawGender ? normalizeGender(rawGender) : undefined;

  // Age inference: explicit metafield, otherwise derive Kids/Adult from gender.
  let age =
    readMetafieldAny(p, ["Age", "age", "Age Group", "age_group", "custom.age", "luxe.age"]) || undefined;
  if (!age) {
    if (gender === "Kids" || /\b(kid|kids|child|children|baby|infant|toddler|boy|boys|girl|girls)\b/i.test((p.title || "") + " " + tagList.join(" "))) {
      age = "Kids";
    } else if (gender === "Men" || gender === "Women" || gender === "Unisex") {
      age = "Adult";
    }
  }

  const material = readMetafieldAny(p, [
    "material",
    "Material",
    "composition",
    "Composition",
    "custom.composition",
    "luxe.composition",
    "custom.material",
    "luxe.material",
  ]);

  const country_of_origin = readMetafieldAny(p, [
    "ff_country_of_origin",
    "country_of_origin",
    "Country of Origin",
    "Country",
    "custom.ff_country_of_origin",
    "luxe.ff_country_of_origin",
    "custom.country_of_origin",
    "luxe.country_of_origin",
  ]);

  const style =
    readMetafieldAny(p, ["style", "Style", "custom.style", "luxe.style"]) || undefined;

  const rawCategoryCode =
    readMetafieldAny(p, ["category", "Category", "ff_category"]) || p.product_type || undefined;

  const category_type =
    readMetafieldAny(p, ["category_type", "Category Type", "custom.category_type", "luxe.category_type"]) ||
    rawCategoryCode ||
    undefined;

  // Apparel-specific type label (e.g. "Outerwear", "Pants"). Falls back to
  // category_type / product_type / a code lookup so live "Apparel Type" /
  // "Type" schema properties resolve for OUTW, PANT, DRSH, etc.
  const apparel_type =
    readMetafieldAny(p, ["Apparel Type", "apparel_type", "Type", "type"]) ||
    APPAREL_TYPE_BY_CODE[normalizeCategoryCode(rawCategoryCode || "")] ||
    category_type ||
    undefined;

  const description = (p.body_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;

  const pieces =
    readMetafieldAny(p, ["Pieces", "pieces", "Total Number of Pieces", "total_pieces", "piece_count"]) ||
    "1";

  // Article is an enum on Jomashop's Apparel category — sending the product
  // title verbatim triggers "Article is not included in the list". Prefer an
  // explicit Article metafield, then derive from apparel_type / category code
  // (e.g. OUTW → "Outerwear"). buildSchemaProperties will then coerce to the
  // schema's accepted option list and drop the value when no match exists.
  const article =
    readMetafieldAny(p, ["Article", "article"]) ||
    apparel_type ||
    APPAREL_TYPE_BY_CODE[normalizeCategoryCode(rawCategoryCode || "")] ||
    undefined;

  const hardware = readMetafieldAny(p, ["hardware", "Hardware"]);
  const dimensions = readMetafieldAny(p, ["dimensions", "Dimensions"]);
  const interior_material = readMetafieldAny(p, ["interior_material", "Interior Material"]);

  // Product ID (UPC/EAN) and ASIN must NEVER be derived from category code
  // or product type — Jomashop's Product ID Type enum accepts only UPC and
  // EAN. We source them strictly from explicit identifier fields.
  //
  // UPC = 12 digits, EAN = 13 digits. variant.barcode is the canonical
  // Shopify carrier; metafields with the literal label "UPC" / "EAN" / "ASIN"
  // are honored too.
  const firstBarcode =
    (firstVariant?.barcode && String(firstVariant.barcode).trim()) || undefined;
  const upcMeta = readMetafieldAny(p, ["UPC", "upc", "Upc", "custom.upc", "luxe.upc"]);
  const eanMeta = readMetafieldAny(p, ["EAN", "ean", "Ean", "custom.ean", "luxe.ean"]);
  const asinMeta = readMetafieldAny(p, ["ASIN", "asin", "Asin", "custom.asin", "luxe.asin"]);

  let product_id: string | undefined;
  let product_id_type: string | undefined;
  if (upcMeta && /^\d{11,13}$/.test(upcMeta.trim())) {
    product_id = upcMeta.trim();
    product_id_type = product_id.length === 13 ? "EAN" : "UPC";
  } else if (eanMeta && /^\d{12,13}$/.test(eanMeta.trim())) {
    product_id = eanMeta.trim();
    product_id_type = "EAN";
  } else if (firstBarcode && /^\d{12,13}$/.test(firstBarcode)) {
    product_id = firstBarcode;
    product_id_type = firstBarcode.length === 13 ? "EAN" : "UPC";
  }
  const asin = asinMeta && asinMeta.trim() ? asinMeta.trim() : undefined;

  // Variation Size (Yes/No) is a boolean-style enum on Jomashop. "Yes" when
  // the product has a size option (one or more variants with a non-empty
  // size value). Never the literal size value — "4" is not in the accepted
  // Yes/No list.
  let variation_size_yes_no: string | undefined;
  if (sizeOpt) {
    const hasNonEmptySize = (p.variants || []).some((v) => {
      const val = (v as unknown as Record<string, unknown>)[sizeOpt] as string | null | undefined;
      return typeof val === "string" && val.trim() !== "";
    });
    variation_size_yes_no = hasNonEmptySize ? "Yes" : "No";
  } else if (size) {
    // No "Size" option but a size value resolved from a metafield — still
    // counts as having a size variation.
    variation_size_yes_no = "Yes";
  } else {
    variation_size_yes_no = "No";
  }

  // Parent SKU: pulled strictly from explicit parent-sku metafields. Never
  // derived from the variant SKU, variant size, manufacturer number, brand,
  // or product handle — those are not parent SKUs by definition and silently
  // substituting them would corrupt Jomashop's product grouping. When no
  // parent-sku metafield is present the field stays undefined; downstream
  // schema-mapping / payload code surfaces the gap rather than guessing.
  const parent_sku = readParentSku(p);

  return {
    brand: brand || undefined,
    model: p.title || undefined,
    name: p.title || undefined,
    article: article || undefined,
    gender,
    age,
    size: size || undefined,
    size_system,
    size_type: size_system,
    color: color || undefined,
    material: material || undefined,
    composition: material || undefined,
    category_type,
    apparel_type,
    style,
    country_of_origin: country_of_origin || undefined,
    description,
    pieces,
    hardware: hardware || undefined,
    dimensions: dimensions || undefined,
    interior_material: interior_material || undefined,
    raw_category_code: rawCategoryCode || undefined,
    product_id_type,
    product_id,
    asin,
    variation_size_yes_no,
    parent_sku: parent_sku || undefined,
  };
}

/**
 * Mapping from Shopify product-type codes (DRSH, OUTW, PANT, ...) to the
 * value Jomashop expects under live "Apparel Type" / "Type" properties.
 * Independent from the BUILT_IN_CATEGORY_OVERRIDES table (which maps to the
 * Jomashop top-level category like "Apparel" / "Footwear") — this drives
 * the live per-category property value.
 */
const APPAREL_TYPE_BY_CODE: Record<string, string> = {
  outw: "Outerwear",
  scoat: "Outerwear",
  coat: "Outerwear",
  blzr: "Outerwear",
  jack: "Jackets",
  vest: "Vests",
  pant: "Pants",
  trou: "Pants",
  jean: "Jeans",
  swpa: "Sweatpants",
  jogg: "Joggers",
  shor: "Shorts",
  shrt: "Shirts",
  shir: "Shirts",
  drsh: "Dress Shirts",
  polo: "Polo Shirts",
  tshr: "T-Shirts",
  tank: "Tank Tops",
  tops: "Tops",
  blou: "Blouses",
  swtr: "Sweaters",
  hood: "Hoodies",
  crew: "Sweatshirts",
  swsh: "Sweatshirts",
  pull: "Pullovers",
  dres: "Dresses",
  skrt: "Skirts",
  suit: "Suits",
  tuxe: "Tuxedos",
  swim: "Swimwear",
  legg: "Leggings",
  sock: "Socks",
  undw: "Underwear",
  paja: "Pajamas",
  robe: "Robes",
  body: "Bodysuits",
  jump: "Jumpsuits",
  actv: "Activewear",
  bras: "Bras",
  cape: "Capes",
  scrf: "Scarves",
  beanie: "Hats",
  hat1: "Hats",
  cbund: "Cummerbunds",
  heac: "Headwear",
  mask: "Masks",
};

/**
 * Flexible label-matcher: pick the best canonical field for a given
 * Jomashop schema property descriptor. Inspects the field name AND label,
 * collapsed to alphanumeric tokens, then matches against a series of
 * keyword tests ordered most-specific first.
 *
 * Returns the canonical field name (key into CanonicalProductFields) or
 * null if nothing matches.
 */
function pickCanonicalField(prop: SchemaPropertyDescriptor): keyof CanonicalProductFields | null {
  const tokens = [labelToken(prop.field), labelToken(prop.label)].filter((s) => s.length > 0);
  if (tokens.length === 0) return null;
  const has = (sub: string) => tokens.some((t) => t.includes(sub));
  // Most-specific first so "Variation Size (Yes/No)" and "Apparel Size Type"
  // don't fall through to "size", and so "Parent SKU" maps to the parent_sku
  // canonical field instead of being treated as a generic "SKU".
  if (has("parentsku") || has("parentitemsku") || has("groupsku") || has("parentnumber"))
    return "parent_sku";
  if (has("variationsize") || has("variantsize") || has("sizevariation") || has("sizeyesno"))
    return "variation_size_yes_no";
  if (has("productidtype") || has("productidkind") || has("idtype")) return "product_id_type";
  if (has("productid") && !has("productidtype") && !has("productidkind")) return "product_id";
  if (has("upc") && !has("upclookup")) return "product_id";
  if (has("ean") && !has("eancode") || tokens.some((t) => t === "ean")) return "product_id";
  if (has("asin")) return "asin";
  if (has("apparelsizetype") || has("sizetype") || has("sizesystem") || has("sizescale")) return "size_system";
  if (has("apparelsize") || has("size")) return "size";
  if (has("countryoforigin") || has("origin") || has("madein") || has("country")) return "country_of_origin";
  if (has("detaileddescription") || has("description") || has("details")) return "description";
  if (has("totalnumberofpieces") || has("pieces") || has("piececount")) return "pieces";
  if (has("article")) return "article";
  if (has("apparelttype") || has("appareltype")) return "apparel_type";
  if (has("categorytype")) return "category_type";
  if (has("type") && !has("sizetype")) return "apparel_type";
  if (has("agegroup") || has("age")) return "age";
  if (has("gender") || has("sex")) return "gender";
  if (has("color") || has("colour")) return "color";
  if (has("composition")) return "composition";
  if (has("material") || has("fabric")) return "material";
  if (has("interiormaterial")) return "interior_material";
  if (has("hardware")) return "hardware";
  if (has("dimensions") || has("measurements")) return "dimensions";
  if (has("style")) return "style";
  if (has("brand") || has("manufacturer") || has("designer")) return "brand";
  if (has("model") || has("name")) return "model";
  return null;
}

/**
 * If a schema property has an enum/options list, pick the option whose
 * normalized form matches the canonical value. Returns the canonical option
 * spelling (so the payload uses the exact case Jomashop expects), or
 * undefined when no match is found.
 */
function matchSchemaOption(value: string, options: string[] | undefined): string | undefined {
  if (!options || options.length === 0) return value;
  const v = labelToken(value);
  if (!v) return undefined;
  for (const opt of options) {
    if (labelToken(opt) === v) return opt;
  }
  // Substring fallback: option contains the value, or vice versa.
  for (const opt of options) {
    const o = labelToken(opt);
    if (o.includes(v) || v.includes(o)) return opt;
  }
  return undefined;
}

/**
 * Normalize the raw /i1/categories/:id response into a uniform list of
 * schema property descriptors. The portal returns one of many shapes
 * depending on tenant config — some flavours nest the property list under
 * `properties`, `attributes`, `fields`, or `category.properties`; each
 * entry may name its label `name`, `label`, `title`, or `field`. We collect
 * all of them so the schema-driven mapper has a single source of truth.
 *
 * Returns an empty array when no recognizable property list is present
 * (which signals the caller to fall back to the bundled schema).
 */
/**
 * Normalize the v1 `/v1/categories/:name` response into the same uniform
 * descriptor shape as `normalizeI1CategorySchema`. The v1 shape (per the
 * published Jomashop docs) wraps each schema property as:
 *
 *   {
 *     key: "article",
 *     designation: "required" | "recommended" | "optional",
 *     name: "Article",
 *     kind: "enumerable" | "string" | "numeric" | "boolean",
 *     data: { values: ["Outerwear", "Jackets", …], multiple?: boolean,
 *             min_length?: number, max_length?: number }
 *   }
 *
 * The accepted enum list lives under `data.values` — when present we treat
 * the property as a verified Jomashop-confirmed enum and emit its options
 * exactly. Required-ness comes from `designation === "required"`.
 *
 * Returns [] when the payload doesn't carry a recognizable v1 property
 * list, so callers can fall back to /i1 or the bundled schema.
 */
export function normalizeV1CategorySchema(raw: unknown): SchemaPropertyDescriptor[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const candidates: unknown[] = [
    root.properties,
    (root.category as { properties?: unknown } | undefined)?.properties,
    (root.data as { properties?: unknown } | undefined)?.properties,
  ];
  let list: unknown[] = [];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      list = c;
      break;
    }
  }
  if (list.length === 0) return [];
  // Heuristic: a v1 property has at least one of {designation, kind, data}.
  // Otherwise this isn't a v1 payload — let the caller try the /i1
  // normalizer (which handles older shapes).
  const looksLikeV1 = list.some((p) => {
    if (!p || typeof p !== "object") return false;
    const it = p as Record<string, unknown>;
    return "designation" in it || "kind" in it || "data" in it;
  });
  if (!looksLikeV1) return [];

  const out: SchemaPropertyDescriptor[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    // Prefer human-readable `name` for the outbound payload key (matches the
    // Title Case labels Jomashop's /i1 endpoint accepts). Fall back to `key`
    // only when `name` is absent. Skip the property entirely if both are
    // missing or empty.
    const nameRaw = typeof it.name === "string" ? it.name.trim() : "";
    const keyRaw = typeof it.key === "string" ? it.key.trim() : "";
    const field = nameRaw || keyRaw;
    if (!field) continue;
    const label = nameRaw || keyRaw;
    const designation =
      typeof it.designation === "string" ? it.designation.toLowerCase().trim() : "";
    const required = designation === "required" || designation === "mandatory";
    const kindRaw = typeof it.kind === "string" ? it.kind.toLowerCase().trim() : "";
    let type: string | undefined;
    if (kindRaw === "enumerable" || kindRaw === "enum") type = "enum";
    else if (kindRaw === "numeric" || kindRaw === "number" || kindRaw === "integer") type = "number";
    else if (kindRaw === "boolean" || kindRaw === "bool") type = "boolean";
    else if (kindRaw === "string" || kindRaw === "text") type = "string";
    // data.values → options
    const dataObj = (it.data && typeof it.data === "object" ? (it.data as Record<string, unknown>) : null);
    const options: string[] = [];
    const valsRaw = dataObj?.values;
    if (Array.isArray(valsRaw)) {
      for (const o of valsRaw) {
        if (typeof o === "string" && o.trim()) options.push(o);
        else if (o && typeof o === "object") {
          const vo = o as Record<string, unknown>;
          const v = vo.value ?? vo.label ?? vo.name;
          if (typeof v === "string" && v.trim()) options.push(v);
        }
      }
    }
    const hasOptions = options.length > 0;
    if (hasOptions && !type) type = "enum";
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    const multiple = Boolean(dataObj?.multiple);
    const min_length = num(dataObj?.min_length);
    const max_length = num(dataObj?.max_length);
    const min_value = num(dataObj?.min_value ?? dataObj?.min);
    const max_value = num(dataObj?.max_value ?? dataObj?.max);
    const only_integer =
      kindRaw === "integer" ||
      Boolean(dataObj?.only_integer) ||
      Boolean(dataObj?.integer);
    out.push({
      field,
      label,
      required,
      type,
      options: hasOptions ? options : undefined,
      // v1 options are LIVE and verified — never mark as unverified.
      allow_omit: !required,
      omit_when_unknown_enum: !required && hasOptions,
      multiple: multiple || undefined,
      min_length,
      max_length,
      min_value,
      max_value,
      only_integer: only_integer || undefined,
    });
  }
  return out;
}

export function normalizeI1CategorySchema(raw: unknown): SchemaPropertyDescriptor[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const candidates: unknown[] = [
    root.properties,
    root.attributes,
    root.fields,
    (root.category as { properties?: unknown })?.properties,
    (root.category as { attributes?: unknown })?.attributes,
    (root.data as { properties?: unknown })?.properties,
    (root.data as { attributes?: unknown })?.attributes,
  ];
  let list: unknown[] = [];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      list = c;
      break;
    }
  }
  if (list.length === 0) return [];
  const out: SchemaPropertyDescriptor[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const label =
      (typeof it.label === "string" && it.label) ||
      (typeof it.name === "string" && it.name) ||
      (typeof it.title === "string" && it.title) ||
      (typeof it.field === "string" && it.field) ||
      (typeof it.key === "string" && it.key) ||
      "";
    const field =
      (typeof it.field === "string" && it.field) ||
      (typeof it.key === "string" && it.key) ||
      (typeof it.label === "string" && it.label) ||
      (typeof it.name === "string" && it.name) ||
      "";
    if (!field || typeof field !== "string" || !field.trim()) continue;
    const required = Boolean(it.required || it.is_required || it.mandatory);
    const type = typeof it.type === "string" ? it.type : undefined;
    const options: string[] = [];
    const optsRaw = it.options ?? it.values ?? it.enum;
    if (Array.isArray(optsRaw)) {
      for (const o of optsRaw) {
        if (typeof o === "string" && o.trim()) options.push(o);
        else if (o && typeof o === "object") {
          const v = (o as Record<string, unknown>).value ?? (o as Record<string, unknown>).label ?? (o as Record<string, unknown>).name;
          if (typeof v === "string" && v.trim()) options.push(v);
        }
      }
    }
    // Live-schema interpretation:
    //   - Optional enum properties default to omit_when_unknown_enum=true so
    //     a source value not in the accepted list is dropped from the
    //     payload rather than triggering Jomashop's "X is not included in
    //     the list" rejection.
    //   - Optional properties default to allow_omit=true so the payload
    //     never carries an explicit null for a field Jomashop did not
    //     require (some validators reject explicit nulls).
    const hasOptions = options.length > 0;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    const multiple = Boolean(it.multiple);
    const min_length = num(it.min_length ?? it.minLength);
    const max_length = num(it.max_length ?? it.maxLength);
    const min_value = num(it.min_value ?? it.min);
    const max_value = num(it.max_value ?? it.max);
    const only_integer =
      type === "integer" || Boolean(it.only_integer) || Boolean(it.integer);
    out.push({
      field,
      label: typeof label === "string" ? label : undefined,
      required,
      type,
      options: hasOptions ? options : undefined,
      allow_omit: !required,
      omit_when_unknown_enum: !required && hasOptions,
      multiple: multiple || undefined,
      min_length,
      max_length,
      min_value,
      max_value,
      only_integer: only_integer || undefined,
    });
  }
  return out;
}

/**
 * Build the outgoing `properties` object from a live Jomashop schema and a
 * canonical product field bag. Output keys are the exact schema field
 * labels — never generic lowercase names — so a live Apparel schema with
 * "Gender" / "Apparel Type" / "Detailed Description" properties produces
 * exactly those keys, not the legacy `gender` / `category_type` keys.
 *
 * Returns the populated properties plus the exact labels of required
 * schema properties that could not be filled, so readiness/UI surfaces the
 * exact missing field names.
 */
/**
 * Optional dependency injected into the schema mapper to resolve operator
 * enum overrides at mapping time. The mapper passes the resolved Jomashop
 * category, the schema field label, and the canonical source value (the
 * value the mapper would otherwise have sent), and expects back either an
 * accepted Jomashop option string or null when no mapping exists. The
 * second parameter `acceptedOptions` is the live/fallback option list the
 * resolver should verify against; when omitted the resolver may emit a
 * value without verifying.
 *
 * Kept as a function pointer (rather than a direct import from
 * server/storage) so this module stays pure and unit-testable without
 * touching SQLite.
 */
export type EnumOverrideResolver = (
  jomashopCategory: string,
  jomashopField: string,
  sourceValue: string,
  acceptedOptions: string[] | undefined,
) => string | null;

export function buildSchemaProperties(
  schema: SchemaPropertyDescriptor[],
  canonical: CanonicalProductFields,
  context?: {
    /** Jomashop category name for override lookups (e.g. "Apparel"). */
    category?: string;
    /** Resolver that returns a Jomashop-accepted option for a source value,
     *  or null when no override is registered. See EnumOverrideResolver. */
    resolveEnumOverride?: EnumOverrideResolver;
    /** Extra canonical source values to try for override lookups beyond the
     *  one the schema mapper extracted (e.g. raw Shopify product_type code).
     *  Tried in order; the first hit wins. */
    extraSourceValues?: Partial<Record<keyof CanonicalProductFields, string[]>>;
  },
): {
  properties: Record<string, string | number | boolean | null>;
  missingRequired: string[];
  schemaLabels: string[];
  /** Per-field record of enum coercion failures (canonical value, accepted
   *  options) for preflight error reporting. Keyed by schema label. */
  invalidEnums: Array<{ field: string; value: string; options: string[] }>;
  /** Fields that were dropped from the payload because the value could not
   *  be mapped to an accepted option AND the field allows omission. */
  omittedFields: string[];
  /** Required schema fields whose option list is `options_unverified` —
   *  the push cannot proceed because emitting a guess risks Jomashop's
   *  "X is not included in the list" rejection. Surfaced as a preflight
   *  blocker; the operator must load the live option list (or map values)
   *  before the field can be sent. */
  unverifiedRequiredOptions: Array<{ field: string; value?: string }>;
  /** Enum coercions performed by the data-driven category-code synonym
   *  resolver. Surfaces in the UI as "auto-resolved" so the operator can
   *  audit / override the choice. Each entry records the live schema field,
   *  the chosen accepted option, and the source code that drove it. */
  autoResolvedEnums: Array<{ field: string; chosen: string; sourceCode: string; reason: string }>;
} {
  const properties: Record<string, string | number | boolean | null> = {};
  const missingRequired: string[] = [];
  const schemaLabels: string[] = [];
  const invalidEnums: Array<{ field: string; value: string; options: string[] }> = [];
  const omittedFields: string[] = [];
  const unverifiedRequiredOptions: Array<{ field: string; value?: string }> = [];
  const autoResolvedEnums: Array<{ field: string; chosen: string; sourceCode: string; reason: string }> = [];

  // Build the prioritized list of source values to feed the enum-override
  // resolver for a single property. The resolver checks each in order and
  // takes the first hit so explicit `Article` metafield values still beat
  // the apparel_type code lookup.
  function sourceValuesFor(prop: SchemaPropertyDescriptor, canonicalValue: string | undefined): string[] {
    const out: string[] = [];
    if (canonicalValue) out.push(canonicalValue);
    const ck = pickCanonicalField(prop);
    if (ck) {
      const extras = context?.extraSourceValues?.[ck];
      if (Array.isArray(extras)) {
        for (const e of extras) {
          if (e && !out.includes(e)) out.push(e);
        }
      }
    }
    // Always try the raw Shopify category code (e.g. "OUTW") for enum
    // fields whose canonical value otherwise comes from a sibling field.
    // The enum override seeds for Apparel/Article are keyed on these codes.
    const rawCode = canonical.raw_category_code;
    if (rawCode && !out.includes(rawCode)) out.push(rawCode);
    // De-dup empties.
    return out.filter((s) => typeof s === "string" && s.trim().length > 0);
  }

  function resolveOverrideFor(
    prop: SchemaPropertyDescriptor,
    canonicalValue: string | undefined,
  ): { value: string; source: string } | null {
    if (!context?.resolveEnumOverride || !context.category) return null;
    const candidates = sourceValuesFor(prop, canonicalValue);
    const optionsForCheck = prop.options_unverified ? undefined : prop.options;
    for (const src of candidates) {
      const hit = context.resolveEnumOverride(
        context.category,
        prop.field,
        src,
        optionsForCheck,
      );
      if (hit) return { value: hit, source: src };
    }
    return null;
  }

  // Synonym resolver — option-aware mapping from Shopify category codes
  // (OUTW, HEEL, CRBD, ...) to the live accepted-options list. Only runs
  // when the schema property carries a VERIFIED option list (not
  // options_unverified) AND the operator override didn't already supply a
  // value. Resolution is null-safe: a code that doesn't map to any accepted
  // option returns null and the caller falls through to the existing
  // omit / preflight path.
  function resolveSynonymFor(
    prop: SchemaPropertyDescriptor,
    canonicalValue: string | undefined,
  ): { value: string; source: string } | null {
    if (prop.options_unverified) return null;
    if (!Array.isArray(prop.options) || prop.options.length === 0) return null;
    const sources: string[] = [];
    if (canonical.raw_category_code) sources.push(canonical.raw_category_code);
    if (canonical.apparel_type) sources.push(canonical.apparel_type);
    if (canonical.category_type) sources.push(canonical.category_type);
    if (canonical.style) sources.push(canonical.style);
    if (canonicalValue) sources.push(canonicalValue);
    for (const src of sources) {
      const hit = resolveCategorySynonym(prop.field, src, prop.options);
      if (hit) return { value: hit, source: src };
    }
    return null;
  }

  for (const prop of schema) {
    if (!prop || typeof prop.field !== "string" || prop.field.trim() === "" || prop.field === "undefined") {
      continue;
    }
    const outKey = prop.field;
    schemaLabels.push(outKey);
    const canonicalKey = pickCanonicalField(prop);
    let value: string | undefined = canonicalKey ? (canonical[canonicalKey] as string | undefined) : undefined;
    if (typeof value === "string") value = value.trim() || undefined;
    const rawValueForReporting = value;

    // options_unverified short-circuit: the bundled `options` list is a
    // best-guess and may not match Jomashop's actual accepted set. We
    // refuse to emit a value derived from the bundled options — but an
    // operator-supplied (or built-in seed) enum override IS allowed to
    // resolve the field, because that override represents a confirmed
    // mapping rather than a guess against the unverified list.
    if (prop.options_unverified) {
      const override = resolveOverrideFor(prop, value);
      if (override) {
        properties[outKey] = override.value;
        continue;
      }
      if (prop.required) {
        // Required field with unverified options AND no override → preflight
        // block. missingRequired triggers the existing 422 path; the
        // unverifiedRequiredOptions detail gives the operator the exact next
        // step (load the live option list OR add an enum mapping).
        missingRequired.push(outKey);
        unverifiedRequiredOptions.push({ field: outKey, value: rawValueForReporting });
        properties[outKey] = null;
      } else {
        // Optional field with unverified options → drop entirely. Never
        // a guess; the absent key is safer than an invalid enum value.
        omittedFields.push(outKey);
      }
      continue;
    }

    // Resolution order for enum fields with a verified accepted-options
    // list:
    //   1) Operator override (verified mapping) — always wins when present.
    //      A saved operator mapping is a deliberate choice and must beat any
    //      auto-resolution, even when the canonical value would otherwise
    //      match directly. This preserves operator intent across pushes.
    //   2) Direct enum coercion against the canonical value (matchSchemaOption).
    //   3) Data-driven category-code synonym resolver, gated on the live
    //      accepted-options list. Surfaces in auto_resolved_enums.
    //   4) Drop (enumCoercionFailed) — surfaces in invalid_enums.
    //
    // Non-enum fields (no options) pass through unchanged.
    let enumCoercionFailed = false;
    if (prop.options && prop.options.length > 0) {
      // (1) Try operator override first so a verified mapping always wins.
      const override = resolveOverrideFor(prop, value);
      if (override) {
        value = override.value;
      } else if (value) {
        // (2) Direct coercion against the accepted-options list.
        const coerced = matchSchemaOption(value, prop.options);
        if (coerced === undefined || coerced === "") {
          // (3) Synonym resolver as fallback.
          const synonym = resolveSynonymFor(prop, value);
          if (synonym) {
            value = synonym.value;
            autoResolvedEnums.push({
              field: outKey,
              chosen: synonym.value,
              sourceCode: synonym.source,
              reason: "category-code synonym matched live accepted option",
            });
          } else {
            // (4) Drop — caller decides whether this is preflight-blocking.
            enumCoercionFailed = true;
            value = undefined;
          }
        } else {
          value = coerced;
        }
      } else {
        // No canonical value AND no override — try the synonym resolver as
        // a last resort (e.g. OUTW → "Coats & Jackets" when no Article
        // metafield exists). Gated on the live accepted-options list so we
        // never emit a guess.
        const synonym = resolveSynonymFor(prop, undefined);
        if (synonym) {
          value = synonym.value;
          autoResolvedEnums.push({
            field: outKey,
            chosen: synonym.value,
            sourceCode: synonym.source,
            reason: "category-code synonym matched live accepted option",
          });
        }
      }
    }

    if (!value) {
      // Two branches:
      //   (a) The field permits omission AND the value either is missing
      //       outright or failed enum coercion → drop the key from output.
      //   (b) The field is required → null + missingRequired entry.
      //   (c) Otherwise → null (legacy behaviour for non-enum optional fields).
      const isOptionalEnumMiss = enumCoercionFailed && prop.omit_when_unknown_enum;
      const canOmit = !prop.required && (prop.allow_omit || isOptionalEnumMiss);
      if (canOmit) {
        omittedFields.push(outKey);
      } else {
        properties[outKey] = null;
      }
      if (prop.required) missingRequired.push(outKey);
      if (enumCoercionFailed && rawValueForReporting) {
        invalidEnums.push({
          field: outKey,
          value: rawValueForReporting,
          options: prop.options || [],
        });
      }
    } else {
      properties[outKey] = value;
    }
  }
  return {
    properties,
    missingRequired,
    schemaLabels,
    invalidEnums,
    omittedFields,
    unverifiedRequiredOptions,
    autoResolvedEnums,
  };
}

/**
 * Pre-flight coercions on the canonical bag based on the schema being
 * targeted. Most categories don't need this, but Apparel's Gender enum
 * (Men/Women/Unisex) doesn't accept "Kids" — Kids products must travel via
 * Age=Kids and Gender=Unisex. Doing this before enum coercion lets the
 * required Gender field always pass.
 *
 * Also maps Country of Origin synonyms (e.g. "USA" → "United States" when
 * the live schema only lists the latter, and vice versa) when both are not
 * in the accepted list.
 */
export function coerceCanonicalForCategory(
  canonical: CanonicalProductFields,
  schemaProperties: Array<{ field: string; options?: string[]; label?: string }>,
): CanonicalProductFields {
  const out = { ...canonical };
  // Find the Gender schema property and inspect its option list.
  const genderProp = schemaProperties.find(
    (p) => p && typeof p.field === "string" && /gender/i.test(p.field),
  );
  if (genderProp) {
    const opts = (genderProp.options || []).map((o) => o.toLowerCase());
    if (
      out.gender &&
      out.gender.toLowerCase() === "kids" &&
      opts.length > 0 &&
      !opts.includes("kids")
    ) {
      // Funnel Kids to Unisex when supported; otherwise let enum coercion
      // drop the value (Age=Kids still carries the kids signal).
      if (opts.includes("unisex")) out.gender = "Unisex";
      else out.gender = undefined;
      if (!out.age) out.age = "Kids";
    }
  }
  // Country of Origin synonym pass — try the obvious variants when the
  // canonical string doesn't directly match one of the accepted options.
  const cooProp = schemaProperties.find(
    (p) =>
      p &&
      typeof p.field === "string" &&
      /country(of)?origin/i.test(p.field.replace(/\s+/g, "")),
  );
  if (cooProp && out.country_of_origin && cooProp.options && cooProp.options.length > 0) {
    const lower = out.country_of_origin.trim().toLowerCase();
    const optsLower = cooProp.options.map((o) => o.toLowerCase());
    if (!optsLower.includes(lower)) {
      const synonyms: Record<string, string[]> = {
        usa: ["united states", "united states of america", "us"],
        "united states": ["usa", "us"],
        "united states of america": ["usa", "united states"],
        uk: ["united kingdom", "great britain", "britain", "england"],
        "united kingdom": ["uk", "great britain"],
      };
      const aliases = synonyms[lower] || [];
      for (const alias of aliases) {
        const idx = optsLower.indexOf(alias);
        if (idx !== -1) {
          out.country_of_origin = cooProp.options[idx];
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Map a Shopify product to a Jomashop product payload.
 * `properties` schema is either fetched live or falls back to FALLBACK_CATEGORY_SCHEMAS.
 */
export function mapShopifyToJomashop(
  product: ShopifyProduct,
  schemaProperties: Array<{ field: string; required: boolean; type?: string; options?: string[]; label?: string }>,
  forcedCategory?: SupportedCategory,
  options?: {
    /** Optional enum override resolver. When supplied the mapper consults
     *  it for any enum field whose canonical value either fails the option
     *  list check OR whose options are marked unverified. See
     *  EnumOverrideResolver for the contract. */
    resolveEnumOverride?: EnumOverrideResolver;
  },
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

  // Build a properties object using the category schema. Schema-driven
  // mapping always uses EXACT live/Title-Case labels so the /i1/products/
  // endpoint accepts the payload. The bundled FALLBACK_CATEGORY_SCHEMAS were
  // rewritten to use Title Case labels too — the legacy lowercase emit path
  // (preserved below) only runs when the schema itself was already
  // lowercase, which is unreachable for any production category. It is
  // retained as a defensive mapping for tests / external callers that hand
  // in an explicitly-lowercase schema.
  const usesLiveSchemaLabels = schemaUsesExactLabels(schemaProperties);
  const properties: Record<string, string | number | boolean | null> = {};
  const missingRequiredProps: string[] = [];
  let invalidEnums: Array<{ field: string; value: string; options: string[] }> = [];
  let omittedOptionalFields: string[] = [];
  let unverifiedRequiredOptions: Array<{ field: string; value?: string }> = [];
  let autoResolvedEnums: Array<{ field: string; chosen: string; sourceCode: string; reason: string }> = [];

  if (usesLiveSchemaLabels) {
    let canonical = buildCanonicalProductFields(product);
    // Apparel-specific coercion: the live Apparel Gender schema rejects
    // "Kids" — it expects Men/Women/Unisex. Funnel Kids products through
    // Age=Kids and downshift Gender to Unisex BEFORE schema mapping so the
    // enum coercion in buildSchemaProperties doesn't drop Gender as
    // unmappable (which would surface a required-field error).
    canonical = coerceCanonicalForCategory(canonical, schemaProperties);
    const built = buildSchemaProperties(
      schemaProperties as SchemaPropertyDescriptor[],
      canonical,
      {
        category,
        resolveEnumOverride: options?.resolveEnumOverride,
      },
    );
    for (const [k, v] of Object.entries(built.properties)) {
      properties[k] = v;
    }
    for (const label of built.missingRequired) {
      missingRequiredProps.push(label);
      warnings.push(
        `Missing required ${category} field "${label}" — add via metafield, product option, or vendor field.`,
      );
    }
    invalidEnums = built.invalidEnums;
    omittedOptionalFields = built.omittedFields;
    unverifiedRequiredOptions = built.unverifiedRequiredOptions;
    autoResolvedEnums = built.autoResolvedEnums;
    for (const r of autoResolvedEnums) {
      warnings.push(
        `Auto-resolved ${category} field "${r.field}" to "${r.chosen}" from source code "${r.sourceCode}" — ${r.reason}. Add a verified enum mapping to override.`,
      );
    }
    for (const inv of invalidEnums) {
      warnings.push(
        `Value "${inv.value}" for ${category} field "${inv.field}" is not in Jomashop's accepted list (${inv.options.slice(0, 8).join(", ")}${inv.options.length > 8 ? "…" : ""}). Add a mapping or correct the source metafield.`,
      );
    }
    for (const u of unverifiedRequiredOptions) {
      warnings.push(
        `Required ${category} field "${u.field}" has no confirmed Jomashop option list. Load the live category schema (or supply a mapping) before pushing — sending a guess will trigger "${u.field} is not included in the list".`,
      );
    }
  } else for (const prop of schemaProperties) {
    // Defensive: schema entries with an empty/undefined field name are
    // surfaced as "Needs category verification" rather than emitted as a
    // property keyed "undefined".
    if (!prop || typeof prop.field !== "string" || prop.field.trim() === "" || prop.field === "undefined") {
      continue;
    }
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
          value = readMetafieldAny(product, [
            "Color",
            "color",
            "Colour",
            "colour",
            "primary_color",
            "Primary Color",
            "ff_color",
            "FF Color",
            "custom.color",
            "luxe.color",
            "ff.color",
            "global.color",
            "custom.colour",
            "luxe.colour",
            "custom.primary_color",
            "luxe.primary_color",
            "custom.ff_color",
            "luxe.ff_color",
          ]);
          // Fall back to product/variant option ("Color" / "Colour"). Use
          // structured fields only — never infer color from product title.
          if (!value && colorOpt && firstVariant) {
            value = (firstVariant[colorOpt] as string | null) || undefined;
          }
          break;
        case "size":
          value = readMetafieldAny(product, ["Size", "size", "custom.size", "luxe.size"]);
          if (!value && sizeOpt && firstVariant) {
            value = (firstVariant[sizeOpt] as string | null) || undefined;
          }
          break;
        case "size_system": {
          const raw =
            readMetafieldAny(product, [
              "size_system",
              "Size Scale",
              "size_scale",
              "custom.size_scale",
              "luxe.size_scale",
            ]) || "US";
          value = normalizeSizeSystem(raw);
          break;
        }
        case "gender":
          value =
            readMetafieldAny(product, ["Gender", "gender", "custom.gender", "luxe.gender"]) ||
            (Array.isArray(product.tags) ? product.tags : (product.tags || "").split(","))
              .map((t) => t.trim())
              .find((t) => /^(Men|Mens|Women|Womens|Unisex|Kids)$/i.test(t));
          if (value) value = normalizeGender(value);
          break;
        case "material":
          // Shopify often stores fabric/material under the "Composition"
          // metafield label. Treat composition/material as interchangeable
          // for the Jomashop "material" field.
          value = readMetafieldAny(product, [
            "material",
            "Material",
            "composition",
            "Composition",
            "custom.composition",
            "luxe.composition",
            "custom.material",
            "luxe.material",
          ]);
          break;
        case "style":
          value =
            readMetafieldAny(product, ["style", "Style", "custom.style", "luxe.style"]) ||
            product.product_type;
          break;
        case "category_type":
          value =
            readMetafieldAny(product, ["category_type", "Category", "category"]) ||
            product.product_type;
          break;
        case "country_of_origin":
          value = readMetafieldAny(product, [
            "ff_country_of_origin",
            "country_of_origin",
            "Country of Origin",
            "custom.ff_country_of_origin",
            "luxe.ff_country_of_origin",
            "custom.country_of_origin",
            "luxe.country_of_origin",
          ]);
          break;
        case "hardware":
          value = readMetafieldAny(product, ["hardware", "Hardware"]);
          break;
        case "dimensions":
          value = readMetafieldAny(product, ["dimensions", "Dimensions"]);
          break;
        case "interior_material":
          value = readMetafieldAny(product, ["interior_material", "Interior Material"]);
          break;
        case "composition":
          value = readMetafieldAny(product, [
            "composition",
            "Composition",
            "material",
            "Material",
          ]);
          break;
        case "parent_sku":
          // Parent SKU is sourced strictly from explicit parent-sku
          // metafields. Never substituted from variant size, variant SKU,
          // brand, or handle — those are not parent SKUs by definition.
          value = readParentSku(product);
          break;
      }
    }

    // Treat the literal string "undefined" as a missing value so the UI
    // never renders e.g. `color: undefined missing`.
    if (typeof value === "string" && value.trim().toLowerCase() === "undefined") {
      value = undefined;
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

  // Locate the brand for top-level use. When the schema labels are live
  // (e.g. "Brand", "Manufacturer"), properties.brand won't exist — search
  // for any property whose label normalizes to brand/manufacturer/designer.
  function findBrandInProperties(): string | null {
    if (typeof properties.brand === "string" && properties.brand.trim() !== "") {
      return properties.brand as string;
    }
    for (const [k, v] of Object.entries(properties)) {
      if (typeof v !== "string" || v.trim() === "") continue;
      const tok = labelToken(k);
      if (tok.includes("brand") || tok.includes("manufacturer") || tok.includes("designer")) {
        return v;
      }
    }
    return null;
  }
  const canonicalBrandFallback = usesLiveSchemaLabels
    ? buildCanonicalProductFields(product).brand
    : undefined;
  const brand =
    findBrandInProperties() || canonicalBrandFallback || product.vendor || "";

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

  const ambiguousCategory = isAmbiguousCategoryCode(rawCategory);
  if (ambiguousCategory) {
    warnings.push(
      `Shopify category code "${rawCategory}" is ambiguous (e.g. wallet/belt). Pick the correct Jomashop category before pushing.`,
    );
  }

  const debugRaw = {
    metafields: (product.metafields || []).map((m) => ({
      namespace: m?.namespace,
      key: m?.key,
      name: m?.name,
      label: m?.label,
      value: m?.value === null || m?.value === undefined ? "" : String(m.value),
    })),
    options: (product.options || []).map((o) => ({
      name: o.name,
      values: o.values,
    })),
    variants: (product.variants || []).map((v) => {
      const opts: Record<string, string> = {};
      (product.options || []).forEach((opt, idx) => {
        const key = (`option${idx + 1}`) as "option1" | "option2" | "option3";
        const val = v[key];
        if (val) opts[opt.name] = String(val);
      });
      return {
        sku: v.sku,
        options: opts,
      };
    }),
  };

  return {
    missing_required: missingRequiredProps,
    missing_top_level: missingTopLevelFields,
    invalid_enums: invalidEnums,
    omitted_optional_fields: omittedOptionalFields,
    unverified_required_options: unverifiedRequiredOptions,
    auto_resolved_enums: autoResolvedEnums,
    category,
    is_sample: sampleFixture,
    raw_category: rawCategory,
    suggested_category: suggestJomashopCategory(rawCategory, category),
    ambiguous_category: ambiguousCategory,
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
    debug_raw: debugRaw,
  };
}

/**
 * Forbidden legacy lowercase fields. Jomashop's /i1 push endpoint validates
 * payloads against the live category schema and rejects records that contain
 * any of these top-level keys (e.g. "brand: Invalid Record, schema fallback").
 * The schema-driven mapper writes these values out under the EXACT live
 * labels ("Color", "Apparel Type", ...) instead — these constants exist so
 * the payload builder can strip them defensively and surface them in
 * push-time debug output.
 */
export const FORBIDDEN_TOP_LEVEL_LEGACY_FIELDS: ReadonlyArray<string> = [
  "brand",
  "model",
  "gender",
  "size",
  "size_system",
  "color",
  "material",
  "category_type",
  "country_of_origin",
  "age",
  "apparel_type",
  "category",
  "style",
  "hardware",
  "interior_material",
  "composition",
  "dimensions",
];

/** True when ANY schema label uses Title Case / spaces — i.e. the schema is
 *  the exact-label live (or post-rewrite fallback) shape, not the legacy
 *  lowercase one that Jomashop now rejects. */
export function schemaUsesExactLabels(
  schema: Array<{ field: string; label?: string }>,
): boolean {
  return schema.some(
    (s) => s && typeof s.field === "string" && (/[A-Z\s]/.test(s.field) || (s.label && /[A-Z\s]/.test(s.label))),
  );
}

/**
 * Build the JSON payload sent to Jomashop. The output contains ONLY the
 * fields the /i1/products/ endpoint accepts:
 *
 *   - sku, vendor_sku, manufacturer_number — variant identifiers
 *   - name, description, images          — product metadata
 *   - price, msrp                        — pricing (extracted into `stock` by
 *                                          buildI1ProductEnvelope)
 *   - manufacturer_id, category_id       — required by /i1
 *   - properties                         — exact-label schema properties
 *
 * Forbidden legacy lowercase fields (brand, gender, size, ...) are NEVER
 * emitted at the top level. The third return value is `pushDebug`, a record
 * of category, schema source, exact property keys, and any forbidden keys
 * that were stripped — surfaced in route responses for operator inspection.
 *
 * Returns `{ payload, variant, missingRequired, missingTopLevel, pushDebug }`.
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
  invalidEnums: Array<{ field: string; value: string; options: string[] }>;
  omittedOptionalFields: string[];
  unverifiedRequiredOptions: Array<{ field: string; value?: string }>;
  pushDebug: {
    category: string;
    schemaLabelsExact: boolean;
    propertyKeys: string[];
    removedLegacyKeys: string[];
    fallbackUnsafe: boolean;
    invalidEnums: Array<{ field: string; value: string; options: string[] }>;
    omittedOptionalFields: string[];
    unverifiedRequiredOptions: Array<{ field: string; value?: string }>;
    autoResolvedEnums: Array<{ field: string; chosen: string; sourceCode: string; reason: string }>;
  };
} {
  const variant =
    (variantSku && mapped.variants.find((v) => v.vendor_sku === variantSku)) ||
    mapped.variants[0] ||
    null;

  const properties: Record<string, unknown> = {};
  const removedLegacyKeys: string[] = [];
  for (const [k, v] of Object.entries(mapped.properties)) {
    if (v === null || v === undefined || v === "") continue;
    // Drop legacy lowercase keys from outgoing properties — Jomashop's /i1
    // schema validator rejects them with "<field>: Invalid Record, schema
    // fallback" when the live category requires the Title Case form.
    if (FORBIDDEN_TOP_LEVEL_LEGACY_FIELDS.includes(k)) {
      removedLegacyKeys.push(`properties.${k}`);
      continue;
    }
    properties[k] = v;
  }
  const propertiesUseLiveLabels = schemaUsesExactLabels(
    Object.keys(properties).map((field) => ({ field })),
  );
  // The mapper produced lowercase-only output — the schema we were handed
  // must be the legacy lowercase fallback, which is unsafe to push because
  // /i1 rejects those keys. We detect this either when the surviving
  // properties are still all lowercase, OR when EVERY property emitted by
  // the upstream mapper was a lowercase legacy key (meaning we just
  // stripped them and there are no exact-label survivors).
  const hadAnyLegacyEmissions = removedLegacyKeys.length > 0;
  const hadAnyLiveEmissions = Object.keys(properties).length > 0 && propertiesUseLiveLabels;
  const fallbackUnsafe =
    (Object.keys(properties).length > 0 && !propertiesUseLiveLabels) ||
    (hadAnyLegacyEmissions && !hadAnyLiveEmissions);

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

  // Strict-shape /i1 payload. Generic lowercase fields are NEVER spread to
  // the top level — they would be rejected by the live schema validator
  // (this is exactly the bug the user reported).
  const payload: Record<string, unknown> = {
    sku,
    vendor_sku: sku,
    manufacturer_number: manufacturerNumber,
    name: mapped.name,
    description: mapped.description,
    price,
    msrp,
    images: mapped.images,
    properties,
  };
  // Live /i1 record ids — required by /i1/products/. We always send them
  // when known so the legacy /v1/products fallback can also consume them.
  if (overrides.manufacturer_id !== undefined && overrides.manufacturer_id !== null) {
    payload.manufacturer_id = overrides.manufacturer_id;
  }
  if (overrides.category_id !== undefined && overrides.category_id !== null) {
    payload.category_id = overrides.category_id;
  }

  // Validation surfaces (used by the push route to refuse the call when
  // either schema-required props or top-level identifiers are missing).
  const missingRequired = mapped.warnings.filter((w) => /Missing required/.test(w));
  const missingTopLevel: string[] = [];
  if (!sku) {
    missingTopLevel.push("sku");
  }
  if (!manufacturerNumber) {
    missingTopLevel.push("manufacturer_number");
  }
  // manufacturer_id / category_id are required by /i1/products/. The push
  // route resolves them upstream against /i1/{manufacturers,categories} and
  // then calls this builder; an unresolved id is an unrecoverable preflight
  // failure here.
  if (overrides.manufacturer_id === undefined || overrides.manufacturer_id === null) {
    missingTopLevel.push("manufacturer_id");
  }
  if (overrides.category_id === undefined || overrides.category_id === null) {
    missingTopLevel.push("category_id");
  }

  const invalidEnums = mapped.invalid_enums || [];
  const omittedOptionalFields = mapped.omitted_optional_fields || [];
  const unverifiedRequiredOptions = mapped.unverified_required_options || [];
  const autoResolvedEnums = mapped.auto_resolved_enums || [];

  const pushDebug = {
    category: (overrides.category && overrides.category.trim()) || mapped.category,
    schemaLabelsExact: propertiesUseLiveLabels,
    propertyKeys: Object.keys(properties),
    removedLegacyKeys,
    fallbackUnsafe,
    invalidEnums,
    omittedOptionalFields,
    unverifiedRequiredOptions,
    autoResolvedEnums,
  };

  return {
    payload,
    variant,
    missingRequired,
    missingTopLevel,
    invalidEnums,
    omittedOptionalFields,
    unverifiedRequiredOptions,
    pushDebug,
  };
}

/**
 * Wrap the flat product payload into the envelope expected by /i1/products/.
 * Portal-side JS posts `{ product: { manufacturer_id, category_id, name,
 * sku, manufacturer_number, properties, images, ... }, stock: { quantity,
 * price, status, ... } }`. The product node carries ONLY the strict
 * /i1-accepted fields — no legacy lowercase identifiers — so Jomashop's
 * schema validator never sees the keys it rejects.
 */
export function buildI1ProductEnvelope(
  payload: Record<string, unknown>,
  variant: MappedProduct["variants"][number] | null,
): Record<string, unknown> {
  // Strict allow-list. Legacy fields (brand, category, gender, size, ...)
  // are intentionally absent — the live category schema dictates the rest
  // via product.properties.
  const productKeys = [
    "manufacturer_id",
    "category_id",
    "name",
    "sku",
    "vendor_sku",
    "manufacturer_number",
    "description",
    "images",
    "properties",
  ];
  const product: Record<string, unknown> = {};
  for (const k of productKeys) {
    if (k in payload) product[k] = payload[k];
  }
  const stock: Record<string, unknown> = {
    quantity: variant?.quantity ?? 0,
    price: variant?.jomashop_price ?? payload.price ?? null,
    status: variant?.status ?? "active",
  };
  if (payload.msrp !== undefined && payload.msrp !== null) stock.msrp = payload.msrp;
  return { product, stock };
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
  // Don't auto-classify ambiguous codes (wallets, belts, card holders) —
  // surface the raw code so the operator picks the right Jomashop category.
  if (SMALL_LEATHER_GOODS_CODES.has(norm)) return rawCategory;
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
