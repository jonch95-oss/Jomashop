/**
 * Compact projection of a fully-mapped product. Strips heavy fields
 * (debug_raw, full metafields echo, full image array) and keeps only what
 * the Products list view actually renders. Used both as the cache row and
 * the default list response so we never ship megabytes of metafield JSON
 * for a 3,000-product catalog.
 *
 * Extracted out of routes.ts so the inline-field-repair route can produce
 * the same compact shape after a writeback (and re-seed the cache row
 * in-place) without introducing a circular import.
 */
export type CompactMappedProduct = {
  category: string;
  is_sample: boolean;
  raw_category: string | null;
  suggested_category: string;
  ambiguous_category: boolean;
  vendor_sku: string;
  sku: string;
  manufacturer_number: string | null;
  name: string;
  brand: string;
  price: number | null;
  msrp: number | null;
  msrp_source: string;
  msrp_metafield_key: string | null;
  commercial_discount: number;
  jomashop_price: number | null;
  image: string | null;
  images: string[];
  description: string;
  properties: Record<string, string | number | boolean>;
  variant_count: number;
  variants: Array<{
    vendor_sku: string;
    price: number | null;
    jomashop_price: number | null;
    quantity: number;
    status: "active" | "out_of_stock" | "inactive";
    options: Record<string, string>;
  }>;
  warnings: string[];
  missing_required: string[];
  missing_top_level: string[];
  invalid_enums: Array<{ field: string; value: string; options: string[] }>;
  unverified_required_options: Array<{ field: string; value?: string }>;
  auto_resolved_enums: Array<{ field: string; chosen: string; sourceCode: string; reason: string }>;
  source: { shopify_product_id?: string | number; shopify_variant_ids: Array<string | number> };
  push_state: string;
  jomashop_sku: string | null;
  last_push_error: string | null;
  last_pushed_at: number | null;
  last_invalid_params: string[] | null;
  last_rejected_category: string | null;
  last_rejected_brand: string | null;
  jomashop_resolution: {
    outbound_brand: string;
    outbound_category: string;
    manufacturer: { id: number | string; name: string } | null;
    manufacturer_suggestion: { id: number | string; name: string } | null;
    category_record: { id: number | string; name: string } | null;
    i1_available: boolean;
  };
  schema_source: "live-i1" | "live-v1" | "fallback" | "none";
  schema_fields: Array<{ field: string; required: boolean }>;
  readiness: string;
};

export function compactifyMapped(m: any): CompactMappedProduct {
  const properties: Record<string, string | number | boolean> = {};
  if (m.properties && typeof m.properties === "object") {
    let count = 0;
    for (const [k, v] of Object.entries(m.properties)) {
      if (count >= 24) break;
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        properties[k] = v as string | number | boolean;
        count += 1;
      }
    }
  }
  const variants = Array.isArray(m.variants)
    ? m.variants.map((v: any) => {
        const optsIn =
          v.options && typeof v.options === "object" && !Array.isArray(v.options)
            ? v.options
            : {};
        const options: Record<string, string> = {};
        for (const [k, val] of Object.entries(optsIn)) {
          if (typeof k !== "string" || !k) continue;
          if (val === null || val === undefined) continue;
          options[k] = String(val);
        }
        return {
          vendor_sku: String(v.vendor_sku ?? ""),
          price: typeof v.price === "number" ? v.price : null,
          jomashop_price: typeof v.jomashop_price === "number" ? v.jomashop_price : null,
          quantity: typeof v.quantity === "number" ? v.quantity : 0,
          status: (v.status ?? "inactive") as "active" | "out_of_stock" | "inactive",
          options,
        };
      })
    : [];
  const firstImage =
    typeof m.image === "string" && m.image
      ? m.image
      : Array.isArray(m.images) && m.images.length > 0 && typeof m.images[0] === "string"
        ? m.images[0]
        : null;
  const description =
    typeof m.description === "string" ? m.description.slice(0, 1500) : "";
  return {
    category: m.category,
    is_sample: Boolean(m.is_sample),
    raw_category: m.raw_category ?? null,
    suggested_category: m.suggested_category ?? "",
    ambiguous_category: Boolean(m.ambiguous_category),
    vendor_sku: m.vendor_sku ?? "",
    sku: m.sku ?? m.vendor_sku ?? "",
    manufacturer_number: m.manufacturer_number ?? null,
    name: m.name ?? "",
    brand: m.brand ?? "",
    description,
    price: typeof m.price === "number" ? m.price : null,
    msrp: typeof m.msrp === "number" ? m.msrp : null,
    msrp_source: typeof m.msrp_source === "string" && m.msrp_source ? m.msrp_source : "none",
    msrp_metafield_key:
      typeof m.msrp_metafield_key === "string" && m.msrp_metafield_key ? m.msrp_metafield_key : null,
    commercial_discount: typeof m.commercial_discount === "number" ? m.commercial_discount : 0,
    jomashop_price: typeof m.jomashop_price === "number" ? m.jomashop_price : null,
    image: firstImage,
    images: firstImage ? [firstImage] : [],
    properties,
    variant_count: variants.length,
    variants,
    warnings: Array.isArray(m.warnings) ? m.warnings.slice(0, 8) : [],
    missing_required: Array.isArray(m.missing_required) ? m.missing_required : [],
    missing_top_level: Array.isArray(m.missing_top_level) ? m.missing_top_level : [],
    invalid_enums: Array.isArray(m.invalid_enums)
      ? m.invalid_enums
          .filter((u: any) => u && typeof u.field === "string" && u.field)
          .map((u: any) => ({
            field: String(u.field),
            value: u.value === undefined || u.value === null ? "" : String(u.value),
            options: Array.isArray(u.options) ? u.options.map(String) : [],
          }))
      : [],
    unverified_required_options: Array.isArray(m.unverified_required_options)
      ? m.unverified_required_options
          .filter((u: any) => u && typeof u.field === "string" && u.field)
          .map((u: any) => ({
            field: String(u.field),
            value: u.value !== undefined && u.value !== null ? String(u.value) : undefined,
          }))
      : [],
    auto_resolved_enums: Array.isArray(m.auto_resolved_enums)
      ? m.auto_resolved_enums
          .filter((r: any) => r && typeof r.field === "string" && r.field)
          .map((r: any) => ({
            field: String(r.field),
            chosen: r.chosen !== undefined && r.chosen !== null ? String(r.chosen) : "",
            sourceCode:
              r.sourceCode !== undefined && r.sourceCode !== null ? String(r.sourceCode) : "",
            reason: r.reason !== undefined && r.reason !== null ? String(r.reason) : "",
          }))
      : [],
    source: {
      shopify_product_id: m.source?.shopify_product_id,
      shopify_variant_ids: Array.isArray(m.source?.shopify_variant_ids)
        ? m.source.shopify_variant_ids.slice(0, 100)
        : [],
    },
    push_state: m.push_state ?? "not_pushed",
    jomashop_sku: m.jomashop_sku ?? null,
    last_push_error: m.last_push_error ?? null,
    last_pushed_at: m.last_pushed_at ?? null,
    last_invalid_params: m.last_invalid_params ?? null,
    last_rejected_category: m.last_rejected_category ?? null,
    last_rejected_brand: m.last_rejected_brand ?? null,
    jomashop_resolution: m.jomashop_resolution ?? {
      outbound_brand: "",
      outbound_category: "",
      manufacturer: null,
      manufacturer_suggestion: null,
      category_record: null,
      i1_available: false,
    },
    schema_source: (m.schema_source ?? "none") as "live-i1" | "live-v1" | "fallback" | "none",
    schema_fields: Array.isArray(m.schema_fields)
      ? m.schema_fields
          .filter(
            (f: any) =>
              f && typeof f.field === "string" && f.field.trim() !== "" && f.field !== "undefined",
          )
          .slice(0, 32)
          .map((f: any) => ({ field: String(f.field), required: Boolean(f.required) }))
      : [],
    readiness: m.readiness ?? "missing",
  };
}

/**
 * Derive a readiness string from the mapper's missing/invalid lists. Used by
 * the inline-repair route to mark a row "ready" the moment the operator
 * fills the last required field, without re-running the full /i1 manufacturer
 * and category lookup. Inputs come straight off the post-repair MappedProduct
 * (missing_required, missing_top_level, invalid_enums, ambiguous_category)
 * plus a flag indicating whether the schema property list was non-empty.
 */
export function deriveReadinessFromMapping(input: {
  is_sample?: boolean;
  push_state?: string | null;
  schemaLoaded: boolean;
  ambiguous_category?: boolean;
  missing_top_level: string[];
  missing_required: string[];
  invalid_enums: Array<{ field: string }>;
  vendor_sku?: string;
  category?: string;
  has_undefined_property: boolean;
}): "ready" | "missing" | "needs-category-verification" | "rejected" | "sample" {
  if (input.is_sample) return "sample";
  // Note: we intentionally do NOT downgrade to "rejected" here. A successful
  // repair clears the issues that caused the last rejection on the next push;
  // the row stays in its current bucket until the operator pushes again.
  if (!input.schemaLoaded) return "needs-category-verification";
  if (input.ambiguous_category) return "needs-category-verification";
  const hasSku = Boolean(input.vendor_sku && input.vendor_sku.trim() !== "");
  const hasCategory = Boolean(input.category);
  if (
    input.missing_top_level.length > 0 ||
    input.missing_required.length > 0 ||
    input.invalid_enums.length > 0 ||
    !hasSku ||
    !hasCategory ||
    input.has_undefined_property
  ) {
    return "missing";
  }
  return "ready";
}
