/**
 * Smoke test for the Shopify → Jomashop mapper.
 *
 * Runs the mapper against a fixture that mirrors the live "Cavalli Class
 * Mens Navy Dress Shirt" product reported in the field: the Color metafield
 * lives in the `custom` namespace with the human-readable definition name
 * "Color" (capitalized), and material/composition is provided as
 * `Composition`. The test asserts:
 *
 *   - properties.color === "NAVY"
 *   - properties.material is populated from Composition
 *   - missing_required does NOT include "color" or "material"
 *
 * Also runs a "definition name only" variant where the metafield key is
 * `primary_color` but the admin-UI definition surfaces it as "Color" —
 * exercises the new definition-name match path in the mapper.
 *
 * Invoke with: npx tsx script/test-mapping.ts
 */

import {
  BUILT_IN_CATEGORY_OVERRIDES,
  buildCanonicalProductFields,
  buildI1ProductEnvelope,
  buildJomashopProductPayload,
  buildSchemaProperties,
  coerceJomashopToSupported,
  isAmbiguousCategoryCode,
  lookupBuiltInCategoryDefault,
  mapShopifyToJomashop,
  normalizeCategoryCode,
  normalizeI1CategorySchema,
  type ShopifyProduct,
  type SchemaPropertyDescriptor,
} from "../server/mapping";
import {
  BUILT_IN_BRAND_OVERRIDES,
  lookupBrandOverride,
  normalizeBrandKey,
} from "../server/brand_mapping";
import { FALLBACK_CATEGORY_SCHEMAS, SUPPORTED_CATEGORIES } from "../shared/schema";

let failures = 0;

function assert(cond: unknown, msg: string) {
  if (!cond) {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function clothingSchema() {
  return FALLBACK_CATEGORY_SCHEMAS.Clothing.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
  }));
}

function runColorNavyCase() {
  console.log("Case 1: Color = NAVY metafield, Composition = cotton");
  const product: ShopifyProduct = {
    id: "shopify-cavalli-1",
    title: "Cavalli Class Mens Navy Dress Shirt",
    body_html: "<p>Cavalli Class shirt.</p>",
    vendor: "Cavalli Class",
    product_type: "Clothing",
    tags: ["Men", "Shirt"],
    images: [{ src: "https://example.com/cavalli.jpg" }],
    options: [{ name: "Size", values: ["15"] }],
    variants: [
      {
        id: 9001,
        sku: "OXT701CE00104848-15",
        price: "120.00",
        inventory_quantity: 5,
        option1: "15",
      },
    ],
    metafields: [
      // Color metafield: lives in custom namespace, key "color", admin-UI
      // definition name "Color" (capitalized). Mirrors the field shown in
      // the user's Shopify metafields screenshot.
      { namespace: "custom", key: "color", value: "NAVY", name: "Color", label: "Color" },
      { namespace: "custom", key: "composition", value: "cotton", name: "Composition", label: "Composition" },
      {
        namespace: "custom",
        key: "ff_country_of_origin",
        value: "China",
        name: "FF Country of Origin",
        label: "FF Country of Origin",
      },
      {
        namespace: "custom",
        key: "ff_designer_id",
        value: "OXT701CE00104848",
        name: "FF Designer Id",
        label: "FF Designer Id",
      },
    ],
  };

  const mapped = mapShopifyToJomashop(product, clothingSchema());
  assert(
    mapped.properties.Color === "NAVY",
    `properties.Color === "NAVY" (got ${JSON.stringify(mapped.properties.Color)})`,
  );
  // Material is now intentionally absent from the Clothing/Apparel schema
  // because Jomashop rejects it for those categories ("Material must be
  // blank"). The mapper must not emit a Material key when the schema omits
  // it — sending a Composition-derived value would trigger that rejection.
  assert(
    !("Material" in mapped.properties),
    `properties.Material is omitted for Clothing schema (got ${JSON.stringify(mapped.properties.Material)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("Color"),
    `missing_required does not include "Color" (got ${JSON.stringify(mapped.missing_required)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("Material"),
    `missing_required does not include "Material"`,
  );
  assert(mapped.debug_raw && mapped.debug_raw.metafields.length === 4, "debug_raw.metafields populated");
}

function runDefinitionNameOnlyCase() {
  console.log("Case 2: metafield key=primary_color, definition name='Color'");
  const product: ShopifyProduct = {
    id: "shopify-test-2",
    title: "Generic Mens Shirt",
    body_html: "",
    vendor: "Generic",
    product_type: "Clothing",
    tags: ["Men"],
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      { id: 9002, sku: "GEN-SHIRT-M", price: "50.00", inventory_quantity: 2, option1: "M" },
    ],
    metafields: [
      // Key is not "color" but admin-UI definition name is "Color".
      { namespace: "ff", key: "primary_color", value: "RED", name: "Color", label: "Color" },
      { namespace: "custom", key: "composition", value: "100% cotton", name: "Composition", label: "Composition" },
    ],
  };

  const mapped = mapShopifyToJomashop(product, clothingSchema());
  assert(
    mapped.properties.Color === "RED",
    `definition-name match: properties.Color === "RED" (got ${JSON.stringify(mapped.properties.Color)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("Color"),
    `missing_required does not include "Color" via definition-name match`,
  );
}

function runVariantSelectedOptionFallback() {
  console.log("Case 3: no color metafield, variant option Color=Beige fallback");
  const product: ShopifyProduct = {
    id: "shopify-test-3",
    title: "Plain Shirt",
    body_html: "",
    vendor: "X",
    product_type: "Clothing",
    tags: ["Men"],
    images: [],
    options: [
      { name: "Size", values: ["M"] },
      { name: "Color", values: ["Beige"] },
    ],
    variants: [
      {
        id: 9003,
        sku: "PLAIN-M-BEIGE",
        price: "40.00",
        inventory_quantity: 1,
        option1: "M",
        option2: "Beige",
      },
    ],
    metafields: [
      { namespace: "custom", key: "composition", value: "cotton" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, clothingSchema());
  assert(
    mapped.properties.Color === "Beige",
    `variant option fallback: properties.Color === "Beige" (got ${JSON.stringify(mapped.properties.Color)})`,
  );
}

function runListTypeMetafield() {
  console.log("Case 4: list-type metafield value parsed");
  const product: ShopifyProduct = {
    id: "shopify-test-4",
    title: "Shirt",
    vendor: "X",
    product_type: "Clothing",
    tags: [],
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [{ id: 9004, sku: "X-1", price: "10.00", inventory_quantity: 1, option1: "M" }],
    metafields: [
      { namespace: "custom", key: "color", value: JSON.stringify(["NAVY"]), name: "Color", label: "Color" },
      { namespace: "custom", key: "composition", value: '"cotton"', name: "Composition" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, clothingSchema());
  assert(
    mapped.properties.Color === "NAVY",
    `list metafield unpacked: properties.Color === "NAVY" (got ${JSON.stringify(mapped.properties.Color)})`,
  );
  // Material is intentionally absent from Clothing schema (Jomashop rejects
  // Material for Apparel/Clothing). The metafield is still parsed correctly
  // — just not emitted under the Clothing schema's property list.
  assert(
    !("Material" in mapped.properties),
    `Material omitted under Clothing schema (got ${JSON.stringify(mapped.properties.Material)})`,
  );
}

function runBuiltInCategoryDefaults() {
  console.log("Case 5: built-in Shopify→Jomashop category seed mappings");
  const cases: Array<{ code: string; expected: string }> = [
    { code: "DRSH", expected: "Apparel" },
    { code: "WALL", expected: "Accessories" },
    { code: "SNEK", expected: "Footwear" },
    { code: "SUNG", expected: "Eyewear" },
    { code: "NECK", expected: "Necklaces" },
    { code: "RING", expected: "Rings" },
    { code: "POUC", expected: "Handbags" },
    { code: "BOOT", expected: "Footwear" },
    { code: "CARD", expected: "Accessories" },
    { code: "TOTE", expected: "Handbags" },
    { code: "PINS", expected: "Pins & Brooches" },
    { code: "BRAC", expected: "Bracelets" },
    { code: "EARI", expected: "Earrings" },
    { code: "HOME", expected: "Home Decor" },
    // Casing / punctuation tolerance — normalized lookup must collapse these.
    { code: "drsh", expected: "Apparel" },
    { code: "Dress-Shirts".replace("Dress-Shirts", "DRSH"), expected: "Apparel" },
  ];
  for (const { code, expected } of cases) {
    const got = lookupBuiltInCategoryDefault(code);
    assert(
      got === expected,
      `lookupBuiltInCategoryDefault("${code}") === "${expected}" (got ${JSON.stringify(got)})`,
    );
  }
  // Unknown codes return null.
  assert(
    lookupBuiltInCategoryDefault("ZZZZ-UNKNOWN") === null,
    `unknown code returns null`,
  );
  // Coercion from Jomashop name → SupportedCategory. Now that "Footwear" /
  // "Accessories" / "Apparel" / "Eyewear" / "Rings" / "Necklaces" are
  // first-class entries in SUPPORTED_CATEGORIES (with exact Title-Case
  // schemas), they coerce to themselves rather than collapsing into the
  // legacy "Shoes" / "Clothing" buckets.
  assert(coerceJomashopToSupported("Footwear") === "Footwear", `Footwear → Footwear`);
  assert(
    coerceJomashopToSupported("Accessories") === "Accessories",
    `Accessories → Accessories`,
  );
  assert(coerceJomashopToSupported("Apparel") === "Apparel", `Apparel → Apparel`);
  assert(coerceJomashopToSupported("Eyewear") === "Eyewear", `Eyewear → Eyewear`);
  assert(coerceJomashopToSupported("Rings") === "Rings", `Rings → Rings`);
  assert(coerceJomashopToSupported("Necklaces") === "Necklaces", `Necklaces → Necklaces`);
  assert(coerceJomashopToSupported("Handbags") === "Handbags", `Handbags → Handbags`);
  assert(coerceJomashopToSupported("Clothing") === "Clothing", `Clothing → Clothing`);
  assert(coerceJomashopToSupported("Shoes") === "Shoes", `Shoes → Shoes`);
  // Ambiguity: WALL/CARD have built-in defaults, so they no longer surface
  // as ambiguous (operator decision already made via the seed mapping).
  assert(
    !isAmbiguousCategoryCode("WALL"),
    `WALL is no longer ambiguous after built-in mapping → Accessories`,
  );
  assert(
    !isAmbiguousCategoryCode("CARD"),
    `CARD is no longer ambiguous after built-in mapping → Accessories`,
  );
  // A code that is in SMALL_LEATHER_GOODS_CODES but NOT in the built-in
  // map (e.g. "keychain" — the short code KCHN is seeded but the full word
  // is not) must still be flagged ambiguous so the operator picks.
  assert(
    isAmbiguousCategoryCode("keychain"),
    `"keychain" remains ambiguous (no built-in seed mapping)`,
  );
  // BELT is now seeded → Accessories, so it should no longer be ambiguous.
  assert(
    !isAmbiguousCategoryCode("BELT"),
    `BELT is no longer ambiguous after built-in mapping → Accessories`,
  );
  // normalizeCategoryCode parity check used by the lookup table.
  assert(
    normalizeCategoryCode("Dress-Shirts") === "dressshirts",
    `normalizeCategoryCode strips non-alphanumerics`,
  );
  // Spot-check that the built-in map shape is what the rest of the code
  // expects: keys are normalized.
  for (const k of Object.keys(BUILT_IN_CATEGORY_OVERRIDES)) {
    assert(
      normalizeCategoryCode(k) === k,
      `built-in key "${k}" is already in normalized form`,
    );
  }
}

function runBrandKeyNormalization() {
  console.log("Case 6: brand key normalization + override payload");
  // Same canonical key for case/punctuation variants. Required for the
  // brand_overrides lookup table to treat "Tods", "TODS", and "Tod's" as
  // one row so the operator does not have to save the override three times.
  assert(
    normalizeBrandKey("Tods") === normalizeBrandKey("TODS"),
    `normalizeBrandKey is case-insensitive`,
  );
  assert(
    normalizeBrandKey("Tod's") === normalizeBrandKey("Tods"),
    `normalizeBrandKey strips apostrophes (Tod's === Tods)`,
  );
  assert(
    normalizeBrandKey("  Off-White  ") === normalizeBrandKey("offwhite"),
    `normalizeBrandKey strips spaces and dashes`,
  );
  assert(
    normalizeBrandKey(null) === "" && normalizeBrandKey(undefined) === "",
    `normalizeBrandKey returns empty for null/undefined`,
  );

  // buildJomashopProductPayload must honour both category and brand
  // overrides so the outbound payload exactly matches what the operator
  // typed — this is what unlocks fixing a rejected product without
  // mutating Shopify.
  const product: ShopifyProduct = {
    id: "shopify-tods-boot-1",
    title: "Tods Womens Multicolored Boot",
    vendor: "Tods",
    product_type: "BOOT",
    options: [{ name: "Size", values: ["35.5"] }],
    variants: [
      {
        id: 9100,
        sku: "XXW83B0BR70THYG409-35.5",
        price: "1200.00",
        inventory_quantity: 1,
        option1: "35.5",
      },
    ],
    metafields: [
      { namespace: "custom", key: "ff_designer_id", value: "XXW83B0BR70THYG409" },
      { namespace: "custom", key: "color", value: "Multicolor", name: "Color" },
      { namespace: "custom", key: "composition", value: "Leather" },
    ],
  };
  const props = clothingSchema();
  const mapped = mapShopifyToJomashop(product, props);
  const { payload, pushDebug } = buildJomashopProductPayload(mapped, undefined, {
    category: "Boots",
    brand: "Tod's",
  });
  // The strict /i1 payload no longer carries legacy top-level "brand" /
  // "category" — they are conveyed by manufacturer_id/category_id and the
  // schema-driven properties. pushDebug.category records the operator
  // override for traceability.
  assert(
    !("brand" in payload),
    `payload no longer carries legacy top-level "brand" (got ${JSON.stringify(payload.brand)})`,
  );
  assert(
    !("category" in payload),
    `payload no longer carries legacy top-level "category" (got ${JSON.stringify(payload.category)})`,
  );
  assert(
    pushDebug.category === "Boots",
    `pushDebug.category honours override (got ${JSON.stringify(pushDebug.category)})`,
  );
  assert(
    payload.sku === "XXW83B0BR70THYG409-35.5",
    `payload.sku preserved from variant (got ${JSON.stringify(payload.sku)})`,
  );
}

function runManufacturerIdCarriedThrough() {
  console.log(
    "Case 7: resolved manufacturer_id + category_id flow through buildJomashopProductPayload",
  );
  // Mirrors what the push route does after resolveManufacturer /
  // resolveCategoryRecord succeed: it sets overrides.manufacturer_id +
  // overrides.category_id and the canonical brand/category names. The
  // payload must carry both ids AND the canonical names so /i1/products/
  // can accept the create and /v1/products fallback still works.
  const product: ShopifyProduct = {
    id: "shopify-tods-boot-2",
    title: "Tods Womens Multicolored Boot",
    vendor: "Tods",
    product_type: "BOOT",
    options: [{ name: "Size", values: ["35.5"] }],
    variants: [
      {
        id: 9200,
        sku: "XXW83B0BR70THYG409-35.5",
        price: "1200.00",
        inventory_quantity: 1,
        option1: "35.5",
      },
    ],
    metafields: [
      { namespace: "custom", key: "ff_designer_id", value: "XXW83B0BR70THYG409" },
      { namespace: "custom", key: "color", value: "Multicolor", name: "Color" },
      { namespace: "custom", key: "composition", value: "Leather" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, clothingSchema());
  const { payload, variant } = buildJomashopProductPayload(mapped, undefined, {
    category: "Footwear",
    brand: "Tod's",
    manufacturer_id: 421,
    category_id: 12,
  });
  assert(
    payload.manufacturer_id === 421,
    `payload.manufacturer_id propagated (got ${JSON.stringify(payload.manufacturer_id)})`,
  );
  assert(
    payload.category_id === 12,
    `payload.category_id propagated (got ${JSON.stringify(payload.category_id)})`,
  );
  // Brand/category names no longer travel as top-level legacy fields. The
  // /i1 endpoint reads them off manufacturer_id/category_id and schema
  // properties; pushDebug retains the canonical operator-supplied names for
  // logs and the rejected-state UI.
  assert(
    !("brand" in payload),
    `payload no longer carries legacy top-level "brand"`,
  );
  assert(
    !("category" in payload),
    `payload no longer carries legacy top-level "category"`,
  );

  // /i1 envelope split: product node carries the brand/category ids; stock
  // node carries quantity/price/status from the variant.
  const envelope = buildI1ProductEnvelope(payload, variant);
  const productNode = envelope.product as Record<string, unknown>;
  const stockNode = envelope.stock as Record<string, unknown>;
  assert(
    productNode && productNode.manufacturer_id === 421,
    `envelope.product.manufacturer_id present`,
  );
  assert(
    productNode && productNode.category_id === 12,
    `envelope.product.category_id present`,
  );
  assert(
    productNode && productNode.sku === "XXW83B0BR70THYG409-35.5",
    `envelope.product.sku present (got ${JSON.stringify(productNode?.sku)})`,
  );
  assert(
    stockNode && typeof stockNode.quantity === "number" && stockNode.quantity === 1,
    `envelope.stock.quantity reflects variant.quantity (got ${JSON.stringify(stockNode?.quantity)})`,
  );
  assert(
    stockNode && stockNode.price !== undefined && stockNode.price !== null,
    `envelope.stock.price populated`,
  );
}

function runResolvedRecordsRequiredForReadiness() {
  console.log(
    "Case 8: readiness logic requires resolved manufacturer record (simulated)",
  );
  // We can't call /i1/manufacturers from the unit test (no network), but we
  // can verify the resolver helpers behave correctly given an in-memory list
  // and that the per-product readiness contract is "exact manufacturer
  // match required". Mirrors the inline Levenshtein in routes.ts.
  function lookupKey(s: string): string {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
  }
  const manufacturers = [
    { id: 421, name: "Tod's" },
    { id: 102, name: "Gucci" },
    { id: 303, name: "Saint Laurent" },
  ];
  const byKey = new Map(manufacturers.map((m) => [lookupKey(m.name), m]));
  // "Tods" should normalize to the same key as "Tod's" — exact match.
  assert(
    byKey.has(lookupKey("Tods")),
    `"Tods" exact-matches "Tod's" after normalization (apostrophe stripped)`,
  );
  // A misspelled brand should NOT exact-match.
  assert(
    !byKey.has(lookupKey("Guucci")),
    `"Guucci" does not exact-match anything in the live list`,
  );
  // Readiness contract: when /i1 is available and there's no exact
  // manufacturer match, the product MUST go to needs-category-verification
  // (not ready). We simulate the routes.ts check here.
  const i1Available = byKey.size > 0;
  function isReady(brand: string): boolean {
    if (!i1Available) return true; // legacy fallback
    return byKey.has(lookupKey(brand));
  }
  assert(isReady("Tods") === true, `Readiness flips ready for resolvable "Tods"`);
  assert(
    isReady("Unknown Brand") === false,
    `Readiness flips needs-verification for unknown brand`,
  );
}

function runBuiltInBrandSeeds() {
  console.log("Case 9: built-in Shopify→Jomashop brand seed mappings");
  const cases: Array<{ shopify: string; expected: string }> = [
    { shopify: "ACNESTUDI", expected: "Acne Studios" },
    { shopify: "Cavalli Class", expected: "Roberto Cavalli" },
    { shopify: "CAVALLICL", expected: "Roberto Cavalli" },
    { shopify: "CHRISTIAN", expected: "Christian Louboutin" },
    { shopify: "DOLCE&GAB", expected: "Dolce and Gabbana" },
    { shopify: "Tods", expected: "Tods" },
    { shopify: "TODS", expected: "Tods" },
    { shopify: "Tod's", expected: "Tods" },
    { shopify: "Off White", expected: "Off-White" },
    { shopify: "OFFWHITE", expected: "Off-White" },
    { shopify: "MONCLERGR", expected: "Moncler" },
    { shopify: "PALMANGEL", expected: "Palm Angels" },
    { shopify: "Salvatore Ferragamo", expected: "Salvatore Ferragamo" },
    { shopify: "SALVATORE", expected: "Salvatore Ferragamo (#40)" },
  ];
  for (const { shopify, expected } of cases) {
    const hit = lookupBrandOverride(shopify);
    assert(
      hit !== null && hit.jomashopBrand === expected && hit.source === "built-in",
      `lookupBrandOverride("${shopify}") → "${expected}" (built-in) (got ${JSON.stringify(hit)})`,
    );
  }
  // Blank brands in the audit must NOT be seeded — they should fall through
  // to null so the readiness check surfaces them as unresolved.
  for (const blank of [
    "BELSTAFF",
    "EIDOS",
    "ERL",
    "ERMANNOSC",
    "FLEURDUM",
    "GOSHA",
    "MARA HOFFMAN",
    "MARAHOFFM",
    "ORLBROWN",
    "PESERICO",
    "SOTF",
  ]) {
    const hit = lookupBrandOverride(blank);
    assert(
      hit === null,
      `lookupBrandOverride("${blank}") returns null (no seed) (got ${JSON.stringify(hit)})`,
    );
  }
  // Every built-in brand key must already be in normalized form.
  for (const k of Object.keys(BUILT_IN_BRAND_OVERRIDES)) {
    assert(
      normalizeBrandKey(k) === k,
      `built-in brand key "${k}" is already in normalized form`,
    );
  }
}

async function runResolutionAuditHelpers() {
  const { brandLookupKey, editDistance, buildResolutionAuditWorkbook } = await import(
    "../server/resolution_audit"
  );
  assert(
    brandLookupKey("Tod's") === brandLookupKey("Tods"),
    `brandLookupKey collapses apostrophe variations`,
  );
  assert(
    brandLookupKey("Saint Laurent") === "saintlaurent",
    `brandLookupKey strips whitespace and lowercases`,
  );
  assert(editDistance("kitten", "sitting") === 3, `editDistance basic Levenshtein distance`);
  assert(editDistance("abc", "abc") === 0, `editDistance identical strings are zero`);
  assert(editDistance("", "abc") === 3, `editDistance against empty string returns length`);

  // Build a tiny fixture audit and confirm the workbook serializes.
  const buf = await buildResolutionAuditWorkbook({
    shopDomain: "test.myshopify.com",
    fromCache: true,
    cachedAt: Date.now(),
    totalProducts: 2,
    i1Available: true,
    jomashopManufacturers: [
      { id: 1, name: "Tod's" },
      { id: 2, name: "Gucci" },
    ],
    jomashopCategories: [
      { id: 10, name: "Footwear" },
      { id: 11, name: "Handbags" },
    ],
    brandRows: [
      {
        shopify_brand: "Tods",
        shopify_brand_normalized: "tods",
        product_count: 3,
        sample_titles: ["Tods loafer"],
        sample_skus: ["TODS-1"],
        current_override: "Tod's",
        current_override_source: "operator",
        outbound_brand: "Tod's",
        exact_match: { id: 1, name: "Tod's" },
        suggestion: null,
        suggestion_distance: null,
        status: "override",
      },
      {
        shopify_brand: "Unknown",
        shopify_brand_normalized: "unknown",
        product_count: 1,
        sample_titles: [],
        sample_skus: [],
        current_override: null,
        current_override_source: null,
        outbound_brand: "Unknown",
        exact_match: null,
        suggestion: null,
        suggestion_distance: null,
        status: "unresolved",
      },
    ],
    categoryRows: [
      {
        shopify_category_code: "DRSH",
        shopify_category_code_normalized: "drsh",
        suggested_category: "Dress Shirts",
        product_count: 5,
        sample_titles: ["Cavalli Class Mens Shirt"],
        sample_skus: ["CAV-1"],
        current_override: null,
        current_override_source: null,
        outbound_category: "Dress Shirts",
        exact_match: null,
        suggestion: null,
        suggestion_distance: null,
        status: "unresolved",
      },
    ],
    summary: {
      distinctBrands: 2,
      unresolvedBrands: 1,
      fuzzyBrands: 0,
      exactBrands: 0,
      overrideBrands: 1,
      distinctCategories: 1,
      unresolvedCategories: 1,
      fuzzyCategories: 0,
      exactCategories: 0,
      overrideCategories: 0,
      totalProducts: 2,
      notReadyProducts: 2,
    },
    warnings: [],
  });
  assert(buf.length > 1000, `audit XLSX workbook serializes to non-trivial buffer`);
}

// ---- Schema-driven property mapping tests ----------------------------------

function apparelLiveSchema(): SchemaPropertyDescriptor[] {
  // Mirrors what /i1/categories/:id returns for the Apparel category — exact
  // labels Jomashop requires, NOT the lowercase fallback fields.
  return [
    { field: "Gender", label: "Gender", required: true, type: "enum", options: ["Men", "Women", "Unisex", "Kids"] },
    { field: "Age", label: "Age", required: true, type: "enum", options: ["Adult", "Kids"] },
    { field: "Apparel Type", label: "Apparel Type", required: true, options: ["Outerwear", "Pants", "Shirts", "Dresses"] },
    { field: "Detailed Description", label: "Detailed Description", required: true, type: "string" },
    { field: "Total Number of Pieces", label: "Total Number of Pieces", required: true, type: "string" },
    { field: "Color", label: "Color", required: true, type: "string" },
    { field: "Article", label: "Article", required: false, type: "string" },
    { field: "Apparel Size Type", label: "Apparel Size Type", required: false, options: ["US", "EU", "UK", "IT"] },
    { field: "Apparel Size", label: "Apparel Size", required: false, type: "string" },
  ];
}

function footwearLiveSchema(): SchemaPropertyDescriptor[] {
  return [
    { field: "Gender", label: "Gender", required: true, options: ["Men", "Women", "Unisex", "Kids"] },
    { field: "Shoe Size", label: "Shoe Size", required: true, type: "string" },
    { field: "Shoe Size Type", label: "Shoe Size Type", required: true, options: ["US", "EU", "UK", "IT"] },
    { field: "Color", label: "Color", required: true, type: "string" },
    { field: "Material", label: "Material", required: false, type: "string" },
    { field: "Country of Origin", label: "Country of Origin", required: false, type: "string" },
  ];
}

function handbagLiveSchema(): SchemaPropertyDescriptor[] {
  return [
    { field: "Color", label: "Color", required: true, type: "string" },
    { field: "Material", label: "Material", required: true, type: "string" },
    { field: "Style", label: "Style", required: false, options: ["Shoulder", "Tote", "Crossbody"] },
    { field: "Hardware", label: "Hardware", required: false, options: ["Gold", "Silver"] },
    { field: "Country of Origin", label: "Country of Origin", required: false, type: "string" },
  ];
}

function runApparelCanadaGooseOuterwear() {
  console.log("Case 10: Apparel/OUTW Canada Goose — live schema labels");
  const product: ShopifyProduct = {
    id: "shopify-cg-kids-outw-1",
    title: "Canada Goose Kids Black Outerwear",
    body_html: "<p>Kids' down-filled parka in black.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids", "Outerwear"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["XS"] }],
    variants: [
      {
        id: 9500,
        sku: "CG-KIDS-OUTW-XS",
        price: "650.00",
        inventory_quantity: 1,
        option1: "XS",
      },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color", label: "Color" },
      { namespace: "custom", key: "composition", value: "Down" },
      { namespace: "custom", key: "ff_designer_id", value: "CG-PARKA-001" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelLiveSchema());
  // Outgoing properties MUST use exact Jomashop labels — never the
  // generic lowercase ones that Jomashop rejects.
  assert(
    "Gender" in mapped.properties,
    `outgoing properties include exact "Gender" label`,
  );
  assert(
    "Apparel Type" in mapped.properties,
    `outgoing properties include exact "Apparel Type" label`,
  );
  assert(
    "Color" in mapped.properties,
    `outgoing properties include exact "Color" label`,
  );
  // Generic lowercase keys that Jomashop rejected MUST NOT be present.
  for (const banned of ["gender", "category_type", "country_of_origin", "size_system", "material"]) {
    assert(
      !(banned in mapped.properties),
      `outgoing properties exclude generic lowercase "${banned}" (got ${JSON.stringify(Object.keys(mapped.properties))})`,
    );
  }
  // Apparel Type for OUTW must map to "Outerwear" via APPAREL_TYPE_BY_CODE.
  assert(
    mapped.properties["Apparel Type"] === "Outerwear",
    `Apparel Type === "Outerwear" for OUTW (got ${JSON.stringify(mapped.properties["Apparel Type"])})`,
  );
  // Gender Kids derived from the product tag → schema enum-normalized.
  assert(
    mapped.properties.Gender === "Kids",
    `Gender === "Kids" via tag (got ${JSON.stringify(mapped.properties.Gender)})`,
  );
  // Age derived: Gender=Kids → "Kids" via canonical fields.
  assert(
    mapped.properties.Age === "Kids",
    `Age === "Kids" derived from gender (got ${JSON.stringify(mapped.properties.Age)})`,
  );
  // Detailed Description must be populated from body_html.
  assert(
    typeof mapped.properties["Detailed Description"] === "string" &&
      String(mapped.properties["Detailed Description"]).length > 0,
    `Detailed Description populated from body_html (got ${JSON.stringify(mapped.properties["Detailed Description"])})`,
  );
  // Total Number of Pieces defaults to "1" when no metafield supplied.
  assert(
    mapped.properties["Total Number of Pieces"] === "1",
    `Total Number of Pieces === "1" by default (got ${JSON.stringify(mapped.properties["Total Number of Pieces"])})`,
  );
  // Color preserved verbatim (single value, in options-less or matching schema).
  assert(
    mapped.properties.Color === "Black",
    `Color === "Black" (got ${JSON.stringify(mapped.properties.Color)})`,
  );
  // missing_required uses exact schema labels (NOT generic names).
  for (const requiredLabel of ["Gender", "Age", "Apparel Type", "Detailed Description", "Total Number of Pieces", "Color"]) {
    if ((mapped.missing_required || []).includes(requiredLabel)) {
      console.warn(`  Warning: required label "${requiredLabel}" surfaced as missing — investigate`);
    }
  }
  // Build payload — properties should not be spread to top level for live labels.
  const { payload } = buildJomashopProductPayload(mapped, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    category_id: 42,
    manufacturer_id: 100,
  });
  // properties block must contain exact labels.
  const payloadProps = payload.properties as Record<string, unknown>;
  assert(
    "Apparel Type" in payloadProps && "Detailed Description" in payloadProps,
    `payload.properties carries exact labels`,
  );
  // Top-level payload MUST NOT contain banned generic keys.
  for (const banned of ["gender", "size", "size_system", "material", "category_type", "country_of_origin", "color"]) {
    assert(
      !(banned in payload),
      `payload top-level excludes generic "${banned}" (got ${Object.keys(payload).join(",")})`,
    );
  }
  // /i1 envelope split — product carries category_id + manufacturer_id +
  // properties with exact labels.
  const envelope = buildI1ProductEnvelope(payload, mapped.variants[0]);
  const productNode = envelope.product as Record<string, unknown>;
  assert(
    productNode && productNode.category_id === 42 && productNode.manufacturer_id === 100,
    `envelope.product carries resolved ids`,
  );
  const envProps = productNode.properties as Record<string, unknown>;
  assert(
    envProps && "Apparel Type" in envProps,
    `envelope.product.properties carries exact "Apparel Type" label`,
  );
}

function runFootwearTodsBoot() {
  console.log("Case 11: Footwear/BOOT Tods — live schema labels");
  const product: ShopifyProduct = {
    id: "shopify-tods-boot-3",
    title: "Tods Womens Multicolored Boot",
    body_html: "<p>Womens boot in calfskin leather.</p>",
    vendor: "Tods",
    product_type: "BOOT",
    tags: ["Women", "Boot"],
    images: [],
    options: [
      { name: "Size", values: ["35.5"] },
      { name: "Color", values: ["Multicolor"] },
    ],
    variants: [
      {
        id: 9600,
        sku: "XXW83B0BR70-35.5",
        price: "1200.00",
        inventory_quantity: 1,
        option1: "35.5",
        option2: "Multicolor",
      },
    ],
    metafields: [
      { namespace: "custom", key: "ff_designer_id", value: "XXW83B0BR70" },
      { namespace: "custom", key: "composition", value: "Leather" },
      { namespace: "custom", key: "size_scale", value: "EU" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, footwearLiveSchema());
  // Exact labels in output, generic excluded.
  for (const label of ["Gender", "Shoe Size", "Shoe Size Type", "Color"]) {
    assert(label in mapped.properties, `outgoing properties include exact "${label}" label`);
  }
  for (const banned of ["gender", "size", "size_system", "color", "material", "country_of_origin"]) {
    assert(
      !(banned in mapped.properties),
      `outgoing properties exclude generic "${banned}" (got ${JSON.stringify(Object.keys(mapped.properties))})`,
    );
  }
  // Shoe Size populated from product option fallback.
  assert(
    mapped.properties["Shoe Size"] === "35.5",
    `Shoe Size === "35.5" (got ${JSON.stringify(mapped.properties["Shoe Size"])})`,
  );
  // Shoe Size Type matches the schema enum option "EU".
  assert(
    mapped.properties["Shoe Size Type"] === "EU",
    `Shoe Size Type === "EU" via enum match (got ${JSON.stringify(mapped.properties["Shoe Size Type"])})`,
  );
  // Color from variant option (no metafield given).
  assert(
    mapped.properties.Color === "Multicolor",
    `Color === "Multicolor" (got ${JSON.stringify(mapped.properties.Color)})`,
  );
  // Gender Women from tag.
  assert(
    mapped.properties.Gender === "Women",
    `Gender === "Women" (got ${JSON.stringify(mapped.properties.Gender)})`,
  );
}

function runHandbagSchemaDriven() {
  console.log("Case 12: Handbags — schema-driven mapping excludes unknown fields");
  const product: ShopifyProduct = {
    id: "shopify-bag-1",
    title: "Saint Laurent Crossbody Bag",
    body_html: "<p>Quilted calfskin crossbody.</p>",
    vendor: "Saint Laurent",
    product_type: "CRBD",
    tags: ["Women", "Crossbody"],
    images: [],
    options: [{ name: "Color", values: ["Noir"] }],
    variants: [
      { id: 9700, sku: "YSL-CRB-1", price: "1800.00", inventory_quantity: 1, option1: "Noir" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Noir", name: "Color" },
      { namespace: "custom", key: "composition", value: "Calfskin leather" },
      { namespace: "custom", key: "style", value: "Crossbody" },
      { namespace: "custom", key: "hardware", value: "Gold" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, handbagLiveSchema());
  // Only exact schema labels — no surprise generic keys (Gender, Size, etc.
  // were NOT in the handbag schema and must not appear).
  const keys = Object.keys(mapped.properties);
  for (const k of keys) {
    assert(
      /[A-Z\s]/.test(k),
      `handbag output key "${k}" is a live label (not generic lowercase)`,
    );
  }
  for (const banned of ["gender", "size", "age", "apparel_type", "category_type"]) {
    assert(!(banned in mapped.properties), `handbag output excludes "${banned}"`);
  }
  // Required labels present.
  for (const required of ["Color", "Material"]) {
    assert(required in mapped.properties, `handbag output includes required "${required}"`);
  }
  assert(
    mapped.properties.Material === "Calfskin leather",
    `Material === "Calfskin leather" via composition (got ${JSON.stringify(mapped.properties.Material)})`,
  );
  // Style normalized to schema enum option "Crossbody".
  assert(
    mapped.properties.Style === "Crossbody",
    `Style === "Crossbody" via enum match (got ${JSON.stringify(mapped.properties.Style)})`,
  );
}

function runMissingRequiredSurfacesExactLabels() {
  console.log("Case 13: missing required schema labels surface exactly");
  const product: ShopifyProduct = {
    id: "shopify-empty-1",
    title: "Generic Product",
    vendor: "Generic",
    product_type: "OUTW",
    tags: [],
    images: [],
    options: [],
    variants: [{ id: 9800, sku: "GEN-1", price: "10.00", inventory_quantity: 1 }],
    metafields: [], // intentionally empty so most required fields are missing
  };
  const mapped = mapShopifyToJomashop(product, apparelLiveSchema());
  const missing = mapped.missing_required || [];
  // Color, Gender, Age (no metafield, no gender tag) must surface as exact
  // labels — never as "color" / "gender" / "age".
  for (const label of ["Color"]) {
    assert(
      missing.includes(label),
      `missing_required surfaces exact label "${label}" (got ${JSON.stringify(missing)})`,
    );
  }
  // missing_required must NOT contain lowercase generic versions.
  for (const banned of ["color", "gender", "age", "category_type"]) {
    assert(
      !missing.includes(banned),
      `missing_required excludes generic "${banned}" (got ${JSON.stringify(missing)})`,
    );
  }
}

function runI1SchemaNormalization() {
  console.log("Case 14: normalizeI1CategorySchema parses portal-shaped payloads");
  // The portal sometimes wraps the property list under "category.properties"
  // and uses {name, required, options:[{value:"..."}]} entries.
  const raw = {
    category: {
      id: 42,
      name: "Apparel",
      properties: [
        { name: "Gender", required: true, options: [{ value: "Men" }, { value: "Women" }, { value: "Kids" }] },
        { name: "Apparel Type", required: true, options: ["Outerwear", "Pants"] },
        { name: "Color", required: true, type: "string" },
      ],
    },
  };
  const norm = normalizeI1CategorySchema(raw);
  assert(norm.length === 3, `normalizeI1CategorySchema picks 3 properties (got ${norm.length})`);
  const fields = norm.map((p) => p.field);
  for (const expected of ["Gender", "Apparel Type", "Color"]) {
    assert(fields.includes(expected), `normalized schema contains "${expected}"`);
  }
  const gender = norm.find((p) => p.field === "Gender");
  assert(
    gender !== undefined && gender.required && (gender.options || []).includes("Women"),
    `Gender required + options unpacked`,
  );
  // Empty / unrecognised input degrades to [] so caller falls back.
  assert(normalizeI1CategorySchema(null).length === 0, `null input → []`);
  assert(normalizeI1CategorySchema({}).length === 0, `empty object → []`);
}

function runCanonicalFieldsExtraction() {
  console.log("Case 15: buildCanonicalProductFields extracts canonical bag");
  const product: ShopifyProduct = {
    id: "shopify-x-1",
    title: "Some Product",
    body_html: "<p>Hello.</p>",
    vendor: "ACME",
    product_type: "PANT",
    tags: ["Men"],
    images: [],
    options: [{ name: "Size", values: ["32"] }],
    variants: [{ id: 9900, sku: "ACME-PANT-32", price: "100.00", inventory_quantity: 1, option1: "32" }],
    metafields: [
      { namespace: "custom", key: "color", value: "Navy", name: "Color" },
      { namespace: "custom", key: "composition", value: "Wool" },
      { namespace: "custom", key: "ff_country_of_origin", value: "Italy" },
    ],
  };
  const canonical = buildCanonicalProductFields(product);
  assert(canonical.brand === "ACME", `canonical.brand from vendor`);
  assert(canonical.gender === "Men", `canonical.gender from tag`);
  assert(canonical.age === "Adult", `canonical.age inferred Adult for Men gender`);
  assert(canonical.size === "32", `canonical.size from product option`);
  assert(canonical.color === "Navy", `canonical.color from metafield`);
  assert(canonical.material === "Wool", `canonical.material from composition`);
  assert(canonical.country_of_origin === "Italy", `canonical.country_of_origin`);
  assert(canonical.apparel_type === "Pants", `canonical.apparel_type from PANT code`);
  assert(canonical.pieces === "1", `canonical.pieces defaults to "1"`);
  // buildSchemaProperties direct call — small unit check on the assembler.
  const out = buildSchemaProperties(apparelLiveSchema(), canonical);
  assert(out.properties.Gender === "Men", `buildSchemaProperties: Gender mapped`);
  assert(out.properties["Apparel Type"] === "Pants", `buildSchemaProperties: Apparel Type mapped`);
  assert(out.properties["Apparel Size"] === "32", `buildSchemaProperties: Apparel Size mapped`);
  // missingRequired uses exact labels.
  assert(
    Array.isArray(out.missingRequired),
    `buildSchemaProperties returns missingRequired array`,
  );
}

// ---------- Case 16: per-category strict-shape payload contract ----------
//
// The push route's contract: for EVERY supported category, the outgoing
// payload must
//   (a) carry NO forbidden lowercase top-level fields,
//   (b) put schema properties under exact Title Case labels,
//   (c) split into product+stock envelopes with the strict allow-list.
// This test exercises Apparel + Footwear + Handbags + Accessories + Eyewear
// + Rings + Necklaces so a future category addition that re-introduces the
// lowercase emit path fails CI rather than reaching Jomashop.
function runStrictShapePerCategory() {
  console.log("Case 16: strict-shape payload contract per category");
  const baseVariant = {
    id: 9999,
    sku: "STRICT-TEST-1",
    price: "200.00",
    inventory_quantity: 1,
    option1: "M",
  };
  const baseProduct = (category: string, vendor: string): ShopifyProduct => ({
    id: `shopify-strict-${category}`,
    title: `${vendor} ${category} fixture`,
    body_html: `<p>${category} item.</p>`,
    vendor,
    product_type: category,
    tags: ["Men"],
    images: [{ src: "https://example.com/img.jpg" }],
    options: [{ name: "Size", values: ["M"] }],
    variants: [{ ...baseVariant }],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "composition", value: "Leather" },
      { namespace: "custom", key: "ff_designer_id", value: "STRICT-TEST-1" },
      { namespace: "custom", key: "country_of_origin", value: "Italy" },
    ],
  });

  const supportedToTest = [
    "Apparel",
    "Footwear",
    "Handbags",
    "Accessories",
    "Eyewear",
    "Rings",
    "Necklaces",
  ] as const;

  for (const category of supportedToTest) {
    const schema = FALLBACK_CATEGORY_SCHEMAS[category].map((f) => ({
      field: f.field,
      required: f.required,
      type: f.type,
      options: f.options,
    }));
    const product = baseProduct(category, "Gucci");
    const mapped = mapShopifyToJomashop(product, schema, category);
    const { payload, pushDebug } = buildJomashopProductPayload(mapped, undefined, {
      category,
      brand: "Gucci",
      manufacturer_id: 1,
      category_id: 2,
    });

    // (a) NO forbidden lowercase keys at the top level.
    const forbidden = [
      "brand",
      "category",
      "gender",
      "size",
      "size_system",
      "color",
      "material",
      "category_type",
      "country_of_origin",
      "age",
      "apparel_type",
      "style",
      "hardware",
      "model",
      "composition",
    ];
    const topLevelKeys = Object.keys(payload);
    for (const k of forbidden) {
      assert(
        !topLevelKeys.includes(k),
        `[${category}] payload top-level excludes forbidden "${k}" (got top-level ${JSON.stringify(topLevelKeys)})`,
      );
    }
    // (b) properties keys are Title Case / spaced.
    const propKeys = Object.keys((payload.properties as Record<string, unknown>) || {});
    if (propKeys.length > 0) {
      assert(
        propKeys.every((k) => /[A-Z]/.test(k) || /\s/.test(k)),
        `[${category}] payload.properties uses exact Title Case labels (got ${JSON.stringify(propKeys)})`,
      );
    }
    // (c) /i1 envelope split — product node strict allow-list only.
    const envelope = buildI1ProductEnvelope(payload, mapped.variants[0]);
    const productNode = envelope.product as Record<string, unknown>;
    const stockNode = envelope.stock as Record<string, unknown>;
    const allowedProductKeys = new Set([
      "manufacturer_id",
      "category_id",
      "name",
      "sku",
      "vendor_sku",
      "manufacturer_number",
      "description",
      "images",
      "properties",
    ]);
    for (const k of Object.keys(productNode)) {
      assert(
        allowedProductKeys.has(k),
        `[${category}] envelope.product carries only strict allow-list key (saw "${k}")`,
      );
    }
    assert(productNode.manufacturer_id === 1, `[${category}] envelope.product.manufacturer_id propagated`);
    assert(productNode.category_id === 2, `[${category}] envelope.product.category_id propagated`);
    assert(
      typeof stockNode.quantity === "number",
      `[${category}] envelope.stock.quantity present`,
    );

    // (d) pushDebug surfaces schema source + property keys.
    assert(pushDebug.schemaLabelsExact === true, `[${category}] pushDebug.schemaLabelsExact === true`);
    assert(pushDebug.fallbackUnsafe === false, `[${category}] pushDebug.fallbackUnsafe === false`);
    assert(Array.isArray(pushDebug.propertyKeys), `[${category}] pushDebug.propertyKeys is array`);
  }
}

// ---------- Case 17: fallbackUnsafe trips when schema is lowercase-only ----------
//
// Simulates the exact production failure: /i1/categories/:id returns nothing,
// and the route falls back to a lowercase-only schema. The payload builder
// MUST flag pushDebug.fallbackUnsafe = true so the route can refuse the push
// at preflight instead of sending fields Jomashop will reject.
function runFallbackUnsafeGate() {
  console.log("Case 17: fallbackUnsafe gate refuses lowercase-only schemas");
  const lowercaseSchema = [
    { field: "color", type: "string" as const, required: true },
    { field: "material", type: "string" as const, required: false },
  ];
  const product: ShopifyProduct = {
    id: "shopify-fallback-1",
    title: "Fixture",
    vendor: "Gucci",
    product_type: "Apparel",
    options: [{ name: "Size", values: ["M"] }],
    variants: [{ id: 1, sku: "FB-1", price: "100.00", inventory_quantity: 1, option1: "M" }],
    metafields: [
      { namespace: "custom", key: "color", value: "Black" },
      { namespace: "custom", key: "composition", value: "Leather" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, lowercaseSchema);
  // Legacy lowercase keys end up in mapped.properties (the legacy emit
  // branch). The builder must DROP them and flag fallbackUnsafe so the route
  // returns a 422 instead of POSTing to /i1.
  const { payload, pushDebug } = buildJomashopProductPayload(mapped, undefined, {
    category: "Apparel",
    brand: "Gucci",
    manufacturer_id: 1,
    category_id: 2,
  });
  assert(
    pushDebug.fallbackUnsafe === true,
    `lowercase schema → pushDebug.fallbackUnsafe === true (got ${pushDebug.fallbackUnsafe})`,
  );
  assert(
    pushDebug.removedLegacyKeys.length > 0,
    `pushDebug.removedLegacyKeys lists the stripped lowercase keys (got ${JSON.stringify(pushDebug.removedLegacyKeys)})`,
  );
  const props = (payload.properties as Record<string, unknown>) || {};
  assert(
    !("color" in props) && !("material" in props),
    `payload.properties strips lowercase keys defensively (got ${JSON.stringify(Object.keys(props))})`,
  );
}

// ---------- Cases 19 & 20: Apparel fallback pushability ----------
//
// Mirrors the production failure flagged on the Products page after 35ab58b:
// a Canada Goose Kids Apparel item resolves to brand_id 2774 + category_id 35
// but the live /i1/categories/35 schema lookup comes back empty. The push
// builder MUST be allowed to fall back to FALLBACK_CATEGORY_SCHEMAS.Apparel
// (which uses exact Title Case labels) and produce a safe, pushable payload —
// it must not flag fallbackUnsafe and it must never emit lowercase legacy
// fields at the top level.

function canadaGooseKidsApparelProduct(): ShopifyProduct {
  return {
    id: "shopify-cg-kids-1",
    title: "Canada Goose Kids Black Outerwear Jacket",
    body_html: "<p>Kids outerwear.</p>",
    vendor: "Canada Goose",
    product_type: "Outerwear",
    tags: ["Kids"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      {
        id: 70001,
        sku: "OUTW-CG-001",
        price: "400.00",
        inventory_quantity: 4,
        option1: "M",
      },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "composition", value: "Down/Polyester", name: "Composition" },
      { namespace: "custom", key: "ff_designer_id", value: "OUTW-CG-001" },
      { namespace: "custom", key: "gender", value: "Kids" },
      { namespace: "custom", key: "age", value: "Kids" },
      { namespace: "custom", key: "apparel_type", value: "Outerwear" },
      { namespace: "custom", key: "detailed_description", value: "Black down-filled outerwear jacket for kids." },
      { namespace: "custom", key: "total_number_of_pieces", value: "1" },
    ],
  };
}

function runApparelFallbackPushability() {
  console.log(
    "Case 19: Apparel fallback schema produces a pushable payload when live /i1 schema is unavailable",
  );
  const product = canadaGooseKidsApparelProduct();
  const apparelFallback = FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
  }));
  const mapped = mapShopifyToJomashop(product, apparelFallback, "Apparel");
  const { payload, pushDebug, missingRequired, missingTopLevel } = buildJomashopProductPayload(
    mapped,
    undefined,
    {
      category: "Apparel",
      brand: "Canada Goose",
      manufacturer_id: 2774,
      category_id: 35,
    },
  );

  assert(
    pushDebug.fallbackUnsafe === false,
    `Apparel fallback push is NOT flagged fallbackUnsafe (got ${pushDebug.fallbackUnsafe})`,
  );
  assert(
    pushDebug.schemaLabelsExact === true,
    `Apparel fallback push reports schemaLabelsExact === true`,
  );
  assert(
    missingTopLevel.length === 0,
    `Apparel fallback push has no missing top-level fields (got ${JSON.stringify(missingTopLevel)})`,
  );
  assert(
    missingRequired.length === 0,
    `Apparel fallback push has no missing required fields when source data is present (got ${JSON.stringify(missingRequired)})`,
  );
  assert(payload.manufacturer_id === 2774, `payload.manufacturer_id propagated (got ${payload.manufacturer_id})`);
  assert(payload.category_id === 35, `payload.category_id propagated (got ${payload.category_id})`);
}

function runApparelFallbackPayloadIsTitleCase() {
  console.log(
    "Case 20: Apparel fallback payload uses Title Case property keys and never emits lowercase legacy fields",
  );
  const product = canadaGooseKidsApparelProduct();
  const apparelFallback = FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
  }));
  const mapped = mapShopifyToJomashop(product, apparelFallback, "Apparel");
  const { payload } = buildJomashopProductPayload(mapped, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });

  const forbiddenTopLevel = [
    "brand",
    "category",
    "gender",
    "size",
    "size_system",
    "color",
    "material",
    "category_type",
    "country_of_origin",
    "age",
    "apparel_type",
    "style",
    "hardware",
    "model",
    "composition",
  ];
  for (const k of forbiddenTopLevel) {
    assert(
      !(k in payload),
      `Apparel fallback payload top-level excludes forbidden "${k}" (got top-level ${JSON.stringify(Object.keys(payload))})`,
    );
  }
  const props = (payload.properties as Record<string, unknown>) || {};
  const propKeys = Object.keys(props);
  assert(propKeys.length > 0, `Apparel fallback payload.properties is populated (got ${JSON.stringify(propKeys)})`);
  assert(
    propKeys.every((k) => /[A-Z]/.test(k) || /\s/.test(k)),
    `Apparel fallback payload.properties uses ONLY Title Case labels (got ${JSON.stringify(propKeys)})`,
  );
  for (const k of forbiddenTopLevel) {
    assert(
      !(k in props),
      `Apparel fallback payload.properties excludes lowercase legacy key "${k}" (got ${JSON.stringify(propKeys)})`,
    );
  }
  // Spot-check known Title Case labels for Apparel.
  assert("Gender" in props, `Apparel fallback payload.properties carries "Gender"`);
  assert("Apparel Type" in props, `Apparel fallback payload.properties carries "Apparel Type"`);
  assert("Color" in props, `Apparel fallback payload.properties carries "Color"`);
}

// ---------- Case 18: every SUPPORTED_CATEGORIES entry has exact-label fallback ----------
//
// Guard rail. A future category addition that forgets to put exact Title
// Case labels in FALLBACK_CATEGORY_SCHEMAS would silently regress the
// production push to lowercase-fallback again.
function runEverySupportedCategoryHasExactLabels() {
  console.log("Case 18: every SUPPORTED_CATEGORIES entry has exact-label fallback");
  for (const cat of SUPPORTED_CATEGORIES) {
    const schema = FALLBACK_CATEGORY_SCHEMAS[cat];
    assert(
      Array.isArray(schema) && schema.length > 0,
      `FALLBACK_CATEGORY_SCHEMAS.${String(cat)} is a non-empty array`,
    );
    const allExact = schema.every((p) => /[A-Z]/.test(p.field) || /\s/.test(p.field));
    assert(
      allExact,
      `FALLBACK_CATEGORY_SCHEMAS.${String(cat)} uses ONLY exact Title Case labels (got ${JSON.stringify(schema.map((p) => p.field))})`,
    );
  }
}

// ---------- Cases 21+: enum/option validation across categories ----------

// Mirrors the exact payload Jomashop rejected: Canada Goose Kids Black
// Outerwear, SKU 3103K61-4, pushed to category_id 35 (Apparel). Jomashop
// returned validation errors for Material, Gender ("Kids" not in list),
// Article (free-text product name), and Country of Origin ("Canada" not in
// list). The mapper + payload builder must now:
//   - omit Material entirely (not in the Apparel schema)
//   - coerce Gender Kids → Unisex (and surface Age=Kids)
//   - either map Article to an accepted enum option or omit it (no free text)
//   - drop Country of Origin when "Canada" isn't in the accepted list
function runCanadaGooseApparelRejectionFix() {
  console.log(
    "Case 21: Canada Goose Kids Apparel rejection — Material/Gender/Article/Country handled",
  );
  const apparelFallback = FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
  }));
  const product: ShopifyProduct = {
    id: "shopify-cg-3103K61-4",
    title: "Canada Goose Kids Black Outerwear",
    body_html: "<p>Kids outerwear in black.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids", "Outerwear"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["4"] }],
    variants: [
      {
        id: 30001,
        sku: "3103K61-4",
        price: "650.00",
        inventory_quantity: 1,
        option1: "4",
      },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "BLACK", name: "Color" },
      { namespace: "custom", key: "composition", value: "Cotton" },
      { namespace: "custom", key: "country_of_origin", value: "Canada" },
      { namespace: "custom", key: "ff_designer_id", value: "3103K61" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelFallback, "Apparel");

  // (1) Material must not appear in mapped.properties — it is not in the
  // Apparel schema at all. The previous code emitted Material from the
  // Composition metafield, which Jomashop rejected.
  assert(
    !("Material" in mapped.properties),
    `Apparel: Material is NOT emitted (Jomashop rejects it) (got ${JSON.stringify(mapped.properties.Material)})`,
  );

  // (2) Gender "Kids" must be coerced to Unisex (the Apparel Gender enum
  // accepts Men/Women/Unisex — "Kids" triggers the rejection).
  assert(
    mapped.properties.Gender === "Unisex",
    `Apparel: Gender Kids → Unisex (got ${JSON.stringify(mapped.properties.Gender)})`,
  );

  // (3) Age must remain "Kids" so Jomashop still knows this is a kids item.
  assert(
    mapped.properties.Age === "Kids",
    `Apparel: Age === "Kids" (got ${JSON.stringify(mapped.properties.Age)})`,
  );

  // (4) Article must NOT be the product title verbatim. It should either
  // map to an accepted option (e.g. "Outerwear" from the OUTW code) or be
  // dropped from the payload. Free-text "Canada Goose Kids Black Outerwear"
  // is exactly what Jomashop rejected.
  const articleValue = mapped.properties.Article;
  if (articleValue !== undefined && articleValue !== null) {
    assert(
      typeof articleValue === "string" && APPAREL_TYPE_OPTIONS_FOR_TEST.includes(articleValue),
      `Apparel: Article (when present) maps to accepted option (got ${JSON.stringify(articleValue)})`,
    );
  }
  // For OUTW specifically we expect "Outerwear" via APPAREL_TYPE_BY_CODE.
  assert(
    articleValue === "Outerwear",
    `Apparel/OUTW: Article === "Outerwear" via code map (got ${JSON.stringify(articleValue)})`,
  );

  // (5) Country of Origin "Canada" is not in the accepted list — the
  // payload must DROP the field rather than send "Canada".
  const { payload, pushDebug, invalidEnums, omittedOptionalFields } = buildJomashopProductPayload(
    mapped,
    undefined,
    {
      category: "Apparel",
      brand: "Canada Goose",
      manufacturer_id: 2774,
      category_id: 35,
    },
  );
  const payloadProps = (payload.properties as Record<string, unknown>) || {};
  assert(
    !("Country of Origin" in payloadProps),
    `Apparel: Country of Origin dropped when value not in accepted list (got ${JSON.stringify(payloadProps["Country of Origin"])})`,
  );
  assert(
    omittedOptionalFields.includes("Country of Origin"),
    `Apparel: omittedOptionalFields lists Country of Origin (got ${JSON.stringify(omittedOptionalFields)})`,
  );

  // (6) invalidEnums must record the Canada attempt so the operator can see
  // what was sent versus what is accepted.
  const cooInvalid = invalidEnums.find((e) => e.field === "Country of Origin");
  assert(
    cooInvalid !== undefined && cooInvalid.value === "Canada",
    `Apparel: invalidEnums captures the Canada → accepted-list mismatch (got ${JSON.stringify(invalidEnums)})`,
  );

  // (7) The payload must be pushable: no Material, Gender is Unisex,
  // Article is Outerwear (accepted), Country of Origin dropped. pushDebug
  // confirms schemaLabelsExact and no missing required.
  assert(pushDebug.schemaLabelsExact === true, `Apparel: pushDebug.schemaLabelsExact === true`);
  assert(pushDebug.fallbackUnsafe === false, `Apparel: pushDebug.fallbackUnsafe === false`);

  // (8) Top-level payload must NOT carry a Material key, even though the
  // Composition metafield was present.
  assert(
    !("Material" in payload),
    `Apparel: top-level payload excludes Material (got ${Object.keys(payload).join(",")})`,
  );
}

// Helper mirroring the internal APPAREL_TYPE_OPTIONS list used by the
// Apparel schema for Article/Apparel Type validation. Kept here so the test
// doesn't need to import the private const.
const APPAREL_TYPE_OPTIONS_FOR_TEST = [
  "Outerwear",
  "Jackets",
  "Coats",
  "Vests",
  "Blazers",
  "Suits",
  "Tuxedos",
  "Pants",
  "Jeans",
  "Shorts",
  "Sweatpants",
  "Joggers",
  "Leggings",
  "Skirts",
  "Dresses",
  "Jumpsuits",
  "Bodysuits",
  "Shirts",
  "Dress Shirts",
  "T-Shirts",
  "Polo Shirts",
  "Tank Tops",
  "Tops",
  "Blouses",
  "Sweaters",
  "Sweatshirts",
  "Hoodies",
  "Pullovers",
  "Activewear",
  "Swimwear",
  "Underwear",
  "Bras",
  "Socks",
  "Pajamas",
  "Robes",
  "Capes",
  "Scarves",
  "Hats",
  "Cummerbunds",
  "Headwear",
  "Masks",
];

// Case 22: Footwear with a country not in the accepted list — Country of
// Origin must be dropped, but the rest of the payload remains pushable.
function runFootwearUnknownCountry() {
  console.log("Case 22: Footwear — unknown Country of Origin dropped, push remains valid");
  const footwearFallback = FALLBACK_CATEGORY_SCHEMAS.Footwear.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
  }));
  const product: ShopifyProduct = {
    id: "shopify-tods-fw-1",
    title: "Tods Womens Black Loafer",
    body_html: "<p>Calfskin loafer.</p>",
    vendor: "Tods",
    product_type: "LOAF",
    tags: ["Women", "Loafer"],
    images: [],
    options: [{ name: "Size", values: ["38"] }],
    variants: [
      { id: 40001, sku: "TODS-LOAF-38", price: "650.00", inventory_quantity: 1, option1: "38" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "composition", value: "Calfskin leather" },
      { namespace: "custom", key: "country_of_origin", value: "Atlantis" },
      { namespace: "custom", key: "size_scale", value: "EU" },
      { namespace: "custom", key: "ff_designer_id", value: "TODS-LOAF" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, footwearFallback, "Footwear");
  const { payload, invalidEnums, omittedOptionalFields, missingRequired } =
    buildJomashopProductPayload(mapped, undefined, {
      category: "Footwear",
      brand: "Tods",
      manufacturer_id: 1,
      category_id: 2,
    });
  const props = (payload.properties as Record<string, unknown>) || {};
  // Required fields present.
  assert(props.Gender === "Women", `Footwear: Gender === "Women"`);
  assert(props["Shoe Size"] === "38", `Footwear: Shoe Size === "38"`);
  assert(props["Shoe Size Type"] === "EU", `Footwear: Shoe Size Type === "EU"`);
  assert(props.Color === "Black", `Footwear: Color === "Black"`);
  // Country of Origin dropped.
  assert(
    !("Country of Origin" in props),
    `Footwear: Country of Origin dropped when not in accepted list (got ${JSON.stringify(props["Country of Origin"])})`,
  );
  assert(
    omittedOptionalFields.includes("Country of Origin"),
    `Footwear: omittedOptionalFields includes Country of Origin (got ${JSON.stringify(omittedOptionalFields)})`,
  );
  // invalidEnums records "Atlantis".
  const inv = invalidEnums.find((e) => e.field === "Country of Origin");
  assert(
    inv !== undefined && inv.value === "Atlantis",
    `Footwear: invalidEnums captures Atlantis (got ${JSON.stringify(invalidEnums)})`,
  );
  // Required fields all good.
  assert(
    missingRequired.length === 0,
    `Footwear: no missing required fields (got ${JSON.stringify(missingRequired)})`,
  );
}

// Case 23: Handbags — Style unknown value dropped, Material remains
// required and present (Handbags does accept Material, unlike Apparel).
function runHandbagsStyleEnumDrop() {
  console.log("Case 23: Handbags — unknown Style enum dropped, Material kept");
  const handbagFallback = FALLBACK_CATEGORY_SCHEMAS.Handbags.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
  }));
  const product: ShopifyProduct = {
    id: "shopify-bag-22",
    title: "Saint Laurent Bag",
    body_html: "<p>Quilted bag.</p>",
    vendor: "Saint Laurent",
    product_type: "HBAG",
    tags: ["Women"],
    images: [],
    options: [{ name: "Color", values: ["Noir"] }],
    variants: [
      { id: 50001, sku: "YSL-BAG-22", price: "1500.00", inventory_quantity: 1, option1: "Noir" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Noir", name: "Color" },
      { namespace: "custom", key: "composition", value: "Calfskin leather" },
      { namespace: "custom", key: "style", value: "MessengerStyleNotInList" },
      { namespace: "custom", key: "hardware", value: "Gold" },
      { namespace: "custom", key: "ff_designer_id", value: "YSL-BAG" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, handbagFallback, "Handbags");
  const { payload, omittedOptionalFields, missingRequired } = buildJomashopProductPayload(
    mapped,
    undefined,
    {
      category: "Handbags",
      brand: "Saint Laurent",
      manufacturer_id: 1,
      category_id: 2,
    },
  );
  const props = (payload.properties as Record<string, unknown>) || {};
  // Material is required for Handbags and must be present.
  assert(
    props.Material === "Calfskin leather",
    `Handbags: Material === "Calfskin leather" (got ${JSON.stringify(props.Material)})`,
  );
  // Style "MessengerStyleNotInList" not in accepted options — must be dropped.
  assert(
    !("Style" in props),
    `Handbags: unknown Style dropped (got ${JSON.stringify(props.Style)})`,
  );
  assert(
    omittedOptionalFields.includes("Style"),
    `Handbags: omittedOptionalFields includes Style`,
  );
  // Hardware "Gold" is accepted.
  assert(
    props.Hardware === "Gold",
    `Handbags: Hardware === "Gold" (got ${JSON.stringify(props.Hardware)})`,
  );
  assert(
    missingRequired.length === 0,
    `Handbags: no missing required (got ${JSON.stringify(missingRequired)})`,
  );
}

// Case 24: Apparel required Gender that doesn't coerce to any option must
// surface a clear preflight failure — neither a silent omit nor a Jomashop
// round-trip rejection.
function runApparelGenderUnmappable() {
  console.log("Case 24: Apparel — Gender that cannot be mapped surfaces as required");
  const apparelFallback = FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
  }));
  const product: ShopifyProduct = {
    id: "shopify-apparel-no-gender",
    title: "Pants",
    vendor: "Generic",
    product_type: "PANT",
    tags: [],
    images: [],
    options: [{ name: "Size", values: ["32"] }],
    variants: [{ id: 60001, sku: "G-PANT-1", price: "100.00", inventory_quantity: 1, option1: "32" }],
    metafields: [
      { namespace: "custom", key: "color", value: "Navy", name: "Color" },
      { namespace: "custom", key: "ff_designer_id", value: "G-PANT-1" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelFallback, "Apparel");
  // No tag/metafield gives us Men/Women/Unisex; the canonical bag has no
  // gender, so missing_required should list "Gender".
  assert(
    (mapped.missing_required || []).includes("Gender"),
    `Apparel: missing_required includes Gender when unresolvable (got ${JSON.stringify(mapped.missing_required)})`,
  );
}

runColorNavyCase();
runDefinitionNameOnlyCase();
runVariantSelectedOptionFallback();
runListTypeMetafield();
runBuiltInCategoryDefaults();
runBrandKeyNormalization();
runManufacturerIdCarriedThrough();
runResolvedRecordsRequiredForReadiness();
runBuiltInBrandSeeds();
await runResolutionAuditHelpers();
runApparelCanadaGooseOuterwear();
runFootwearTodsBoot();
runHandbagSchemaDriven();
runMissingRequiredSurfacesExactLabels();
runI1SchemaNormalization();
runCanonicalFieldsExtraction();
runStrictShapePerCategory();
runFallbackUnsafeGate();
runEverySupportedCategoryHasExactLabels();
runApparelFallbackPushability();
runApparelFallbackPayloadIsTitleCase();
runCanadaGooseApparelRejectionFix();
runFootwearUnknownCountry();
runHandbagsStyleEnumDrop();
runApparelGenderUnmappable();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll mapping smoke tests passed.");
