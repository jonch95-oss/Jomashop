import type { Express } from "express";
import { storage } from "./storage";
import {
  fetchShopifyProductImages,
  getActiveShopifyConnection,
} from "./shopify";
import {
  mapShopifyToJomashop,
  type ShopifyProduct,
  type SchemaPropertyDescriptor,
} from "./mapping";
import { canonicalJomashopCategory, type SupportedCategory } from "@shared/schema";
import { resolveCategorySchema } from "./jomashop";
import {
  deriveMetafieldTargetForProductField,
  fieldIsVariantTargeted,
  loadLiveSchemaForCategory,
  writeMetafield,
} from "./jomashop_product_field_excel";
import { lookupEnumOverride } from "./enum_mapping";
import { compactifyMapped, type CompactMappedProduct } from "./compact_mapped";

/**
 * Inline per-product field repair: validate a single field value against the
 * live Jomashop schema and write it back to a Shopify metafield without
 * requiring the bulk Excel workflow. Mirrors the namespace/key + variant-vs-
 * product target logic used by `jomashop_product_field_excel.ts` so the two
 * paths land on the same metafields.
 */

export type InlineRepairField = {
  field: string;
  value: string;
  /** When set, force the write to this variant id (overrides the variant
   *  detection from the field name). Used for size when a specific variant
   *  is being repaired. Either the bare numeric id or a GID is accepted. */
  variantId?: string | number;
};

export type InlineRepairResult = {
  field: string;
  ok: boolean;
  ownerType: "product" | "variant";
  ownerId: string;
  namespace: string;
  key: string;
  metafieldTarget: string; // "namespace.key" for UI display
  error: string | null;
  validationError: string | null;
};

/** Validate one value against a schema property descriptor.
 *  Returns null when valid, or a human-readable error message. */
export function validateInlineFieldValue(
  fdef: SchemaPropertyDescriptor | undefined,
  value: string,
): string | null {
  const val = String(value ?? "").trim();
  if (val === "") return "Value is required.";
  if (!fdef) {
    // Unknown to schema — allow string up to Shopify's single-line cap.
    if (val.length > 1000) return "Value exceeds 1000 character cap.";
    return null;
  }
  if (fdef.type === "enum" && Array.isArray(fdef.options) && fdef.options.length > 0) {
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
      return `${fdef.multiple ? "Token(s)" : "Value"} "${bad.join(", ")}" not in the live accepted-options list (${fdef.options.length} options). Accepted: ${preview}${fdef.options.length > 8 ? "…" : ""}`;
    }
  }
  if (fdef.type === "number" || fdef.type === "integer" || fdef.only_integer) {
    const n = Number(val);
    if (!Number.isFinite(n)) return `Expected a number; got "${val}".`;
    if ((fdef.only_integer === true || fdef.type === "integer") && !Number.isInteger(n)) {
      return `Expected an integer; got "${val}".`;
    }
    if (typeof fdef.min_value === "number" && n < fdef.min_value) {
      return `Value ${n} is below min_value=${fdef.min_value}.`;
    }
    if (typeof fdef.max_value === "number" && n > fdef.max_value) {
      return `Value ${n} exceeds max_value=${fdef.max_value}.`;
    }
  }
  if (fdef.type === "string" || (!fdef.type && !(Array.isArray(fdef.options) && fdef.options.length > 0))) {
    if (typeof fdef.min_length === "number" && val.length < fdef.min_length) {
      return `Length ${val.length} is below min_length=${fdef.min_length}.`;
    }
    if (typeof fdef.max_length === "number" && val.length > fdef.max_length) {
      return `Length ${val.length} exceeds max_length=${fdef.max_length}.`;
    }
  }
  if (val.length > 1000 && !(typeof fdef.max_length === "number" && fdef.max_length > 1000)) {
    return "Value exceeds 1000 character cap.";
  }
  return null;
}

function ownerIdForProduct(productId: string | number): string {
  const s = String(productId);
  return s.startsWith("gid://") ? s : `gid://shopify/Product/${s}`;
}
function ownerIdForVariant(variantId: string | number): string {
  const s = String(variantId);
  return s.startsWith("gid://") ? s : `gid://shopify/ProductVariant/${s}`;
}

/** Locate a single Shopify product (with metafields) by id from either the
 *  active live connection or, when offline, the cached product preview so an
 *  operator can still validate fields against the cached schema. */
async function findProductById(productId: string): Promise<{
  product: ShopifyProduct | null;
  shopDomain: string | null;
  fromCache: boolean;
  category: string | null;
}> {
  const conn = getActiveShopifyConnection();
  if (conn) {
    const { streamShopifyProducts } = await import("./shopify");
    let found: ShopifyProduct | null = null;
    await streamShopifyProducts((pageProducts) => {
      for (const p of pageProducts) {
        if (String(p.id) === String(productId)) {
          found = p;
          return false;
        }
      }
    }, { pageSize: 100 });
    if (found) {
      return { product: found, shopDomain: conn.shopDomain, fromCache: false, category: null };
    }
  }
  // Cache fallback — used so validation can run against the cached schema
  // when the live Admin API is unreachable.
  const stores = storage.listStores();
  for (const s of stores) {
    const cache = storage.getProductCache(s.shopDomain);
    if (!cache) continue;
    let payload: any;
    try { payload = JSON.parse(cache.payloadJson); } catch { continue; }
    const all: any[] = Array.isArray(payload?.mapped) ? payload.mapped : [];
    const hit = all.find((m: any) => String(m?.source?.shopify_product_id ?? "") === String(productId));
    if (hit) {
      return {
        product: null,
        shopDomain: s.shopDomain,
        fromCache: true,
        category: typeof hit?.category === "string" ? hit.category : null,
      };
    }
  }
  return { product: null, shopDomain: null, fromCache: false, category: null };
}

/** Per-field descriptor returned by GET /api/jomashop/inline-field-repair/:id. */
export type InlineRepairFieldDescriptor = {
  field: string;
  required: boolean;
  type: string;
  options: string[];
  options_unverified: boolean;
  multiple: boolean;
  min_value: number | undefined;
  max_value: number | undefined;
  only_integer: boolean;
  min_length: number | undefined;
  max_length: number | undefined;
  isVariantTargeted: boolean;
  metafieldTarget: string;
  currentValue: string;
  invalidValue: string;
  status: "ok" | "missing" | "invalid";
  needsRepair: boolean;
};

/**
 * Pure helper that projects a mapped product + live schema into the
 * per-field descriptor list returned to the UI. Pulled out of the route
 * handler so the test suite can exercise the missing/invalid/optional
 * surfacing logic directly without spinning up Express or hitting Shopify.
 *
 *  - mappedProperties: the `properties` map returned by mapShopifyToJomashop
 *    after running with the live schema (post enum-coercion).
 *  - invalidEnums: the `invalid_enums` list from the same map result.
 *  - schemaFields: the live schema descriptors for the canonical category.
 */
export function buildInlineRepairFieldDescriptors(
  schemaFields: SchemaPropertyDescriptor[],
  mappedProperties: Record<string, unknown>,
  invalidEnums: Array<{ field: string; value: string; options: string[] }>,
  variantOptionsByVariantId?: Record<string, Record<string, string>>,
): InlineRepairFieldDescriptor[] {
  const invalidByField = new Map<string, { value: string; options: string[] }>();
  for (const ie of invalidEnums || []) {
    if (ie && typeof ie.field === "string") {
      invalidByField.set(ie.field, {
        value: String(ie.value ?? ""),
        options: Array.isArray(ie.options) ? ie.options : [],
      });
    }
  }
  // For variant-targeted size fields, gather the set of variants that
  // already carry a non-empty size on their Shopify option. When EVERY
  // variant has a size, the field is treated as "ok" — the inline repair
  // panel must not ask the operator to fill Shoe Size by hand when each
  // SKU clearly has one already (e.g. sizes 34, 35, 36, ...). The push
  // payload substitutes the variant's own size at send time
  // (extractVariantSize + buildJomashopProductPayload).
  const variantSizes: string[] = [];
  let variantCount = 0;
  if (variantOptionsByVariantId && typeof variantOptionsByVariantId === "object") {
    for (const opts of Object.values(variantOptionsByVariantId)) {
      variantCount += 1;
      if (!opts || typeof opts !== "object") continue;
      for (const [k, v] of Object.entries(opts)) {
        const tok = String(k).toLowerCase().replace(/[^a-z0-9]+/g, "");
        if (tok === "size" || tok === "shoesize" || tok === "apparelsize") {
          if (typeof v === "string" && v.trim() !== "") variantSizes.push(v.trim());
        }
      }
    }
  }
  const allVariantsHaveSize = variantCount > 0 && variantSizes.length >= variantCount;
  return schemaFields
    .filter(
      (f) => f && typeof f.field === "string" && f.field.trim() !== "" && f.field !== "undefined",
    )
    .map((f) => {
      const metaTarget = deriveMetafieldTargetForProductField(f.field);
      const isVariantTargeted = fieldIsVariantTargeted(f.field);
      const fieldTok = String(f.field).toLowerCase().replace(/[^a-z0-9]+/g, "");
      const isSizeField =
        fieldTok === "size" || fieldTok === "shoesize" || fieldTok === "apparelsize";
      let currentValue = (() => {
        const direct = (mappedProperties as any)[f.field];
        if (direct !== undefined && direct !== null) return String(direct);
        const wanted = f.field.toLowerCase().trim();
        for (const [k, v] of Object.entries(mappedProperties)) {
          if (String(k).toLowerCase().trim() === wanted) {
            return v === null || v === undefined ? "" : String(v);
          }
        }
        return "";
      })();
      // If the field is a variant-scoped size AND every variant carries a
      // non-empty size in its Shopify option, fall back to summarizing the
      // variant sizes so the inline panel reports the field as "ok" with a
      // value the operator can recognize ("34, 35, 36, 37, 38"). The push
      // payload uses the specific variant's size at send time.
      if (
        isVariantTargeted &&
        isSizeField &&
        currentValue.trim() === "" &&
        allVariantsHaveSize
      ) {
        currentValue = variantSizes.join(", ");
      }
      const invalid = invalidByField.get(f.field);
      const isInvalid = invalid !== undefined;
      const invalidValue = invalid ? invalid.value : "";
      const isMissing =
        currentValue.trim() === "" || currentValue.trim().toLowerCase() === "undefined";
      const status: "ok" | "missing" | "invalid" =
        isInvalid ? "invalid" : isMissing ? "missing" : "ok";
      return {
        field: f.field,
        required: f.required === true,
        type: f.type ?? "string",
        options: Array.isArray(f.options) ? f.options : [],
        options_unverified: f.options_unverified === true,
        multiple: f.multiple === true,
        min_value: f.min_value,
        max_value: f.max_value,
        only_integer: f.only_integer === true,
        min_length: f.min_length,
        max_length: f.max_length,
        isVariantTargeted,
        metafieldTarget: `${metaTarget.namespace}.${metaTarget.key}`,
        currentValue,
        invalidValue,
        status,
        needsRepair: isInvalid || (f.required === true && isMissing),
      };
    });
}

export function registerInlineFieldRepairRoutes(app: Express): void {
  /**
   * GET /api/jomashop/inline-field-repair/:productId
   *
   * Returns the live (or fallback) schema for the product's resolved category
   * plus the current per-field values so the UI can render schema-driven
   * inputs (Select for enums, Input for string/number) with the right
   * `options`, `required`, and validation hints — without having to run the
   * Excel exporter first.
   */
  app.get("/api/jomashop/inline-field-repair/:productId", async (req, res) => {
    const productId = String(req.params.productId || "");
    if (!productId) {
      return res.status(400).json({ ok: false, error: "Missing product id" });
    }
    try {
      const located = await findProductById(productId);
      let category = located.category || "";
      // First-pass map with no schema to get the resolved category. We then
      // load the live schema for that canonical category and re-map with the
      // full descriptors so the returned per-field status reflects what the
      // mapper actually emits (missing_required, invalid_enums, ...).
      let mappedProperties: Record<string, unknown> = {};
      let invalidEnums: Array<{ field: string; value: string; options: string[] }> = [];
      let variantOptionsByVariantId: Record<string, Record<string, string>> = {};
      if (located.product) {
        const tmp = mapShopifyToJomashop(located.product, []);
        category = tmp.category;
        for (const v of located.product.variants || []) {
          const id = String((v as any).id ?? "");
          if (!id) continue;
          const opts: Record<string, string> = {};
          const so = (v as any).selectedOptions || (v as any).options;
          if (Array.isArray(so)) {
            for (const o of so) {
              if (o && typeof o === "object" && o.name) opts[String(o.name)] = String(o.value ?? "");
            }
          } else if (so && typeof so === "object") {
            for (const [k, vv] of Object.entries(so)) opts[String(k)] = String(vv ?? "");
          }
          variantOptionsByVariantId[id] = opts;
        }
      }
      if (!category) {
        return res.status(404).json({ ok: false, error: "Product not found in connected Shopify store or cache." });
      }
      const canonical = canonicalJomashopCategory(category) as SupportedCategory;
      const live = await loadLiveSchemaForCategory(canonical);
      const fields = live.fields.filter(
        (f) => f && typeof f.field === "string" && f.field.trim() !== "" && f.field !== "undefined",
      );
      // Re-map with the live schema so the per-field status surfaced to the
      // UI matches the mapper's own missing_required / invalid_enums output —
      // this lets the inline panel render optional fields that are currently
      // missing AND invalid-enum fields with their offending values without
      // requiring the parent to also do the bookkeeping.
      if (located.product) {
        const mappedFull = mapShopifyToJomashop(
          located.product,
          fields,
          undefined,
          {
            resolveEnumOverride: (cat, field, sourceValue, acceptedOptions) => {
              const hit = lookupEnumOverride(cat, field, sourceValue, acceptedOptions);
              return hit ? hit.jomashopOption : null;
            },
          },
        );
        if (mappedFull.properties && typeof mappedFull.properties === "object") {
          mappedProperties = mappedFull.properties as Record<string, unknown>;
        }
        invalidEnums = Array.isArray((mappedFull as any).invalid_enums)
          ? ((mappedFull as any).invalid_enums as Array<{ field: string; value: string; options: string[] }>)
          : [];
      }
      return res.json({
        ok: true,
        productId,
        shopDomain: located.shopDomain,
        fromCache: located.fromCache,
        // Canonical Jomashop category — surfaced explicitly so the UI shows
        // "Apparel" when the Shopify product type was the legacy alias
        // "Clothing", instead of confusing the operator with a "not found
        // in /i1/categories: Clothing" warning.
        category: canonical,
        sourceCategory: category,
        categoryAliased: canonical !== category,
        schemaSource: live.source,
        fields: buildInlineRepairFieldDescriptors(
          fields,
          mappedProperties,
          invalidEnums,
          variantOptionsByVariantId,
        ),
        variantOptionsByVariantId,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  /**
   * POST /api/jomashop/inline-field-repair
   *
   * Body: {
   *   productId: string,
   *   category?: string,
   *   confirm: true,
   *   fields: [{ field, value, variantId? }],
   * }
   *
   * Validates each (field,value) against the live category schema, writes
   * valid ones to Shopify metafields (variant target for variant-scoped
   * fields like Size), and returns per-field results + the metafield
   * target each value was written to. Invalidates the product cache on
   * success so the next refresh picks up the new values.
   */
  app.post("/api/jomashop/inline-field-repair", async (req, res) => {
    const body = (req.body || {}) as {
      productId?: string;
      category?: string;
      confirm?: boolean;
      fields?: InlineRepairField[];
    };
    if (!body.confirm) {
      return res.status(400).json({
        ok: false,
        error: "Missing confirmation. Set `confirm: true` to write Shopify metafields.",
      });
    }
    if (!body.productId) {
      return res.status(400).json({ ok: false, error: "Missing productId." });
    }
    const fields = Array.isArray(body.fields) ? body.fields : [];
    if (fields.length === 0) {
      return res.status(400).json({ ok: false, error: "No fields supplied." });
    }
    // Reject obviously malformed entries up-front so the route never crashes.
    for (const f of fields) {
      if (!f || typeof f !== "object" || typeof f.field !== "string" || !f.field.trim()) {
        return res.status(400).json({ ok: false, error: "Each field entry must include a non-empty `field`." });
      }
      if (typeof (f as any).value !== "string" && typeof (f as any).value !== "number") {
        return res.status(400).json({ ok: false, error: `Field "${f.field}" missing string value.` });
      }
    }

    const conn = getActiveShopifyConnection();
    if (!conn) {
      return res.status(503).json({
        ok: false,
        error: "No connected Shopify store with an access token. Complete OAuth install first.",
      });
    }

    // Locate the product (live) so we can:
    //   - resolve the right category for schema lookup
    //   - find any existing source metafield to preserve namespace/key
    //   - pick a default variant id when a size field comes in without one
    const located = await findProductById(body.productId);
    const product = located.product;
    if (!product) {
      return res.status(404).json({ ok: false, error: "Product not found in connected Shopify store." });
    }
    const tmpMap = mapShopifyToJomashop(product, []);
    const resolvedCategoryRaw =
      (body.category && body.category.trim()) || tmpMap.category;
    const canonical = canonicalJomashopCategory(resolvedCategoryRaw) as SupportedCategory;

    // Load the live schema + descriptors. We resolve via `resolveCategorySchema`
    // to mirror the push route, then fall back to the bulk loader which also
    // tries v1/i1 and bundled fallback.
    const { schema } = await resolveCategorySchema(canonical).catch(() => ({ schema: undefined as any }));
    let descriptors: SchemaPropertyDescriptor[] =
      (schema && (schema as any).properties) ? ((schema as any).properties as SchemaPropertyDescriptor[]) : [];
    if (!descriptors || descriptors.length === 0) {
      const live = await loadLiveSchemaForCategory(canonical);
      descriptors = live.fields;
    }
    const descriptorByField = new Map<string, SchemaPropertyDescriptor>();
    for (const d of descriptors || []) {
      if (d && typeof d.field === "string") descriptorByField.set(d.field, d);
    }
    descriptorByField.set("Commercial Discount", {
      field: "Commercial Discount",
      required: true,
      type: "number",
      min_value: 0,
      max_value: 100,
    } as SchemaPropertyDescriptor);

    // First pass — collect validation errors so we never write a partial set
    // of values when validation fails on a sibling field.
    const validation: Array<{ field: string; error: string | null; fdef: SchemaPropertyDescriptor | undefined }> = [];
    for (const f of fields) {
      const fdef = descriptorByField.get(f.field);
      // Also try a case-insensitive match against descriptor labels so the
      // UI can submit canonical label even when the schema drifts.
      let resolved = fdef;
      if (!resolved) {
        const wanted = f.field.toLowerCase().trim();
        for (const [k, v] of Array.from(descriptorByField.entries())) {
          if (k.toLowerCase().trim() === wanted) { resolved = v; break; }
        }
      }
      // Apply enum operator-override resolution before validation: if the
      // operator has saved an enum override mapping that maps this source
      // value to a verified accepted option, accept the value.
      let valueForValidation = String(f.value ?? "");
      if (resolved && resolved.type === "enum" && Array.isArray(resolved.options)) {
        const override = lookupEnumOverride(canonical, resolved.field, valueForValidation, resolved.options);
        if (override) valueForValidation = override.jomashopOption;
      }
      const err = validateInlineFieldValue(resolved, valueForValidation);
      validation.push({ field: f.field, error: err, fdef: resolved });
    }
    const validationErrors = validation.filter((v) => v.error);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "One or more field values failed validation.",
        results: validation.map((v) => ({
          field: v.field,
          ok: false,
          validationError: v.error,
        })),
      });
    }

    // Pre-fetch first variant id once (for variant-scoped fields submitted
    // without a variantId). When the product has no variant, variant-scoped
    // fields are written to the product instead with a warning.
    const firstVariantId = product?.variants?.[0]?.id;

    // Second pass — write metafields. Use the same namespace/key strategy as
    // the bulk Excel apply: default `jomashop.<slug>` unless a source
    // metafield is already populated for the same field.
    const results: InlineRepairResult[] = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const fdef = validation[i].fdef;
      // Resolve a verified enum override for the writeback value too — we
      // store the canonical Jomashop label on Shopify so the next mapping
      // pass derives the field cleanly from the metafield.
      let value = String(f.value ?? "").trim();
      if (fdef && fdef.type === "enum" && Array.isArray(fdef.options)) {
        const override = lookupEnumOverride(canonical, fdef.field, value, fdef.options);
        if (override) value = override.jomashopOption;
      }
      const isVariant = fieldIsVariantTargeted(f.field);
      const target = deriveMetafieldTargetForProductField(f.field);
      const explicitVariant = f.variantId !== undefined && f.variantId !== null && String(f.variantId).trim() !== "";
      let ownerType: "product" | "variant" = "product";
      let ownerId = "";
      if (isVariant) {
        const vid = explicitVariant ? f.variantId : firstVariantId;
        if (vid !== undefined && vid !== null && String(vid).trim() !== "") {
          ownerType = "variant";
          ownerId = ownerIdForVariant(vid);
        } else {
          ownerId = ownerIdForProduct(product.id ?? body.productId);
          ownerType = "product";
        }
      } else {
        ownerId = ownerIdForProduct(product.id ?? body.productId);
      }
      const write = await writeMetafield(conn, ownerId, target.namespace, target.key, value);
      results.push({
        field: f.field,
        ok: write.ok,
        ownerType,
        ownerId,
        namespace: target.namespace,
        key: target.key,
        metafieldTarget: `${target.namespace}.${target.key}`,
        error: write.ok ? null : write.error,
        validationError: null,
      });
    }

    const allOk = results.every((r) => r.ok);

    // After writeback, recompute the mapping for this product so the caller
    // can immediately tell whether it is now push-ready, without paying for a
    // full /api/products/refresh round-trip. Best-effort: failures here are
    // not fatal — the writes already happened, the operator can refresh.
    let postRepair:
      | {
          missing_required: string[];
          missing_top_level: string[];
          invalid_enums: Array<{ field: string; value: string; options: string[] }>;
          push_ready: boolean;
          /** Full compact mapped product after re-running the mapper with the
           *  fresh metafield values. Returned so the Products page can splice
           *  this row into its in-memory list without waiting for a full
           *  /api/products/refresh — fields disappear, category-properties
           *  grid + warnings update, and the Push button enables immediately. */
          product?: CompactMappedProduct;
        }
      | null = null;
    let remappedCompact: CompactMappedProduct | null = null;
    try {
      // Re-fetch the now-updated product so the metafields read includes the
      // values we just wrote, then re-map against the live schema.
      const refetched = await findProductById(body.productId);
      const fresh = refetched.product;
      if (fresh) {
        // Hydrate full image list before remapping so the readiness signal is
        // consistent with what the push route uses.
        try {
          const detail = await fetchShopifyProductImages(String((fresh as any).id));
          if (detail && detail.images.length > 0) {
            const seen = new Set<string>();
            const merged: Array<{ src: string; alt?: string | null }> = [];
            for (const img of detail.images) {
              if (seen.has(img.src)) continue;
              seen.add(img.src);
              merged.push({ src: img.src, alt: img.alt });
            }
            (fresh as any).images = merged;
          }
        } catch { /* non-fatal */ }
        const mapped = mapShopifyToJomashop(fresh, descriptors as any, undefined, {
          resolveEnumOverride: (cat, field, sourceValue, acceptedOptions) => {
            const hit = lookupEnumOverride(cat, field, sourceValue, acceptedOptions);
            return hit ? hit.jomashopOption : null;
          },
        });
        const missingRequired = Array.isArray((mapped as any).missing_required)
          ? ((mapped as any).missing_required as string[]).filter((n) => n && n !== "undefined")
          : [];
        const missingTopLevel = Array.isArray((mapped as any).missing_top_level)
          ? ((mapped as any).missing_top_level as string[]).filter((n) => n && n !== "undefined")
          : [];
        const remappedInvalidEnums = Array.isArray((mapped as any).invalid_enums)
          ? ((mapped as any).invalid_enums as Array<{ field: string; value: string; options: string[] }>)
          : [];
        // Schema source detection: matches the buildPreview heuristic — if
        // the property descriptors carry exact-case labels (any uppercase
        // letter or whitespace in the field name) we treat the schema as
        // live; otherwise it came from the bundled fallback set.
        const schemaSource: "live-i1" | "live-v1" | "fallback" | "none" =
          descriptors.some(
            (d: any) =>
              d && typeof d.field === "string" && (/[A-Z]/.test(d.field) || /\s/.test(d.field)),
          )
            ? "live-i1"
            : descriptors.length > 0
              ? "fallback"
              : "none";
        const schemaLoaded = descriptors.some(
          (d: any) =>
            d && typeof d.field === "string" && d.field.trim() !== "" && d.field !== "undefined",
        );
        const hasUndefinedProp = Object.entries(
          ((mapped as any).properties ?? {}) as Record<string, unknown>,
        ).some(
          ([k, v]) =>
            !k ||
            k === "undefined" ||
            v === undefined ||
            (typeof v === "string" && (v as string).trim().toLowerCase() === "undefined"),
        );
        // Pull the latest push-status row so the compact projection keeps any
        // prior pushed/rejected metadata (the UI uses these to label the row).
        const pushStatus = (() => {
          try {
            const all = storage.listPushStatuses(conn.shopDomain);
            return all.find(
              (ps) =>
                ps.shopifySku &&
                ps.shopifySku === ((mapped as any).vendor_sku as string),
            );
          } catch {
            return undefined;
          }
        })();
        const enriched: any = {
          ...mapped,
          push_state: pushStatus?.state ?? "not_pushed",
          jomashop_sku: pushStatus?.jomashopSku ?? null,
          last_push_error: pushStatus?.lastError ?? null,
          last_pushed_at: pushStatus?.lastPushedAt ?? null,
          last_invalid_params: (() => {
            if (!pushStatus?.lastInvalidParams) return null;
            try {
              const parsed = JSON.parse(pushStatus.lastInvalidParams);
              return Array.isArray(parsed) ? parsed.map(String) : null;
            } catch {
              return null;
            }
          })(),
          last_rejected_category: pushStatus?.lastRejectedCategory ?? null,
          last_rejected_brand: pushStatus?.lastRejectedBrand ?? null,
          schema_source: schemaSource,
          schema_fields: descriptors
            .filter(
              (d: any) =>
                d && typeof d.field === "string" && d.field.trim() !== "" && d.field !== "undefined",
            )
            .map((d: any) => ({ field: String(d.field), required: Boolean(d.required) })),
          readiness: (() => {
            // Don't override an existing rejection — the operator still needs
            // to acknowledge that the next push will use new fields.
            if ((mapped as any).is_sample) return "sample";
            if (!schemaLoaded) return "needs-category-verification";
            if ((mapped as any).ambiguous_category) return "needs-category-verification";
            if (
              missingTopLevel.length > 0 ||
              missingRequired.length > 0 ||
              remappedInvalidEnums.length > 0 ||
              hasUndefinedProp
            ) {
              return "missing";
            }
            return "ready";
          })(),
        };
        remappedCompact = compactifyMapped(enriched);
        postRepair = {
          missing_required: missingRequired,
          missing_top_level: missingTopLevel,
          invalid_enums: remappedInvalidEnums,
          push_ready:
            missingRequired.length === 0 &&
            missingTopLevel.length === 0 &&
            remappedInvalidEnums.length === 0,
          product: remappedCompact,
        };
      }
    } catch {
      // Best-effort — caller can call /api/products/refresh manually.
    }

    // Update the cache in place — replace the matching mapped row with the
    // freshly remapped one — so a page refresh shows the repaired state
    // without paying for a full /api/products/refresh. If we have no
    // remapped row (live fetch failed) we fall back to clearing the cache so
    // the next refresh re-derives.
    try {
      if (remappedCompact) {
        const existing = storage.getProductCache(conn.shopDomain);
        if (existing) {
          let payload: any;
          try { payload = JSON.parse(existing.payloadJson); } catch { payload = null; }
          if (payload && Array.isArray(payload.mapped)) {
            const targetPid = String(body.productId);
            let replaced = false;
            payload.mapped = payload.mapped.map((m: any) => {
              const pid = String(m?.source?.shopify_product_id ?? "");
              if (pid === targetPid) {
                replaced = true;
                return remappedCompact;
              }
              return m;
            });
            if (replaced) {
              storage.upsertProductCache({
                shopDomain: conn.shopDomain,
                fetchedCount: existing.fetchedCount,
                pageCount: existing.pageCount,
                hasMore: existing.hasMore,
                payloadJson: JSON.stringify(payload),
                fetchedAt: Date.now(),
              });
            } else {
              // Product wasn't in the cache slice — clear so next refresh
              // picks up the new values rather than serving stale rows.
              storage.clearProductCache(conn.shopDomain);
            }
          } else {
            storage.clearProductCache(conn.shopDomain);
          }
        }
      } else {
        storage.clearProductCache(conn.shopDomain);
      }
    } catch {
      // non-fatal — the writeback already succeeded.
    }

    storage.appendLog({
      level: allOk ? "info" : "warn",
      message: `Inline field repair: ${results.filter((r) => r.ok).length}/${results.length} metafield writes succeeded for product ${body.productId}`,
      detailsJson: JSON.stringify({
        productId: body.productId,
        category: canonical,
        results: results.map((r) => ({
          field: r.field,
          ok: r.ok,
          ownerType: r.ownerType,
          metafieldTarget: r.metafieldTarget,
          error: r.error,
        })),
      }),
      createdAt: Date.now(),
    });

    return res.json({
      ok: allOk,
      productId: body.productId,
      category: canonical,
      shopDomain: conn.shopDomain,
      results,
      cacheInvalidatedFor: conn.shopDomain,
      postRepair,
      note: allOk
        ? "Applied. The product cache was invalidated; click Refresh from Shopify to recompute readiness across the catalog."
        : "Some metafield writes failed. See results for details.",
    });
  });
}
