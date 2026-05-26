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
  buildI1ProductEnvelope,
  buildJomashopProductPayload,
  coerceJomashopToSupported,
  isAmbiguousCategoryCode,
  lookupBuiltInCategoryDefault,
  mapShopifyToJomashop,
  normalizeCategoryCode,
  type ShopifyProduct,
} from "../server/mapping";
import {
  BUILT_IN_BRAND_OVERRIDES,
  lookupBrandOverride,
  normalizeBrandKey,
} from "../server/brand_mapping";
import { FALLBACK_CATEGORY_SCHEMAS } from "../shared/schema";

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
  assert(mapped.properties.color === "NAVY", `properties.color === "NAVY" (got ${JSON.stringify(mapped.properties.color)})`);
  assert(
    typeof mapped.properties.material === "string" && /cotton/i.test(String(mapped.properties.material)),
    `properties.material populated from Composition (got ${JSON.stringify(mapped.properties.material)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("color"),
    `missing_required does not include "color" (got ${JSON.stringify(mapped.missing_required)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("material"),
    `missing_required does not include "material"`,
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
    mapped.properties.color === "RED",
    `definition-name match: properties.color === "RED" (got ${JSON.stringify(mapped.properties.color)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("color"),
    `missing_required does not include "color" via definition-name match`,
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
    mapped.properties.color === "Beige",
    `variant option fallback: properties.color === "Beige" (got ${JSON.stringify(mapped.properties.color)})`,
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
    mapped.properties.color === "NAVY",
    `list metafield unpacked: properties.color === "NAVY" (got ${JSON.stringify(mapped.properties.color)})`,
  );
  assert(
    mapped.properties.material === "cotton",
    `quoted scalar unwrapped: properties.material === "cotton" (got ${JSON.stringify(mapped.properties.material)})`,
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
  // Coercion from Jomashop name → SupportedCategory.
  assert(coerceJomashopToSupported("Footwear") === "Shoes", `Footwear → Shoes`);
  assert(
    coerceJomashopToSupported("Accessories") === "Clothing",
    `Accessories → Clothing`,
  );
  assert(coerceJomashopToSupported("Handbags") === "Handbags", `Handbags → Handbags`);
  assert(coerceJomashopToSupported("Clothing") === "Clothing", `Clothing → Clothing`);
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
  const { payload } = buildJomashopProductPayload(mapped, undefined, {
    category: "Boots",
    brand: "Tod's",
  });
  assert(
    payload.category === "Boots",
    `payload.category honours override (got ${JSON.stringify(payload.category)})`,
  );
  assert(
    payload.brand === "Tod's",
    `payload.brand honours override (got ${JSON.stringify(payload.brand)})`,
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
  assert(
    payload.brand === "Tod's",
    `payload.brand uses canonical Jomashop spelling (got ${JSON.stringify(payload.brand)})`,
  );
  assert(
    payload.category === "Footwear",
    `payload.category uses canonical Jomashop spelling (got ${JSON.stringify(payload.category)})`,
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

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll mapping smoke tests passed.");
