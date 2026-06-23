import type { Express } from "express";
import { storage } from "./storage";
import { BUILT_IN_BRAND_OVERRIDES, lookupBrandOverride } from "./brand_mapping";
import {
  BUILT_IN_CATEGORY_OVERRIDES,
  lookupCategoryOverride,
} from "./category_mapping";
import { lookupEnumOverride, normalizeEnumSourceValue } from "./enum_mapping";
import { deriveMetafieldTargetForProductField } from "./jomashop_product_field_excel";
import { canonicalJomashopCategory } from "@shared/schema";

/**
 * Mapping memory + auto-fill suggestions.
 *
 * The brand/category/enum override tables already act as the app's persistent
 * "internal memory". This module surfaces them in one place and mines the
 * cached product preview for values that are still unresolved, proposing
 * fills with a confidence label so the operator can apply them in bulk:
 *
 *   - "Exact Match"     — a verified saved override already resolves this value.
 *   - "Previously Used" — a saved (unverified) override exists for reuse.
 *   - "Suggested"       — a built-in seed maps it.
 *   - "Needs Review"    — nothing resolves it; operator must supply a value.
 *
 * Everything here is read-only/dry-run. Applying a suggestion goes through the
 * existing /api/brand-mapping, /api/category-mapping, /api/enum-mapping routes.
 */

export type Confidence = "Exact Match" | "Previously Used" | "Suggested" | "Needs Review";

type CachedRow = Record<string, any>;

/** Read every cached compact mapped product across connected stores. */
function readAllCachedProducts(): CachedRow[] {
  const out: CachedRow[] = [];
  for (const store of storage.listStores()) {
    const cache = storage.getProductCache(store.shopDomain);
    if (!cache) continue;
    let payload: any;
    try {
      payload = JSON.parse(cache.payloadJson);
    } catch {
      continue;
    }
    if (Array.isArray(payload?.mapped)) {
      for (const m of payload.mapped) {
        if (m && typeof m === "object" && !m.is_sample) out.push(m);
      }
    }
  }
  return out;
}

function brandConfidence(brand: string): { confidence: Confidence; proposed: string | null } {
  const saved = lookupBrandOverride(brand);
  if (saved && saved.jomashopBrand.trim()) {
    return {
      confidence: saved.source === "operator" ? "Exact Match" : "Suggested",
      proposed: saved.jomashopBrand,
    };
  }
  return { confidence: "Needs Review", proposed: null };
}

function categoryConfidence(code: string): { confidence: Confidence; proposed: string | null } {
  const saved = lookupCategoryOverride(code);
  if (saved && saved.jomashopCategory.trim()) {
    return {
      confidence: saved.source === "operator" ? "Previously Used" : "Suggested",
      proposed: saved.jomashopCategory,
    };
  }
  return { confidence: "Needs Review", proposed: null };
}

function enumConfidence(
  category: string,
  field: string,
  value: string,
  options: string[] | undefined,
): { confidence: Confidence; proposed: string | null } {
  const hit = lookupEnumOverride(category, field, value, options);
  if (hit) {
    return {
      confidence: hit.verified ? "Exact Match" : "Previously Used",
      proposed: hit.jomashopOption,
    };
  }
  return { confidence: "Needs Review", proposed: null };
}

export function registerMappingMemoryRoutes(app: Express): void {
  // -------- All saved mappings in one payload --------
  app.get("/api/mapping-memory/all", (_req, res) => {
    const brand = storage.listBrandOverrides();
    const category = storage.listCategoryOverrides();
    const enums = storage.listEnumOverrides();
    res.json({
      ok: true,
      counts: {
        brand: brand.length,
        category: category.length,
        enum: enums.length,
        builtInBrand: Object.keys(BUILT_IN_BRAND_OVERRIDES).length,
        builtInCategory: Object.keys(BUILT_IN_CATEGORY_OVERRIDES).length,
      },
      brand: brand.map((o) => ({
        shopify_brand: o.shopifyBrand,
        jomashop_brand: o.jomashopBrand,
        notes: o.notes,
        updated_at: o.updatedAt,
      })),
      category: category.map((o) => ({
        shopify_category_code: o.shopifyCategoryCode,
        jomashop_category: o.jomashopCategory,
        notes: o.notes,
        updated_at: o.updatedAt,
      })),
      enum: enums.map((o) => ({
        jomashop_category: o.jomashopCategory,
        jomashop_field: o.jomashopField,
        source_value: o.sourceValue,
        jomashop_option: o.jomashopOption,
        verified: o.verified,
        operator_verified: o.operatorVerified,
        updated_at: o.updatedAt,
      })),
    });
  });

  // -------- Suggested auto-fills mined from the cached catalog --------
  app.get("/api/mapping-memory/suggestions", (_req, res) => {
    const products = readAllCachedProducts();

    // brand value -> { count, sampleSku }
    const brandHits = new Map<string, { count: number; sample: string }>();
    const categoryHits = new Map<string, { count: number; sample: string }>();
    const enumHits = new Map<
      string,
      { category: string; field: string; value: string; options: string[]; count: number; sample: string }
    >();

    for (const p of products) {
      const sku = String(p.vendor_sku ?? p.sku ?? "");
      // Unresolved brand: no live manufacturer match.
      const resolution = p.jomashop_resolution || {};
      const brand = String(p.brand ?? "").trim();
      if (brand && !resolution.manufacturer) {
        const cur = brandHits.get(brand) || { count: 0, sample: sku };
        cur.count += 1;
        brandHits.set(brand, cur);
      }
      // Unresolved category: no live category record matched.
      const code = String(p.raw_category ?? p.suggested_category ?? "").trim();
      if (code && !resolution.category_record) {
        const cur = categoryHits.get(code) || { count: 0, sample: sku };
        cur.count += 1;
        categoryHits.set(code, cur);
      }
      // Enum gaps: invalid values + unverified required options.
      const canonical = canonicalJomashopCategory(String(p.category ?? "")) as string;
      const enumRows: Array<{ field: string; value: string; options: string[] }> = [];
      for (const ie of Array.isArray(p.invalid_enums) ? p.invalid_enums : []) {
        if (ie && ie.field) {
          enumRows.push({
            field: String(ie.field),
            value: String(ie.value ?? ""),
            options: Array.isArray(ie.options) ? ie.options.map(String) : [],
          });
        }
      }
      for (const u of Array.isArray(p.unverified_required_options) ? p.unverified_required_options : []) {
        if (u && u.field) {
          enumRows.push({ field: String(u.field), value: String(u.value ?? ""), options: [] });
        }
      }
      for (const row of enumRows) {
        const key = `${canonical}||${row.field}||${normalizeEnumSourceValue(row.value)}`;
        const cur =
          enumHits.get(key) ||
          { category: canonical, field: row.field, value: row.value, options: row.options, count: 0, sample: sku };
        cur.count += 1;
        if (row.options.length > cur.options.length) cur.options = row.options;
        enumHits.set(key, cur);
      }
    }

    const brandSuggestions = Array.from(brandHits.entries()).map(([value, info]) => {
      const { confidence, proposed } = brandConfidence(value);
      return { type: "brand" as const, source_value: value, proposed, confidence, affected_count: info.count, sample_sku: info.sample };
    });
    const categorySuggestions = Array.from(categoryHits.entries()).map(([value, info]) => {
      const { confidence, proposed } = categoryConfidence(value);
      return { type: "category" as const, source_value: value, proposed, confidence, affected_count: info.count, sample_sku: info.sample };
    });
    const enumSuggestions = Array.from(enumHits.values()).map((info) => {
      const { confidence, proposed } = enumConfidence(info.category, info.field, info.value, info.options);
      return {
        type: "enum" as const,
        category: info.category,
        field: info.field,
        source_value: info.value,
        options: info.options,
        proposed,
        confidence,
        affected_count: info.count,
        sample_sku: info.sample,
      };
    });

    const sortByCount = <T extends { affected_count: number }>(a: T, b: T) => b.affected_count - a.affected_count;
    brandSuggestions.sort(sortByCount);
    categorySuggestions.sort(sortByCount);
    enumSuggestions.sort(sortByCount);

    res.json({
      ok: true,
      scanned: products.length,
      counts: {
        brand: brandSuggestions.length,
        category: categorySuggestions.length,
        enum: enumSuggestions.length,
      },
      brand: brandSuggestions,
      category: categorySuggestions,
      enum: enumSuggestions,
    });
  });

  // -------- Write-back preview: where each correction would land --------
  // Dry-run only. Splits a product's outstanding fields into three buckets:
  //   - shopify_writeback: needs a Shopify metafield write (no internal value)
  //   - internal_mapping:  a saved/built-in override resolves it (push-ready
  //                        once the mapping is applied; no Shopify write needed)
  //   - jomashop_ready:    nothing outstanding for that field
  app.get("/api/shopify/writeback-preview/:productId", (req, res) => {
    const productId = String(req.params.productId || "");
    if (!productId) return res.status(400).json({ ok: false, error: "Missing product id" });
    const product = readAllCachedProducts().find(
      (p) => String(p?.source?.shopify_product_id ?? "") === productId,
    );
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: "Product not found in cache. Refresh from Shopify first.",
      });
    }
    const canonical = canonicalJomashopCategory(String(product.category ?? "")) as string;

    const missingRequired: string[] = Array.isArray(product.missing_required) ? product.missing_required : [];
    const missingTopLevel: string[] = Array.isArray(product.missing_top_level) ? product.missing_top_level : [];
    const invalidEnums: Array<{ field: string; value: string; options: string[] }> = Array.isArray(
      product.invalid_enums,
    )
      ? product.invalid_enums
      : [];

    const shopifyWriteback: Array<{ field: string; metafield_target: string; reason: string }> = [];
    const internalMapping: Array<{ field: string; proposed: string | null; confidence: Confidence }> = [];

    const handleField = (field: string, value: string, options: string[] | undefined, reason: string) => {
      const { confidence, proposed } = enumConfidence(canonical, field, value, options);
      if (proposed) {
        internalMapping.push({ field, proposed, confidence });
      } else {
        const target = deriveMetafieldTargetForProductField(field);
        shopifyWriteback.push({ field, metafield_target: `${target.namespace}.${target.key}`, reason });
      }
    };

    for (const ie of invalidEnums) {
      handleField(String(ie.field), String(ie.value ?? ""), Array.isArray(ie.options) ? ie.options.map(String) : [], "invalid value");
    }
    for (const field of missingRequired) {
      if (invalidEnums.some((ie) => ie.field === field)) continue;
      handleField(String(field), "", undefined, "missing required");
    }
    for (const field of missingTopLevel) {
      const target = deriveMetafieldTargetForProductField(String(field));
      shopifyWriteback.push({ field: String(field), metafield_target: `${target.namespace}.${target.key}`, reason: "missing top-level" });
    }

    res.json({
      ok: true,
      product_id: productId,
      vendor_sku: product.vendor_sku ?? null,
      category: canonical,
      jomashop_ready: shopifyWriteback.length === 0 && internalMapping.length === 0,
      shopify_writeback: shopifyWriteback,
      internal_mapping: internalMapping,
      missing_required: missingRequired,
      missing_top_level: missingTopLevel,
      invalid_enums: invalidEnums,
    });
  });
}
