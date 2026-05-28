// Per-product Jomashop field XLSX workflow.
//
// Sister module to `jomashop_mapping_excel.ts`. Where that file aggregates
// every unresolved enum mapping into ONE row per (category, property, source),
// this one walks the cached product preview and produces ONE row per
// product/variant, with each Jomashop category's live schema fields as
// columns. The operator fills the missing/incorrect cells in Excel and
// uploads the file; valid cells are written back to Shopify metafields and
// the cached preview is invalidated so the next refresh picks the new values
// up.
//
// Sheet layout:
//   - One sheet per Jomashop category (preferred per spec). Each sheet
//     carries identity columns + that category's live schema fields as
//     editable columns. Required fields are marked with "*" in the header.
//   - "Accepted Options" helper sheet listing the live accepted values for
//     every enum field we couldn't fit into a dropdown.
//   - "Instructions" sheet up front summarizing the workflow.
//
// Both workflows coexist — the existing grouped enum-override workflow is
// untouched. This one is complementary and writes Shopify metafields.

import crypto from "node:crypto";
import ExcelJS from "exceljs";
import type { Express } from "express";
import multer from "multer";

import { storage } from "./storage";
import { FALLBACK_CATEGORY_SCHEMAS, SUPPORTED_CATEGORIES } from "@shared/schema";
import {
  getV1CategoryDescriptors,
  resolveCategoryRecord,
  getCategoryPropertiesI1,
  jomashopConfigured,
} from "./jomashop";
import {
  MSRP_METAFIELD_CANDIDATES,
  PARENT_SKU_METAFIELD_CANDIDATES,
  findMetafieldSource,
  findMsrpSource,
  normalizeI1CategorySchema,
  readParentSku,
  type ShopifyProduct,
  type SchemaPropertyDescriptor,
} from "./mapping";
import { getActiveShopifyConnection } from "./shopify";
import {
  MAX_IMPORT_ROWS,
  rejectIfTooManyRows,
  releaseLock,
  withLockOr409,
} from "./stability";
import { logMemory } from "./memlog";

const MAX_PRODUCT_FIELD_SESSIONS = 8;

// ---------- Types ----------

export type ProductFieldExportRow = {
  rowId: string;
  jomashopCategory: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  productTitle: string;
  vendorSku: string;
  manufacturerNumber: string;
  brand: string;
  shopifyCategoryCode: string;
  shopifyProductType: string;
  jomashopCategoryId: string;
  jomashopBrandId: string;
  pushStatus: string;
  warnings: string;
  /** Shopify retail price (line through in the UI). Read-only column. */
  shopifyPrice: string;
  /** MSRP / list price the operator can edit. Writeback lands on the
   *  originating metafield when one existed (e.g. `custom.msrp`), otherwise
   *  on `jomashop.msrp`. Stored as a string for the workbook cell. */
  msrp: string;
  /** Source label for MSRP (variant_compare_at_price | metafield |
   *  shopify_price_fallback | none) — surfaced as a read-only column so the
   *  operator can see where the current value came from. */
  msrpSource: string;
  /** Current app-derived value per Jomashop schema field name. */
  fieldValues: Record<string, string>;
  /** Variant-specific marker used to decide product vs variant metafield. */
  isVariant: boolean;
  /** Optional override of the writeback target metafield (namespace/key) per
   *  Jomashop schema field. When the canonical value originally came from a
   *  non-`jomashop` metafield (e.g. Parent SKU lives at `custom.parent_sku`),
   *  the writeback prefers updating the existing metafield in place rather
   *  than minting a fresh `jomashop.*` one. Keyed by field name. */
  fieldWritebackTargets?: Record<string, { namespace: string; key: string }>;
  /** Writeback target for the MSRP system column. Defaults to
   *  `{namespace:"jomashop", key:"msrp"}` when no existing metafield source
   *  was present on the Shopify product; falls back to the matched
   *  MSRP_METAFIELD_CANDIDATES location otherwise. */
  msrpWritebackTarget?: { namespace: string; key: string };
};

export type ProductFieldExportResult = {
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  /** Only rows for products not push-ready by default; full=true returns all. */
  includedAll: boolean;
  /** Per-category aggregation: schema fields + the rows that go on that sheet. */
  categories: Array<{
    category: string;
    fields: SchemaPropertyDescriptor[];
    fieldsSource: "live-v1" | "live-i1" | "fallback" | "unknown";
    rows: ProductFieldExportRow[];
  }>;
};

// Identity columns are present on every category sheet.
// `editable: true` columns are user-writable (e.g. MSRP). Anything else is
// reference-only — the upload parser ignores edits made to those cells.
const IDENTITY_COLUMNS: Array<{
  header: string;
  key: string;
  width: number;
  editable?: boolean;
}> = [
  { header: "Row ID", key: "row_id", width: 14 },
  { header: "Shopify Product ID", key: "shopify_product_id", width: 18 },
  { header: "Shopify Variant ID", key: "shopify_variant_id", width: 18 },
  { header: "Product Title", key: "product_title", width: 36 },
  { header: "Vendor SKU", key: "vendor_sku", width: 18 },
  { header: "Manufacturer Number", key: "manufacturer_number", width: 18 },
  { header: "Brand", key: "brand", width: 18 },
  { header: "Shopify Category Code", key: "shopify_category_code", width: 18 },
  { header: "Shopify Product Type", key: "shopify_product_type", width: 18 },
  { header: "Jomashop Category", key: "jomashop_category", width: 18 },
  { header: "Jomashop Category ID", key: "jomashop_category_id", width: 16 },
  { header: "Jomashop Brand ID", key: "jomashop_brand_id", width: 14 },
  { header: "Current Push Status", key: "push_status", width: 16 },
  { header: "Warnings", key: "warnings", width: 32 },
  { header: "Shopify Price", key: "shopify_price", width: 12 },
  { header: "MSRP", key: "msrp", width: 12, editable: true },
  { header: "MSRP Source", key: "msrp_source", width: 22 },
];

const TRAILING_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: "Write Back?", key: "write_back", width: 12 },
  { header: "Notes", key: "notes", width: 28 },
];

// Field names that conventionally apply to variants (size, etc). Used to
// decide product vs variant metafield target during writeback. Tested in
// `script/test-mapping.ts`.
const VARIANT_FIELD_TOKENS = new Set<string>([
  "size",
  "variationsizeyesno",
  "variation_size_yes_no",
  "variationsize",
  "variation",
  "shoesize",
  "size_us",
  // Apparel / footwear size labels — the size *value* is per-variant in
  // Shopify (each variant has its own size + a separate metafield row), so
  // the inline repair flow routes "Apparel Size" to ProductVariant. The
  // *size system* (Apparel Size Type / Size Code) is a product-wide setting
  // (US vs EU sizing for the whole product), so it stays on the product
  // metafield — do NOT include those tokens here.
  "apparelsize",
]);

export function fieldIsVariantTargeted(propertyName: string): boolean {
  const tok = String(propertyName)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return VARIANT_FIELD_TOKENS.has(tok);
}

/**
 * Detect whether a Jomashop schema field label refers to the Parent SKU
 * concept. "Parent SKU", "ParentSKU", "Parent_Sku", and similar variants
 * are all matched; the bare "SKU" / "Vendor SKU" is intentionally NOT a
 * Parent SKU (those identify the child variant, not its parent group).
 */
export function fieldIsParentSku(propertyName: string): boolean {
  const tok = String(propertyName)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return tok === "parentsku" || tok === "parentitemsku" || tok === "groupsku" || tok === "parentnumber";
}

/**
 * Build a synthetic ShopifyProduct shape from the compact `debug_raw`
 * metafields echo cached on each mapped product. Used by the per-product
 * XLSX exporter to (re-)derive Parent SKU values and locate the original
 * source metafield without re-fetching the live product from the Admin API.
 */
function productFromDebugRaw(m: any): ShopifyProduct {
  const mfs: ShopifyProduct["metafields"] = [];
  const raw = (m && m.debug_raw && Array.isArray(m.debug_raw.metafields))
    ? m.debug_raw.metafields
    : [];
  for (const mf of raw) {
    if (!mf || typeof mf !== "object") continue;
    mfs.push({
      namespace: typeof mf.namespace === "string" ? mf.namespace : undefined,
      key: typeof mf.key === "string" ? mf.key : undefined,
      name: typeof mf.name === "string" ? mf.name : undefined,
      label: typeof mf.label === "string" ? mf.label : undefined,
      value: mf.value === undefined || mf.value === null ? null : String(mf.value),
    });
  }
  return { metafields: mfs };
}

/**
 * Derive a safe Shopify metafield namespace+key for a Jomashop schema field
 * name. Mirrors the strategy used by the grouped enum-override workflow so
 * the two paths land on the same metafield when they write to the same
 * field.
 *
 *   "Article"                -> jomashop.article
 *   "Variation Size (Yes/No)" -> jomashop.variation_size_yes_no
 *   "Product ID Type"         -> jomashop.product_id_type
 */
export function deriveMetafieldTargetForProductField(propertyName: string): {
  namespace: string;
  key: string;
} {
  const key = String(propertyName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return { namespace: "jomashop", key: key || "value" };
}

// ---------- Schema loading per category ----------

export async function loadLiveSchemaForCategory(category: string): Promise<{
  fields: SchemaPropertyDescriptor[];
  source: "live-v1" | "live-i1" | "fallback" | "unknown";
}> {
  // Start with bundled fallback so we always have SOMETHING for the column
  // list.
  const fallback = (FALLBACK_CATEGORY_SCHEMAS as Record<string, SchemaPropertyDescriptor[]>)[
    category
  ];
  let baseFields: SchemaPropertyDescriptor[] = Array.isArray(fallback) ? [...fallback] : [];
  let source: "live-v1" | "live-i1" | "fallback" | "unknown" =
    baseFields.length > 0 ? "fallback" : "unknown";

  if (!jomashopConfigured()) {
    return { fields: baseFields, source };
  }
  try {
    const v1 = await getV1CategoryDescriptors(category).catch(() => null);
    if (v1 && (v1 as any).ok && Array.isArray((v1 as any).descriptors)) {
      const live = (v1 as any).descriptors as SchemaPropertyDescriptor[];
      if (live.length > 0) {
        baseFields = live;
        source = "live-v1";
      }
    }
    if (source !== "live-v1") {
      const rec = await resolveCategoryRecord(category).catch(() => null);
      const liveId =
        rec && (rec as any).ok && (rec as any).exact ? (rec as any).exact.id : null;
      if (liveId !== null) {
        const propsResp = await getCategoryPropertiesI1(liveId).catch(() => null);
        if (propsResp && (propsResp as any).ok && (propsResp as any).data) {
          const liveSchema = normalizeI1CategorySchema((propsResp as any).data);
          if (liveSchema.length > 0) {
            baseFields = liveSchema;
            source = "live-i1";
          }
        }
      }
    }
  } catch {
    // ignore — keep fallback
  }
  return { fields: baseFields, source };
}

// ---------- Aggregation ----------

/**
 * Walk the cached product preview, group products by Jomashop category, and
 * load each category's live schema. The result has all the data needed to
 * build a multi-sheet workbook with one row per product (or variant if the
 * product has multiple variants).
 *
 * `includeAll=false` (default) limits the output to products that are NOT
 * push-ready — i.e. readiness != "ready" — so the operator's worklist
 * matches the "what still needs filling" Mapping/Products UI buckets.
 */
/**
 * Hard cap on rows we'll aggregate for a single export. Anything beyond is
 * rejected at the route layer with a 413 so we don't blow Render's 512MB
 * worker on a runaway export.
 */
export const MAX_EXPORT_ROWS = 12000;

export async function aggregateProductFieldRows(opts: {
  includeAll?: boolean;
  /** Optional filter — restrict to one Jomashop category. Case-insensitive
   *  match against the cached `m.category` field. Used by the export route
   *  to keep large multi-thousand-product shops exportable in chunks. */
  categoryFilter?: string;
  /** Stop aggregating once this many rows are produced (across all sheets).
   *  Used as a safety guard so a single export request can't pin O(rows)
   *  memory regardless of cap behaviour at the route layer. */
  rowLimit?: number;
} = {}): Promise<ProductFieldExportResult & { truncated?: boolean }> {
  const includeAll = opts.includeAll === true;
  const categoryFilter = (opts.categoryFilter || "").trim().toLowerCase();
  const rowLimit = typeof opts.rowLimit === "number" && opts.rowLimit > 0 ? opts.rowLimit : Infinity;
  // Resolve a shopDomain. Prefer the live connection, then a connected
  // store row, but ALSO fall back to any store that has a populated
  // product cache — that's what lets an operator export the cached
  // catalog after the OAuth session has lapsed (export is a read-only
  // operation that only needs the cached snapshot, not a live token).
  const conn = getActiveShopifyConnection();
  let shopDomain: string | null =
    conn?.shopDomain ??
    storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
    null;
  let cache = shopDomain ? storage.getProductCache(shopDomain) : undefined;
  if (!cache) {
    for (const s of storage.listStores()) {
      const c = storage.getProductCache(s.shopDomain);
      if (c) {
        shopDomain = s.shopDomain;
        cache = c;
        break;
      }
    }
  }
  const result: ProductFieldExportResult = {
    shopDomain,
    fromCache: false,
    cachedAt: null,
    totalProducts: 0,
    includedAll: includeAll,
    categories: [],
  };
  if (!shopDomain) return result;
  if (!cache) return result;
  result.fromCache = true;
  result.cachedAt = cache.fetchedAt;

  let payload: any;
  try {
    payload = JSON.parse(cache.payloadJson);
  } catch {
    return result;
  }
  const allMapped: any[] = Array.isArray(payload?.mapped) ? payload.mapped : [];
  result.totalProducts = allMapped.length;

  // Group products by Jomashop category, honouring the optional category
  // filter so a single export call can target one sheet at a time on shops
  // with thousands of unready rows.
  const byCategory = new Map<string, any[]>();
  for (const m of allMapped) {
    const cat = String(m?.category || "").trim();
    if (!cat) continue;
    if (!includeAll && m?.readiness === "ready") continue;
    if (categoryFilter && cat.toLowerCase() !== categoryFilter) continue;
    let bucket = byCategory.get(cat);
    if (!bucket) {
      bucket = [];
      byCategory.set(cat, bucket);
    }
    bucket.push(m);
  }

  // For each category, load the live schema and build rows.
  let totalRows = 0;
  let truncated = false;
  for (const [category, products] of Array.from(byCategory.entries())) {
    if (totalRows >= rowLimit) {
      truncated = true;
      break;
    }
    const { fields, source } = await loadLiveSchemaForCategory(category);
    // Drop schema entries with empty/undefined names.
    const cleanFields = fields.filter(
      (f) => f && typeof f.field === "string" && f.field.trim() !== "" && f.field !== "undefined",
    );
    const rows: ProductFieldExportRow[] = [];
    let stopCategoryEarly = false;
    for (const m of products) {
      if (totalRows >= rowLimit) {
        stopCategoryEarly = true;
        truncated = true;
        break;
      }
      const productId = m?.source?.shopify_product_id;
      const variants = Array.isArray(m?.variants) ? m.variants : [];
      const variantIds: Array<string | number> = Array.isArray(m?.source?.shopify_variant_ids)
        ? m.source.shopify_variant_ids
        : [];

      const baseProps: Record<string, any> = (m?.properties && typeof m.properties === "object")
        ? m.properties
        : {};

      // Synthetic product (metafields only) used to (re-)derive values that
      // come straight from Shopify metafields independent of whichever
      // schema happened to be in effect when the cache was built. Currently
      // only Parent SKU uses this path — `m.properties` lacks it whenever
      // the live category schema didn't carry a "Parent SKU" property at
      // mapping time.
      const syntheticProduct = productFromDebugRaw(m);
      const parentSkuFromMetafields = readParentSku(syntheticProduct);
      const parentSkuSource = findMetafieldSource(
        syntheticProduct,
        PARENT_SKU_METAFIELD_CANDIDATES,
      );

      // Locate the existing MSRP metafield source (if any) so writeback lands
      // on the same metafield the value was originally read from instead of
      // always minting a fresh `jomashop.msrp`. Falls back to the
      // jomashop.msrp default when no candidate metafield is present.
      const msrpWritebackTarget =
        findMsrpSource(syntheticProduct) ?? { namespace: "jomashop", key: "msrp" };

      const msrpValue =
        typeof m?.msrp === "number" && Number.isFinite(m.msrp) ? String(m.msrp) : "";
      const msrpSourceLabel =
        typeof m?.msrp_source === "string" && m.msrp_source ? String(m.msrp_source) : "none";
      const shopifyPriceValue =
        typeof m?.price === "number" && Number.isFinite(m.price) ? String(m.price) : "";

      const fieldWritebackTargets: Record<string, { namespace: string; key: string }> = {};

      const mkRow = (variantId: string, variantOptions: Record<string, string>, isVariant: boolean) => {
        const fieldValues: Record<string, string> = {};
        for (const f of cleanFields) {
          // Look up the current app-derived value for this field by exact
          // name first, then by case-insensitive match (covers the live vs
          // fallback label drift).
          let v: any = baseProps[f.field];
          if (v === undefined) {
            const wanted = f.field.toLowerCase().trim();
            for (const [k, val] of Object.entries(baseProps)) {
              if (String(k).toLowerCase().trim() === wanted) {
                v = val;
                break;
              }
            }
          }
          // Variant-targeted fields prefer the variant's own option value.
          if (isVariant && fieldIsVariantTargeted(f.field) && variantOptions) {
            for (const [k, val] of Object.entries(variantOptions)) {
              if (String(k).toLowerCase().includes(f.field.toLowerCase())) {
                v = val;
                break;
              }
            }
          }
          // Parent SKU fields: prefer the metafield-derived value even when
          // the cached mapped properties don't carry one. Never substitute
          // variant size / variant SKU here.
          if (fieldIsParentSku(f.field)) {
            const candidate =
              typeof v === "string" && v.trim() !== "" ? String(v) : parentSkuFromMetafields;
            v = candidate || "";
            if (candidate && parentSkuSource) {
              fieldWritebackTargets[f.field] = parentSkuSource;
            }
          }
          fieldValues[f.field] =
            v === undefined || v === null ? "" : String(v);
        }
        const rowId = crypto
          .createHash("sha1")
          .update(`${category}|${productId ?? ""}|${variantId}`)
          .digest("hex")
          .slice(0, 12);
        rows.push({
          rowId,
          jomashopCategory: category,
          shopifyProductId: productId ? String(productId) : "",
          shopifyVariantId: variantId,
          productTitle: String(m?.name ?? ""),
          vendorSku: String(m?.vendor_sku ?? ""),
          manufacturerNumber: String(m?.manufacturer_number ?? ""),
          brand: String(m?.brand ?? ""),
          shopifyCategoryCode: String(m?.raw_category ?? ""),
          shopifyProductType: String(m?.raw_category ?? ""),
          jomashopCategoryId: String(
            m?.jomashop_resolution?.category_record?.id ?? "",
          ),
          jomashopBrandId: String(m?.jomashop_resolution?.manufacturer?.id ?? ""),
          pushStatus: String(
            m?.readiness ?? m?.push_state ?? "missing",
          ),
          warnings: Array.isArray(m?.warnings)
            ? (m.warnings as string[]).slice(0, 3).join(" | ")
            : "",
          shopifyPrice: shopifyPriceValue,
          msrp: msrpValue,
          msrpSource: msrpSourceLabel,
          fieldValues,
          isVariant,
          fieldWritebackTargets:
            Object.keys(fieldWritebackTargets).length > 0
              ? { ...fieldWritebackTargets }
              : undefined,
          msrpWritebackTarget,
        });
      };

      if (variants.length > 1) {
        for (let i = 0; i < variants.length; i++) {
          if (totalRows >= rowLimit) {
            stopCategoryEarly = true;
            truncated = true;
            break;
          }
          const v = variants[i];
          const variantId =
            variantIds[i] !== undefined ? String(variantIds[i]) : String(v?.vendor_sku ?? "");
          const opts = (v?.options && typeof v.options === "object") ? v.options as Record<string, string> : {};
          mkRow(variantId, opts, true);
          totalRows += 1;
        }
      } else {
        const variantId =
          variantIds[0] !== undefined ? String(variantIds[0]) : String(variants[0]?.vendor_sku ?? "");
        const opts =
          (variants[0]?.options && typeof variants[0].options === "object")
            ? (variants[0].options as Record<string, string>)
            : {};
        mkRow(variantId, opts, false);
        totalRows += 1;
      }
      if (stopCategoryEarly) break;
    }
    result.categories.push({
      category,
      fields: cleanFields,
      fieldsSource: source,
      rows,
    });
  }

  result.categories.sort((a, b) => a.category.localeCompare(b.category));
  (result as ProductFieldExportResult & { truncated?: boolean }).truncated = truncated;
  return result as ProductFieldExportResult & { truncated?: boolean };
}

// ---------- Workbook build ----------

function sanitizeSheetName(name: string): string {
  // Excel sheet names: max 31 chars, no : \ / ? * [ ]
  return String(name).replace(/[:\\\/\?\*\[\]]/g, "_").slice(0, 31) || "Sheet";
}

/**
 * Defined-name slug used to reference an enum's accepted-values range from a
 * data validation formula. Must be a valid Excel defined name: letters,
 * digits, dot, underscore; cannot start with a digit; cannot match a cell
 * reference. We collapse non-alphanumeric chars to "_" and prefix with
 * "opts_" to guarantee a safe start.
 */
export function buildOptionsRangeName(category: string, field: string): string {
  const slug = (s: string) =>
    String(s)
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return `opts_${slug(category)}_${slug(field)}`.slice(0, 255);
}

/**
 * Convert a 1-based column index to its Excel letter (A, B, … Z, AA, AB, …).
 * Used to build absolute cell references for defined names and data
 * validation formulae.
 */
function columnLetter(idx: number): string {
  let n = idx;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function buildProductFieldWorkbook(
  agg: ProductFieldExportResult,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LuxeSupply Jomashop Product Field Export";
  wb.created = new Date();

  // Instructions sheet.
  const help = wb.addWorksheet("Instructions");
  help.columns = [{ header: "How to use this workbook", key: "txt", width: 100 }];
  help.getRow(1).font = { bold: true };
  const lines = [
    "One sheet per Jomashop category. One row per Shopify product (or per variant for multi-variant products).",
    "Identity columns (left side) are for reference — do not edit Row ID, Shopify Product ID, or Shopify Variant ID.",
    "Fill the per-field columns with the EXACT Jomashop-accepted value. Required fields are marked with * in the header and highlighted yellow.",
    "Every enum field has a dropdown that pulls from the live Jomashop accepted-values list — even when the list is long.",
    "Fields that accept multiple values (multi-select on Jomashop) are noted in the header; enter comma-separated values matching the dropdown options.",
    "Numeric fields show min/max/integer-only hints in their header note.",
    "Set Write Back? = Yes to also push the value to a Shopify metafield (namespace `jomashop`, key derived from the property name).",
    "Variant-specific fields (e.g. Size) are written to variant metafields; product-level fields are written to product metafields.",
    "Upload the completed file via the 'Upload Product Field Excel' button on the Mapping page.",
    "Leave a cell blank to skip that field for that product.",
    "Note: Upload validation is authoritative — even if you bypass a dropdown, any enum value not on the live accepted list will be rejected on upload.",
  ];
  for (const l of lines) help.addRow({ txt: l });

  // Hidden helper sheet that holds the accepted-values list for every enum
  // field across every category. One COLUMN per (category, field); the
  // workbook defines a name pointing at that column's data range. Category
  // sheets reference those named ranges in their data validation. This is
  // the only way to support enum lists that exceed Excel's ~255-char inline
  // list limit (e.g. Country of Origin with ~200 countries).
  const optionsSheet = wb.addWorksheet("_Options");
  // Mark the sheet hidden so the operator only sees the editable category
  // sheets. exceljs accepts "hidden" / "veryHidden".
  optionsSheet.state = "hidden";

  // Plan all columns first so we can lay them out side-by-side with one
  // header row + values down each column.
  type OptionCol = {
    category: string;
    field: string;
    rangeName: string;
    columnIndex: number; // 1-based
    options: string[];
  };
  const optionCols: OptionCol[] = [];
  let nextCol = 1;
  for (const cat of agg.categories) {
    for (const f of cat.fields) {
      if (f.type !== "enum") continue;
      const opts = Array.isArray(f.options) ? f.options.filter((o) => o && o.trim()) : [];
      if (opts.length === 0) continue;
      optionCols.push({
        category: cat.category,
        field: f.field,
        rangeName: buildOptionsRangeName(cat.category, f.field),
        columnIndex: nextCol,
        options: opts,
      });
      nextCol++;
    }
  }
  // Header row of the hidden sheet: "<Category>!<Field>" for readability if
  // the operator unhides the sheet. The header is intentionally NOT part of
  // the named range — only the values below are.
  if (optionCols.length > 0) {
    for (const oc of optionCols) {
      optionsSheet.getCell(1, oc.columnIndex).value = `${oc.category} :: ${oc.field}`;
      optionsSheet.getCell(1, oc.columnIndex).font = { bold: true };
      for (let i = 0; i < oc.options.length; i++) {
        optionsSheet.getCell(i + 2, oc.columnIndex).value = oc.options[i];
      }
      const lastRow = oc.options.length + 1; // header is row 1, first value row 2
      const letter = columnLetter(oc.columnIndex);
      // Defined name -> absolute reference into the _Options sheet.
      const ref = `_Options!$${letter}$2:$${letter}$${lastRow}`;
      wb.definedNames.add(ref, oc.rangeName);
    }
    optionsSheet.getColumn(1).width = 32;
  }

  const optionColByKey = new Map<string, OptionCol>();
  for (const oc of optionCols) {
    optionColByKey.set(`${oc.category}::${oc.field}`, oc);
  }

  // Hidden _Meta sheet: explicit (sanitized sheet name -> canonical Jomashop
  // category) mapping. Lets upload parsing resolve a sheet to its category
  // even when the server-side live product cache is empty, stale, or the
  // category list temporarily can't be fetched. Header row is bold but the
  // sheet is hidden so the operator never sees it. Column 1 = sheet name,
  // column 2 = canonical category name.
  const metaSheet = wb.addWorksheet("_Meta");
  metaSheet.state = "hidden";
  metaSheet.columns = [
    { header: "Sheet Name", key: "sheet_name", width: 32 },
    { header: "Jomashop Category", key: "category", width: 32 },
  ];
  metaSheet.getRow(1).font = { bold: true };
  for (const cat of agg.categories) {
    metaSheet.addRow({
      sheet_name: sanitizeSheetName(cat.category),
      category: cat.category,
    });
  }

  // Accepted Options helper sheet — human-readable reference. Kept even
  // though dropdowns now cover all enum lengths, because operators
  // sometimes need to copy-paste large lists or cross-check the published
  // accepted values offline.
  const acceptedSheet = wb.addWorksheet("Accepted Options");
  acceptedSheet.columns = [
    { header: "Jomashop Category", key: "category", width: 22 },
    { header: "Property", key: "property", width: 28 },
    { header: "Required", key: "required", width: 10 },
    { header: "Multiple", key: "multiple", width: 10 },
    { header: "Accepted Options (one per line)", key: "options", width: 80 },
  ];
  acceptedSheet.getRow(1).font = { bold: true };

  if (agg.categories.length === 0) {
    // Nothing to write — emit an empty workbook with a single explanatory
    // row so the operator gets a useful artifact even when the cache is
    // empty.
    const empty = wb.addWorksheet("No Products");
    empty.columns = [{ header: "Status", key: "status", width: 80 }];
    empty.addRow({
      status:
        agg.fromCache === false
          ? "No connected Shopify store / no product cache. Click Refresh from Shopify first."
          : "No matching products found in the cached preview.",
    });
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  // Provide at least 1 placeholder body row so per-column data validation
  // can be applied to a non-empty range even when the category has zero
  // matching products. Without this, exceljs writes the validation but
  // there are no cells to attach it to, so the operator-visible dropdown
  // disappears on the first new row.
  const VALIDATION_ROW_PAD = 50;

  for (const cat of agg.categories) {
    const ws = wb.addWorksheet(sanitizeSheetName(cat.category), {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    const fieldColumns = cat.fields.map((f) => ({
      header: `${f.field}${f.required ? " *" : ""}`,
      key: `field__${f.field}`,
      width: 22,
    }));
    ws.columns = [
      ...IDENTITY_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width })),
      ...fieldColumns,
      ...TRAILING_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width })),
    ];

    // Header styling: identity = orange, optional editable = green,
    // required editable = yellow (per spec), trailing = blue.
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: "middle", horizontal: "center" };
    let col = 1;
    for (const _ of IDENTITY_COLUMNS) {
      header.getCell(col).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFE0B2" },
      };
      header.getCell(col).note = "Identity / context column — do not edit.";
      col++;
    }
    for (const f of cat.fields) {
      const cell = header.getCell(col);
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: f.required ? "FFFFE082" : "FFC8E6C9" },
      };
      if (f.required) {
        cell.font = { bold: true, color: { argb: "FFB71C1C" } };
      }
      const noteParts: string[] = [];
      if (f.required) noteParts.push("REQUIRED Jomashop field — must be filled.");
      if (f.type === "enum" && Array.isArray(f.options) && f.options.length > 0) {
        noteParts.push(
          `Pick a value from the dropdown (live accepted list, ${f.options.length} option${f.options.length === 1 ? "" : "s"}).`,
        );
      }
      if (f.multiple) {
        noteParts.push(
          "Accepts multiple values — enter comma-separated tokens; each token must be in the accepted list.",
        );
      }
      if (f.type === "number" || f.type === "integer" || f.only_integer) {
        const bounds: string[] = [];
        if (typeof f.min_value === "number") bounds.push(`min=${f.min_value}`);
        if (typeof f.max_value === "number") bounds.push(`max=${f.max_value}`);
        noteParts.push(
          `Numeric${f.only_integer ? " (integer only)" : ""}${bounds.length > 0 ? `; ${bounds.join(", ")}` : ""}.`,
        );
      }
      if (f.type === "string" || (!f.type && !Array.isArray(f.options))) {
        const bounds: string[] = [];
        if (typeof f.min_length === "number") bounds.push(`min length=${f.min_length}`);
        if (typeof f.max_length === "number") bounds.push(`max length=${f.max_length}`);
        if (bounds.length > 0) noteParts.push(`Free text; ${bounds.join(", ")}.`);
      }
      if (noteParts.length > 0) cell.note = noteParts.join(" ");
      col++;
    }
    for (const _ of TRAILING_COLUMNS) {
      header.getCell(col).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFBBDEFB" },
      };
      col++;
    }

    // Body rows.
    for (const r of cat.rows) {
      const rowData: Record<string, string> = {
        row_id: r.rowId,
        shopify_product_id: r.shopifyProductId,
        shopify_variant_id: r.shopifyVariantId,
        product_title: r.productTitle,
        vendor_sku: r.vendorSku,
        manufacturer_number: r.manufacturerNumber,
        brand: r.brand,
        shopify_category_code: r.shopifyCategoryCode,
        shopify_product_type: r.shopifyProductType,
        jomashop_category: r.jomashopCategory,
        jomashop_category_id: r.jomashopCategoryId,
        jomashop_brand_id: r.jomashopBrandId,
        push_status: r.pushStatus,
        warnings: r.warnings,
        shopify_price: r.shopifyPrice,
        msrp: r.msrp,
        msrp_source: r.msrpSource,
        write_back: "",
        notes: "",
      };
      for (const f of cat.fields) {
        rowData[`field__${f.field}`] = r.fieldValues[f.field] ?? "";
      }
      ws.addRow(rowData);
    }

    // Compute number of body rows we attach validations to. Use the larger
    // of actual data rows OR a small pad so the operator can drag-fill new
    // rows without losing the dropdown.
    const dataRowCount = Math.max(cat.rows.length, VALIDATION_ROW_PAD);

    // Per-column data validation for EVERY enum field. References the
    // hidden _Options sheet via a workbook-level defined name — works for
    // any length of accepted-values list (Excel's ~255-char inline list
    // cap doesn't apply).
    const identityCount = IDENTITY_COLUMNS.length;
    for (let i = 0; i < cat.fields.length; i++) {
      const f = cat.fields[i];
      const colIdx = identityCount + 1 + i; // 1-based
      const colLetter = columnLetter(colIdx);
      const oc = optionColByKey.get(`${cat.category}::${f.field}`);

      // Highlight required body cells with a faint yellow tint so they
      // visually stand out from optional columns.
      if (f.required) {
        for (let r = 0; r < dataRowCount; r++) {
          const cell = ws.getCell(`${colLetter}${r + 2}`);
          if (!cell.fill || (cell.fill as { type?: string }).type !== "pattern") {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFFFF8E1" },
            };
          }
        }
      }

      if (f.type === "enum" && oc) {
        // Single-select enum: use the named range directly.
        // Multi-select enum (f.multiple === true): Excel's data validation
        // doesn't natively support multi-select against a list, so we use
        // a prompt-only validation pointing at the list — operator types
        // comma-separated values; upload validation enforces each token.
        const formula = `=${oc.rangeName}`;
        if (f.multiple === true) {
          for (let r = 0; r < dataRowCount; r++) {
            ws.getCell(`${colLetter}${r + 2}`).dataValidation = {
              type: "list",
              allowBlank: true,
              showInputMessage: true,
              prompt:
                "Enter comma-separated values. Each token must be one of the listed accepted values.",
              promptTitle: `${f.field} (multi-select)`,
              formulae: [formula],
            };
          }
        } else {
          for (let r = 0; r < dataRowCount; r++) {
            ws.getCell(`${colLetter}${r + 2}`).dataValidation = {
              type: "list",
              allowBlank: !f.required,
              showErrorMessage: true,
              errorStyle: "stop",
              errorTitle: `Invalid ${f.field}`,
              error: `Value must be one of the Jomashop-accepted options for "${f.field}".`,
              formulae: [formula],
            };
          }
        }
      } else if (f.type === "number" || f.type === "integer" || f.only_integer) {
        // Numeric data validation — bounds when known.
        const isInt = f.only_integer === true || f.type === "integer";
        for (let r = 0; r < dataRowCount; r++) {
          ws.getCell(`${colLetter}${r + 2}`).dataValidation = {
            type: isInt ? "whole" : "decimal",
            allowBlank: !f.required,
            operator: "between",
            formulae: [
              typeof f.min_value === "number" ? String(f.min_value) : "-1E308",
              typeof f.max_value === "number" ? String(f.max_value) : "1E308",
            ],
            errorStyle: "stop",
            errorTitle: `Invalid ${f.field}`,
            error: isInt
              ? `Enter an integer${typeof f.min_value === "number" || typeof f.max_value === "number" ? ` between ${f.min_value ?? "-∞"} and ${f.max_value ?? "∞"}` : ""}.`
              : `Enter a number${typeof f.min_value === "number" || typeof f.max_value === "number" ? ` between ${f.min_value ?? "-∞"} and ${f.max_value ?? "∞"}` : ""}.`,
          };
        }
      } else if (
        (f.type === "string" || !f.type) &&
        (typeof f.max_length === "number" || typeof f.min_length === "number")
      ) {
        // Free-text fields with length hints — apply textLength validation.
        const min = typeof f.min_length === "number" ? f.min_length : 0;
        const max = typeof f.max_length === "number" ? f.max_length : 1000;
        for (let r = 0; r < dataRowCount; r++) {
          ws.getCell(`${colLetter}${r + 2}`).dataValidation = {
            type: "textLength",
            allowBlank: !f.required,
            operator: "between",
            formulae: [String(min), String(max)],
            errorStyle: "stop",
            errorTitle: `Invalid ${f.field}`,
            error: `Text length must be between ${min} and ${max} characters.`,
          };
        }
      }
    }

    // Write Back? as Yes/No dropdown.
    const writeBackColIdx = identityCount + cat.fields.length + 1; // first trailing column
    const wbLetter = columnLetter(writeBackColIdx);
    for (let r = 0; r < dataRowCount; r++) {
      ws.getCell(`${wbLetter}${r + 2}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"Yes,No"'],
      };
    }

    if (cat.rows.length > 0) {
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: identityCount + cat.fields.length + TRAILING_COLUMNS.length },
      };
    }

    // Accepted Options helper sheet entries for enum fields.
    for (const f of cat.fields) {
      if (f.type !== "enum") continue;
      const opts = Array.isArray(f.options) ? f.options : [];
      if (opts.length === 0) continue;
      acceptedSheet.addRow({
        category: cat.category,
        property: f.field,
        required: f.required ? "Yes" : "No",
        multiple: f.multiple ? "Yes" : "No",
        options: opts.join("\n"),
      });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------- Upload parsing ----------

export type ParsedProductFieldRow = {
  rowNumber: number;
  sheetName: string;
  rowId: string;
  jomashopCategory: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  vendorSku: string;
  /** field name -> user-supplied value (already trimmed). Blank cells omitted. */
  fieldValues: Record<string, string>;
  /** Operator-edited MSRP cell (system column, not a schema field). Empty
   *  string when blank. Written back as a product-level metafield on apply. */
  msrp: string;
  writeBack: boolean;
  notes: string;
  isValid: boolean;
  errors: string[];
};

export type ParseProductFieldUploadResult = {
  rows: ParsedProductFieldRow[];
  headerErrors: string[];
  perCategoryWarnings: string[];
};

export type ParseProductFieldUploadOptions = {
  /**
   * When true, every row that has at least one filled editable field value
   * is treated as if its `Write Back?` cell were "Yes". The per-row cell
   * value still wins when it is explicitly "No" — operators can opt out of
   * the global writeback by setting Write Back? = No on individual rows.
   */
  forceWriteback?: boolean;
};

/**
 * Resolve a workbook sheet name to its canonical Jomashop category.
 *
 * Precedence:
 *   1. Hidden `_Meta` sheet shipped by the exporter — authoritative when
 *      present. Allows imports to work even if the live product cache is
 *      empty / stale / unreachable.
 *   2. Exact match against the live agg snapshot (sanitized sheet name and
 *      raw category name).
 *   3. Exact match against the static SUPPORTED_CATEGORIES list (case- and
 *      whitespace-insensitive), so the importer accepts every category we
 *      ship, regardless of agg / live state.
 *
 * Returns null when no canonical category is found.
 */
export function resolveSheetCategory(
  sheetName: string,
  opts: {
    metaMap?: Map<string, string>;
    aggCategories?: Iterable<string>;
  } = {},
): string | null {
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
  const sheetKey = norm(sheetName);
  if (opts.metaMap) {
    // _Meta lookup — both sanitized and raw forms.
    const direct = opts.metaMap.get(sheetKey);
    if (direct) return direct;
  }
  if (opts.aggCategories) {
    const arr = Array.from(opts.aggCategories);
    for (const cat of arr) {
      if (norm(sanitizeSheetName(cat)) === sheetKey) return cat;
      if (norm(cat) === sheetKey) return cat;
    }
  }
  for (const cat of SUPPORTED_CATEGORIES) {
    if (norm(sanitizeSheetName(cat)) === sheetKey) return cat;
    if (norm(cat) === sheetKey) return cat;
  }
  return null;
}

function readCell(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in (v as any) && Array.isArray((v as any).richText)) {
      return ((v as any).richText as Array<{ text: string }>)
        .map((t) => t.text)
        .join("")
        .trim();
    }
    if ("text" in (v as any)) return String((v as any).text ?? "").trim();
    if ("result" in (v as any)) return String((v as any).result ?? "").trim();
  }
  return String(v).trim();
}

export async function parseProductFieldUpload(
  buffer: Buffer,
  agg: ProductFieldExportResult,
  options: ParseProductFieldUploadOptions = {},
): Promise<ParseProductFieldUploadResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const headerErrors: string[] = [];
  const perCategoryWarnings: string[] = [];
  const rows: ParsedProductFieldRow[] = [];
  const forceWriteback = options.forceWriteback === true;

  // Index agg categories by canonical category name for live-schema lookup.
  const aggByCategoryName = new Map<string, ProductFieldExportResult["categories"][number]>();
  for (const c of agg.categories) aggByCategoryName.set(c.category, c);

  // Pull explicit (sheet -> category) mappings from the hidden _Meta sheet
  // when present. This makes the parser robust against an empty / stale
  // live product cache (the prior implementation would fail to resolve any
  // sheet at all in that case, producing zero-row imports).
  const metaSheetWs = wb.getWorksheet("_Meta");
  const metaMap = new Map<string, string>();
  if (metaSheetWs) {
    const normKey = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
    for (let r = 2; r <= metaSheetWs.rowCount; r++) {
      const sn = readCell(metaSheetWs.getRow(r).getCell(1));
      const cat = readCell(metaSheetWs.getRow(r).getCell(2));
      if (sn && cat) metaMap.set(normKey(sn), cat);
    }
  }

  // Cache schemas loaded lazily for sheets whose category isn't in agg
  // (e.g. operator uploaded a fully-filled workbook for an empty cache).
  const lazySchemas = new Map<
    string,
    { fields: SchemaPropertyDescriptor[]; source: "live-v1" | "live-i1" | "fallback" | "unknown" }
  >();

  for (const ws of wb.worksheets) {
    if (
      ws.name === "Instructions" ||
      ws.name === "Accepted Options" ||
      ws.name === "No Products" ||
      ws.name === "_Options" ||
      ws.name === "_Meta"
    ) {
      continue;
    }
    const categoryName = resolveSheetCategory(ws.name, {
      metaMap,
      aggCategories: agg.categories.map((c) => c.category),
    });
    if (!categoryName) {
      perCategoryWarnings.push(
        `Sheet "${ws.name}" doesn't match any known Jomashop category; skipping.`,
      );
      continue;
    }
    let cat = aggByCategoryName.get(categoryName);
    if (!cat) {
      // Live cache had nothing for this category. Load the schema on demand
      // so we can still validate rows (and at least surface them for
      // writeback). Fields list is sourced live when possible, otherwise
      // from the bundled fallback. Reuses the same loader the exporter
      // uses.
      let schemaEntry = lazySchemas.get(categoryName);
      if (!schemaEntry) {
        schemaEntry = await loadLiveSchemaForCategory(categoryName);
        lazySchemas.set(categoryName, schemaEntry);
      }
      const cleanFields = schemaEntry.fields.filter(
        (f) => f && typeof f.field === "string" && f.field.trim() !== "" && f.field !== "undefined",
      );
      cat = {
        category: categoryName,
        fields: cleanFields,
        fieldsSource: schemaEntry.source,
        rows: [],
      };
      aggByCategoryName.set(categoryName, cat);
    }

    // Build column-by-header lookup.
    const headerByCol: Record<number, string> = {};
    ws.getRow(1).eachCell((cell, c) => {
      headerByCol[c] = String(cell.value ?? "").trim();
    });
    const colByHeader = new Map<string, number>();
    for (const [c, name] of Object.entries(headerByCol)) {
      colByHeader.set(name, Number(c));
    }
    // The category sheet must include at least Row ID + identity columns.
    const requiredHeaders = ["Row ID", "Shopify Product ID", "Write Back?"];
    for (const h of requiredHeaders) {
      if (!colByHeader.has(h)) {
        headerErrors.push(`Sheet "${ws.name}": missing required header "${h}"`);
      }
    }
    // Field name -> column index (strip trailing " *").
    const fieldColByName = new Map<string, number>();
    for (const [header, c] of Array.from(colByHeader.entries())) {
      const fieldName = header.replace(/\s*\*\s*$/, "").trim();
      // A header counts as a field column when it matches one of the
      // category's schema fields.
      if (cat.fields.some((f) => f.field === fieldName)) {
        fieldColByName.set(fieldName, c);
      }
    }
    const get = (rowNum: number, header: string): string => {
      const col = colByHeader.get(header);
      if (!col) return "";
      return readCell(ws.getRow(rowNum).getCell(col));
    };

    for (let r = 2; r <= ws.rowCount; r++) {
      const wsRow = ws.getRow(r);
      if (!wsRow || !wsRow.hasValues) continue;
      const rowId = get(r, "Row ID");
      // Collect field values (only non-blank).
      const fieldValues: Record<string, string> = {};
      const errors: string[] = [];
      for (const [fieldName, c] of Array.from(fieldColByName.entries())) {
        const cell = wsRow.getCell(c);
        const val = readCell(cell);
        if (val === "") continue;
        const fdef = cat.fields.find((f) => f.field === fieldName);
        // Enum validation — authoritative even if the operator bypasses the
        // dropdown. For multi-select fields validate each comma-separated
        // token individually.
        if (
          fdef &&
          fdef.type === "enum" &&
          Array.isArray(fdef.options) &&
          fdef.options.length > 0
        ) {
          const optSet = new Set(fdef.options.map((o) => o.toLowerCase().trim()));
          const tokens = fdef.multiple === true
            ? val.split(",").map((t) => t.trim()).filter((t) => t !== "")
            : [val.trim()];
          const bad: string[] = [];
          for (const t of tokens) {
            if (!optSet.has(t.toLowerCase().trim())) bad.push(t);
          }
          if (bad.length > 0) {
            const preview = fdef.options.slice(0, 8).join(", ");
            errors.push(
              `"${fieldName}" ${fdef.multiple ? "token(s)" : "value"} "${bad.join(", ")}" not in the live accepted-options list (${fdef.options.length} options). Accepted: ${preview}${fdef.options.length > 8 ? "…" : ""}`,
            );
            continue;
          }
        }
        // Numeric type validation with min/max/only_integer enforcement.
        if (
          fdef &&
          (fdef.type === "number" || fdef.type === "integer" || fdef.only_integer)
        ) {
          const n = Number(val);
          if (!Number.isFinite(n)) {
            errors.push(`"${fieldName}" expects a number; got "${val}"`);
            continue;
          }
          if (
            (fdef.only_integer === true || fdef.type === "integer") &&
            !Number.isInteger(n)
          ) {
            errors.push(`"${fieldName}" expects an integer; got "${val}"`);
            continue;
          }
          if (typeof fdef.min_value === "number" && n < fdef.min_value) {
            errors.push(
              `"${fieldName}" value ${n} is below min_value=${fdef.min_value}.`,
            );
            continue;
          }
          if (typeof fdef.max_value === "number" && n > fdef.max_value) {
            errors.push(
              `"${fieldName}" value ${n} exceeds max_value=${fdef.max_value}.`,
            );
            continue;
          }
        }
        // String length bounds when schema declares them.
        if (fdef && (fdef.type === "string" || (!fdef.type && !Array.isArray(fdef.options)))) {
          if (typeof fdef.min_length === "number" && val.length < fdef.min_length) {
            errors.push(
              `"${fieldName}" length ${val.length} is below min_length=${fdef.min_length}.`,
            );
            continue;
          }
          if (typeof fdef.max_length === "number" && val.length > fdef.max_length) {
            errors.push(
              `"${fieldName}" length ${val.length} exceeds max_length=${fdef.max_length}.`,
            );
            continue;
          }
        }
        // Global 1000-char cap (Shopify single-line metafield max). Skipped
        // when the schema declared its own larger max_length, which takes
        // precedence.
        if (val.length > 1000 && !(fdef && typeof fdef.max_length === "number" && fdef.max_length > 1000)) {
          errors.push(`"${fieldName}" exceeds 1000 character cap.`);
          continue;
        }
        fieldValues[fieldName] = val;
      }
      // MSRP system column: editable identity cell. Parse, validate that the
      // operator typed a non-negative number, and track empty separately
      // (empty = "no edit"; the apply step will not overwrite). Bad input
      // raises an error so the operator catches it before push.
      const msrpRaw = get(r, "MSRP");
      let msrpVal = "";
      if (msrpRaw !== "") {
        const n = Number(msrpRaw);
        if (!Number.isFinite(n) || n < 0) {
          errors.push(`"MSRP" expects a non-negative number; got "${msrpRaw}".`);
        } else {
          msrpVal = String(n);
        }
      }
      // Check required fields are present whenever the operator has filled
      // at least one cell on this row (skip silent blank rows). MSRP counts
      // toward "any value" — an MSRP-only edit is still a valid writeback.
      const anyValue = Object.keys(fieldValues).length > 0 || msrpVal !== "";
      if (!rowId && !anyValue) continue;
      if (anyValue) {
        for (const f of cat.fields) {
          if (!f.required) continue;
          if (!fieldValues[f.field]) {
            // Allow operator to leave required fields blank IF the current
            // value coming back from the source already has one — we can't
            // see that here, so report a soft warning rather than a hard
            // error. We'll flag as a note in `errors` only when no other
            // values are present.
            errors.push(
              `Required field "${f.field}" left blank — provide a value to fill the gap.`,
            );
          }
        }
      }
      const writeBackRaw = get(r, "Write Back?").toLowerCase().trim();
      const rowSaysNo =
        writeBackRaw === "no" || writeBackRaw === "n" || writeBackRaw === "false";
      const rowSaysYes =
        writeBackRaw === "yes" || writeBackRaw === "y" || writeBackRaw === "true";
      // Per-row Write Back? wins when explicitly set. When blank AND the
      // global forceWriteback flag is on, treat rows with at least one
      // filled value as writeback candidates. This is the "global writeback
      // for a completed workbook" path requested by operators who don't
      // want to mark every row by hand.
      const writeBack = rowSaysYes
        ? true
        : rowSaysNo
        ? false
        : forceWriteback && anyValue;
      rows.push({
        rowNumber: r,
        sheetName: ws.name,
        rowId,
        jomashopCategory: cat.category,
        shopifyProductId: get(r, "Shopify Product ID"),
        shopifyVariantId: get(r, "Shopify Variant ID"),
        vendorSku: get(r, "Vendor SKU"),
        fieldValues,
        msrp: msrpVal,
        writeBack,
        notes: get(r, "Notes"),
        isValid: errors.length === 0,
        errors,
      });
    }
  }

  return { rows, headerErrors, perCategoryWarnings };
}

// ---------- Shopify metafield write ----------

const ADMIN_API_VERSION = "2024-10";

export async function writeMetafield(
  conn: { shopDomain: string; accessToken: string },
  ownerId: string,
  namespace: string,
  key: string,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const endpoint = `https://${conn.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const query = `
    mutation Set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      {
        ownerId,
        namespace,
        key,
        type: "single_line_text_field",
        value,
      },
    ],
  };
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
    return { ok: false, error: (err as Error).message };
  }
  const body = (await res.json().catch(() => null)) as
    | {
        data?: {
          metafieldsSet?: {
            userErrors?: Array<{ field: string[]; message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      }
    | null;
  if (!res.ok || !body) return { ok: false, error: `Shopify Admin API ${res.status}` };
  if (body.errors && body.errors.length > 0) {
    return { ok: false, error: body.errors.map((e) => e.message).join("; ") };
  }
  const ue = body.data?.metafieldsSet?.userErrors ?? [];
  if (ue.length > 0) {
    return { ok: false, error: ue.map((e) => e.message).join("; ") };
  }
  return { ok: true };
}

export type ProductFieldWriteResult = {
  rowId: string;
  ownerId: string;
  ownerType: "product" | "variant";
  field: string;
  namespace: string;
  key: string;
  ok: boolean;
  error: string | null;
};

// ---------- Route registration ----------

type Session = {
  id: string;
  createdAt: number;
  rows: ParsedProductFieldRow[];
  aggSnapshot: ProductFieldExportResult;
  /** Whether the preview was parsed with forceWriteback on. */
  forceWriteback: boolean;
};
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSIONS = new Map<string, Session>();
function newSessionId(): string {
  return crypto.randomBytes(16).toString("hex");
}
function gcSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const stale: string[] = [];
  SESSIONS.forEach((s, id) => {
    if (s.createdAt < cutoff) stale.push(id);
  });
  for (const id of stale) SESSIONS.delete(id);
  // Bounded session count: evict oldest (insertion-order) until we are at
  // or below the cap. Maps preserve insertion order so this is a cheap LRU.
  while (SESSIONS.size > MAX_PRODUCT_FIELD_SESSIONS) {
    const oldest = SESSIONS.keys().next();
    if (oldest.done) break;
    SESSIONS.delete(oldest.value);
  }
}

export function registerJomashopProductFieldExcelRoutes(app: Express): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  // GET: JSON summary (debug / UI preview).
  app.get("/api/jomashop-product-fields/summary", async (req, res) => {
    try {
      const includeAll = String(req.query.all ?? "") === "1" || String(req.query.all ?? "") === "true";
      const agg = await aggregateProductFieldRows({ includeAll });
      res.json({
        ok: true,
        shopDomain: agg.shopDomain,
        fromCache: agg.fromCache,
        cachedAt: agg.cachedAt,
        totalProducts: agg.totalProducts,
        includedAll: agg.includedAll,
        categories: agg.categories.map((c) => ({
          category: c.category,
          fieldsSource: c.fieldsSource,
          fields: c.fields.map((f) => ({
            field: f.field,
            required: f.required,
            type: f.type ?? "string",
            optionCount: Array.isArray(f.options) ? f.options.length : 0,
          })),
          rowCount: c.rows.length,
        })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // GET: XLSX export.
  //
  // Hardening against Render OOM / exit 134:
  //   - acquires the `productFieldExport` lock so two concurrent operators
  //     can't double the working set;
  //   - logs RSS before aggregation, after aggregation, and after workbook
  //     build so post-mortems can pinpoint where memory blew;
  //   - rejects with 413 when the resulting row count would exceed
  //     MAX_EXPORT_ROWS, asking the operator to add ?category=X;
  //   - releases the row + workbook buffers to GC before responding.
  app.get("/api/jomashop-product-fields/export.xlsx", async (req, res) => {
    const includeAll = String(req.query.all ?? "") === "1" || String(req.query.all ?? "") === "true";
    const categoryFilter = typeof req.query.category === "string" ? req.query.category.trim() : "";
    if (!withLockOr409(res, "productFieldExport")) return;
    try {
      logMemory("productFieldExport.start", { includeAll, categoryFilter });
      // First pass: count rows under the safety cap. If the operator asked
      // for an unfiltered export and the row count would exceed
      // MAX_EXPORT_ROWS, fail fast with a 413 and an actionable message.
      const agg = await aggregateProductFieldRows({
        includeAll,
        categoryFilter: categoryFilter || undefined,
        rowLimit: MAX_EXPORT_ROWS + 1,
      });
      if (!agg.shopDomain) {
        // No store at all (never installed, or all rows deleted). Surface
        // a clear reconnect CTA the UI can render as a button.
        return res.status(503).json({
          ok: false,
          error:
            "No Shopify store on file. Complete OAuth install at Setup → Begin install before exporting.",
          reconnectUrl: "/#/setup",
        });
      }
      if (!agg.fromCache) {
        return res.status(409).json({
          ok: false,
          error:
            "No cached product preview. Click Refresh from Shopify on the Products page first.",
          reconnectUrl: "/#/products",
        });
      }
      const rowCount = agg.categories.reduce((acc, c) => acc + c.rows.length, 0);
      if (rowCount > MAX_EXPORT_ROWS) {
        return res.status(413).json({
          ok: false,
          error:
            `Export would produce ${rowCount} rows (cap is ${MAX_EXPORT_ROWS}). ` +
            `Filter to a single category via ?category=<JomashopCategory> ` +
            `or set ?all=0 to limit to unready rows only.`,
          rowCount,
          maxExportRows: MAX_EXPORT_ROWS,
          availableCategories: agg.categories.map((c) => ({
            category: c.category,
            rows: c.rows.length,
          })),
        });
      }
      logMemory("productFieldExport.aggregated", {
        rows: rowCount,
        sheets: agg.categories.length,
      });
      const buf = await buildProductFieldWorkbook(agg);
      logMemory("productFieldExport.workbookBuilt", {
        rows: rowCount,
        bytes: buf.length,
      });
      const filename = `jomashop-product-fields-${agg.shopDomain.replace(/\.myshopify\.com$/, "")}-${
        includeAll ? "all" : "unready"
      }${categoryFilter ? `-${categoryFilter.replace(/[^A-Za-z0-9]+/g, "_")}` : ""}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Export-Rows", String(rowCount));
      res.setHeader("X-Export-Sheets", String(agg.categories.length));
      res.setHeader("X-Export-Shop", agg.shopDomain);
      if (agg.truncated) res.setHeader("X-Export-Truncated", "1");
      storage.appendLog({
        level: "info",
        message: `Exported Jomashop product-field XLSX (${rowCount} row(s), ${agg.categories.length} sheet(s)) for ${agg.shopDomain}${categoryFilter ? ` [category=${categoryFilter}]` : ""}`,
        detailsJson: JSON.stringify({
          totalProducts: agg.totalProducts,
          includedAll: agg.includedAll,
          categoryFilter: categoryFilter || null,
          truncated: Boolean(agg.truncated),
          bytes: buf.length,
          categories: agg.categories.map((c) => ({
            category: c.category,
            rows: c.rows.length,
            fields: c.fields.length,
            fieldsSource: c.fieldsSource,
          })),
        }),
        createdAt: Date.now(),
      });
      // Drop the aggregation reference before sending the buffer so its
      // backing arrays can be released while we stream the response.
      (agg as any).categories = null;
      res.end(buf);
      logMemory("productFieldExport.responded", { bytes: buf.length });
    } catch (err) {
      const msg = (err as Error).message;
      logMemory("productFieldExport.failed", { message: msg });
      storage.appendLog({
        level: "error",
        message: `Jomashop product-field XLSX export failed: ${msg}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      res.status(500).json({ ok: false, error: msg });
    } finally {
      releaseLock("productFieldExport");
    }
  });

  // POST: upload XLSX, validate, hold the parsed result in a session.
  app.post(
    "/api/jomashop-product-fields/import-preview",
    upload.single("file"),
    async (req, res) => {
      gcSessions();
      const file = req.file;
      if (!file) {
        return res.status(400).json({ ok: false, error: "Missing uploaded file." });
      }
      // Serialize large XLSX imports — they can hold tens of MB of parsed
      // rows in memory; running two concurrently doubles RSS.
      if (!withLockOr409(res, "import.product-fields")) return;
      try {
        // forceWriteback accepted via multipart field (string "true"/"1"),
        // body field, or `?forceWriteback=1` query string. Multipart field
        // is the natural form to send alongside the file from a browser.
        const fwRaw =
          (req.body && (req.body.forceWriteback ?? req.body.writebackAllFilled)) ??
          (req.query?.forceWriteback ?? req.query?.writebackAllFilled);
        const forceWriteback =
          fwRaw === true ||
          fwRaw === "1" ||
          (typeof fwRaw === "string" && fwRaw.toLowerCase() === "true") ||
          (typeof fwRaw === "string" && fwRaw.toLowerCase() === "yes");
        logMemory("import.product-fields.start", { bytes: file.size });
        const agg = await aggregateProductFieldRows({ includeAll: true });
        const parsed = await parseProductFieldUpload(file.buffer, agg, {
          forceWriteback,
        });
        if (rejectIfTooManyRows(res, parsed.rows.length, MAX_IMPORT_ROWS)) {
          return;
        }
        const sessionId = newSessionId();
        SESSIONS.set(sessionId, {
          id: sessionId,
          createdAt: Date.now(),
          rows: parsed.rows,
          aggSnapshot: agg,
          forceWriteback,
        });
        const validRows = parsed.rows.filter((r) => r.isValid);
        const errorRows = parsed.rows.filter((r) => !r.isValid);
        const writebackRows = validRows.filter((r) => r.writeBack);
        const pushReadyRows = validRows.filter(
          (r) => Object.keys(r.fieldValues).length > 0,
        );
        res.json({
          ok: parsed.headerErrors.length === 0,
          sessionId,
          forceWriteback,
          headerErrors: parsed.headerErrors,
          perCategoryWarnings: parsed.perCategoryWarnings,
          totals: {
            total: parsed.rows.length,
            valid: validRows.length,
            errors: errorRows.length,
            writeback: writebackRows.length,
            pushReady: pushReadyRows.length,
            metafieldsFillable: validRows.reduce(
              (acc, r) => acc + Object.keys(r.fieldValues).length,
              0,
            ),
          },
          rows: parsed.rows.map((r) => ({
            rowNumber: r.rowNumber,
            sheetName: r.sheetName,
            rowId: r.rowId,
            jomashop_category: r.jomashopCategory,
            shopify_product_id: r.shopifyProductId,
            shopify_variant_id: r.shopifyVariantId,
            vendor_sku: r.vendorSku,
            field_count: Object.keys(r.fieldValues).length,
            field_values: r.fieldValues,
            write_back: r.writeBack,
            notes: r.notes,
            is_valid: r.isValid,
            errors: r.errors,
          })),
        });
      } catch (err) {
        const msg = (err as Error).message;
        logMemory("import.product-fields.failed", { message: msg });
        res.status(400).json({ ok: false, error: `Could not parse XLSX: ${msg}` });
      } finally {
        releaseLock("import.product-fields");
        logMemory("import.product-fields.done");
      }
    },
  );

  // POST: apply — write Shopify metafields + invalidate cache.
  app.post("/api/jomashop-product-fields/apply", async (req, res) => {
    gcSessions();
    const body = (req.body ?? {}) as {
      sessionId?: string;
      confirm?: boolean;
      ignoreErrors?: boolean;
      forceWriteback?: boolean;
      writebackAllFilled?: boolean;
      pushReady?: boolean;
    };
    if (!body.confirm) {
      return res.status(400).json({
        ok: false,
        error: "Missing confirmation. Set `confirm: true` to apply.",
      });
    }
    if (!body.sessionId) {
      return res.status(400).json({ ok: false, error: "Missing sessionId." });
    }
    const session = SESSIONS.get(body.sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ ok: false, error: "Session not found or expired. Re-upload the XLSX." });
    }
    const ignoreErrors = body.ignoreErrors === true;
    // Apply-time forceWriteback: when true, every valid row that carries at
    // least one filled field value is treated as if Write Back? = Yes,
    // regardless of what was on the row. Honors the existing session-level
    // flag from import-preview when not overridden here.
    const forceWriteback =
      body.forceWriteback === true ||
      body.writebackAllFilled === true ||
      session.forceWriteback === true;
    const validRows = session.rows.filter((r) => r.isValid || ignoreErrors);
    const skippedInvalid = session.rows.length - validRows.length;

    const conn = getActiveShopifyConnection();
    const shopDomain =
      conn?.shopDomain ??
      storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
      null;

    const writes: ProductFieldWriteResult[] = [];
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;

    // Index aggSnapshot rows by rowId so the apply step can look up the
    // per-field writeback targets stamped at export time (e.g. preserving
    // an existing `custom.parent_sku` source instead of always writing to
    // `jomashop.parent_sku`). Falls back to the slug-derived default when
    // no override is present.
    const targetsByRowId = new Map<string, Record<string, { namespace: string; key: string }>>();
    // MSRP writeback target per rowId. Defaults to `jomashop.msrp` at the
    // exporter; preserved here so the apply step can write back to the
    // originating metafield (e.g. `custom.msrp`) when one existed.
    const msrpTargetByRowId = new Map<string, { namespace: string; key: string }>();
    for (const cat of session.aggSnapshot.categories) {
      for (const r of cat.rows) {
        if (r.fieldWritebackTargets && Object.keys(r.fieldWritebackTargets).length > 0) {
          targetsByRowId.set(r.rowId, r.fieldWritebackTargets);
        }
        if (r.msrpWritebackTarget) {
          msrpTargetByRowId.set(r.rowId, r.msrpWritebackTarget);
        }
      }
    }

    const pushReadyRowIds: string[] = [];
    if (conn) {
      for (const row of validRows) {
        const rowHasFilledValues =
          Object.keys(row.fieldValues).length > 0 || row.msrp !== "";
        const effectiveWriteBack =
          row.writeBack || (forceWriteback && rowHasFilledValues);
        if (!effectiveWriteBack) continue;
        const overrides = targetsByRowId.get(row.rowId);
        // MSRP system column write — always product-level (never variant).
        // Lands on the originating Shopify metafield when one was detected at
        // export time; otherwise on `jomashop.msrp`.
        if (row.msrp !== "" && row.shopifyProductId) {
          const target = msrpTargetByRowId.get(row.rowId) ?? {
            namespace: "jomashop",
            key: "msrp",
          };
          const ownerId = row.shopifyProductId.startsWith("gid://")
            ? row.shopifyProductId
            : `gid://shopify/Product/${row.shopifyProductId}`;
          attempted++;
          const result = await writeMetafield(
            conn,
            ownerId,
            target.namespace,
            target.key,
            row.msrp,
          );
          writes.push({
            rowId: row.rowId,
            ownerId,
            ownerType: "product",
            field: "MSRP",
            namespace: target.namespace,
            key: target.key,
            ok: result.ok,
            error: result.ok ? null : result.error,
          });
          if (result.ok) {
            succeeded++;
            if (!pushReadyRowIds.includes(row.rowId)) pushReadyRowIds.push(row.rowId);
          } else failed++;
        }
        for (const [fieldName, value] of Object.entries(row.fieldValues)) {
          if (!value) continue;
          const override = overrides ? overrides[fieldName] : undefined;
          const target = override
            ? { namespace: override.namespace, key: override.key }
            : deriveMetafieldTargetForProductField(fieldName);
          const isVariant = fieldIsVariantTargeted(fieldName);
          const ownerId =
            isVariant && row.shopifyVariantId
              ? row.shopifyVariantId.startsWith("gid://")
                ? row.shopifyVariantId
                : `gid://shopify/ProductVariant/${row.shopifyVariantId}`
              : row.shopifyProductId
              ? row.shopifyProductId.startsWith("gid://")
                ? row.shopifyProductId
                : `gid://shopify/Product/${row.shopifyProductId}`
              : "";
          if (!ownerId) {
            writes.push({
              rowId: row.rowId,
              ownerId: "",
              ownerType: isVariant ? "variant" : "product",
              field: fieldName,
              namespace: target.namespace,
              key: target.key,
              ok: false,
              error: "Missing Shopify product/variant id; cannot write metafield.",
            });
            failed++;
            attempted++;
            continue;
          }
          attempted++;
          const result = await writeMetafield(
            conn,
            ownerId,
            target.namespace,
            target.key,
            value,
          );
          writes.push({
            rowId: row.rowId,
            ownerId,
            ownerType: isVariant ? "variant" : "product",
            field: fieldName,
            namespace: target.namespace,
            key: target.key,
            ok: result.ok,
            error: result.ok ? null : result.error,
          });
          if (result.ok) {
            succeeded++;
            if (!pushReadyRowIds.includes(row.rowId)) pushReadyRowIds.push(row.rowId);
          } else failed++;
        }
      }
    }

    // Invalidate cached preview so the next refresh re-derives the
    // properties from the freshly-written metafields.
    if (shopDomain) {
      try {
        storage.clearProductCache(shopDomain);
      } catch {
        // non-fatal
      }
    }

    storage.appendLog({
      level: "info",
      message: `Applied Jomashop product-field XLSX: ${validRows.length} row(s), ${succeeded}/${attempted} metafield writes succeeded`,
      detailsJson: JSON.stringify({
        sessionId: session.id,
        rowsProcessed: session.rows.length,
        validRows: validRows.length,
        skippedInvalid,
        writeAttempted: attempted,
        writeSucceeded: succeeded,
        writeFailed: failed,
      }),
      createdAt: Date.now(),
    });

    SESSIONS.delete(session.id);
    res.json({
      ok: true,
      rowsProcessed: session.rows.length,
      validRowsApplied: validRows.length,
      skippedInvalidRows: skippedInvalid,
      cacheInvalidatedFor: shopDomain,
      shopifyConnected: Boolean(conn),
      forceWriteback,
      metafieldWriteSummary: { attempted, succeeded, failed },
      metafieldWrites: writes,
      // Rows that successfully wrote at least one metafield are now
      // candidates for a Jomashop push. The UI / orchestrator decides
      // whether to actually push; we do NOT push from this route unless
      // the caller explicitly opted in (see /api/jomashop/push-...).
      pushReadyRowIds,
      pushReadyCount: pushReadyRowIds.length,
      warnings: !conn
        ? ["No connected Shopify store — metafield writes were skipped."]
        : [],
      note: shopDomain
        ? "Applied. Click Refresh from Shopify on the Products page to recompute readiness with the new metafields."
        : "Applied.",
    });
  });

  // Diagnostic: report active session/lock state without exposing payloads.
  app.get("/api/jomashop-product-fields/_status", (_req, res) => {
    res.json({
      ok: true,
      sessionCount: SESSIONS.size,
      sessionCap: MAX_PRODUCT_FIELD_SESSIONS,
      ttlMs: SESSION_TTL_MS,
    });
  });
}
