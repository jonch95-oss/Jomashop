import type { Express } from "express";
import { storage } from "./storage";
import { getActiveShopifyConnection } from "./shopify";
import type { SchemaPropertyDescriptor } from "./mapping";
import { canonicalJomashopCategory, type SupportedCategory } from "@shared/schema";
import {
  deriveMetafieldTargetForProductField,
  fieldIsVariantTargeted,
  loadLiveSchemaForCategory,
  writeMetafield,
} from "./jomashop_product_field_excel";
import { lookupEnumOverride } from "./enum_mapping";
import { validateInlineFieldValue } from "./inline_field_repair";
import { deriveReadinessFromMapping, type CompactMappedProduct } from "./compact_mapped";

/**
 * Bulk fill grid: one screen to fill every product-level required Jomashop
 * field that is currently missing or invalid across the cached catalog, then
 * push the now-ready rows live. Built for "go live fast":
 *
 *   - READ is cache-driven (no per-product Shopify streaming). The grid is
 *     assembled from the same compact preview rows the Products page renders,
 *     plus the live category schema (loaded once per category for the enum
 *     option lists).
 *   - WRITE goes straight to Shopify metafields via `writeMetafield`, using an
 *     owner id reconstructed from the cached product/variant id — so applying
 *     N edits costs N metafield writes, not N full-catalog scans. It mirrors
 *     the namespace/key + validation logic of the per-product inline repair so
 *     both paths land on the same metafields and the next mapping pass derives
 *     the field cleanly.
 *
 * Scope: product-level required fields (Color, Material, Article, Gender, …)
 * plus the common top-level blocker Commercial Discount. Variant-scoped fields
 * (e.g. per-variant Shoe Size) are intentionally excluded from the grid — they
 * are normally derived from the variant's own Shopify option at push time and
 * are better handled in the per-product inline panel.
 */

const COMMERCIAL_DISCOUNT_FIELD = "Commercial Discount";

const COMMERCIAL_DISCOUNT_DESCRIPTOR: SchemaPropertyDescriptor = {
  field: COMMERCIAL_DISCOUNT_FIELD,
  required: true,
  type: "number",
  min_value: 0,
  max_value: 100,
} as SchemaPropertyDescriptor;

export type BulkFillFieldDescriptor = {
  field: string;
  required: boolean;
  type: string;
  options: string[];
  options_unverified: boolean;
  multiple: boolean;
  isVariantTargeted: boolean;
  metafieldTarget: string;
  /** True for the synthetic Commercial Discount column (written to
   *  jomashop.commercial_discount, not a category schema property). */
  isTopLevel: boolean;
};

export type BulkFillCell = {
  field: string;
  status: "missing" | "invalid" | "ok";
  currentValue: string;
  invalidValue: string;
};

export type BulkFillRow = {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  brand: string;
  category: string;
  readiness: string;
  image: string | null;
  /** Product-level fields on this row that still need a value or a fix. */
  needsRepair: string[];
  cells: Record<string, BulkFillCell>;
};

export type BulkFillCategoryGroup = {
  category: string;
  schemaSource: string;
  fields: BulkFillFieldDescriptor[];
  rows: BulkFillRow[];
};

export type BulkFillGrid = {
  totalProducts: number;
  unreadyProducts: number;
  categories: BulkFillCategoryGroup[];
};

function lc(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

/** Read a property value off the compact row's properties map,
 *  case-insensitively (the live schema label casing can drift). */
function readProperty(properties: Record<string, unknown> | undefined, field: string): string {
  if (!properties || typeof properties !== "object") return "";
  const direct = (properties as Record<string, unknown>)[field];
  if (direct !== undefined && direct !== null) return String(direct);
  const wanted = lc(field);
  for (const [k, v] of Object.entries(properties)) {
    if (lc(k) === wanted) return v === null || v === undefined ? "" : String(v);
  }
  return "";
}

/**
 * Pure grid builder. Kept free of Express/Shopify so the test suite can
 * exercise the column-selection + per-cell status logic directly.
 *
 *  - allMapped: compact mapped rows from the cached preview payload.
 *  - schemaByCategory: live (or fallback) schema descriptors per canonical
 *    category, keyed by the canonical category name.
 */
export function buildBulkFillGrid(
  allMapped: any[],
  schemaByCategory: Map<string, { fields: SchemaPropertyDescriptor[]; source: string }>,
): BulkFillGrid {
  const groups = new Map<string, BulkFillCategoryGroup>();
  let unready = 0;

  for (const m of allMapped) {
    if (!m || m.is_sample) continue;
    const productId = m?.source?.shopify_product_id;
    if (productId === undefined || productId === null || String(productId).trim() === "") continue;
    if (m.readiness === "ready") continue;

    const canonical = canonicalJomashopCategory(String(m.category || "")) || String(m.category || "");
    if (!canonical) continue;

    const missingRequired: string[] = Array.isArray(m.missing_required) ? m.missing_required : [];
    const missingTopLevel: string[] = Array.isArray(m.missing_top_level) ? m.missing_top_level : [];
    const invalidEnums: Array<{ field: string; value: string; options: string[] }> = Array.isArray(
      m.invalid_enums,
    )
      ? m.invalid_enums
      : [];

    const invalidByField = new Map<string, { value: string; options: string[] }>();
    for (const ie of invalidEnums) {
      if (ie && typeof ie.field === "string") {
        invalidByField.set(ie.field, {
          value: String(ie.value ?? ""),
          options: Array.isArray(ie.options) ? ie.options : [],
        });
      }
    }

    const schemaEntry = schemaByCategory.get(canonical);
    const schemaFields = schemaEntry?.fields ?? [];

    // Candidate product-level columns: every required schema field that is not
    // variant-scoped, plus any field this row reports as missing/invalid (so a
    // field not present in the loaded schema still gets a free-text column).
    const fieldDefByName = new Map<string, SchemaPropertyDescriptor>();
    for (const f of schemaFields) {
      if (!f || typeof f.field !== "string" || f.field.trim() === "" || f.field === "undefined") continue;
      if (fieldIsVariantTargeted(f.field)) continue;
      fieldDefByName.set(f.field, f);
    }
    const rowRepairFields = new Set<string>();
    for (const f of missingRequired) {
      if (typeof f === "string" && f && f !== "undefined" && !fieldIsVariantTargeted(f)) {
        rowRepairFields.add(f);
      }
    }
    for (const f of Array.from(invalidByField.keys())) {
      if (f && f !== "undefined" && !fieldIsVariantTargeted(f)) rowRepairFields.add(f);
    }
    const wantsCommercialDiscount = missingTopLevel.includes("commercial_discount");

    if (rowRepairFields.size === 0 && !wantsCommercialDiscount) continue;

    unready += 1;

    let group = groups.get(canonical);
    if (!group) {
      group = {
        category: canonical,
        schemaSource: schemaEntry?.source ?? "unknown",
        fields: [],
        rows: [],
      };
      groups.set(canonical, group);
    }

    // Register any new columns surfaced by this row.
    const ensureColumn = (field: string, def: SchemaPropertyDescriptor | undefined, isTopLevel: boolean) => {
      if (group!.fields.some((c) => c.field === field)) return;
      const target = isTopLevel
        ? { namespace: "jomashop", key: "commercial_discount" }
        : deriveMetafieldTargetForProductField(field);
      group!.fields.push({
        field,
        required: def?.required === true || isTopLevel,
        type: def?.type ?? (isTopLevel ? "number" : "string"),
        options: Array.isArray(def?.options) ? (def!.options as string[]) : [],
        options_unverified: def?.options_unverified === true,
        multiple: def?.multiple === true,
        isVariantTargeted: false,
        metafieldTarget: `${target.namespace}.${target.key}`,
        isTopLevel,
      });
    };

    const cells: Record<string, BulkFillCell> = {};
    for (const field of Array.from(rowRepairFields)) {
      ensureColumn(field, fieldDefByName.get(field), false);
      const invalid = invalidByField.get(field);
      const currentValue = readProperty(m.properties, field);
      const isMissing = currentValue.trim() === "" || lc(currentValue) === "undefined";
      cells[field] = {
        field,
        status: invalid ? "invalid" : isMissing ? "missing" : "ok",
        currentValue,
        invalidValue: invalid ? invalid.value : "",
      };
    }
    if (wantsCommercialDiscount) {
      ensureColumn(COMMERCIAL_DISCOUNT_FIELD, COMMERCIAL_DISCOUNT_DESCRIPTOR, true);
      cells[COMMERCIAL_DISCOUNT_FIELD] = {
        field: COMMERCIAL_DISCOUNT_FIELD,
        status: "missing",
        currentValue: "",
        invalidValue: "",
      };
    }

    const variantId = Array.isArray(m?.source?.shopify_variant_ids)
      ? m.source.shopify_variant_ids[0]
      : undefined;

    group.rows.push({
      productId: String(productId),
      variantId: variantId !== undefined && variantId !== null ? String(variantId) : null,
      sku: String(m.vendor_sku ?? m.sku ?? ""),
      name: String(m.name ?? ""),
      brand: String(m.brand ?? ""),
      category: canonical,
      readiness: String(m.readiness ?? "missing"),
      image: typeof m.image === "string" && m.image ? m.image : null,
      needsRepair: Object.keys(cells).filter((f) => cells[f].status !== "ok"),
      cells,
    });
  }

  // Stable column order: required schema order first (alphabetical fallback),
  // Commercial Discount last.
  const categories = Array.from(groups.values()).sort((a, b) => a.category.localeCompare(b.category));
  for (const g of categories) {
    g.fields.sort((a, b) => {
      if (a.isTopLevel !== b.isTopLevel) return a.isTopLevel ? 1 : -1;
      return a.field.localeCompare(b.field);
    });
  }
  return {
    totalProducts: allMapped.length,
    unreadyProducts: unready,
    categories,
  };
}

function ownerIdForProduct(productId: string | number): string {
  const s = String(productId);
  return s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`;
}
function ownerIdForVariant(variantId: string | number): string {
  const s = String(variantId);
  return s.startsWith("gid://") ? s : `gid://shopify/ProductVariant/${s}`;
}

type ApplyEdit = {
  productId: string;
  variantId?: string | null;
  fields: Array<{ field: string; value: string | number }>;
};

export function registerBulkFillRoutes(app: Express): void {
  /**
   * GET /api/jomashop/bulk-fill/grid?category=&limit=
   *
   * Returns the bulk-fill grid (not-ready products grouped by canonical
   * category, with product-level required fields needing repair as columns).
   * Read-only and cache-driven.
   */
  app.get("/api/jomashop/bulk-fill/grid", async (req, res) => {
    try {
      const conn = getActiveShopifyConnection();
      let shopDomain: string | null = conn?.shopDomain ?? null;
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
      if (!cache) {
        return res.json({
          ok: true,
          shopDomain,
          shopifyConnected: Boolean(conn),
          fromCache: false,
          totalProducts: 0,
          unreadyProducts: 0,
          categories: [],
          note: "No cached preview yet. Open Products and click Refresh from Shopify first.",
        });
      }
      let payload: any;
      try {
        payload = JSON.parse(cache.payloadJson);
      } catch {
        return res.status(500).json({ ok: false, error: "Cached preview is corrupt; refresh from Shopify." });
      }
      const allMapped: any[] = Array.isArray(payload?.mapped) ? payload.mapped : [];

      const categoryFilter = typeof req.query.category === "string" ? req.query.category.trim() : "";

      // Discover the set of canonical categories present among not-ready rows,
      // then load each live schema once.
      const neededCategories = new Set<string>();
      for (const m of allMapped) {
        if (!m || m.is_sample || m.readiness === "ready") continue;
        const canonical =
          canonicalJomashopCategory(String(m.category || "")) || String(m.category || "");
        if (!canonical) continue;
        if (categoryFilter && lc(canonical) !== lc(categoryFilter)) continue;
        neededCategories.add(canonical);
      }

      const schemaByCategory = new Map<string, { fields: SchemaPropertyDescriptor[]; source: string }>();
      for (const cat of Array.from(neededCategories)) {
        try {
          const live = await loadLiveSchemaForCategory(cat as SupportedCategory);
          schemaByCategory.set(cat, { fields: live.fields, source: live.source });
        } catch (err) {
          schemaByCategory.set(cat, { fields: [], source: "unknown" });
        }
      }

      const filtered = categoryFilter
        ? allMapped.filter((m) => {
            const canonical =
              canonicalJomashopCategory(String(m?.category || "")) || String(m?.category || "");
            return lc(canonical) === lc(categoryFilter);
          })
        : allMapped;

      const grid = buildBulkFillGrid(filtered, schemaByCategory);

      return res.json({
        ok: true,
        shopDomain,
        shopifyConnected: Boolean(conn),
        fromCache: true,
        cachedAt: cache.fetchedAt,
        totalProducts: allMapped.length,
        unreadyProducts: grid.unreadyProducts,
        categories: grid.categories,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  /**
   * POST /api/jomashop/bulk-fill/apply
   *
   * Body: { confirm: true, edits: [{ productId, variantId?, fields: [{ field, value }] }] }
   *
   * Validates each value against the product's live category schema, writes
   * valid ones to Shopify metafields, and updates the cached preview row in
   * place so the grid + Products page reflect the new readiness without a full
   * /api/products/refresh. Invalid cells are reported per-field and skipped —
   * one bad value never blocks the rest of the batch.
   */
  app.post("/api/jomashop/bulk-fill/apply", async (req, res) => {
    const body = (req.body || {}) as { confirm?: boolean; edits?: ApplyEdit[] };
    if (!body.confirm) {
      return res.status(400).json({
        ok: false,
        error: "Missing confirmation. Set `confirm: true` to write Shopify metafields.",
      });
    }
    const edits = Array.isArray(body.edits) ? body.edits : [];
    if (edits.length === 0) {
      return res.status(400).json({ ok: false, error: "No edits supplied." });
    }

    const conn = getActiveShopifyConnection();
    if (!conn) {
      return res.status(503).json({
        ok: false,
        error: "No connected Shopify store with an access token. Complete OAuth install first.",
      });
    }

    const cache = storage.getProductCache(conn.shopDomain);
    if (!cache) {
      return res.status(409).json({
        ok: false,
        error: "No cached preview. Open Products and click Refresh from Shopify first.",
      });
    }
    let payload: any;
    try {
      payload = JSON.parse(cache.payloadJson);
    } catch {
      return res.status(500).json({ ok: false, error: "Cached preview is corrupt; refresh from Shopify." });
    }
    const allMapped: any[] = Array.isArray(payload?.mapped) ? payload.mapped : [];
    const rowByProductId = new Map<string, any>();
    for (const m of allMapped) {
      const pid = String(m?.source?.shopify_product_id ?? "");
      if (pid) rowByProductId.set(pid, m);
    }

    // Load schema per category once (validation needs the descriptors).
    const schemaCache = new Map<string, Map<string, SchemaPropertyDescriptor>>();
    async function descriptorsFor(category: string): Promise<Map<string, SchemaPropertyDescriptor>> {
      const canonical = canonicalJomashopCategory(category) || category;
      const existing = schemaCache.get(canonical);
      if (existing) return existing;
      const map = new Map<string, SchemaPropertyDescriptor>();
      try {
        const live = await loadLiveSchemaForCategory(canonical as SupportedCategory);
        for (const d of live.fields) {
          if (d && typeof d.field === "string") map.set(d.field, d);
        }
      } catch {
        // leave empty — fields validate as free-text strings
      }
      map.set(COMMERCIAL_DISCOUNT_FIELD, COMMERCIAL_DISCOUNT_DESCRIPTOR);
      schemaCache.set(canonical, map);
      return map;
    }

    type FieldResult = {
      field: string;
      ok: boolean;
      metafieldTarget: string | null;
      error: string | null;
      validationError: string | null;
    };
    type ProductResult = {
      productId: string;
      sku: string;
      written: number;
      failed: number;
      fields: FieldResult[];
      readiness: string | null;
      push_ready: boolean;
    };

    const productResults: ProductResult[] = [];
    let totalWritten = 0;
    let totalFailed = 0;

    for (const edit of edits) {
      const productId = String(edit?.productId ?? "");
      const row = rowByProductId.get(productId);
      const fields = Array.isArray(edit?.fields) ? edit.fields : [];
      const result: ProductResult = {
        productId,
        sku: row ? String(row.vendor_sku ?? row.sku ?? "") : "",
        written: 0,
        failed: 0,
        fields: [],
        readiness: null,
        push_ready: false,
      };
      if (!productId || !row) {
        result.fields.push({
          field: "*",
          ok: false,
          metafieldTarget: null,
          error: "Product not found in cached preview. Refresh from Shopify and retry.",
          validationError: null,
        });
        result.failed += 1;
        totalFailed += 1;
        productResults.push(result);
        continue;
      }

      const descriptors = await descriptorsFor(String(row.category || ""));
      const canonical = canonicalJomashopCategory(String(row.category || "")) || String(row.category || "");

      // Track applied values so we can update the cached row in place.
      const appliedValues: Array<{ field: string; value: string; isTopLevel: boolean }> = [];

      for (const f of fields) {
        const fieldName = typeof f?.field === "string" ? f.field.trim() : "";
        if (!fieldName) continue;
        const rawValue = String(f?.value ?? "").trim();
        const isTopLevel = fieldName === COMMERCIAL_DISCOUNT_FIELD;
        // Resolve descriptor (case-insensitive label match).
        let fdef = descriptors.get(fieldName);
        if (!fdef) {
          const wanted = lc(fieldName);
          for (const [k, v] of Array.from(descriptors.entries())) {
            if (lc(k) === wanted) {
              fdef = v;
              break;
            }
          }
        }
        // Apply a saved enum override before validation + writeback so the
        // canonical Jomashop label is what we store and validate.
        let value = rawValue;
        if (fdef && fdef.type === "enum" && Array.isArray(fdef.options)) {
          const override = lookupEnumOverride(canonical, fdef.field, value, fdef.options);
          if (override) value = override.jomashopOption;
        }

        const validationError = validateInlineFieldValue(fdef, value);
        if (validationError) {
          result.fields.push({
            field: fieldName,
            ok: false,
            metafieldTarget: null,
            error: null,
            validationError,
          });
          result.failed += 1;
          totalFailed += 1;
          continue;
        }

        const target = isTopLevel
          ? { namespace: "jomashop", key: "commercial_discount" }
          : deriveMetafieldTargetForProductField(fieldName);
        const ownerId = ownerIdForProduct(row?.source?.shopify_product_id ?? productId);
        const write = await writeMetafield(conn, ownerId, target.namespace, target.key, value);
        result.fields.push({
          field: fieldName,
          ok: write.ok,
          metafieldTarget: `${target.namespace}.${target.key}`,
          error: write.ok ? null : write.error,
          validationError: null,
        });
        if (write.ok) {
          result.written += 1;
          totalWritten += 1;
          appliedValues.push({ field: fieldName, value, isTopLevel });
        } else {
          result.failed += 1;
          totalFailed += 1;
        }
      }

      // Update the cached compact row in place so readiness reflects the new
      // values immediately (no full /api/products/refresh required).
      if (appliedValues.length > 0) {
        const props =
          row.properties && typeof row.properties === "object" ? { ...row.properties } : {};
        let newMissingRequired: string[] = Array.isArray(row.missing_required)
          ? [...row.missing_required]
          : [];
        let newMissingTopLevel: string[] = Array.isArray(row.missing_top_level)
          ? [...row.missing_top_level]
          : [];
        let newInvalidEnums: Array<{ field: string; value: string; options: string[] }> =
          Array.isArray(row.invalid_enums) ? [...row.invalid_enums] : [];
        let commercialDiscount = typeof row.commercial_discount === "number" ? row.commercial_discount : 0;

        for (const a of appliedValues) {
          if (a.isTopLevel) {
            const n = Number(a.value);
            if (Number.isFinite(n)) commercialDiscount = n;
            newMissingTopLevel = newMissingTopLevel.filter((x) => x !== "commercial_discount");
          } else {
            props[a.field] = a.value;
            newMissingRequired = newMissingRequired.filter(
              (x) => lc(x) !== lc(a.field),
            );
            newInvalidEnums = newInvalidEnums.filter((x) => lc(x.field) !== lc(a.field));
          }
        }

        const hasUndefinedProp = Object.entries(props).some(
          ([k, v]) =>
            !k ||
            k === "undefined" ||
            v === undefined ||
            (typeof v === "string" && lc(v) === "undefined"),
        );
        const schemaLoaded =
          Array.isArray(row.schema_fields) && row.schema_fields.length > 0
            ? true
            : row.schema_source && row.schema_source !== "none";

        const readiness = deriveReadinessFromMapping({
          is_sample: Boolean(row.is_sample),
          push_state: row.push_state ?? null,
          schemaLoaded: Boolean(schemaLoaded),
          ambiguous_category: Boolean(row.ambiguous_category),
          missing_top_level: newMissingTopLevel,
          missing_required: newMissingRequired,
          invalid_enums: newInvalidEnums,
          vendor_sku: row.vendor_sku,
          category: row.category,
          has_undefined_property: hasUndefinedProp,
        });

        row.properties = props;
        row.missing_required = newMissingRequired;
        row.missing_top_level = newMissingTopLevel;
        row.invalid_enums = newInvalidEnums;
        row.commercial_discount = commercialDiscount;
        row.readiness = readiness;
        // Recompute Jomashop price preview if a discount was just supplied.
        if (typeof row.price === "number" && commercialDiscount > 0) {
          row.jomashop_price = Math.round(row.price * (1 - commercialDiscount / 100) * 100) / 100;
        }

        result.readiness = readiness;
        result.push_ready =
          newMissingRequired.length === 0 &&
          newMissingTopLevel.length === 0 &&
          newInvalidEnums.length === 0;
      } else {
        result.readiness = String(row.readiness ?? "missing");
      }

      productResults.push(result);
    }

    // Persist the updated cache payload once for the whole batch.
    try {
      storage.upsertProductCache({
        shopDomain: conn.shopDomain,
        fetchedCount: cache.fetchedCount,
        pageCount: cache.pageCount,
        hasMore: cache.hasMore,
        payloadJson: JSON.stringify(payload),
        fetchedAt: cache.fetchedAt,
      });
    } catch {
      // non-fatal — the metafield writes already happened; a manual refresh
      // will recompute readiness from Shopify.
    }

    storage.appendLog({
      level: totalFailed === 0 ? "info" : "warn",
      message: `Bulk fill: ${totalWritten} metafield write(s) across ${edits.length} product(s), ${totalFailed} failure(s)`,
      detailsJson: JSON.stringify({
        products: productResults.map((p) => ({
          productId: p.productId,
          written: p.written,
          failed: p.failed,
          readiness: p.readiness,
        })),
      }),
      createdAt: Date.now(),
    });

    return res.json({
      ok: totalFailed === 0,
      shopDomain: conn.shopDomain,
      totalWritten,
      totalFailed,
      nowReady: productResults.filter((p) => p.push_ready).length,
      products: productResults,
      cacheUpdatedFor: conn.shopDomain,
      note:
        totalFailed === 0
          ? "Applied. Rows that became ready can be pushed now."
          : "Applied with some failures — see per-field results.",
    });
  });
}
