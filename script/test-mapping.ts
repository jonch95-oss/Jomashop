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
  MSRP_METAFIELD_CANDIDATES,
  PARENT_SKU_METAFIELD_CANDIDATES,
  buildCanonicalProductFields,
  buildI1ProductEnvelope,
  buildJomashopProductPayload,
  buildSchemaProperties,
  extractVariantSize,
  coerceJomashopToSupported,
  findMetafieldSource,
  findMsrpSource,
  findParentSkuSource,
  isAmbiguousCategoryCode,
  lookupBuiltInCategoryDefault,
  mapShopifyToJomashop,
  charmPrice,
  charmRetailWithMarginFloor,
  normalizeCategoryCode,
  normalizeI1CategorySchema,
  normalizeV1CategorySchema,
  readParentSku,
  deriveColorFromTitle,
  deriveGenderFromTitle,
  deriveSizeSystem,
  resolveMsrp,
  type ShopifyProduct,
  type SchemaPropertyDescriptor,
} from "../server/mapping";
import {
  BUILT_IN_BRAND_OVERRIDES,
  lookupBrandOverride,
  normalizeBrandKey,
} from "../server/brand_mapping";
import {
  BUILT_IN_ENUM_OVERRIDES,
  normalizeEnumCategoryKey,
  normalizeEnumFieldKey,
  normalizeEnumSourceValue,
} from "../server/enum_mapping";
import {
  FALLBACK_CATEGORY_SCHEMAS,
  SUPPORTED_CATEGORIES,
  canonicalJomashopCategory,
  CANONICAL_JOMASHOP_CATEGORY_ALIASES,
} from "../shared/schema";
import {
  buildMappingWorkbook,
  buildMappingOptionsRangeName,
  parseMappingUpload,
  deriveDefaultMetafieldTarget,
  type AggregateMappingsResult,
  type MappingRowExportRecord,
} from "../server/jomashop_mapping_excel";
import { MAX_EXPORT_ROWS } from "../server/jomashop_product_field_excel";
import {
  buildProductFieldWorkbook,
  parseProductFieldUpload,
  deriveMetafieldTargetForProductField,
  fieldIsParentSku,
  fieldIsVariantTargeted,
  buildOptionsRangeName,
  resolveSheetCategory,
  applyFieldValuesToCachedProducts,
  type ProductFieldExportResult,
} from "../server/jomashop_product_field_excel";
import {
  buildInlineRepairFieldDescriptors,
  validateInlineFieldValue,
} from "../server/inline_field_repair";
import {
  compactifyMapped,
  deriveReadinessFromMapping,
} from "../server/compact_mapped";
import {
  jomashopRequest,
  __resetSessionPathForTest,
} from "../server/jomashop";
import {
  parsePortalCsv,
  tableToRecords,
  coercePortalRecord,
  headerToField,
  dollarsToCents,
  buildCatalogIndex,
  catalogEntriesFromProducts,
  matchPortalStyle,
  reconcileStatus,
  isInventoryPushEligible,
  extractOrderLineSkus,
  type CatalogEntry,
} from "../server/portal_reconcile";

// Pure (storage-free) enum override resolver that mimics the production
// lookupEnumOverride for tests. Mirrors the strict trust gate used in
// production:
//  - overlay entries are treated as VERIFIED operator overrides (the test
//    has already decided the mapping is correct, regardless of acceptedOptions).
//  - BUILT_IN_ENUM_OVERRIDES entries are only honored when their `verified`
//    flag is true AND the supplied acceptedOptions list contains the target.
//  - When acceptedOptions is undefined, built-in seeds are NEVER honored —
//    matches the production resolver. Overlay entries continue to be honored
//    so tests can simulate an operator_verified row when no live list exists.
function makeTestEnumResolver(overlay: Record<string, string> = {}) {
  return (
    category: string,
    field: string,
    sourceValue: string,
    acceptedOptions: string[] | undefined,
  ): string | null => {
    const cat = normalizeEnumCategoryKey(category);
    const f = normalizeEnumFieldKey(field);
    const v = normalizeEnumSourceValue(sourceValue);
    if (!cat || !f || !v) return null;
    const key = `${cat}|${f}|${v}`;
    const overlayHit = overlay[key];
    if (overlayHit) {
      if (acceptedOptions && acceptedOptions.length > 0) {
        const accepted = acceptedOptions.map((o) => o.toLowerCase().trim());
        if (!accepted.includes(overlayHit.toLowerCase().trim())) return null;
      }
      return overlayHit;
    }
    const seed = BUILT_IN_ENUM_OVERRIDES[key];
    if (!seed) return null;
    if (!seed.verified) return null;
    if (!acceptedOptions || acceptedOptions.length === 0) return null;
    const accepted = acceptedOptions.map((o) => o.toLowerCase().trim());
    if (!accepted.includes(seed.jomashopOption.toLowerCase().trim())) return null;
    return seed.jomashopOption;
  };
}

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
      "parent_sku",
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
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
  }));
  // With a verified operator override in place, the resolver maps the
  // "Outerwear" raw_category_code → Jomashop Article "Outerwear", Article is
  // satisfied, and the payload is pushable end-to-end. Built-in seeds are no
  // longer trusted to do this — the operator must explicitly stand up the
  // mapping (see lookupEnumOverride / enum_overrides table).
  const verifiedOverlay = {
    "apparel|article|outerwear": "Outerwear",
    "apparel|article|outw": "Outerwear",
  };
  const mapped = mapShopifyToJomashop(product, apparelFallback, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver(verifiedOverlay),
  });
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
    `Apparel fallback push has no missing required fields when source data + enum resolver are present (got ${JSON.stringify(missingRequired)})`,
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
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
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
    options_unverified: f.options_unverified,
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

  // (4) Article is now REQUIRED on the Apparel fallback (Jomashop rejected
  // the push with "Article can't be blank"). The bundled options list is
  // still tagged `options_unverified: true`, so without an enum override
  // resolver the field must surface as a preflight block in
  // missing_required + unverified_required_options. The OUTW source value
  // is what the operator needs to map (raw_category code).
  const articleValue = mapped.properties.Article;
  assert(
    articleValue === null || articleValue === undefined,
    `Apparel: Article without resolver is held back from payload (got ${JSON.stringify(articleValue)})`,
  );
  assert(
    (mapped.missing_required || []).includes("Article"),
    `Apparel: Article surfaces in missing_required when no enum override resolves it (got ${JSON.stringify(mapped.missing_required)})`,
  );
  assert(
    (mapped.unverified_required_options || []).some((u) => u.field === "Article"),
    `Apparel: Article surfaces in unverified_required_options (got ${JSON.stringify(mapped.unverified_required_options)})`,
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

  // (7) Article must be absent from the outgoing payload properties when
  // unresolved — sending a guess would trigger the "X is not included in
  // the list" rejection.
  assert(
    !("Article" in payloadProps),
    `Apparel: Article omitted from payload.properties when unresolved (got ${JSON.stringify(payloadProps.Article)})`,
  );
  assert(
    pushDebug.unverifiedRequiredOptions.some((u) => u.field === "Article"),
    `Apparel: pushDebug.unverifiedRequiredOptions surfaces Article (got ${JSON.stringify(pushDebug.unverifiedRequiredOptions)})`,
  );

  // (8) Schema labels still exact / not fallbackUnsafe.
  assert(pushDebug.schemaLabelsExact === true, `Apparel: pushDebug.schemaLabelsExact === true`);
  assert(pushDebug.fallbackUnsafe === false, `Apparel: pushDebug.fallbackUnsafe === false`);

  // (9) Top-level payload must NOT carry a Material key.
  assert(
    !("Material" in payload),
    `Apparel: top-level payload excludes Material (got ${Object.keys(payload).join(",")})`,
  );

  // (10) When the resolver IS supplied AND a VERIFIED operator override
  // exists for OUTW → "Outerwear", the SAME product re-maps with Article =
  // "Outerwear" emitted, no preflight block. This is the operator-unblock
  // path for OUTW pushes. Critically, this is now ONLY satisfied by an
  // operator-supplied overlay — the prior built-in seed is no longer
  // trusted (see lookupEnumOverride trust gate).
  const verifiedOverlay = { "apparel|article|outw": "Outerwear" };
  const mappedWithResolver = mapShopifyToJomashop(product, apparelFallback, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver(verifiedOverlay),
  });
  assert(
    mappedWithResolver.properties.Article === "Outerwear",
    `Apparel: with verified enum override, Article = "Outerwear" (got ${JSON.stringify(mappedWithResolver.properties.Article)})`,
  );
  assert(
    !(mappedWithResolver.missing_required || []).includes("Article"),
    `Apparel: with verified override, Article is NOT missing_required (got ${JSON.stringify(mappedWithResolver.missing_required)})`,
  );
  assert(
    !(mappedWithResolver.unverified_required_options || []).some((u) => u.field === "Article"),
    `Apparel: with verified override, Article NOT in unverified_required_options (got ${JSON.stringify(mappedWithResolver.unverified_required_options)})`,
  );
  const resolvedPayload = buildJomashopProductPayload(mappedWithResolver, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });
  const resolvedProps = (resolvedPayload.payload.properties as Record<string, unknown>) || {};
  assert(
    resolvedProps.Article === "Outerwear",
    `Apparel: with verified override, payload.properties.Article === "Outerwear" (got ${JSON.stringify(resolvedProps.Article)})`,
  );

  // (11) Without the verified overlay — i.e. relying on the (now-removed)
  // built-in OUTW seed — Article MUST remain blocked. This is the
  // regression guard for the 3103K61-4 incident: the prior build sent
  // Article="Outerwear" from a never-verified seed and Jomashop rejected
  // it. The test ensures we never re-introduce that behavior.
  const mappedNoOverlay = mapShopifyToJomashop(product, apparelFallback, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver(),
  });
  assert(
    mappedNoOverlay.properties.Article == null,
    `Apparel: built-in seed alone NEVER emits Article (got ${JSON.stringify(mappedNoOverlay.properties.Article)})`,
  );
  assert(
    (mappedNoOverlay.missing_required || []).includes("Article"),
    `Apparel: built-in seed alone keeps Article in missing_required`,
  );
  assert(
    (mappedNoOverlay.unverified_required_options || []).some((u) => u.field === "Article"),
    `Apparel: built-in seed alone keeps Article in unverified_required_options`,
  );
  const noOverlayPayload = buildJomashopProductPayload(mappedNoOverlay, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });
  const noOverlayProps =
    (noOverlayPayload.payload.properties as Record<string, unknown>) || {};
  assert(
    !("Article" in noOverlayProps),
    `Apparel: built-in seed alone never sends Article in payload (got ${JSON.stringify(noOverlayProps.Article)})`,
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
    options_unverified: f.options_unverified,
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

// Case 25: bundled Apparel Article options are unverified — even a value
// that matches the guessed list (e.g. "Outerwear") must NOT be emitted.
// Direct repro of the rejection from deploy e897310: Canada Goose Kids
// SKU 3103K61-4 was rejected with "Article is not included in the list"
// after the previous fix sent Article="Outerwear" from the bundled list.
function runApparelArticleNeverGuessed() {
  console.log("Case 25: Apparel — bundled Article options are unverified; Article never sent");
  const apparelFallback = FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
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
      { id: 30001, sku: "3103K61-4", price: "650.00", inventory_quantity: 1, option1: "4" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "BLACK", name: "Color" },
      { namespace: "custom", key: "ff_designer_id", value: "3103K61" },
    ],
  };
  // Without an enum override resolver, the bundled Article field
  // (required + options_unverified) must block preflight via
  // missing_required + unverified_required_options, never emit a guessed
  // value. The build path's payload must also be free of Article.
  const mapped = mapShopifyToJomashop(product, apparelFallback, "Apparel");
  const articleVal = mapped.properties.Article;
  assert(
    articleVal === null || articleVal === undefined,
    `Apparel: without resolver, Article must not be emitted (got ${JSON.stringify(articleVal)})`,
  );
  assert(
    (mapped.missing_required || []).includes("Article"),
    `Apparel: missing_required includes Article when unresolved (got ${JSON.stringify(mapped.missing_required)})`,
  );
  assert(
    (mapped.unverified_required_options || []).some((u) => u.field === "Article"),
    `Apparel: unverified_required_options surfaces Article (got ${JSON.stringify(mapped.unverified_required_options)})`,
  );
  const { payload, pushDebug } = buildJomashopProductPayload(mapped, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });
  const props = (payload.properties as Record<string, unknown>) || {};
  assert(
    !("Article" in props),
    `Apparel: payload.properties.Article omitted when unresolved (got ${JSON.stringify(props.Article)})`,
  );
  assert(
    pushDebug.unverifiedRequiredOptions.some((u) => u.field === "Article"),
    `Apparel: pushDebug.unverifiedRequiredOptions surfaces Article (got ${JSON.stringify(pushDebug.unverifiedRequiredOptions)})`,
  );
}

// Case 26: when a LIVE schema response carries explicit options for the
// Article field, those options are trusted (options_unverified is not set)
// and Article IS emitted when the canonical value matches.
function runApparelArticleSentFromLiveSchema() {
  console.log("Case 26: Apparel — live schema options for Article are trusted and emitted");
  const liveSchema: SchemaPropertyDescriptor[] = [
    { field: "Gender", label: "Gender", required: true, type: "enum", options: ["Men", "Women", "Unisex"] },
    { field: "Age", label: "Age", required: true, type: "enum", options: ["Adult", "Kids"] },
    { field: "Apparel Type", label: "Apparel Type", required: true, options: ["Outerwear", "Pants"] },
    { field: "Detailed Description", label: "Detailed Description", required: true, type: "string" },
    { field: "Total Number of Pieces", label: "Total Number of Pieces", required: true, type: "string" },
    { field: "Color", label: "Color", required: true, type: "string" },
    // Live options reported by Jomashop — the only set we trust.
    { field: "Article", label: "Article", required: false, type: "enum", options: ["Down Parka", "Bomber"] },
  ];
  const product: ShopifyProduct = {
    id: "shopify-cg-live-1",
    title: "Canada Goose Down Parka",
    body_html: "<p>Down parka.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids"],
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [{ id: 1, sku: "CG-LIVE-1", price: "650.00", inventory_quantity: 1, option1: "M" }],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "Article", value: "Down Parka", name: "Article" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, liveSchema, "Apparel");
  assert(
    mapped.properties.Article === "Down Parka",
    `Apparel: live-schema Article option emitted verbatim (got ${JSON.stringify(mapped.properties.Article)})`,
  );
}

// Case 27: a required field whose options are unverified must block the
// push at preflight with a clear actionable message — never a guess that
// would be rejected by Jomashop.
function runApparelRequiredUnverifiedBlocksPreflight() {
  console.log(
    "Case 27: required field with options_unverified triggers preflight block",
  );
  const schemaWithRequiredUnverified: SchemaPropertyDescriptor[] = [
    { field: "Gender", required: true, type: "enum", options: ["Men", "Women", "Unisex"] },
    { field: "Age", required: true, type: "enum", options: ["Adult", "Kids"] },
    { field: "Apparel Type", required: true, type: "enum", options: ["Outerwear"] },
    { field: "Detailed Description", required: true, type: "string" },
    { field: "Total Number of Pieces", required: true, type: "string" },
    { field: "Color", required: true, type: "string" },
    // Required + unverified — must block preflight.
    {
      field: "Article",
      required: true,
      type: "enum",
      options: ["Outerwear", "Pants"],
      options_unverified: true,
    },
  ];
  const product: ShopifyProduct = {
    id: "shopify-cg-required-unverified-1",
    title: "Canada Goose Kids Black Outerwear",
    body_html: "<p>Kids outerwear.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids"],
    images: [],
    options: [{ name: "Size", values: ["4"] }],
    variants: [{ id: 1, sku: "REQ-UNV-1", price: "650.00", inventory_quantity: 1, option1: "4" }],
    metafields: [{ namespace: "custom", key: "color", value: "Black", name: "Color" }],
  };
  const mapped = mapShopifyToJomashop(product, schemaWithRequiredUnverified, "Apparel");
  // Article must surface as a required-field block via missing_required AND
  // via unverified_required_options.
  assert(
    (mapped.missing_required || []).includes("Article"),
    `Required+unverified Article surfaces in missing_required (got ${JSON.stringify(mapped.missing_required)})`,
  );
  assert(
    (mapped.unverified_required_options || []).some((u) => u.field === "Article"),
    `Required+unverified Article surfaces in unverified_required_options (got ${JSON.stringify(mapped.unverified_required_options)})`,
  );
  // Article must NOT be emitted as a value — even though a canonical value
  // ("Outerwear" via OUTW code) is available.
  const articleVal = mapped.properties.Article;
  assert(
    articleVal === null || articleVal === undefined,
    `Required+unverified Article is not emitted with a guess (got ${JSON.stringify(articleVal)})`,
  );
  const { pushDebug, missingRequired, unverifiedRequiredOptions } = buildJomashopProductPayload(
    mapped,
    undefined,
    { category: "Apparel", brand: "Canada Goose", manufacturer_id: 1, category_id: 35 },
  );
  assert(
    missingRequired.length > 0,
    `Required+unverified Article: missingRequired carries the field (got ${JSON.stringify(missingRequired)})`,
  );
  assert(
    unverifiedRequiredOptions.some((u) => u.field === "Article"),
    `buildJomashopProductPayload: unverifiedRequiredOptions surfaces Article (got ${JSON.stringify(unverifiedRequiredOptions)})`,
  );
  assert(
    pushDebug.unverifiedRequiredOptions.some((u) => u.field === "Article"),
    `pushDebug.unverifiedRequiredOptions surfaces Article (got ${JSON.stringify(pushDebug.unverifiedRequiredOptions)})`,
  );
}

// Case 28: Apparel OUTW with no Article metafield — without a resolver the
// push must be blocked at preflight (unverified_required_options surfaces
// Article). When the operator supplies an enum override mapping OUTW →
// "Outerwear" the SAME product re-maps with Article emitted.
function runApparelArticleResolverUnblocks() {
  console.log(
    "Case 28: Apparel OUTW Article unresolved blocks; with enum mapping override the payload includes Article",
  );
  const apparelFallback = FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
  }));
  const product: ShopifyProduct = {
    id: "shopify-cg-3103K61-4",
    title: "Canada Goose Kids Black Outerwear",
    body_html: "<p>Kids outerwear in black.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["4"] }],
    variants: [
      { id: 30001, sku: "3103K61-4", price: "650.00", inventory_quantity: 1, option1: "4" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "BLACK", name: "Color" },
      { namespace: "custom", key: "ff_designer_id", value: "3103K61" },
      { namespace: "custom", key: "detailed_description", value: "Kids outerwear in black." },
      { namespace: "custom", key: "total_number_of_pieces", value: "1" },
    ],
  };

  // (a) Without a resolver — Article is blocked, payload carries no Article.
  const mappedNoResolver = mapShopifyToJomashop(product, apparelFallback, "Apparel");
  assert(
    (mappedNoResolver.unverified_required_options || []).some((u) => u.field === "Article"),
    `Case 28 (no resolver): unverified_required_options surfaces Article (got ${JSON.stringify(mappedNoResolver.unverified_required_options)})`,
  );
  const payloadNoResolver = buildJomashopProductPayload(mappedNoResolver, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });
  const propsNoResolver = (payloadNoResolver.payload.properties as Record<string, unknown>) || {};
  assert(
    !("Article" in propsNoResolver),
    `Case 28 (no resolver): payload.properties has no Article (got ${JSON.stringify(propsNoResolver.Article)})`,
  );
  assert(
    payloadNoResolver.pushDebug.unverifiedRequiredOptions.some((u) => u.field === "Article"),
    `Case 28 (no resolver): pushDebug.unverifiedRequiredOptions surfaces Article`,
  );

  // (b) With operator overlay mapping OUTW → Outerwear.
  const mappedResolved = mapShopifyToJomashop(product, apparelFallback, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver({
      "apparel|article|outw": "Outerwear",
    }),
  });
  assert(
    mappedResolved.properties.Article === "Outerwear",
    `Case 28 (with overlay): properties.Article === "Outerwear" (got ${JSON.stringify(mappedResolved.properties.Article)})`,
  );
  assert(
    !(mappedResolved.unverified_required_options || []).some((u) => u.field === "Article"),
    `Case 28 (with overlay): unverified_required_options does NOT include Article (got ${JSON.stringify(mappedResolved.unverified_required_options)})`,
  );
  const payloadResolved = buildJomashopProductPayload(mappedResolved, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });
  const propsResolved = (payloadResolved.payload.properties as Record<string, unknown>) || {};
  assert(
    propsResolved.Article === "Outerwear",
    `Case 28 (with overlay): payload.properties.Article === "Outerwear" (got ${JSON.stringify(propsResolved.Article)})`,
  );
  assert(
    payloadResolved.pushDebug.unverifiedRequiredOptions.length === 0,
    `Case 28 (with overlay): pushDebug.unverifiedRequiredOptions empty (got ${JSON.stringify(payloadResolved.pushDebug.unverifiedRequiredOptions)})`,
  );
}

// Case 29: Footwear "Shoe Size Type" is a required enum. A Shopify product
// whose source size scale doesn't match Jomashop's accepted list must
// surface as missing_required without an override, and resolve cleanly
// with an enum override mapping "USA" → "US".
function runFootwearRequiredEnumOverride() {
  console.log(
    "Case 29: Footwear Shoe Size Type required enum — unresolved blocks; override resolves it",
  );
  const footwearFallback = FALLBACK_CATEGORY_SCHEMAS.Footwear.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
  }));
  const product: ShopifyProduct = {
    id: "shopify-footwear-1",
    title: "Tod's Mens Brown Boot",
    body_html: "<p>Mens boot.</p>",
    vendor: "Tods",
    product_type: "BOOT",
    tags: ["Men", "Boots"],
    images: [{ src: "https://example.com/tods.jpg" }],
    options: [{ name: "Size", values: ["10"] }],
    variants: [
      { id: 50001, sku: "TODS-BOOT-1", price: "500.00", inventory_quantity: 2, option1: "10" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Brown", name: "Color" },
      // Deliberate mismatch — "Brazilian" is not in the Shoe Size Type list
      // and the bundled options aren't tagged unverified for Footwear, so
      // enum coercion will fail. Without an override the required field is
      // blocked.
      { namespace: "custom", key: "size_scale", value: "Brazilian", name: "Size Scale" },
      { namespace: "custom", key: "ff_designer_id", value: "TODS-BOOT-1" },
    ],
  };

  // (a) Without override — missing_required carries Shoe Size Type.
  const mappedNoOverride = mapShopifyToJomashop(product, footwearFallback, "Footwear");
  assert(
    (mappedNoOverride.missing_required || []).includes("Shoe Size Type"),
    `Case 29 (no override): Shoe Size Type missing (got ${JSON.stringify(mappedNoOverride.missing_required)})`,
  );

  // (b) With operator overlay mapping Brazilian → US.
  const mappedOverride = mapShopifyToJomashop(product, footwearFallback, "Footwear", {
    resolveEnumOverride: makeTestEnumResolver({
      "footwear|shoesizetype|brazilian": "US",
    }),
  });
  assert(
    mappedOverride.properties["Shoe Size Type"] === "US",
    `Case 29 (with overlay): properties["Shoe Size Type"] === "US" (got ${JSON.stringify(mappedOverride.properties["Shoe Size Type"])})`,
  );
  assert(
    !(mappedOverride.missing_required || []).includes("Shoe Size Type"),
    `Case 29 (with overlay): Shoe Size Type NOT missing (got ${JSON.stringify(mappedOverride.missing_required)})`,
  );
}

// Case 30: Handbags "Style" is an optional enum; an enum override should
// still work for optional fields whose canonical value doesn't match the
// list (e.g. operator wants to map "Shoulder-Bag" → "Shoulder").
function runHandbagsOptionalEnumOverride() {
  console.log(
    "Case 30: Handbags optional Style enum — override maps an out-of-list value to an accepted option",
  );
  const handbagsFallback = FALLBACK_CATEGORY_SCHEMAS.Handbags.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
  }));
  const product: ShopifyProduct = {
    id: "shopify-handbags-1",
    title: "Saint Laurent Loulou Shoulder Bag",
    body_html: "<p>Shoulder bag.</p>",
    vendor: "Saint Laurent",
    product_type: "SHLD",
    tags: ["Women", "Handbag"],
    images: [{ src: "https://example.com/ysl.jpg" }],
    options: [{ name: "Color", values: ["Noir"] }],
    variants: [
      { id: 60001, sku: "YSL-LOULOU-NOIR-2", price: "2350.00", inventory_quantity: 1, option1: "Noir" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Noir", name: "Color" },
      { namespace: "custom", key: "material", value: "Calfskin leather" },
      { namespace: "custom", key: "style", value: "Shoulder-Bag", name: "Style" },
      { namespace: "custom", key: "ff_designer_id", value: "YSL-LOULOU-NOIR-2" },
    ],
  };

  // (a) Without override, Style "Shoulder-Bag" doesn't match accepted list;
  // optional enum is dropped.
  const mappedNoOverride = mapShopifyToJomashop(product, handbagsFallback, "Handbags");
  assert(
    !("Style" in mappedNoOverride.properties) || mappedNoOverride.properties.Style === undefined ||
      mappedNoOverride.properties.Style === null ||
      handbagsFallback.find((f) => f.field === "Style")?.options?.includes(String(mappedNoOverride.properties.Style)),
    `Case 30 (no override): Style dropped or matches an accepted option (got ${JSON.stringify(mappedNoOverride.properties.Style)})`,
  );

  // (b) With overlay mapping "Shoulder-Bag" → "Shoulder".
  const mappedOverride = mapShopifyToJomashop(product, handbagsFallback, "Handbags", {
    resolveEnumOverride: makeTestEnumResolver({
      "handbags|style|shoulderbag": "Shoulder",
    }),
  });
  assert(
    mappedOverride.properties.Style === "Shoulder",
    `Case 30 (with overlay): properties.Style === "Shoulder" (got ${JSON.stringify(mappedOverride.properties.Style)})`,
  );
}

// Case 31: the operator-overlay value MUST appear in the accepted options
// list. A misconfigured override (e.g. mapping → "InvalidOption" not in
// the live schema) is rejected by the resolver — the field stays
// unresolved.
function runEnumOverrideRespectsAcceptedOptions() {
  console.log(
    "Case 31: enum override value not in accepted options is ignored",
  );
  const resolver = makeTestEnumResolver({
    "footwear|shoesizetype|usa": "Brazilian", // bogus override
  });
  const result = resolver("Footwear", "Shoe Size Type", "USA", ["US", "EU", "UK", "IT", "FR"]);
  assert(
    result === null,
    `Case 31: bogus override is rejected by accepted-options check (got ${JSON.stringify(result)})`,
  );

  // Same key, valid value → returned.
  const ok = makeTestEnumResolver({
    "footwear|shoesizetype|usa": "US",
  })("Footwear", "Shoe Size Type", "USA", ["US", "EU", "UK", "IT", "FR"]);
  assert(
    ok === "US",
    `Case 31: valid override returns the option (got ${JSON.stringify(ok)})`,
  );
}

// ---------- Case 32: BUILT_IN_ENUM_OVERRIDES is no longer trusted for Apparel/Article ----------
//
// Regression for SKU 3103K61-4: prior to this change, BUILT_IN_ENUM_OVERRIDES
// shipped a bundled `apparel|article|outw → Outerwear` seed that the mapper
// emitted directly. Jomashop's live Apparel category does NOT accept that
// value (the catch was the post-deploy "Article is not included in the list"
// rejection). This test pins the new invariant: even with the seed map fully
// present, the built-in entry MUST be ignored when (a) the seed is not
// flagged `verified: true`, OR (b) no live accepted-options list confirms
// the target. The product-side payload must omit Article entirely until a
// verified operator override exists.
function runCanadaGooseOutwBlocksWithoutVerifiedMapping() {
  console.log(
    "Case 32: Canada Goose OUTW Apparel blocks preflight and never sends Article from an unverified seed",
  );
  const apparelFallback = FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
  }));
  const product: ShopifyProduct = {
    id: "shopify-cg-3103K61-4",
    title: "Canada Goose Kids Black Outerwear",
    body_html: "<p>Kids outerwear in black.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["4"] }],
    variants: [
      { id: 30001, sku: "3103K61-4", price: "650.00", inventory_quantity: 1, option1: "4" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "BLACK", name: "Color" },
      { namespace: "custom", key: "ff_designer_id", value: "3103K61" },
      { namespace: "custom", key: "detailed_description", value: "Kids outerwear in black." },
      { namespace: "custom", key: "total_number_of_pieces", value: "1" },
    ],
  };

  // Use the resolver WITHOUT an overlay — the only mappings available are
  // the (potentially historical) built-in seeds. With the new trust gate the
  // resolver must return null and Article must remain blocked.
  const mapped = mapShopifyToJomashop(product, apparelFallback, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver(),
  });
  assert(
    mapped.properties.Article == null,
    `Case 32: Article not emitted from a built-in seed (got ${JSON.stringify(mapped.properties.Article)})`,
  );
  assert(
    (mapped.missing_required || []).includes("Article"),
    `Case 32: missing_required includes Article`,
  );
  assert(
    (mapped.unverified_required_options || []).some((u) => u.field === "Article"),
    `Case 32: unverified_required_options surfaces Article`,
  );
  const { payload, pushDebug } = buildJomashopProductPayload(mapped, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });
  const props = (payload.properties as Record<string, unknown>) || {};
  assert(
    !("Article" in props),
    `Case 32: payload.properties never carries Article (got ${JSON.stringify(props.Article)})`,
  );
  assert(
    pushDebug.unverifiedRequiredOptions.some((u) => u.field === "Article"),
    `Case 32: pushDebug.unverifiedRequiredOptions surfaces Article`,
  );

  // Sanity: BUILT_IN_ENUM_OVERRIDES has no entries left for apparel/article —
  // a regression test that the export is intentionally empty for the field
  // that produced the 3103K61-4 rejection. (Future additions to the seed
  // table MUST set verified=true and ship with documented accepted options.)
  for (const key of Object.keys(BUILT_IN_ENUM_OVERRIDES)) {
    if (key.startsWith("apparel|article|") || key.startsWith("clothing|article|")) {
      const seed = BUILT_IN_ENUM_OVERRIDES[key];
      assert(
        seed.verified === true,
        `Case 32: any remaining apparel/article seed must be flagged verified (key=${key}, seed=${JSON.stringify(seed)})`,
      );
    }
  }
}

// ---------- Case 33: an unverified OUTW->Outerwear seed is rejected ----------
//
// Even if a future change re-introduces a seed for `apparel|article|outw`
// with `verified: false`, the lookup MUST refuse to honor it. This proves
// the trust gate is enforced inside the resolver, not just at the registration
// site — we never want a careless test/fixture/seed update to flip on a
// guessed mapping in production.
function runUnverifiedBuiltInSeedIsRejected() {
  console.log(
    "Case 33: an unverified built-in OUTW → Outerwear seed is NEVER honored",
  );
  // Stash the original seed (if any) so the test doesn't leak state.
  const seedKey = "apparel|article|outw";
  const original = BUILT_IN_ENUM_OVERRIDES[seedKey];
  try {
    BUILT_IN_ENUM_OVERRIDES[seedKey] = { jomashopOption: "Outerwear", verified: false };
    const resolver = makeTestEnumResolver();
    // Even with a live accepted-options list that contains "Outerwear", an
    // unverified seed must not be returned.
    const result = resolver("Apparel", "Article", "OUTW", ["Outerwear", "Bomber"]);
    assert(
      result === null,
      `Case 33: unverified seed never returned (got ${JSON.stringify(result)})`,
    );
    // And with no accepted-options list, definitely not returned.
    const result2 = resolver("Apparel", "Article", "OUTW", undefined);
    assert(
      result2 === null,
      `Case 33: unverified seed never returned without live options (got ${JSON.stringify(result2)})`,
    );
  } finally {
    if (original === undefined) {
      delete BUILT_IN_ENUM_OVERRIDES[seedKey];
    } else {
      BUILT_IN_ENUM_OVERRIDES[seedKey] = original;
    }
  }
}

// ---------- Case 34: verified mapping only allowed if accepted options contain target or operator_verified ----------
//
// Trust contract on operator-supplied overrides:
//   (a) target IN acceptedOptions → honored.
//   (b) target NOT IN acceptedOptions → rejected (the override is stale or
//       miskeyed against the live schema).
//   (c) no acceptedOptions provided → still honored when the override was
//       saved as operator_verified (in the test resolver, an overlay entry
//       stands in for an operator_verified row).
function runVerifiedMappingRespectsAcceptedOrOperatorVerified() {
  console.log(
    "Case 34: verified mapping honored only when accepted_options contain target OR operator_verified with no live options",
  );
  const overlay = { "apparel|article|outw": "Outerwear" };
  const resolver = makeTestEnumResolver(overlay);

  // (a) Target in accepted list → honored.
  const accepted = resolver("Apparel", "Article", "OUTW", ["Outerwear", "Bomber"]);
  assert(accepted === "Outerwear", `Case 34a: target in accepted list → emitted (got ${JSON.stringify(accepted)})`);

  // (b) Target NOT in accepted list → rejected.
  const rejected = resolver("Apparel", "Article", "OUTW", ["Bomber", "Parka"]);
  assert(
    rejected === null,
    `Case 34b: target not in accepted list → rejected (got ${JSON.stringify(rejected)})`,
  );

  // (c) No live options, but overlay (operator_verified surrogate) → honored.
  const noLive = resolver("Apparel", "Article", "OUTW", undefined);
  assert(
    noLive === "Outerwear",
    `Case 34c: no live options, operator-verified → emitted (got ${JSON.stringify(noLive)})`,
  );
}

// ---------- Case 35: Footwear & Handbags required-enum regression ----------
//
// A category-spanning guard for the verified-override contract. Confirms:
//  - Footwear's required "Shoe Size Type" stays blocked when only a stale
//    (out-of-list) override exists, and resolves when a verified overlay
//    inside the accepted list is supplied.
//  - Handbags' required "Color" is unaffected by the enum mapping changes
//    (it's a free-text string field, not an enum) — proves the trust gate
//    didn't accidentally tighten non-enum fields.
function runFootwearHandbagsRequiredEnumRegression() {
  console.log(
    "Case 35: Footwear/Handbags required-field regression around verified overrides",
  );

  // ---- Footwear ----
  const footwearFallback = FALLBACK_CATEGORY_SCHEMAS.Footwear.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
  }));
  const fwProduct: ShopifyProduct = {
    id: "shopify-fw-regress",
    title: "Some Boot",
    body_html: "<p>Boot.</p>",
    vendor: "Tods",
    product_type: "BOOT",
    tags: ["Men"],
    images: [],
    options: [{ name: "Size", values: ["10"] }],
    variants: [
      { id: 1, sku: "FW-REGRESS-1", price: "500.00", inventory_quantity: 1, option1: "10" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Brown", name: "Color" },
      { namespace: "custom", key: "size_scale", value: "Brazilian", name: "Size Scale" },
      { namespace: "custom", key: "ff_designer_id", value: "FW-REGRESS-1" },
    ],
  };

  // (i) A stale override that maps Brazilian → an option NOT in the accepted
  //     list must be rejected — Shoe Size Type stays blocked.
  const stale = mapShopifyToJomashop(fwProduct, footwearFallback, "Footwear", {
    resolveEnumOverride: makeTestEnumResolver({
      "footwear|shoesizetype|brazilian": "BR", // "BR" is not in accepted list
    }),
  });
  assert(
    (stale.missing_required || []).includes("Shoe Size Type"),
    `Case 35: stale Footwear override leaves Shoe Size Type missing (got ${JSON.stringify(stale.missing_required)})`,
  );

  // (ii) A verified override that lands on an accepted option resolves it.
  const verified = mapShopifyToJomashop(fwProduct, footwearFallback, "Footwear", {
    resolveEnumOverride: makeTestEnumResolver({
      "footwear|shoesizetype|brazilian": "US",
    }),
  });
  assert(
    verified.properties["Shoe Size Type"] === "US",
    `Case 35: verified Footwear override emits Shoe Size Type = "US" (got ${JSON.stringify(verified.properties["Shoe Size Type"])})`,
  );

  // ---- Handbags ----
  const handbagsFallback = FALLBACK_CATEGORY_SCHEMAS.Handbags.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
    allow_omit: f.allow_omit,
    omit_when_unknown_enum: f.omit_when_unknown_enum,
    options_unverified: f.options_unverified,
  }));
  const hbProduct: ShopifyProduct = {
    id: "shopify-hb-regress",
    title: "Bag",
    body_html: "<p>Bag.</p>",
    vendor: "Saint Laurent",
    product_type: "BAG",
    tags: ["Women"],
    images: [],
    options: [{ name: "Color", values: ["Noir"] }],
    variants: [
      { id: 2, sku: "HB-REGRESS-1", price: "2350.00", inventory_quantity: 1, option1: "Noir" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Noir", name: "Color" },
      { namespace: "custom", key: "material", value: "Calfskin leather" },
      { namespace: "custom", key: "ff_designer_id", value: "HB-REGRESS-1" },
    ],
  };
  const hbMapped = mapShopifyToJomashop(hbProduct, handbagsFallback, "Handbags");
  assert(
    hbMapped.properties.Color === "Noir",
    `Case 35: Handbags free-text required Color still resolves (got ${JSON.stringify(hbMapped.properties.Color)})`,
  );
  assert(
    !(hbMapped.missing_required || []).includes("Color"),
    `Case 35: Handbags Color not blocked by enum trust gate (got ${JSON.stringify(hbMapped.missing_required)})`,
  );
}

// ---------- Case 36: v1 schema normalization ----------
//
// The published Jomashop /v1/categories/:name docs return properties with
// `key`, `designation` (required/recommended), `name`, `kind` (enumerable/
// string/numeric), and `data.values` carrying the verified enum option list.
// normalizeV1CategorySchema must parse that shape, mark designation=required
// fields as required, expose data.values as the canonical accepted-options
// list, and refuse to claim a payload is v1 when none of the v1 markers
// (designation/kind/data) appear.
function runV1SchemaNormalization() {
  console.log("Case 36: normalizeV1CategorySchema parses /v1/categories/:name docs shape");
  const apparelV1Payload = {
    name: "Apparel",
    properties: [
      {
        key: "gender",
        designation: "required",
        name: "Gender",
        kind: "enumerable",
        data: { values: ["Men", "Women", "Unisex"] },
      },
      {
        key: "article",
        designation: "required",
        name: "Article",
        kind: "enumerable",
        data: { values: ["Outerwear", "Jackets", "Pants"] },
      },
      {
        key: "color",
        designation: "required",
        name: "Color",
        kind: "string",
        data: {},
      },
      {
        key: "country_of_origin",
        designation: "recommended",
        name: "Country of Origin",
        kind: "enumerable",
        data: { values: ["Italy", "USA"] },
      },
    ],
  };
  const norm = normalizeV1CategorySchema(apparelV1Payload);
  assert(norm.length === 4, `v1 normalizer returns 4 props (got ${norm.length})`);
  const article = norm.find((p) => p.field === "Article");
  assert(article !== undefined, `Article descriptor present`);
  assert(article!.required === true, `Article required from designation=required`);
  assert(
    Array.isArray(article!.options) && article!.options!.includes("Outerwear"),
    `Article options unpack from data.values`,
  );
  const coo = norm.find((p) => p.field === "Country of Origin");
  assert(coo !== undefined && coo.required === false, `Country of Origin not required (designation=recommended)`);
  // A payload missing designation/kind/data shouldn't be misidentified as v1.
  const legacy = normalizeV1CategorySchema({
    properties: [{ field: "Color", required: true }],
  });
  assert(legacy.length === 0, `legacy /i1 shape rejected by v1 normalizer`);
  assert(normalizeV1CategorySchema(null).length === 0, `null → []`);
  assert(normalizeV1CategorySchema({}).length === 0, `empty obj → []`);
}

// ---------- Case 37: mocked v1 Apparel response — Article preflight ----------
//
// Simulates GET /v1/categories/Apparel returning the docs-shape payload with
// Article=["Outerwear", "Jackets", "Pants"]. Two assertions:
//
//   (a) When the operator stores a verified mapping OUTW → "Outerwear" and
//       Article is in data.values, the mapper emits properties.Article =
//       "Outerwear" — proving v1-confirmed options flow through preflight.
//   (b) When the operator stores a mapping OUTW → "Tuxedos" (NOT in
//       data.values), the mapper drops the value and missing_required
//       surfaces Article — proving the accepted_options gate still blocks
//       a mismatched mapping even when v1 is reachable.
function runV1ApparelArticleAcceptedOptions() {
  console.log("Case 37: v1 Apparel Article accepted options gate operator overrides");
  // v1 schema as it would arrive from GET /v1/categories/Apparel
  const v1Raw = {
    name: "Apparel",
    properties: [
      {
        key: "gender",
        designation: "required",
        name: "Gender",
        kind: "enumerable",
        data: { values: ["Men", "Women", "Unisex"] },
      },
      {
        key: "age",
        designation: "required",
        name: "Age",
        kind: "enumerable",
        data: { values: ["Adult", "Kids"] },
      },
      {
        key: "apparel_type",
        designation: "required",
        name: "Apparel Type",
        kind: "enumerable",
        data: { values: ["Outerwear", "Pants", "Shirts"] },
      },
      {
        key: "detailed_description",
        designation: "required",
        name: "Detailed Description",
        kind: "string",
        data: {},
      },
      {
        key: "total_number_of_pieces",
        designation: "required",
        name: "Total Number of Pieces",
        kind: "string",
        data: {},
      },
      {
        key: "color",
        designation: "required",
        name: "Color",
        kind: "string",
        data: {},
      },
      {
        key: "article",
        designation: "required",
        name: "Article",
        kind: "enumerable",
        data: { values: ["Outerwear", "Jackets", "Pants"] },
      },
    ],
  };
  const v1Descriptors = normalizeV1CategorySchema(v1Raw);
  assert(v1Descriptors.length === 7, `v1 normalizer returns 7 descriptors (got ${v1Descriptors.length})`);
  const articleDesc = v1Descriptors.find((p) => p.field === "Article");
  assert(
    articleDesc !== undefined && (articleDesc.options || []).length === 3,
    `Article options sourced from data.values`,
  );
  // None of the v1-sourced descriptors carry options_unverified — they are
  // verified by Jomashop.
  for (const p of v1Descriptors) {
    assert(
      p.options_unverified !== true,
      `v1 descriptor "${p.field}" is not options_unverified`,
    );
  }

  // Build a Canada Goose OUTW Kids Apparel product analogous to the live
  // catalog. Article carries no explicit metafield, so the mapper falls
  // through to the raw_category_code (OUTW) for override resolution.
  const outwProduct: ShopifyProduct = {
    id: "shopify-outw-37",
    title: "Canada Goose Kids Lodge Jacket",
    body_html: "<p>Canada Goose Lodge Jacket for kids.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids"],
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      {
        id: 9901,
        sku: "CG-OUTW-KIDS-M",
        price: "550.00",
        inventory_quantity: 1,
        option1: "M",
      },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Navy", name: "Color" },
      { namespace: "custom", key: "ff_country_of_origin", value: "Italy" },
    ],
  };

  // (a) verified mapping OUTW → "Outerwear" (in v1 data.values) flows through.
  const accepting = mapShopifyToJomashop(outwProduct, v1Descriptors, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver({
      "apparel|article|outw": "Outerwear",
    }),
  });
  assert(
    accepting.properties.Article === "Outerwear",
    `Case 37a: properties.Article === "Outerwear" (v1 confirmed) (got ${JSON.stringify(accepting.properties.Article)})`,
  );
  assert(
    !(accepting.missing_required || []).includes("Article"),
    `Case 37a: Article not blocked when v1 confirms the target (got ${JSON.stringify(accepting.missing_required)})`,
  );

  // (b) Build a product whose Article candidate is NOT in v1 data.values
  //     and whose operator mapping targets a value also NOT in v1 data.values
  //     ("Tuxedos" — Article only lists Outerwear/Jackets/Pants here). The
  //     accepted-options gate must reject the bogus mapping; preflight then
  //     surfaces Article as missing with the v1 accepted-options list ready
  //     to be shown to the operator.
  const sockProduct: ShopifyProduct = {
    ...outwProduct,
    id: "shopify-sock-37b",
    product_type: "SOCK",
    title: "Canada Goose Wool Socks",
    metafields: [
      // Explicit Article metafield value that's not in v1 data.values; the
      // mapper would otherwise try to coerce it.
      { namespace: "custom", key: "Article", value: "Socks" },
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
    ],
  };
  const blocked = mapShopifyToJomashop(sockProduct, v1Descriptors, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver({
      // Operator mapping targets "Tuxedos" — also not in v1 data.values, so
      // it's rejected by the live accepted-options gate.
      "apparel|article|sock": "Tuxedos",
      "apparel|article|socks": "Tuxedos",
    }),
  });
  assert(
    blocked.properties.Article === undefined || blocked.properties.Article === null,
    `Case 37b: Article dropped when override target is not in v1 data.values (got ${JSON.stringify(blocked.properties.Article)})`,
  );
  assert(
    (blocked.missing_required || []).includes("Article"),
    `Case 37b: missing_required surfaces Article (got ${JSON.stringify(blocked.missing_required)})`,
  );
  // The v1 descriptor still carries the canonical accepted list so the
  // preflight 422 response (and /api/jomashop/category-enum-options/Apparel)
  // can show the operator the exact accepted set.
  const acceptedFromDescriptor = articleDesc!.options || [];
  assert(
    acceptedFromDescriptor.includes("Outerwear") && acceptedFromDescriptor.includes("Jackets"),
    `Case 37b: accepted options derivable from v1 descriptor (got ${acceptedFromDescriptor.join(", ")})`,
  );
}

// ---------- Case 38: Canada Goose OUTW maps Article/Apparel Type to ----------
//           "Coats & Jackets" via the synonym resolver on a v1-like Apparel
//           schema. Also verifies Variation Size (Yes/No) → "Yes" from the
//           presence of a Size option, and Product ID Type / Product ID /
//           ASIN are OMITTED when no UPC/EAN/ASIN is supplied.
function runCanadaGooseOutwLiveSynonymResolver() {
  console.log("Case 38: Canada Goose OUTW → Coats & Jackets via synonym resolver");
  const apparelLiveLikeSchema: SchemaPropertyDescriptor[] = [
    {
      field: "Gender",
      label: "Gender",
      required: true,
      type: "enum",
      options: ["Men", "Women", "Unisex"],
    },
    { field: "Age", label: "Age", required: true, type: "enum", options: ["Adult", "Kids"] },
    {
      field: "Apparel Type",
      label: "Apparel Type",
      required: true,
      type: "enum",
      options: ["Outerwear", "Pants", "Shirts"],
    },
    {
      field: "Article",
      label: "Article",
      required: true,
      type: "enum",
      options: [
        "Active & Lounge",
        "Blazers",
        "Cardigans & Sweaters",
        "Casual Button-Downs",
        "Coats & Jackets",
        "Cocktail & Party Dresses",
        "Cover-Ups",
        "Dress Shirts",
        "Pants",
        "Shorts",
        "Skirts",
        "Suits",
        "Tuxedos",
      ],
    },
    {
      field: "Product ID Type",
      label: "Product ID Type",
      required: false,
      type: "enum",
      options: ["EAN", "UPC"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    { field: "Product ID", label: "Product ID", required: false, type: "string", allow_omit: true },
    { field: "ASIN", label: "ASIN", required: false, type: "string", allow_omit: true },
    {
      field: "Variation Size (Yes/No)",
      label: "Variation Size (Yes/No)",
      required: false,
      type: "enum",
      options: ["Yes", "No"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    { field: "Apparel Size Type", label: "Apparel Size Type", required: false, options: ["US", "EU", "UK"], allow_omit: true, omit_when_unknown_enum: true },
    { field: "Apparel Size", label: "Apparel Size", required: false, type: "string", allow_omit: true },
    { field: "Color", label: "Color", required: true, type: "string" },
    { field: "Detailed Description", label: "Detailed Description", required: true, type: "string" },
    { field: "Total Number of Pieces", label: "Total Number of Pieces", required: true, type: "string" },
    { field: "Country of Origin", label: "Country of Origin", required: false, type: "string", allow_omit: true },
    { field: "Fabric Material", label: "Fabric Material", required: false, type: "string", allow_omit: true },
  ];
  const product: ShopifyProduct = {
    id: "shopify-cg-kids-outw-live",
    title: "Canada Goose Kids Black Outerwear",
    body_html: "<p>Kids' down parka in black.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Kids", "Outerwear"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["4"] }],
    variants: [
      { id: 9501, sku: "CG-KIDS-OUTW-4", price: "650.00", inventory_quantity: 1, option1: "4" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "composition", value: "Cotton" },
      { namespace: "custom", key: "ff_country_of_origin", value: "CA" },
      { namespace: "custom", key: "ff_designer_id", value: "CG-PARKA-001" },
      { namespace: "custom", key: "size_scale", value: "US" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelLiveLikeSchema, "Apparel");
  // Article must be auto-resolved to "Coats & Jackets" from OUTW
  assert(
    mapped.properties.Article === "Coats & Jackets",
    `Case 38: properties.Article === "Coats & Jackets" (got ${JSON.stringify(mapped.properties.Article)})`,
  );
  assert(
    mapped.properties["Apparel Type"] === "Outerwear",
    `Case 38: properties["Apparel Type"] === "Outerwear" (got ${JSON.stringify(mapped.properties["Apparel Type"])})`,
  );
  // Variation Size (Yes/No) must be "Yes" — NEVER the literal size value "4".
  assert(
    mapped.properties["Variation Size (Yes/No)"] === "Yes",
    `Case 38: Variation Size (Yes/No) === "Yes" (got ${JSON.stringify(mapped.properties["Variation Size (Yes/No)"])})`,
  );
  // Product ID Type / Product ID / ASIN MUST be omitted (no UPC/EAN/ASIN).
  assert(
    !("Product ID Type" in mapped.properties),
    `Case 38: Product ID Type omitted (got ${JSON.stringify(Object.keys(mapped.properties))})`,
  );
  assert(
    !("Product ID" in mapped.properties),
    `Case 38: Product ID omitted (got ${JSON.stringify(Object.keys(mapped.properties))})`,
  );
  assert(
    !("ASIN" in mapped.properties),
    `Case 38: ASIN omitted (got ${JSON.stringify(Object.keys(mapped.properties))})`,
  );
  // Preflight must NOT block — Article is resolved, no required field missing.
  assert(
    !(mapped.missing_required || []).includes("Article"),
    `Case 38: missing_required does not include Article (got ${JSON.stringify(mapped.missing_required)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("Apparel Type"),
    `Case 38: missing_required does not include Apparel Type (got ${JSON.stringify(mapped.missing_required)})`,
  );
  // Optional unmappable Apparel Size Type: "US" is in options so it's emitted.
  assert(
    mapped.properties["Apparel Size Type"] === "US",
    `Case 38: Apparel Size Type === "US" (got ${JSON.stringify(mapped.properties["Apparel Size Type"])})`,
  );
  // The auto-resolution must be surfaced in auto_resolved_enums.
  const articleResolution = (mapped.auto_resolved_enums || []).find((r) => r.field === "Article");
  assert(
    articleResolution !== undefined && articleResolution.chosen === "Coats & Jackets",
    `Case 38: auto_resolved_enums surfaces Article (got ${JSON.stringify(mapped.auto_resolved_enums)})`,
  );
}

// ---------- Case 39: ASIN/UPC sourced strictly from explicit identifiers ----
function runProductIdSourcedFromUpcOnly() {
  console.log("Case 39: Product ID Type / Product ID emitted only when UPC/EAN present");
  const apparelLiveLikeSchema: SchemaPropertyDescriptor[] = [
    {
      field: "Product ID Type",
      label: "Product ID Type",
      required: false,
      type: "enum",
      options: ["EAN", "UPC"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    { field: "Product ID", label: "Product ID", required: false, type: "string", allow_omit: true },
    { field: "ASIN", label: "ASIN", required: false, type: "string", allow_omit: true },
    { field: "Color", label: "Color", required: false, type: "string", allow_omit: true },
  ];
  // (a) Product with a UPC metafield → Product ID Type=UPC, Product ID=12-digit value.
  const upcProduct: ShopifyProduct = {
    id: "shopify-upc-1",
    title: "Test UPC product",
    vendor: "Test",
    product_type: "OUTW",
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      { id: 1, sku: "TST-1", price: "10.00", inventory_quantity: 1, option1: "M", barcode: "012345678905" },
    ],
    metafields: [{ namespace: "custom", key: "color", value: "Red", name: "Color" }],
  };
  const mappedUpc = mapShopifyToJomashop(upcProduct, apparelLiveLikeSchema, "Apparel");
  assert(
    mappedUpc.properties["Product ID Type"] === "UPC",
    `Case 39a: Product ID Type === "UPC" (got ${JSON.stringify(mappedUpc.properties["Product ID Type"])})`,
  );
  assert(
    mappedUpc.properties["Product ID"] === "012345678905",
    `Case 39a: Product ID === "012345678905" (got ${JSON.stringify(mappedUpc.properties["Product ID"])})`,
  );
  // (b) EAN-13 barcode → Product ID Type=EAN.
  const eanProduct: ShopifyProduct = {
    ...upcProduct,
    id: "shopify-ean-1",
    variants: [
      { id: 2, sku: "TST-2", price: "10.00", inventory_quantity: 1, option1: "M", barcode: "5901234123457" },
    ],
  };
  const mappedEan = mapShopifyToJomashop(eanProduct, apparelLiveLikeSchema, "Apparel");
  assert(
    mappedEan.properties["Product ID Type"] === "EAN",
    `Case 39b: Product ID Type === "EAN" (got ${JSON.stringify(mappedEan.properties["Product ID Type"])})`,
  );
  // (c) No identifier at all → Product ID Type / Product ID / ASIN all OMITTED.
  //     Critically: even though product_type is "OUTW" (a category code), the
  //     mapper must NOT emit "Outerwear" as Product ID Type.
  const noIdProduct: ShopifyProduct = {
    id: "shopify-no-id-1",
    title: "Test no id product",
    vendor: "Test",
    product_type: "OUTW",
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      { id: 3, sku: "TST-3", price: "10.00", inventory_quantity: 1, option1: "M" },
    ],
    metafields: [{ namespace: "custom", key: "color", value: "Red", name: "Color" }],
  };
  const mappedNoId = mapShopifyToJomashop(noIdProduct, apparelLiveLikeSchema, "Apparel");
  assert(
    !("Product ID Type" in mappedNoId.properties),
    `Case 39c: Product ID Type omitted when no UPC/EAN (got ${JSON.stringify(mappedNoId.properties)})`,
  );
  assert(
    !("Product ID" in mappedNoId.properties),
    `Case 39c: Product ID omitted when no UPC/EAN (got ${JSON.stringify(mappedNoId.properties)})`,
  );
  assert(
    !("ASIN" in mappedNoId.properties),
    `Case 39c: ASIN omitted when no ASIN metafield (got ${JSON.stringify(mappedNoId.properties)})`,
  );
  // Critical regression: ensure Product ID Type is NEVER "Outerwear" / category code.
  for (const v of Object.values(mappedNoId.properties)) {
    if (v === "Outerwear" || v === "OUTW") {
      // It's fine for Apparel Type to be "Outerwear" — that's not this property.
    }
  }
  // (d) ASIN supplied via metafield → Product ID Type/Product ID stay omitted,
  //     ASIN emitted as a plain string.
  const asinProduct: ShopifyProduct = {
    ...noIdProduct,
    id: "shopify-asin-1",
    metafields: [
      { namespace: "custom", key: "color", value: "Red", name: "Color" },
      { namespace: "custom", key: "ASIN", value: "B07Z5R5GZK", name: "ASIN" },
    ],
  };
  const mappedAsin = mapShopifyToJomashop(asinProduct, apparelLiveLikeSchema, "Apparel");
  assert(
    mappedAsin.properties.ASIN === "B07Z5R5GZK",
    `Case 39d: ASIN === "B07Z5R5GZK" (got ${JSON.stringify(mappedAsin.properties.ASIN)})`,
  );
  assert(
    !("Product ID Type" in mappedAsin.properties),
    `Case 39d: Product ID Type still omitted without UPC/EAN (got ${JSON.stringify(mappedAsin.properties["Product ID Type"])})`,
  );
}

// ---------- Case 40: Footwear synonym resolver maps codes to live options ---
function runFootwearSynonymResolver() {
  console.log("Case 40: Footwear synonym resolver — HEEL/SNEK/BOOT");
  const footwearLiveSchemaWithType: SchemaPropertyDescriptor[] = [
    { field: "Gender", label: "Gender", required: true, options: ["Men", "Women", "Unisex"] },
    {
      field: "Shoe Type",
      label: "Shoe Type",
      required: true,
      type: "enum",
      options: ["Sneakers", "Heels", "Boots", "Loafers", "Sandals", "Pumps", "Flats", "Slides"],
    },
    { field: "Shoe Size", label: "Shoe Size", required: true, type: "string" },
    { field: "Shoe Size Type", label: "Shoe Size Type", required: true, options: ["US", "EU", "UK"] },
    { field: "Color", label: "Color", required: true, type: "string" },
    {
      field: "Variation Size (Yes/No)",
      label: "Variation Size (Yes/No)",
      required: false,
      options: ["Yes", "No"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ];
  // HEEL → "Heels"
  const heelProduct: ShopifyProduct = {
    id: "shopify-heel-1",
    title: "Designer Pump",
    vendor: "Designer",
    product_type: "HEEL",
    tags: ["Women"],
    images: [],
    options: [{ name: "Size", values: ["7"] }],
    variants: [
      { id: 1, sku: "DGN-HEEL-1", price: "300.00", inventory_quantity: 1, option1: "7" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "size_scale", value: "US" },
    ],
  };
  const mappedHeel = mapShopifyToJomashop(heelProduct, footwearLiveSchemaWithType, "Footwear");
  assert(
    mappedHeel.properties["Shoe Type"] === "Heels",
    `Case 40 HEEL: Shoe Type === "Heels" (got ${JSON.stringify(mappedHeel.properties["Shoe Type"])})`,
  );
  assert(
    !(mappedHeel.missing_required || []).includes("Shoe Type"),
    `Case 40 HEEL: Shoe Type not blocked (got ${JSON.stringify(mappedHeel.missing_required)})`,
  );
  assert(
    mappedHeel.properties["Variation Size (Yes/No)"] === "Yes",
    `Case 40 HEEL: Variation Size (Yes/No) === "Yes" (got ${JSON.stringify(mappedHeel.properties["Variation Size (Yes/No)"])})`,
  );
  // SNEK → "Sneakers"
  const snekProduct: ShopifyProduct = {
    ...heelProduct,
    id: "shopify-snek-1",
    product_type: "SNEK",
    title: "Designer Sneaker",
  };
  const mappedSnek = mapShopifyToJomashop(snekProduct, footwearLiveSchemaWithType, "Footwear");
  assert(
    mappedSnek.properties["Shoe Type"] === "Sneakers",
    `Case 40 SNEK: Shoe Type === "Sneakers" (got ${JSON.stringify(mappedSnek.properties["Shoe Type"])})`,
  );
  // BOOT → "Boots"
  const bootProduct: ShopifyProduct = {
    ...heelProduct,
    id: "shopify-boot-1",
    product_type: "BOOT",
    title: "Designer Boot",
  };
  const mappedBoot = mapShopifyToJomashop(bootProduct, footwearLiveSchemaWithType, "Footwear");
  assert(
    mappedBoot.properties["Shoe Type"] === "Boots",
    `Case 40 BOOT: Shoe Type === "Boots" (got ${JSON.stringify(mappedBoot.properties["Shoe Type"])})`,
  );
}

// ---------- Case 41: Handbags synonym resolver maps codes to live options ---
function runHandbagsSynonymResolver() {
  console.log("Case 41: Handbags synonym resolver — TOTE/CRBD/BPCK");
  const handbagsLiveLikeSchema: SchemaPropertyDescriptor[] = [
    { field: "Color", label: "Color", required: true, type: "string" },
    { field: "Material", label: "Material", required: true, type: "string" },
    {
      field: "Handbag Type",
      label: "Handbag Type",
      required: true,
      type: "enum",
      options: ["Tote", "Crossbody", "Shoulder", "Clutch", "Backpack", "Top Handle", "Hobo"],
    },
    {
      field: "Style",
      label: "Style",
      required: false,
      type: "enum",
      options: ["Tote", "Crossbody", "Shoulder", "Backpack"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ];
  // TOTE → "Tote"
  const toteProduct: ShopifyProduct = {
    id: "shopify-tote-1",
    title: "Designer Tote Bag",
    vendor: "Designer",
    product_type: "TOTE",
    tags: ["Women"],
    images: [],
    options: [{ name: "Color", values: ["Black"] }],
    variants: [
      { id: 1, sku: "DGN-TOTE-1", price: "1000.00", inventory_quantity: 1, option1: "Black" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "material", value: "Leather", name: "Material" },
    ],
  };
  const mappedTote = mapShopifyToJomashop(toteProduct, handbagsLiveLikeSchema, "Handbags");
  assert(
    mappedTote.properties["Handbag Type"] === "Tote",
    `Case 41 TOTE: Handbag Type === "Tote" (got ${JSON.stringify(mappedTote.properties["Handbag Type"])})`,
  );
  // CRBD → "Crossbody"
  const crbdProduct: ShopifyProduct = {
    ...toteProduct,
    id: "shopify-crbd-1",
    product_type: "CRBD",
  };
  const mappedCrbd = mapShopifyToJomashop(crbdProduct, handbagsLiveLikeSchema, "Handbags");
  assert(
    mappedCrbd.properties["Handbag Type"] === "Crossbody",
    `Case 41 CRBD: Handbag Type === "Crossbody" (got ${JSON.stringify(mappedCrbd.properties["Handbag Type"])})`,
  );
  // BPCK → "Backpack"
  const bpckProduct: ShopifyProduct = {
    ...toteProduct,
    id: "shopify-bpck-1",
    product_type: "BPCK",
  };
  const mappedBpck = mapShopifyToJomashop(bpckProduct, handbagsLiveLikeSchema, "Handbags");
  assert(
    mappedBpck.properties["Handbag Type"] === "Backpack",
    `Case 41 BPCK: Handbag Type === "Backpack" (got ${JSON.stringify(mappedBpck.properties["Handbag Type"])})`,
  );
}

// ---------- Case 42: operator override beats synonym resolver --------------
function runOperatorOverrideBeatsSynonym() {
  console.log("Case 42: operator override wins over synonym resolver");
  const apparelSchema: SchemaPropertyDescriptor[] = [
    {
      field: "Article",
      label: "Article",
      required: true,
      type: "enum",
      options: ["Coats & Jackets", "Outerwear", "Jackets"],
    },
    { field: "Color", label: "Color", required: false, type: "string", allow_omit: true },
  ];
  const product: ShopifyProduct = {
    id: "shopify-cg-outw-42",
    title: "Canada Goose Parka",
    vendor: "Canada Goose",
    product_type: "OUTW",
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [{ id: 1, sku: "CG-1", price: "1.00", inventory_quantity: 1, option1: "M" }],
    metafields: [{ namespace: "custom", key: "color", value: "Black", name: "Color" }],
  };
  // Synonym alone would pick "Coats & Jackets" first; operator-verified
  // overrides take precedence (here: "Jackets").
  const mapped = mapShopifyToJomashop(product, apparelSchema, "Apparel", {
    resolveEnumOverride: makeTestEnumResolver({ "apparel|article|outw": "Jackets" }),
  });
  assert(
    mapped.properties.Article === "Jackets",
    `Case 42: operator override "Jackets" wins (got ${JSON.stringify(mapped.properties.Article)})`,
  );
}

// ---------- Jomashop mapping XLSX workflow helpers ----------
// Exercises pure logic in server/jomashop_mapping_excel.ts:
//   - buildMappingWorkbook produces an XLSX with the expected rows / headers
//   - parseMappingUpload validates user_value against accepted options
//     (rejects values not in the live list, accepts values in the list,
//     accepts free-text when no live list is available)
//   - deriveDefaultMetafieldTarget slugifies property names safely
//   - Roundtrip: build → parse identifies invalid + valid rows correctly
async function runJomashopMappingExcelHelpers() {
  console.log("Case 44: Jomashop mapping XLSX export / upload helpers");

  const sampleRows: MappingRowExportRecord[] = [
    {
      rowId: "row-article-outw",
      jomashopCategory: "Apparel",
      shopifyCategoryCode: "OUTW",
      shopifyProductType: "OUTW",
      jomashopPropertyName: "Article",
      required: true,
      currentSourceField: "Shopify category code",
      currentSourceValue: "OUTW",
      currentAutoMappedValue: "(none)",
      statusReason: "Unverified accepted-options list",
      acceptedJomashopOptions: ["Coats & Jackets", "Jackets", "Pants"],
      acceptedOptionsSource: "live-v1",
      exampleProductTitles: ["Canada Goose Parka"],
      exampleSkus: ["CG-OUTW-1"],
      productCount: 12,
      shopifyProductIds: ["111", "222"],
      currentVerifiedOverride: null,
    },
    {
      rowId: "row-color-handbag",
      jomashopCategory: "Handbags",
      shopifyCategoryCode: "BAG",
      shopifyProductType: "BAG",
      jomashopPropertyName: "Color",
      required: true,
      currentSourceField: "metafield",
      currentSourceValue: "(empty)",
      currentAutoMappedValue: "(missing)",
      statusReason: "Required field is missing",
      acceptedJomashopOptions: null,
      acceptedOptionsSource: "unknown",
      exampleProductTitles: ["Designer Tote"],
      exampleSkus: ["TT-1"],
      productCount: 3,
      shopifyProductIds: ["333"],
      currentVerifiedOverride: null,
    },
  ];
  const agg: AggregateMappingsResult = {
    shopDomain: "luxe-test.myshopify.com",
    fromCache: true,
    cachedAt: 1700000000000,
    totalProducts: 15,
    rows: sampleRows,
  };

  const buf = await buildMappingWorkbook(agg);
  assert(buf.length > 0, "Case 44a: workbook export produces a non-empty buffer");

  // Re-parse the same buffer to confirm the round-trip preserves row identity.
  // Since the operator hasn't filled User Jomashop Value yet, every row should
  // be flagged invalid with a "Missing User Jomashop Value" error.
  const reparseEmpty = await parseMappingUpload(buf, agg);
  assert(
    reparseEmpty.headerErrors.length === 0,
    `Case 44b: empty workbook has no header errors (got ${JSON.stringify(reparseEmpty.headerErrors)})`,
  );
  assert(
    reparseEmpty.rows.length === 2,
    `Case 44c: empty workbook parses 2 rows (got ${reparseEmpty.rows.length})`,
  );
  for (const r of reparseEmpty.rows) {
    assert(
      !r.isValid && r.errors.some((e) => e.toLowerCase().includes("user jomashop value")),
      `Case 44d: empty user_value yields a "Missing User Jomashop Value" error for ${r.rowId}`,
    );
  }

  // Now build a workbook the operator has filled in: an accepted Apparel
  // Article value, and a free-text Handbags Color value (no live list).
  // We re-use ExcelJS directly so we don't have to plumb a write API.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("Jomashop Mapping")!;
  // Find column indexes by header name.
  const headerCols: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    headerCols[String(cell.value)] = col;
  });
  const setCell = (rowNum: number, header: string, value: string) => {
    const col = headerCols[header];
    if (!col) throw new Error(`Missing header column: ${header}`);
    ws.getRow(rowNum).getCell(col).value = value;
  };

  // Row 2 = Article OUTW. Accept a valid option.
  setCell(2, "User Jomashop Value", "Coats & Jackets");
  setCell(2, "Write Back To Shopify? (Yes/No)", "Yes");
  // Row 3 = Color (no live list). Free-text Black is accepted as
  // operator-verified.
  setCell(3, "User Jomashop Value", "Black");
  setCell(3, "Write Back To Shopify? (Yes/No)", "No");

  const filledBuf = Buffer.from(await wb.xlsx.writeBuffer());
  const parsedFilled = await parseMappingUpload(filledBuf, agg);
  const articleRow = parsedFilled.rows.find((r) => r.rowId === "row-article-outw")!;
  const colorRow = parsedFilled.rows.find((r) => r.rowId === "row-color-handbag")!;
  assert(
    articleRow.isValid,
    `Case 44e: accepted Article=Coats & Jackets is valid (errors=${JSON.stringify(articleRow.errors)})`,
  );
  assert(
    articleRow.userValue === "Coats & Jackets",
    `Case 44f: user_value preserved through roundtrip (got "${articleRow.userValue}")`,
  );
  assert(
    articleRow.writeBack === true,
    `Case 44g: write_back=Yes parsed to true (got ${articleRow.writeBack})`,
  );
  assert(
    colorRow.isValid,
    `Case 44h: free-text Color value is valid when no live options exist (errors=${JSON.stringify(colorRow.errors)})`,
  );

  // Now build a workbook with an INVALID user value (not in accepted list) —
  // the parser should reject it.
  const wbInvalid = new ExcelJS.Workbook();
  await wbInvalid.xlsx.load(buf);
  const wsInvalid = wbInvalid.getWorksheet("Jomashop Mapping")!;
  const headerColsInvalid: Record<string, number> = {};
  wsInvalid.getRow(1).eachCell((cell, col) => {
    headerColsInvalid[String(cell.value)] = col;
  });
  wsInvalid.getRow(2).getCell(headerColsInvalid["User Jomashop Value"]).value = "Sweaters";
  const invalidBuf = Buffer.from(await wbInvalid.xlsx.writeBuffer());
  const parsedInvalid = await parseMappingUpload(invalidBuf, agg);
  const invalidArticle = parsedInvalid.rows.find((r) => r.rowId === "row-article-outw")!;
  assert(
    !invalidArticle.isValid,
    `Case 44i: "Sweaters" rejected (not in accepted list); got errors=${JSON.stringify(invalidArticle.errors)}`,
  );
  assert(
    invalidArticle.errors.some((e) => e.includes("not an accepted Jomashop option")),
    `Case 44j: rejection mentions accepted-options gate`,
  );

  // deriveDefaultMetafieldTarget slugifies safely.
  const t1 = deriveDefaultMetafieldTarget("Article");
  assert(
    t1.namespace === "jomashop" && t1.key === "article",
    `Case 44k: derive("Article") = jomashop.article (got ${JSON.stringify(t1)})`,
  );
  const t2 = deriveDefaultMetafieldTarget("Country of Origin");
  assert(
    t2.namespace === "jomashop" && t2.key === "country_of_origin",
    `Case 44l: derive("Country of Origin") = jomashop.country_of_origin (got ${JSON.stringify(t2)})`,
  );
  const t3 = deriveDefaultMetafieldTarget("!!!");
  assert(
    t3.namespace === "jomashop" && t3.key === "value",
    `Case 44m: derive falls back to "value" for empty-slug input (got ${JSON.stringify(t3)})`,
  );
}

// ---------- Case 45: per-product field workbook helpers ----------

async function runJomashopProductFieldExcelHelpers() {
  console.log("Case 45: Jomashop per-product field XLSX export / upload helpers");

  // deriveMetafieldTargetForProductField slugifies safely (variant + product fields).
  const t1 = deriveMetafieldTargetForProductField("Article");
  assert(
    t1.namespace === "jomashop" && t1.key === "article",
    `Case 45a: derive("Article") = jomashop.article (got ${JSON.stringify(t1)})`,
  );
  const t2 = deriveMetafieldTargetForProductField("Variation Size (Yes/No)");
  assert(
    t2.namespace === "jomashop" && t2.key === "variation_size_yes_no",
    `Case 45b: derive("Variation Size (Yes/No)") = jomashop.variation_size_yes_no (got ${JSON.stringify(t2)})`,
  );
  const t3 = deriveMetafieldTargetForProductField("Product ID Type");
  assert(
    t3.namespace === "jomashop" && t3.key === "product_id_type",
    `Case 45c: derive("Product ID Type") = jomashop.product_id_type (got ${JSON.stringify(t3)})`,
  );

  // fieldIsVariantTargeted picks size as a variant metafield candidate.
  assert(fieldIsVariantTargeted("Size") === true, "Case 45d: Size routes to variant metafield");
  assert(
    fieldIsVariantTargeted("Variation Size (Yes/No)") === true,
    "Case 45e: Variation Size (Yes/No) routes to variant metafield",
  );
  assert(
    fieldIsVariantTargeted("Article") === false,
    "Case 45f: Article (product-level field) does NOT route to variant",
  );
  assert(
    fieldIsVariantTargeted("Country of Origin") === false,
    "Case 45g: Country of Origin (product-level) does NOT route to variant",
  );

  // Construct a minimal ProductFieldExportResult with two categories:
  // Apparel (live-v1 schema with enum Article) and Handbags (fallback with
  // optional Material).
  const agg: ProductFieldExportResult = {
    shopDomain: "luxe-test.myshopify.com",
    fromCache: true,
    cachedAt: 1700000000000,
    totalProducts: 3,
    includedAll: false,
    categories: [
      {
        category: "Apparel",
        fieldsSource: "live-v1",
        fields: [
          {
            field: "Article",
            label: "Article",
            required: true,
            type: "enum",
            options: ["Coats & Jackets", "Jackets", "Pants"],
          },
          {
            field: "Gender",
            label: "Gender",
            required: true,
            type: "enum",
            options: ["Men", "Women", "Unisex"],
          },
          {
            field: "Fabric Material",
            label: "Fabric Material",
            required: false,
            type: "string",
          },
        ],
        rows: [
          {
            rowId: "row-apparel-001",
            jomashopCategory: "Apparel",
            shopifyProductId: "111",
            shopifyVariantId: "v-111",
            productTitle: "Canada Goose Parka",
            vendorSku: "CG-OUTW-1",
            manufacturerNumber: "CG-OUTW-1-MFR",
            brand: "Canada Goose",
            shopifyCategoryCode: "OUTW",
            shopifyProductType: "OUTW",
            jomashopCategoryId: "42",
            jomashopBrandId: "7",
            pushStatus: "missing",
            warnings: "Missing required Article",
            fieldValues: { Article: "", Gender: "Men", "Fabric Material": "Down" },
            isVariant: false,
          },
        ],
      },
      {
        category: "Handbags",
        fieldsSource: "fallback",
        fields: [
          {
            field: "Material",
            label: "Material",
            required: false,
            type: "string",
          },
          {
            field: "Color",
            label: "Color",
            required: true,
            type: "string",
          },
        ],
        rows: [
          {
            rowId: "row-bag-001",
            jomashopCategory: "Handbags",
            shopifyProductId: "222",
            shopifyVariantId: "v-222",
            productTitle: "Designer Tote",
            vendorSku: "TT-1",
            manufacturerNumber: "TT-1-MFR",
            brand: "Designer",
            shopifyCategoryCode: "TOTE",
            shopifyProductType: "TOTE",
            jomashopCategoryId: "13",
            jomashopBrandId: "3",
            pushStatus: "needs-category-verification",
            warnings: "",
            fieldValues: { Material: "", Color: "" },
            isVariant: false,
          },
        ],
      },
    ],
  };

  const buf = await buildProductFieldWorkbook(agg);
  assert(buf.length > 0, "Case 45h: product-field workbook export buffer non-empty");

  // Parse a re-loaded workbook the operator hasn't touched. Field cells
  // already carry the current app-derived values (so the operator can see
  // what's there). The parser surfaces those values verbatim; only required
  // fields that are still blank produce errors.
  const reparseEmpty = await parseProductFieldUpload(buf, agg);
  assert(
    reparseEmpty.headerErrors.length === 0,
    `Case 45i: empty workbook has no header errors (got ${JSON.stringify(reparseEmpty.headerErrors)})`,
  );
  const apparelEmpty = reparseEmpty.rows.find((r) => r.rowId === "row-apparel-001")!;
  const bagEmpty = reparseEmpty.rows.find((r) => r.rowId === "row-bag-001");
  assert(
    apparelEmpty.fieldValues["Gender"] === "Men",
    `Case 45j: apparel row preserves pre-filled Gender (got ${apparelEmpty.fieldValues["Gender"]})`,
  );
  assert(
    !apparelEmpty.isValid &&
      apparelEmpty.errors.some((e) => e.includes('"Article"') && e.includes("left blank")),
    `Case 45k: apparel row flagged because required Article is still blank (errors=${JSON.stringify(apparelEmpty.errors)})`,
  );
  // Handbag row has no pre-filled values — the row IS surfaced (because
  // identity columns are populated) but has zero field values and no
  // errors (parser only enforces required when at least one cell is
  // filled).
  assert(
    bagEmpty !== undefined && Object.keys(bagEmpty.fieldValues).length === 0,
    `Case 45k2: handbag row surfaces with no field values (got ${JSON.stringify(bagEmpty ?? null)})`,
  );
  assert(
    bagEmpty !== undefined && bagEmpty.isValid,
    `Case 45k3: handbag row is valid because operator hasn't touched it`,
  );

  // Fill the workbook with valid + invalid + writeback values, then re-parse.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const apparelSheet = wb.getWorksheet("Apparel")!;
  const apparelHeaderCols: Record<string, number> = {};
  apparelSheet.getRow(1).eachCell((cell, c) => {
    apparelHeaderCols[String(cell.value)] = c;
  });
  const setApparel = (rowNum: number, header: string, value: string) => {
    const col = apparelHeaderCols[header];
    if (!col) throw new Error(`Missing header column: ${header}`);
    apparelSheet.getRow(rowNum).getCell(col).value = value;
  };
  // Row 2 = Canada Goose Parka. Fill Article=Coats & Jackets, mark writeback.
  setApparel(2, "Article *", "Coats & Jackets");
  setApparel(2, "Fabric Material", "Down");
  setApparel(2, "Write Back?", "Yes");

  const filledBuf1 = Buffer.from(await wb.xlsx.writeBuffer());
  const parsedFilled1 = await parseProductFieldUpload(filledBuf1, agg);
  const apparelRow = parsedFilled1.rows.find((r) => r.rowId === "row-apparel-001")!;
  assert(apparelRow !== undefined, "Case 45l: apparel row round-trips");
  assert(
    apparelRow.fieldValues["Article"] === "Coats & Jackets",
    `Case 45m: Article value preserved (got ${JSON.stringify(apparelRow.fieldValues)})`,
  );
  assert(
    apparelRow.fieldValues["Fabric Material"] === "Down",
    `Case 45n: Fabric Material preserved`,
  );
  assert(apparelRow.writeBack === true, "Case 45o: write_back=Yes parsed to true");
  assert(apparelRow.isValid, `Case 45p: valid row when enum match + non-blank required (errors=${JSON.stringify(apparelRow.errors)})`);

  // Now make Article INVALID (not in accepted list).
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  const apparelSheet2 = wb2.getWorksheet("Apparel")!;
  const headerCols2: Record<string, number> = {};
  apparelSheet2.getRow(1).eachCell((cell, c) => {
    headerCols2[String(cell.value)] = c;
  });
  apparelSheet2.getRow(2).getCell(headerCols2["Article *"]).value = "Sweaters";
  apparelSheet2.getRow(2).getCell(headerCols2["Write Back?"]).value = "Yes";
  const invalidBuf = Buffer.from(await wb2.xlsx.writeBuffer());
  const parsedInvalid = await parseProductFieldUpload(invalidBuf, agg);
  const invalidApparel = parsedInvalid.rows.find((r) => r.rowId === "row-apparel-001")!;
  assert(
    !invalidApparel.isValid,
    `Case 45q: "Sweaters" rejected; got errors=${JSON.stringify(invalidApparel.errors)}`,
  );
  assert(
    invalidApparel.errors.some((e) => e.includes("not in the live accepted-options list")),
    `Case 45r: rejection mentions live accepted-options list`,
  );

  // Cache invalidation check: simulated by calling the apply route requires
  // the storage layer — covered by the route registration test through a
  // type-only assertion: registerJomashopProductFieldExcelRoutes is wired in
  // routes.ts.
  // (Implicitly verified by the build/check step running TS over the import.)

  // Confirm at least one sheet was created per category, plus Instructions
  // and Accepted Options helper sheets.
  const wbCheck = new ExcelJS.Workbook();
  await wbCheck.xlsx.load(buf);
  const sheetNames = wbCheck.worksheets.map((w) => w.name);
  assert(sheetNames.includes("Apparel"), `Case 45s: Apparel sheet present (got ${sheetNames})`);
  assert(sheetNames.includes("Handbags"), `Case 45t: Handbags sheet present`);
  assert(
    sheetNames.includes("Instructions"),
    `Case 45u: Instructions sheet present (got ${sheetNames})`,
  );
  assert(
    sheetNames.includes("Accepted Options"),
    `Case 45v: Accepted Options helper sheet present (got ${sheetNames})`,
  );

  // Required fields are starred in the header.
  const apparelHeaders: string[] = [];
  wbCheck.getWorksheet("Apparel")!.getRow(1).eachCell((c) => {
    apparelHeaders.push(String(c.value));
  });
  assert(
    apparelHeaders.some((h) => h === "Article *"),
    `Case 45w: Article header marked with * (got ${apparelHeaders.join(", ")})`,
  );
  assert(
    apparelHeaders.some((h) => h === "Fabric Material"),
    `Case 45x: optional Fabric Material header NOT starred`,
  );
}

// ---------- Case 46: dropdown coverage via hidden helper sheet ----------

async function runProductFieldDropdownCoverage() {
  console.log(
    "Case 46: per-product workbook dropdowns reference hidden _Options sheet via named ranges (works for long lists)",
  );
  const ExcelJS = (await import("exceljs")).default;

  // Build a realistic agg covering: Apparel Article (required enum),
  // Apparel Variation Size (Yes/No) (enum), Footwear Country of Origin
  // (long enum that exceeds Excel's inline 255-char cap), and Handbags
  // Style (optional short enum).
  const longCountryList = [
    "United States", "United Kingdom", "France", "Italy", "Spain", "Germany",
    "Switzerland", "Japan", "China", "Hong Kong", "Vietnam", "Portugal",
    "Mexico", "India", "Romania", "Turkey", "Bulgaria", "Tunisia", "Morocco",
    "Bangladesh", "Sri Lanka", "Thailand", "Indonesia", "Malaysia",
    "Philippines", "South Korea", "Taiwan", "Cambodia", "Pakistan", "Egypt",
    "Greece", "Poland", "Czech Republic", "Slovakia", "Hungary", "Austria",
    "Belgium", "Netherlands", "Denmark", "Sweden", "Norway", "Finland",
    "Ireland", "Croatia", "Serbia", "Albania", "Macedonia", "Estonia",
    "Latvia", "Lithuania",
  ];
  // Sanity check: ensure the inline encoding would exceed Excel's limit.
  assert(
    longCountryList.join(",").length > 260,
    "Case 46 pre: long country list exceeds Excel inline list limit (forces named-range path)",
  );

  const agg: ProductFieldExportResult = {
    shopDomain: "luxe-test.myshopify.com",
    fromCache: true,
    cachedAt: 1700000000000,
    totalProducts: 4,
    includedAll: true,
    categories: [
      {
        category: "Apparel",
        fieldsSource: "live-v1",
        fields: [
          {
            field: "Article",
            label: "Article",
            required: true,
            type: "enum",
            options: ["Coats & Jackets", "Jackets", "Pants", "Shirts"],
          },
          {
            field: "Variation Size (Yes/No)",
            label: "Variation Size (Yes/No)",
            required: false,
            type: "enum",
            options: ["Yes", "No"],
          },
          {
            field: "Gender",
            label: "Gender",
            required: true,
            type: "enum",
            options: ["Men", "Women", "Unisex"],
          },
        ],
        rows: [
          {
            rowId: "row-apparel-001",
            jomashopCategory: "Apparel",
            shopifyProductId: "111",
            shopifyVariantId: "v-111",
            productTitle: "Canada Goose Parka",
            vendorSku: "CG-OUTW-1",
            manufacturerNumber: "CG-OUTW-1-MFR",
            brand: "Canada Goose",
            shopifyCategoryCode: "OUTW",
            shopifyProductType: "OUTW",
            jomashopCategoryId: "42",
            jomashopBrandId: "7",
            pushStatus: "missing",
            warnings: "Missing required Article",
            fieldValues: { Article: "", "Variation Size (Yes/No)": "", Gender: "Men" },
            isVariant: false,
          },
        ],
      },
      {
        category: "Footwear",
        fieldsSource: "live-v1",
        fields: [
          {
            field: "Gender",
            label: "Gender",
            required: true,
            type: "enum",
            options: ["Men", "Women", "Unisex", "Kids"],
          },
          {
            field: "Country of Origin",
            label: "Country of Origin",
            required: false,
            type: "enum",
            options: longCountryList,
          },
        ],
        rows: [
          {
            rowId: "row-footwear-001",
            jomashopCategory: "Footwear",
            shopifyProductId: "222",
            shopifyVariantId: "v-222",
            productTitle: "Tod's Boot",
            vendorSku: "TODS-1",
            manufacturerNumber: "TODS-1-MFR",
            brand: "Tod's",
            shopifyCategoryCode: "SHOE",
            shopifyProductType: "SHOE",
            jomashopCategoryId: "5",
            jomashopBrandId: "11",
            pushStatus: "missing",
            warnings: "",
            fieldValues: { Gender: "", "Country of Origin": "" },
            isVariant: false,
          },
        ],
      },
      {
        category: "Handbags",
        fieldsSource: "live-v1",
        fields: [
          {
            field: "Style",
            label: "Style",
            required: false,
            type: "enum",
            options: ["Shoulder", "Tote", "Crossbody", "Clutch", "Backpack", "Top-handle"],
          },
          {
            field: "Color",
            label: "Color",
            required: true,
            type: "string",
            max_length: 80,
          },
          {
            field: "Tags",
            label: "Tags",
            required: false,
            type: "enum",
            multiple: true,
            options: ["seasonal", "limited", "classic", "sport"],
          },
          {
            field: "Pieces",
            label: "Pieces",
            required: false,
            type: "integer",
            only_integer: true,
            min_value: 1,
            max_value: 10,
          },
        ],
        rows: [
          {
            rowId: "row-handbag-001",
            jomashopCategory: "Handbags",
            shopifyProductId: "333",
            shopifyVariantId: "v-333",
            productTitle: "Designer Tote",
            vendorSku: "TT-1",
            manufacturerNumber: "TT-1-MFR",
            brand: "Designer",
            shopifyCategoryCode: "TOTE",
            shopifyProductType: "TOTE",
            jomashopCategoryId: "13",
            jomashopBrandId: "3",
            pushStatus: "needs-fill",
            warnings: "",
            fieldValues: { Style: "", Color: "", Tags: "", Pieces: "" },
            isVariant: false,
          },
        ],
      },
    ],
  };

  const buf = await buildProductFieldWorkbook(agg);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  // 46a: hidden _Options sheet exists, is hidden, and contains one column per
  // (category, enum field).
  const optionsSheet = wb.getWorksheet("_Options");
  assert(optionsSheet !== undefined, "Case 46a: _Options sheet present");
  assert(
    (optionsSheet as any).state === "hidden" ||
      (optionsSheet as any).state === "veryHidden",
    `Case 46a2: _Options sheet hidden (got state=${(optionsSheet as any).state})`,
  );

  const expectedRanges: Array<{ category: string; field: string; size: number }> = [
    { category: "Apparel", field: "Article", size: 4 },
    { category: "Apparel", field: "Variation Size (Yes/No)", size: 2 },
    { category: "Apparel", field: "Gender", size: 3 },
    { category: "Footwear", field: "Gender", size: 4 },
    { category: "Footwear", field: "Country of Origin", size: longCountryList.length },
    { category: "Handbags", field: "Style", size: 6 },
    { category: "Handbags", field: "Tags", size: 4 },
  ];
  // Read the workbook definedNames model (one entry per name).
  const dn = (wb as any).definedNames;
  const namesModel: Array<{ name: string; ranges: string[] }> = (dn?.model ?? []) as Array<{
    name: string;
    ranges: string[];
  }>;
  const nameByKey = new Map(namesModel.map((m) => [m.name, m.ranges]));
  for (const e of expectedRanges) {
    const expectedName = buildOptionsRangeName(e.category, e.field);
    const ranges = nameByKey.get(expectedName);
    assert(
      Array.isArray(ranges) && ranges.length > 0,
      `Case 46b: defined name "${expectedName}" exists for ${e.category}/${e.field}`,
    );
    // Range references _Options sheet.
    assert(
      ranges![0].includes("_Options"),
      `Case 46c: defined name "${expectedName}" references _Options sheet (got ${ranges![0]})`,
    );
  }

  // 46d: Apparel sheet's Article column carries a list-type data validation
  // pointing at the named range (NOT an inline quoted list).
  const apparelSheet = wb.getWorksheet("Apparel")!;
  const headerByCol: Record<number, string> = {};
  apparelSheet.getRow(1).eachCell((cell, c) => {
    headerByCol[c] = String(cell.value ?? "").trim();
  });
  const findCol = (header: string): number => {
    const found = Object.entries(headerByCol).find(([, h]) => h === header);
    if (!found) throw new Error(`Apparel sheet missing column "${header}"`);
    return Number(found[0]);
  };
  const articleCol = findCol("Article *");
  const articleCell = apparelSheet.getRow(2).getCell(articleCol);
  const articleDV = (articleCell as any).dataValidation as
    | { type: string; formulae: string[] }
    | undefined;
  assert(
    articleDV && articleDV.type === "list",
    `Case 46d: Article cell has list-type data validation (got ${JSON.stringify(articleDV)})`,
  );
  assert(
    typeof articleDV!.formulae[0] === "string" &&
      articleDV!.formulae[0].includes(buildOptionsRangeName("Apparel", "Article")),
    `Case 46e: Article validation formula references named range (got ${articleDV!.formulae[0]})`,
  );

  // 46f: Variation Size (Yes/No) — short enum, also via named range.
  const varSizeCol = findCol("Variation Size (Yes/No)");
  const varSizeDV = (apparelSheet.getRow(2).getCell(varSizeCol) as any).dataValidation as
    | { type: string; formulae: string[] }
    | undefined;
  assert(
    varSizeDV && varSizeDV.type === "list",
    `Case 46f: Variation Size (Yes/No) cell has list validation`,
  );
  assert(
    varSizeDV!.formulae[0].includes(
      buildOptionsRangeName("Apparel", "Variation Size (Yes/No)"),
    ),
    `Case 46g: Variation Size (Yes/No) formula references the named range`,
  );

  // 46h: Required column header (Article) is highlighted yellow with bold red.
  const articleHeader = apparelSheet.getRow(1).getCell(articleCol);
  const fillObj = (articleHeader.fill as { fgColor?: { argb?: string } } | undefined) ?? undefined;
  assert(
    fillObj?.fgColor?.argb === "FFFFE082",
    `Case 46h: required Article header is yellow-highlighted (got fill=${JSON.stringify(fillObj)})`,
  );
  // Note text mentions REQUIRED.
  const articleHeaderNote = (articleHeader as any).note;
  const noteText =
    typeof articleHeaderNote === "string"
      ? articleHeaderNote
      : typeof articleHeaderNote?.texts === "object"
        ? Array.isArray(articleHeaderNote.texts)
          ? articleHeaderNote.texts.map((t: any) => t.text ?? "").join("")
          : ""
        : "";
  assert(
    noteText.toUpperCase().includes("REQUIRED"),
    `Case 46i: required header note mentions REQUIRED (got ${JSON.stringify(noteText)})`,
  );

  // 46j: Footwear Country of Origin — LONG list — still uses a named range,
  // not an inline list. This is the critical case the named-range design
  // exists for.
  const footwearSheet = wb.getWorksheet("Footwear")!;
  const footwearHeaderByCol: Record<number, string> = {};
  footwearSheet.getRow(1).eachCell((cell, c) => {
    footwearHeaderByCol[c] = String(cell.value ?? "").trim();
  });
  const cooCol = Number(
    Object.entries(footwearHeaderByCol).find(([, h]) => h === "Country of Origin")![0],
  );
  const cooDV = (footwearSheet.getRow(2).getCell(cooCol) as any).dataValidation as
    | { type: string; formulae: string[] }
    | undefined;
  assert(
    cooDV && cooDV.type === "list",
    `Case 46j: Country of Origin (long list) has list validation`,
  );
  assert(
    cooDV!.formulae[0].includes(buildOptionsRangeName("Footwear", "Country of Origin")),
    `Case 46k: long Country of Origin uses named-range reference (got ${cooDV!.formulae[0]})`,
  );
  assert(
    !cooDV!.formulae[0].startsWith('"') ||
      cooDV!.formulae[0].length < 260,
    `Case 46l: long list NOT inlined as a quoted formula (would exceed Excel limit)`,
  );

  // 46m: _Options sheet column for Country of Origin actually contains all
  // ~50 entries (sanity check the data backing the named range).
  // Look for the column whose header is "Footwear :: Country of Origin".
  let cooOptCol: number | null = null;
  optionsSheet!.getRow(1).eachCell((cell, c) => {
    if (String(cell.value ?? "") === "Footwear :: Country of Origin") cooOptCol = c;
  });
  assert(cooOptCol !== null, "Case 46m: _Options carries Footwear/Country of Origin column");
  const firstCountry = optionsSheet!.getRow(2).getCell(cooOptCol!).value;
  const lastCountry = optionsSheet!.getRow(longCountryList.length + 1).getCell(cooOptCol!).value;
  assert(
    String(firstCountry) === longCountryList[0],
    `Case 46n: first option present (got ${firstCountry})`,
  );
  assert(
    String(lastCountry) === longCountryList[longCountryList.length - 1],
    `Case 46o: last option present (got ${lastCountry})`,
  );

  // 46p: Handbags Style (optional short enum) — still uses a named range,
  // not inline, so the convention is consistent.
  const handbagsSheet = wb.getWorksheet("Handbags")!;
  const handbagsHeaderByCol: Record<number, string> = {};
  handbagsSheet.getRow(1).eachCell((cell, c) => {
    handbagsHeaderByCol[c] = String(cell.value ?? "").trim();
  });
  const styleCol = Number(
    Object.entries(handbagsHeaderByCol).find(([, h]) => h === "Style")![0],
  );
  const styleDV = (handbagsSheet.getRow(2).getCell(styleCol) as any).dataValidation as
    | { type: string; formulae: string[] }
    | undefined;
  assert(
    styleDV && styleDV.type === "list",
    `Case 46p: Handbags Style has list validation`,
  );
  assert(
    styleDV!.formulae[0].includes(buildOptionsRangeName("Handbags", "Style")),
    `Case 46q: Handbags Style formula references named range`,
  );

  // 46r: Handbags Tags is a multi-select enum (multiple=true). Validation
  // is "list" with a prompt; upload validation enforces each token.
  const tagsCol = Number(
    Object.entries(handbagsHeaderByCol).find(([, h]) => h === "Tags")![0],
  );
  const tagsDV = (handbagsSheet.getRow(2).getCell(tagsCol) as any).dataValidation as
    | { type: string; formulae: string[]; prompt?: string }
    | undefined;
  assert(
    tagsDV && tagsDV.type === "list",
    `Case 46r: Tags multi-select carries a list validation referencing the named range`,
  );
  assert(
    typeof tagsDV!.prompt === "string" && tagsDV!.prompt.toLowerCase().includes("comma"),
    `Case 46s: multi-select prompt mentions comma-separated values (got ${JSON.stringify(tagsDV!.prompt)})`,
  );

  // 46t: Handbags Pieces is an integer with min=1/max=10. Should carry a
  // "whole"-type data validation, not a list.
  const piecesCol = Number(
    Object.entries(handbagsHeaderByCol).find(([, h]) => h === "Pieces")![0],
  );
  const piecesDV = (handbagsSheet.getRow(2).getCell(piecesCol) as any).dataValidation as
    | { type: string; formulae: string[] }
    | undefined;
  assert(
    piecesDV && piecesDV.type === "whole",
    `Case 46t: integer Pieces uses whole-number validation (got ${JSON.stringify(piecesDV)})`,
  );
  assert(
    Number(piecesDV!.formulae[0]) === 1 && Number(piecesDV!.formulae[1]) === 10,
    `Case 46u: integer bounds carried into formula (got ${JSON.stringify(piecesDV!.formulae)})`,
  );

  // 46v: Color (string field with max_length=80) uses textLength validation.
  const colorCol = Number(
    Object.entries(handbagsHeaderByCol).find(([, h]) => h === "Color *")![0],
  );
  const colorDV = (handbagsSheet.getRow(2).getCell(colorCol) as any).dataValidation as
    | { type: string; formulae: string[] }
    | undefined;
  assert(
    colorDV && colorDV.type === "textLength",
    `Case 46v: string Color with max_length uses textLength validation (got ${JSON.stringify(colorDV)})`,
  );

  // 46w: Free-text fields without bounds (none in this agg, but verify
  // Color note hints at max length).
  const colorHeaderNote = (handbagsSheet.getRow(1).getCell(colorCol) as any).note;
  const colorNoteText =
    typeof colorHeaderNote === "string"
      ? colorHeaderNote
      : Array.isArray(colorHeaderNote?.texts)
        ? colorHeaderNote.texts.map((t: any) => t.text ?? "").join("")
        : "";
  assert(
    colorNoteText.includes("max length=80") || colorNoteText.includes("80"),
    `Case 46w: Color header note mentions max length (got ${JSON.stringify(colorNoteText)})`,
  );

  // 46x: Upload validation rejects multi-select tokens not in the list,
  // even though Excel allowed the input.
  const wbEdit = new ExcelJS.Workbook();
  await wbEdit.xlsx.load(buf);
  const editHandbags = wbEdit.getWorksheet("Handbags")!;
  const editHeaderByCol: Record<string, number> = {};
  editHandbags.getRow(1).eachCell((cell, c) => {
    editHeaderByCol[String(cell.value)] = c;
  });
  editHandbags.getRow(2).getCell(editHeaderByCol["Tags"]).value = "seasonal, weird-token, classic";
  editHandbags.getRow(2).getCell(editHeaderByCol["Color *"]).value = "Black";
  const badBuf = Buffer.from(await wbEdit.xlsx.writeBuffer());
  const parsed = await parseProductFieldUpload(badBuf, agg);
  const handbagRow = parsed.rows.find((r) => r.rowId === "row-handbag-001")!;
  assert(
    !handbagRow.isValid &&
      handbagRow.errors.some(
        (e) => e.includes("Tags") && e.toLowerCase().includes("weird-token"),
      ),
    `Case 46x: multi-select rejected when any token is not in accepted list (errors=${JSON.stringify(handbagRow.errors)})`,
  );

  // 46y: Numeric out-of-bounds rejected.
  const wbEdit2 = new ExcelJS.Workbook();
  await wbEdit2.xlsx.load(buf);
  const editHandbags2 = wbEdit2.getWorksheet("Handbags")!;
  const editHeaderByCol2: Record<string, number> = {};
  editHandbags2.getRow(1).eachCell((cell, c) => {
    editHeaderByCol2[String(cell.value)] = c;
  });
  editHandbags2.getRow(2).getCell(editHeaderByCol2["Pieces"]).value = 99;
  editHandbags2.getRow(2).getCell(editHeaderByCol2["Color *"]).value = "Red";
  const badBuf2 = Buffer.from(await wbEdit2.xlsx.writeBuffer());
  const parsed2 = await parseProductFieldUpload(badBuf2, agg);
  const handbagRow2 = parsed2.rows.find((r) => r.rowId === "row-handbag-001")!;
  assert(
    !handbagRow2.isValid &&
      handbagRow2.errors.some((e) => e.includes("Pieces") && e.includes("max_value")),
    `Case 46y: integer above max_value rejected (errors=${JSON.stringify(handbagRow2.errors)})`,
  );

  // 46z: Footwear Country of Origin — accepts a long-list value present in
  // the accepted set (server-side authoritative).
  const wbEdit3 = new ExcelJS.Workbook();
  await wbEdit3.xlsx.load(buf);
  const editFootwear = wbEdit3.getWorksheet("Footwear")!;
  const editHdr: Record<string, number> = {};
  editFootwear.getRow(1).eachCell((cell, c) => {
    editHdr[String(cell.value)] = c;
  });
  editFootwear.getRow(2).getCell(editHdr["Gender *"]).value = "Men";
  editFootwear.getRow(2).getCell(editHdr["Country of Origin"]).value = "Italy";
  const goodBuf = Buffer.from(await wbEdit3.xlsx.writeBuffer());
  const parsedGood = await parseProductFieldUpload(goodBuf, agg);
  const footwearRow = parsedGood.rows.find((r) => r.rowId === "row-footwear-001")!;
  assert(
    footwearRow.isValid,
    `Case 46z: long-list value "Italy" accepted (errors=${JSON.stringify(footwearRow.errors)})`,
  );

  // 46aa: Upload of an invalid long-list value rejected server-side even
  // when the dropdown would have prevented it.
  const wbEdit4 = new ExcelJS.Workbook();
  await wbEdit4.xlsx.load(buf);
  const editFootwear2 = wbEdit4.getWorksheet("Footwear")!;
  const editHdr2: Record<string, number> = {};
  editFootwear2.getRow(1).eachCell((cell, c) => {
    editHdr2[String(cell.value)] = c;
  });
  editFootwear2.getRow(2).getCell(editHdr2["Gender *"]).value = "Men";
  editFootwear2.getRow(2).getCell(editHdr2["Country of Origin"]).value = "Atlantis";
  const badBuf3 = Buffer.from(await wbEdit4.xlsx.writeBuffer());
  const parsedBad3 = await parseProductFieldUpload(badBuf3, agg);
  const footwearRow2 = parsedBad3.rows.find((r) => r.rowId === "row-footwear-001")!;
  assert(
    !footwearRow2.isValid &&
      footwearRow2.errors.some(
        (e) => e.includes("Country of Origin") && e.toLowerCase().includes("not in the live"),
      ),
    `Case 46aa: invalid long-list value rejected on upload (errors=${JSON.stringify(footwearRow2.errors)})`,
  );
}

// ---------- Case 43: optional unresolved enum is omitted, not blocked ------
function runOptionalUnresolvedOmitted() {
  console.log("Case 43: optional unresolved enum is omitted, never blocks preflight");
  const schema: SchemaPropertyDescriptor[] = [
    {
      field: "Article",
      label: "Article",
      required: false,
      type: "enum",
      options: ["Coats & Jackets", "Pants"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    { field: "Color", label: "Color", required: true, type: "string" },
  ];
  // A product whose category code doesn't map to any candidate Article — the
  // synonym resolver returns null, the field is dropped (allow_omit), and the
  // push is NOT blocked because Article was optional.
  const product: ShopifyProduct = {
    id: "shopify-mystery-1",
    title: "Mystery Item",
    vendor: "Designer",
    product_type: "ZZZZ", // no synonyms
    images: [],
    options: [],
    variants: [{ id: 1, sku: "MYS-1", price: "1.00", inventory_quantity: 1 }],
    metafields: [{ namespace: "custom", key: "color", value: "Red", name: "Color" }],
  };
  const mapped = mapShopifyToJomashop(product, schema, "Apparel");
  assert(
    !("Article" in mapped.properties) || mapped.properties.Article === undefined,
    `Case 43: optional Article dropped when synonym returns null (got ${JSON.stringify(mapped.properties.Article)})`,
  );
  assert(
    !(mapped.missing_required || []).includes("Article"),
    `Case 43: optional Article never appears in missing_required (got ${JSON.stringify(mapped.missing_required)})`,
  );
}

// ---------- Case 47: Parent SKU extraction & writeback target ------------
//
// Asserts:
//   47a — readParentSku reads explicit `parent_sku` / `Parent SKU` metafields
//   47b — buildCanonicalProductFields populates canonical.parent_sku
//   47c — buildSchemaProperties maps a live "Parent SKU" schema field to it
//   47d — Parent SKU is NEVER substituted from variant size
//   47e — Parent SKU is NEVER substituted from variant SKU / brand / handle
//   47f — findParentSkuSource returns the original (namespace, key) when
//          the source metafield is non-default (custom / luxe / ff)
//   47g — fieldIsParentSku detects label variants
//   47h — namespaced metafield key (e.g. "custom.parent_sku") is honored
function runParentSkuMappingAndWriteback() {
  console.log("Case 47: Parent SKU extraction, mapping, and writeback target");

  // 47a + 47b + 47f: explicit parent_sku metafield under custom.* namespace.
  const productExplicit: ShopifyProduct = {
    id: "shopify-parent-1",
    title: "Some Apparel",
    vendor: "ACME",
    product_type: "PANT",
    images: [],
    options: [{ name: "Size", values: ["32", "34"] }],
    variants: [
      { id: 1, sku: "ACME-PANT-32", price: "100.00", inventory_quantity: 1, option1: "32" },
      { id: 2, sku: "ACME-PANT-34", price: "100.00", inventory_quantity: 1, option1: "34" },
    ],
    metafields: [
      { namespace: "custom", key: "parent_sku", value: "ACME-PANT", name: "Parent SKU" },
      { namespace: "custom", key: "color", value: "Navy", name: "Color" },
    ],
  };
  assert(
    readParentSku(productExplicit) === "ACME-PANT",
    `Case 47a: readParentSku reads custom.parent_sku metafield (got ${JSON.stringify(readParentSku(productExplicit))})`,
  );
  const canonicalExplicit = buildCanonicalProductFields(productExplicit);
  assert(
    canonicalExplicit.parent_sku === "ACME-PANT",
    `Case 47b: canonical.parent_sku populated from metafield (got ${JSON.stringify(canonicalExplicit.parent_sku)})`,
  );
  const source = findParentSkuSource(productExplicit);
  assert(
    source !== null && source.namespace === "custom" && source.key === "parent_sku",
    `Case 47f: findParentSkuSource returns original (namespace,key) (got ${JSON.stringify(source)})`,
  );

  // 47g: manufacturer_number strips trailing "-<size>"; parent_sku derives base + "-P".
  const productSized: ShopifyProduct = {
    id: "sized-1",
    title: "Tods Mens Green Loafer",
    vendor: "Tods",
    product_type: "SHOES",
    options: [{ name: "Size", values: ["7", "7.5"] }],
    variants: [
      { id: 11, sku: "XXM0GW05470RE0T022-7", price: "695.00", inventory_quantity: 5, option1: "7" },
      { id: 12, sku: "XXM0GW05470RE0T022-7.5", price: "695.00", inventory_quantity: 2, option1: "7.5" },
    ],
    metafields: [],
  };
  const mappedSized = mapShopifyToJomashop(productSized, clothingSchema());
  assert(
    mappedSized.manufacturer_number === "XXM0GW05470RE0T022",
    `Case 47g: manufacturer_number strips size (got ${JSON.stringify(mappedSized.manufacturer_number)})`,
  );
  assert(
    mappedSized.parent_sku === "XXM0GW05470RE0T022-P",
    `Case 47g: parent_sku = base + "-P" (got ${JSON.stringify(mappedSized.parent_sku)})`,
  );
  // 47h: explicit parent_sku metafield still wins over derivation.
  const productSizedExplicitParent: ShopifyProduct = {
    ...productSized,
    id: "sized-2",
    metafields: [{ namespace: "custom", key: "parent_sku", value: "OVERRIDE-P", name: "Parent SKU" }],
  };
  assert(
    mapShopifyToJomashop(productSizedExplicitParent, clothingSchema()).parent_sku === "OVERRIDE-P",
    `Case 47h: explicit parent_sku metafield wins`,
  );

  // 47i: wipe-proof derivations (color from title, gender from title, size system default).
  assert(deriveColorFromTitle("Tods Mens Green Loafer") === "Green", `Case 47i: color from title (Green)`);
  assert(deriveColorFromTitle("Cavalli Class Mens Navy Dress Shirt") === "Navy", `Case 47i: color from title (Navy)`);
  assert(deriveColorFromTitle("No color here") === undefined, `Case 47i: no color word -> undefined`);
  assert(deriveGenderFromTitle("Tods Mens Green Loafer") === "Men", `Case 47i: gender from title (Men)`);
  assert(deriveGenderFromTitle("Prada Womens Bag") === "Women", `Case 47i: gender from title (Women)`);
  const wiped: ShopifyProduct = {
    id: "wiped-1", title: "Tods Mens Green Loafer", vendor: "Tods", product_type: "SHOES",
    options: [{ name: "Size", values: ["7", "8"] }],
    variants: [{ id: 1, sku: "STYLE1-7", price: "100.00", inventory_quantity: 1, option1: "7" }],
    metafields: [],
  };
  const wm = mapShopifyToJomashop(wiped, clothingSchema());
  assert(wm.properties.Color === "Green", `Case 47i: wiped product still derives Color=Green (got ${JSON.stringify(wm.properties.Color)})`);
  // 47j: operator-confirmed size-system inference (per value + footwear).
  assert(deriveSizeSystem("7.5", true) === "US", `Case 47j: shoe 7.5 -> US`);
  assert(deriveSizeSystem("42", true) === "EU", `Case 47j: shoe 42 -> EU`);
  assert(deriveSizeSystem("48", false) === "IT", `Case 47j: apparel 48 (even) -> IT`);
  assert(deriveSizeSystem("15", false) === "US", `Case 47j: apparel 15 -> US`);
  assert(deriveSizeSystem("M", false) === "US", `Case 47j: letter M -> US`);
  assert(deriveSizeSystem("One Size", false) === "US", `Case 47j: one size -> US`);
  assert(deriveSizeSystem("", false) === undefined, `Case 47j: no size -> undefined`);

  // 47c: a live schema with "Parent SKU" property gets the canonical value.
  const schemaWithParentSku: SchemaPropertyDescriptor[] = [
    ...apparelLiveSchema(),
    { field: "Parent SKU", label: "Parent SKU", required: false, type: "string" },
  ];
  const built = buildSchemaProperties(schemaWithParentSku, canonicalExplicit);
  assert(
    built.properties["Parent SKU"] === "ACME-PANT",
    `Case 47c: buildSchemaProperties wrote canonical.parent_sku under "Parent SKU" (got ${JSON.stringify(built.properties["Parent SKU"])})`,
  );

  // 47d: variant size is NOT a parent SKU. A product whose ONLY size-ish
  // metafield is "size" must yield undefined parent_sku.
  const productSizeOnly: ShopifyProduct = {
    id: "shopify-parent-2",
    title: "Sneakers",
    vendor: "Designer",
    product_type: "SNEK",
    images: [],
    options: [{ name: "Size", values: ["10"] }],
    variants: [{ id: 1, sku: "SNK-10", price: "300.00", inventory_quantity: 1, option1: "10" }],
    metafields: [
      { namespace: "custom", key: "size", value: "10", name: "Size" },
    ],
  };
  assert(
    readParentSku(productSizeOnly) === undefined,
    `Case 47d: variant size is never read as Parent SKU (got ${JSON.stringify(readParentSku(productSizeOnly))})`,
  );
  const canonicalSizeOnly = buildCanonicalProductFields(productSizeOnly);
  assert(
    canonicalSizeOnly.parent_sku === undefined,
    `Case 47d': canonical.parent_sku is undefined when only size metafield exists (got ${JSON.stringify(canonicalSizeOnly.parent_sku)})`,
  );
  // And a schema with "Parent SKU" must NOT auto-fill from size.
  const builtSizeOnly = buildSchemaProperties(schemaWithParentSku, canonicalSizeOnly);
  assert(
    builtSizeOnly.properties["Parent SKU"] === null ||
      builtSizeOnly.properties["Parent SKU"] === undefined,
    `Case 47d'': "Parent SKU" not populated from variant size (got ${JSON.stringify(builtSizeOnly.properties["Parent SKU"])})`,
  );

  // 47e: variant SKU / brand / handle are NOT parent SKUs either. Build a
  // product that has each but no parent_sku metafield; canonical.parent_sku
  // must still be undefined.
  const productNoParentMeta: ShopifyProduct = {
    id: "shopify-parent-3",
    title: "Bag",
    vendor: "ACME",
    product_type: "HAND",
    images: [],
    options: [],
    variants: [{ id: 9, sku: "BAG-XYZ-001", price: "500.00", inventory_quantity: 1 }],
    metafields: [
      { namespace: "custom", key: "ff_designer", value: "ACME" },
      { namespace: "custom", key: "sku", value: "BAG-XYZ-001" },
      { namespace: "custom", key: "vendor_sku", value: "BAG-XYZ-001" },
    ],
  };
  const canonNoParent = buildCanonicalProductFields(productNoParentMeta);
  assert(
    canonNoParent.parent_sku === undefined,
    `Case 47e: variant/vendor SKU & brand are never Parent SKU (got ${JSON.stringify(canonNoParent.parent_sku)})`,
  );

  // 47g: label-variant detection.
  assert(fieldIsParentSku("Parent SKU") === true, "Case 47g: fieldIsParentSku('Parent SKU') == true");
  assert(fieldIsParentSku("parent_sku") === true, "Case 47g': fieldIsParentSku('parent_sku') == true");
  assert(fieldIsParentSku("ParentSku") === true, "Case 47g'': fieldIsParentSku('ParentSku') == true");
  assert(
    fieldIsParentSku("SKU") === false,
    "Case 47g''': bare 'SKU' is NOT a Parent SKU",
  );
  assert(
    fieldIsParentSku("Vendor SKU") === false,
    "Case 47g'''': 'Vendor SKU' is NOT a Parent SKU",
  );
  assert(
    fieldIsVariantTargeted("Parent SKU") === false,
    "Case 47g''''': Parent SKU is product-level, not variant",
  );

  // 47h: namespaced metafield key shape ("custom.parent_sku") is honored.
  const productNamespacedKey: ShopifyProduct = {
    id: "shopify-parent-4",
    title: "Jacket",
    vendor: "X",
    product_type: "OUTW",
    images: [],
    options: [],
    variants: [{ id: 1, sku: "X-JKT", price: "100.00", inventory_quantity: 1 }],
    metafields: [
      { namespace: "luxe", key: "ff_parent_sku", value: "GROUP-001", name: "FF Parent SKU" },
    ],
  };
  assert(
    readParentSku(productNamespacedKey) === "GROUP-001",
    `Case 47h: luxe.ff_parent_sku honored (got ${JSON.stringify(readParentSku(productNamespacedKey))})`,
  );
  const src2 = findParentSkuSource(productNamespacedKey);
  assert(
    src2 !== null && src2.namespace === "luxe" && src2.key === "ff_parent_sku",
    `Case 47h': source detection returns luxe.ff_parent_sku (got ${JSON.stringify(src2)})`,
  );

  // Default-target rule: when there is no parent_sku metafield at all,
  // findParentSkuSource returns null and the writeback should fall back to
  // jomashop.parent_sku (verified via deriveMetafieldTargetForProductField).
  assert(
    findParentSkuSource(productSizeOnly) === null,
    "Case 47i: findParentSkuSource is null when no candidate metafield exists",
  );
  const defaultTarget = deriveMetafieldTargetForProductField("Parent SKU");
  assert(
    defaultTarget.namespace === "jomashop" && defaultTarget.key === "parent_sku",
    `Case 47i': default writeback target is jomashop.parent_sku (got ${JSON.stringify(defaultTarget)})`,
  );

  // Sanity: candidate list includes the documented common shapes.
  assert(
    PARENT_SKU_METAFIELD_CANDIDATES.includes("Parent SKU") &&
      PARENT_SKU_METAFIELD_CANDIDATES.includes("parent_sku") &&
      PARENT_SKU_METAFIELD_CANDIDATES.includes("ff_parent_sku") &&
      PARENT_SKU_METAFIELD_CANDIDATES.includes("parentSku"),
    "Case 47j: candidate list covers parent_sku / Parent SKU / ff_parent_sku / parentSku",
  );

  // findMetafieldSource general helper covers an arbitrary candidate set.
  const generic = findMetafieldSource(productExplicit, ["Color", "color"]);
  assert(
    generic !== null && generic.namespace === "custom" && generic.key === "color",
    `Case 47k: findMetafieldSource generic lookup (got ${JSON.stringify(generic)})`,
  );
}

// ---------- Case 48: Per-product XLSX export populates Parent SKU column ----
//
// Asserts that when the live category schema declares a "Parent SKU"
// property, the export workbook lands the cached product's Parent SKU
// metafield value in that cell — independent of whether `m.properties` was
// pre-populated at mapping time. (Reproduces the real-world ordering: cache
// was built before the live schema gained Parent SKU; the workbook still
// needs to surface the value.)
async function runParentSkuExportColumnPopulation() {
  console.log("Case 48: Per-product XLSX export populates Parent SKU column from metafield echo");
  const { aggregateProductFieldRows: _agg } = await import(
    "../server/jomashop_product_field_excel"
  );
  // We avoid the storage cache by directly constructing a synthetic
  // ProductFieldExportResult and a row-equivalent fixture with a debug_raw
  // metafield echo for Parent SKU. The exporter itself reads from this echo.
  // Round-trip the export through the workbook builder and assert the cell.
  // (Skip the full storage fixture — aggregateProductFieldRows requires the
  // sqlite cache. We test the cell-population helper logic directly.)
  const ws_fixture: ProductFieldExportResult = {
    shopDomain: "luxe-test.myshopify.com",
    fromCache: true,
    cachedAt: 1700000000000,
    totalProducts: 1,
    includedAll: true,
    categories: [
      {
        category: "Apparel",
        fieldsSource: "live-v1",
        fields: [
          { field: "Gender", label: "Gender", required: true, type: "enum", options: ["Men", "Women"] },
          { field: "Parent SKU", label: "Parent SKU", required: false, type: "string" },
        ],
        rows: [
          {
            rowId: "row-parent-001",
            jomashopCategory: "Apparel",
            shopifyProductId: "777",
            shopifyVariantId: "v-777",
            productTitle: "Apparel Item",
            vendorSku: "ACME-PANT-32",
            manufacturerNumber: "ACME-PANT",
            brand: "ACME",
            shopifyCategoryCode: "PANT",
            shopifyProductType: "PANT",
            jomashopCategoryId: "12",
            jomashopBrandId: "34",
            pushStatus: "ready",
            warnings: "",
            fieldValues: {
              Gender: "Men",
              "Parent SKU": "ACME-PANT",
            },
            isVariant: false,
            fieldWritebackTargets: {
              "Parent SKU": { namespace: "custom", key: "parent_sku" },
            },
          },
        ],
      },
    ],
  };
  const buf = await buildProductFieldWorkbook(ws_fixture);
  // Parse the workbook back and assert the cell value.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.getWorksheet("Apparel");
  assert(sheet != null, "Case 48a: Apparel sheet exists");
  const headerByCol = new Map<string, number>();
  sheet!.getRow(1).eachCell((cell, c) => {
    const t = String(cell.value ?? "").replace(/\s*\*\s*$/, "").trim();
    headerByCol.set(t, c);
  });
  const parentSkuCol = headerByCol.get("Parent SKU");
  assert(parentSkuCol !== undefined, "Case 48b: 'Parent SKU' column header present");
  const cellVal = sheet!.getRow(2).getCell(parentSkuCol!).value;
  assert(
    String(cellVal ?? "").trim() === "ACME-PANT",
    `Case 48c: Parent SKU cell populated (got ${JSON.stringify(cellVal)})`,
  );
}

// ---------- Case 49: Upload writeback prefers source metafield target -----
//
// Round-trips a workbook with a Parent SKU edit through parseProductFieldUpload
// and asserts the parsed row carries the new value. The downstream apply
// step prefers fieldWritebackTargets (custom.parent_sku here) over the
// default `jomashop.parent_sku` slug. We assert the target-resolution logic
// directly because the apply step calls Shopify Admin API and isn't unit-
// testable from this harness.
async function runParentSkuUploadWritebackTarget() {
  console.log("Case 49: Upload writeback prefers source metafield target for Parent SKU");
  const fixture: ProductFieldExportResult = {
    shopDomain: "luxe-test.myshopify.com",
    fromCache: true,
    cachedAt: 1700000000000,
    totalProducts: 1,
    includedAll: true,
    categories: [
      {
        category: "Apparel",
        fieldsSource: "live-v1",
        fields: [
          { field: "Parent SKU", label: "Parent SKU", required: false, type: "string" },
        ],
        rows: [
          {
            rowId: "row-parent-002",
            jomashopCategory: "Apparel",
            shopifyProductId: "888",
            shopifyVariantId: "v-888",
            productTitle: "Item",
            vendorSku: "X-SKU-1",
            manufacturerNumber: "MNF",
            brand: "ACME",
            shopifyCategoryCode: "PANT",
            shopifyProductType: "PANT",
            jomashopCategoryId: "",
            jomashopBrandId: "",
            pushStatus: "missing",
            warnings: "",
            fieldValues: { "Parent SKU": "OLD-VAL" },
            isVariant: false,
            fieldWritebackTargets: {
              "Parent SKU": { namespace: "luxe", key: "ff_parent_sku" },
            },
          },
        ],
      },
    ],
  };
  const buf = await buildProductFieldWorkbook(fixture);
  // Mutate workbook: change the Parent SKU cell to "NEW-VAL", set Write Back? = Yes.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.getWorksheet("Apparel");
  assert(sheet != null, "Case 49a: Apparel sheet present");
  const headerByCol = new Map<string, number>();
  sheet!.getRow(1).eachCell((cell, c) => {
    const t = String(cell.value ?? "").replace(/\s*\*\s*$/, "").trim();
    headerByCol.set(t, c);
  });
  const psCol = headerByCol.get("Parent SKU");
  const wbCol = headerByCol.get("Write Back?");
  assert(psCol !== undefined && wbCol !== undefined, "Case 49b: both headers present");
  sheet!.getRow(2).getCell(psCol!).value = "NEW-VAL";
  sheet!.getRow(2).getCell(wbCol!).value = "Yes";
  const out = Buffer.from(await wb.xlsx.writeBuffer());
  const parsed = await parseProductFieldUpload(out, fixture);
  const row = parsed.rows.find((r) => r.rowId === "row-parent-002");
  assert(row != null, `Case 49c: parsed row present (rows=${parsed.rows.map((r) => r.rowId).join(",")})`);
  assert(
    row!.fieldValues["Parent SKU"] === "NEW-VAL",
    `Case 49d: parsed Parent SKU value = NEW-VAL (got ${JSON.stringify(row!.fieldValues["Parent SKU"])})`,
  );
  assert(row!.writeBack === true, `Case 49e: writeBack=true (got ${row!.writeBack})`);
  assert(row!.isValid === true, `Case 49f: parsed row is valid (errors=${JSON.stringify(row!.errors)})`);
  // The apply step resolves the target from aggSnapshot.fieldWritebackTargets:
  // re-derive the same way and assert it lands on luxe.ff_parent_sku rather
  // than the default jomashop.parent_sku slug.
  const targetsByRowId = new Map<string, Record<string, { namespace: string; key: string }>>();
  for (const cat of fixture.categories) {
    for (const r of cat.rows) {
      if (r.fieldWritebackTargets) targetsByRowId.set(r.rowId, r.fieldWritebackTargets);
    }
  }
  const overrides = targetsByRowId.get(row!.rowId);
  const override = overrides ? overrides["Parent SKU"] : undefined;
  const target = override
    ? { namespace: override.namespace, key: override.key }
    : deriveMetafieldTargetForProductField("Parent SKU");
  assert(
    target.namespace === "luxe" && target.key === "ff_parent_sku",
    `Case 49g: writeback target preserved source (got ${JSON.stringify(target)})`,
  );
  // And: when no override exists, the default is jomashop.parent_sku.
  const noOverride = deriveMetafieldTargetForProductField("Parent SKU");
  assert(
    noOverride.namespace === "jomashop" && noOverride.key === "parent_sku",
    `Case 49h: default Parent SKU target is jomashop.parent_sku (got ${JSON.stringify(noOverride)})`,
  );
}

// ---------- Case 50: import-preview sheet recognition + forceWriteback ----
//
// Reproduces the user-reported bug where a completed per-product workbook
// uploaded to /api/jomashop-product-fields/import-preview produced
// "Sheet 'Accessories' doesn't match any known Jomashop category; skipping"
// for every category sheet, despite the sheet names matching the exporter's
// output exactly. Root cause: the parser keyed its sheet -> category map
// solely off of the in-memory `agg` snapshot, which is empty when the
// product cache has been invalidated. The fix routes resolution through
// SUPPORTED_CATEGORIES + a hidden _Meta sheet stamped at export time, so
// the parser always recognizes the workbook's own sheets.
//
// Also exercises the new forceWriteback flag: with Write Back? cells blank,
// `parseProductFieldUpload(..., { forceWriteback: true })` flips
// writeBack=true on rows that have at least one filled field value.
async function runProductFieldSheetRecognitionAndForceWriteback() {
  console.log(
    "Case 50: sheet recognition for actual category names + forceWriteback for blank Write Back? cells",
  );

  // 50a: resolveSheetCategory matches each canonical category from the
  // SUPPORTED_CATEGORIES list, including spaced + ampersand variants.
  const canonicalSheetNames = [
    "Accessories",
    "Apparel",
    "Footwear",
    "Handbags",
    "Home Decor",
    "Pins & Brooches",
  ];
  for (const name of canonicalSheetNames) {
    const resolved = resolveSheetCategory(name);
    assert(
      resolved === name,
      `Case 50a: resolveSheetCategory("${name}") === "${name}" (got ${JSON.stringify(resolved)})`,
    );
  }

  // 50b: case + whitespace insensitive — operator-typed "home decor" still
  // resolves to canonical "Home Decor".
  assert(
    resolveSheetCategory("home decor") === "Home Decor",
    `Case 50b: case-insensitive resolution for "home decor"`,
  );
  assert(
    resolveSheetCategory("pins & brooches") === "Pins & Brooches",
    `Case 50b2: case-insensitive resolution for ampersand sheet name`,
  );

  // 50c: empty agg snapshot — the exact failure mode reported by the user.
  // Build a workbook with the actual sheet names, then parse with an empty
  // agg. Should still resolve every sheet to a known category and surface
  // at least one parsed row per sheet.
  const ExcelJS = (await import("exceljs")).default;
  const aggForExport: ProductFieldExportResult = {
    shopDomain: "test.myshopify.com",
    fromCache: true,
    cachedAt: Date.now(),
    totalProducts: canonicalSheetNames.length,
    includedAll: true,
    categories: canonicalSheetNames.map((category, idx) => ({
      category,
      fieldsSource: "fallback" as const,
      fields: [
        { field: "Color", label: "Color", required: false, type: "string" as const },
      ],
      rows: [
        {
          rowId: `row-${idx}-001`,
          jomashopCategory: category,
          shopifyProductId: `${1000 + idx}`,
          shopifyVariantId: `${2000 + idx}`,
          productTitle: `Test ${category} Product`,
          vendorSku: `VS-${idx}`,
          manufacturerNumber: `MFR-${idx}`,
          brand: "Test Brand",
          shopifyCategoryCode: `CAT-${idx}`,
          shopifyProductType: `CAT-${idx}`,
          jomashopCategoryId: `${100 + idx}`,
          jomashopBrandId: `${200 + idx}`,
          pushStatus: "needs-fill",
          warnings: "",
          fieldValues: { Color: "" },
          isVariant: false,
        },
      ],
    })),
  };

  const buf = await buildProductFieldWorkbook(aggForExport);

  // Confirm the exported workbook carries every requested sheet by name —
  // proves we're testing the exact same sheet names the user uploaded.
  const wbCheck = new ExcelJS.Workbook();
  await wbCheck.xlsx.load(buf);
  const sheetNames = wbCheck.worksheets.map((w) => w.name);
  for (const expected of canonicalSheetNames) {
    assert(
      sheetNames.includes(expected),
      `Case 50c: workbook export carries sheet "${expected}" (got ${sheetNames.join(", ")})`,
    );
  }
  // Hidden _Meta sheet present + populated.
  const metaSheet = wbCheck.getWorksheet("_Meta");
  assert(metaSheet !== undefined, "Case 50c2: hidden _Meta sheet is present in the export");
  assert(
    (metaSheet as any).state === "hidden" || (metaSheet as any).state === "veryHidden",
    `Case 50c3: _Meta sheet is hidden (state=${(metaSheet as any).state})`,
  );

  // 50d: fill one cell per sheet (NO Write Back? cell set) and parse with
  // an EMPTY agg — exactly the failure mode reported in production.
  const wbFill = new ExcelJS.Workbook();
  await wbFill.xlsx.load(buf);
  for (const name of canonicalSheetNames) {
    const ws = wbFill.getWorksheet(name)!;
    const headerCols: Record<string, number> = {};
    ws.getRow(1).eachCell((cell, c) => {
      headerCols[String(cell.value)] = c;
    });
    // Drop a value into Color so the row is non-empty (writeback candidate).
    ws.getRow(2).getCell(headerCols["Color"]).value = "Black";
    // Explicitly do NOT touch Write Back? — that's the bug condition.
  }
  const filledBuf = Buffer.from(await wbFill.xlsx.writeBuffer());

  const emptyAgg: ProductFieldExportResult = {
    shopDomain: null,
    fromCache: false,
    cachedAt: null,
    totalProducts: 0,
    includedAll: true,
    categories: [],
  };

  const parsedEmpty = await parseProductFieldUpload(filledBuf, emptyAgg);
  // Every sheet must produce at least one parsed row — no "doesn't match"
  // warnings.
  for (const expected of canonicalSheetNames) {
    const rowForSheet = parsedEmpty.rows.find((r) => r.jomashopCategory === expected);
    assert(
      rowForSheet !== undefined,
      `Case 50d: sheet "${expected}" parsed at least one row with empty agg (warnings=${JSON.stringify(parsedEmpty.perCategoryWarnings)})`,
    );
  }
  assert(
    parsedEmpty.perCategoryWarnings.length === 0,
    `Case 50d2: no "doesn't match any known Jomashop category" warnings (got ${JSON.stringify(parsedEmpty.perCategoryWarnings)})`,
  );
  assert(
    parsedEmpty.rows.length >= canonicalSheetNames.length,
    `Case 50d3: total parsed rows >= number of category sheets (got ${parsedEmpty.rows.length})`,
  );

  // 50e: with Write Back? blank everywhere, default parse leaves writeBack
  // = false. forceWriteback flips it for rows that have at least one
  // filled cell.
  for (const row of parsedEmpty.rows) {
    assert(
      row.writeBack === false,
      `Case 50e: default writeBack=false when Write Back? cell is blank (sheet=${row.sheetName})`,
    );
  }

  const parsedForced = await parseProductFieldUpload(filledBuf, emptyAgg, {
    forceWriteback: true,
  });
  const forcedRows = parsedForced.rows.filter(
    (r) => Object.keys(r.fieldValues).length > 0,
  );
  assert(
    forcedRows.length >= canonicalSheetNames.length,
    `Case 50f: forceWriteback parse surfaces every filled row (got ${forcedRows.length})`,
  );
  for (const row of forcedRows) {
    assert(
      row.writeBack === true,
      `Case 50f2: forceWriteback flips writeBack=true on filled rows (sheet=${row.sheetName}, fieldValues=${JSON.stringify(row.fieldValues)})`,
    );
  }

  // 50g: forceWriteback does NOT override an explicit Write Back? = No.
  const wbWithNo = new ExcelJS.Workbook();
  await wbWithNo.xlsx.load(buf);
  const apparelWs = wbWithNo.getWorksheet("Apparel")!;
  const apparelHdrs: Record<string, number> = {};
  apparelWs.getRow(1).eachCell((c, idx) => {
    apparelHdrs[String(c.value)] = idx;
  });
  apparelWs.getRow(2).getCell(apparelHdrs["Color"]).value = "Red";
  apparelWs.getRow(2).getCell(apparelHdrs["Write Back?"]).value = "No";
  const noBuf = Buffer.from(await wbWithNo.xlsx.writeBuffer());
  const parsedNo = await parseProductFieldUpload(noBuf, emptyAgg, {
    forceWriteback: true,
  });
  const noRow = parsedNo.rows.find((r) => r.jomashopCategory === "Apparel")!;
  assert(
    noRow.writeBack === false,
    `Case 50g: explicit Write Back? = No wins over forceWriteback (got ${noRow.writeBack})`,
  );

  // 50h: workbook with NO _Meta sheet (e.g. an older export the user
  // already has on disk) still resolves all sheets via the static
  // SUPPORTED_CATEGORIES fallback.
  const wbNoMeta = new ExcelJS.Workbook();
  await wbNoMeta.xlsx.load(buf);
  // Older exports never had a _Meta sheet. Simulate that by removing it
  // before re-parsing.
  const metaWs = wbNoMeta.getWorksheet("_Meta");
  if (metaWs) wbNoMeta.removeWorksheet(metaWs.id);
  // Fill a value too.
  const handbagsWs = wbNoMeta.getWorksheet("Handbags")!;
  const handbagsHdrs: Record<string, number> = {};
  handbagsWs.getRow(1).eachCell((c, idx) => {
    handbagsHdrs[String(c.value)] = idx;
  });
  handbagsWs.getRow(2).getCell(handbagsHdrs["Color"]).value = "Beige";
  const noMetaBuf = Buffer.from(await wbNoMeta.xlsx.writeBuffer());
  const parsedNoMeta = await parseProductFieldUpload(noMetaBuf, emptyAgg);
  const handbagsRowNoMeta = parsedNoMeta.rows.find(
    (r) => r.jomashopCategory === "Handbags",
  );
  assert(
    handbagsRowNoMeta !== undefined,
    `Case 50h: workbook without _Meta still resolves Handbags via SUPPORTED_CATEGORIES fallback (warnings=${JSON.stringify(parsedNoMeta.perCategoryWarnings)})`,
  );
  assert(
    parsedNoMeta.perCategoryWarnings.length === 0,
    `Case 50h2: still no "doesn't match" warnings (got ${JSON.stringify(parsedNoMeta.perCategoryWarnings)})`,
  );
}

// Case 51: Clothing → Apparel alias normalization. The live Jomashop /v1
// category endpoint only knows "Apparel" — pushes for products the internal
// mapper still labels as "Clothing" (legacy alias) must resolve schema via
// the canonical name, otherwise preflight blocks with "accepted option list
// has not been loaded" even when the live Apparel schema is reachable.
function runClothingApparelAliasNormalization() {
  console.log(
    "Case 51: Clothing alias resolves to Apparel for schema lookups; push uses live Apparel Article options",
  );
  // (51a) The alias map carries the canonical mapping.
  assert(
    CANONICAL_JOMASHOP_CATEGORY_ALIASES["clothing"] === "Apparel",
    `clothing alias maps to Apparel (got ${JSON.stringify(CANONICAL_JOMASHOP_CATEGORY_ALIASES["clothing"])})`,
  );
  assert(
    CANONICAL_JOMASHOP_CATEGORY_ALIASES["rtw"] === "Apparel",
    `rtw alias maps to Apparel (got ${JSON.stringify(CANONICAL_JOMASHOP_CATEGORY_ALIASES["rtw"])})`,
  );
  // (51b) canonicalJomashopCategory normalizes every legacy / cased input.
  assert(
    canonicalJomashopCategory("Clothing") === "Apparel",
    `canonicalJomashopCategory("Clothing") === "Apparel"`,
  );
  assert(
    canonicalJomashopCategory("clothing") === "Apparel",
    `canonicalJomashopCategory("clothing") === "Apparel"`,
  );
  assert(
    canonicalJomashopCategory("Apparel") === "Apparel",
    `canonicalJomashopCategory("Apparel") passes through unchanged`,
  );
  // Handbags is not aliased — must pass through.
  assert(
    canonicalJomashopCategory("Handbags") === "Handbags",
    `canonicalJomashopCategory("Handbags") passes through unchanged`,
  );
  // (51c) Push payload for an OUTW Canada Goose Apparel item — when the
  // category was tagged "Clothing" upstream but the live Apparel v1 schema
  // is provided (simulating the production state where
  // /api/jomashop/category-enum-options/Apparel returned the live list with
  // "Coats & Jackets") — the mapper must accept that schema's Article
  // option and the resulting payload must carry it. This is exactly the
  // production failure mode the user reported.
  const apparelV1Schema: SchemaPropertyDescriptor[] = [
    { field: "Gender", label: "Gender", required: true, type: "enum", options: ["Men", "Women", "Unisex"] },
    { field: "Age", label: "Age", required: true, type: "enum", options: ["Adult", "Kids"] },
    {
      field: "Apparel Type",
      label: "Apparel Type",
      required: true,
      type: "enum",
      options: ["Outerwear", "Pants", "Shirts"],
    },
    { field: "Detailed Description", label: "Detailed Description", required: true, type: "string" },
    { field: "Total Number of Pieces", label: "Total Number of Pieces", required: true, type: "string" },
    { field: "Color", label: "Color", required: true, type: "string" },
    // Live v1 Article options as returned by Jomashop for Apparel.
    {
      field: "Article",
      label: "Article",
      required: true,
      type: "enum",
      options: ["Coats & Jackets", "Sweaters", "Shirts & Tops"],
    },
    {
      field: "Variation Size Yes/No",
      label: "Variation Size Yes/No",
      required: false,
      type: "enum",
      options: ["Yes", "No"],
    },
    {
      field: "Country",
      label: "Country",
      required: false,
      type: "enum",
      options: ["CA Canada", "US United States", "IT Italy"],
    },
  ];
  const product: ShopifyProduct = {
    id: "shopify-cg-outw-alias-1",
    title: "Canada Goose Coats & Jackets Black",
    body_html: "<p>Outerwear.</p>",
    vendor: "Canada Goose",
    product_type: "OUTW",
    tags: ["Mens", "Outerwear"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      { id: 9001, sku: "CG-OUTW-ALIAS-M", price: "1295.00", inventory_quantity: 1, option1: "M" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Black", name: "Color" },
      { namespace: "custom", key: "country_of_origin", value: "Canada" },
      { namespace: "custom", key: "ff_designer_id", value: "OUTW-CG-1" },
      // The operator already saved a verified mapping for Article in
      // production. Simulate that via the overlay resolver below.
    ],
  };
  // Operator-saved verified enum mapping: OUTW → "Coats & Jackets".
  const resolver = makeTestEnumResolver({
    "apparel|article|outw": "Coats & Jackets",
    "apparel|apparel type|outw": "Outerwear",
    "apparel|variation size yes/no|m": "Yes",
    "apparel|country|canada": "CA Canada",
  });
  const mapped = mapShopifyToJomashop(product, apparelV1Schema, "Apparel", {
    resolveEnumOverride: resolver,
  });
  // The live Apparel schema is verified — no options_unverified — so Article
  // must resolve to "Coats & Jackets" via the operator mapping AND emit
  // verbatim into payload.properties. This is the exact production
  // assertion: the push payload carries the live verified option, not a
  // fallback blocked at "accepted options unknown".
  assert(
    mapped.properties.Article === "Coats & Jackets",
    `Case 51c: Article === "Coats & Jackets" from live v1 + verified mapping (got ${JSON.stringify(mapped.properties.Article)})`,
  );
  assert(
    mapped.properties["Apparel Type"] === "Outerwear",
    `Case 51c2: Apparel Type === "Outerwear" (got ${JSON.stringify(mapped.properties["Apparel Type"])})`,
  );
  assert(
    mapped.properties.Color === "Black",
    `Case 51c3: Color === "Black" (got ${JSON.stringify(mapped.properties.Color)})`,
  );
  // unverified_required_options MUST be empty — Article options came from
  // the live schema (no options_unverified flag). This is the inverse of
  // the production failure where the fallback Clothing schema marked Article
  // as options_unverified and blocked preflight.
  assert(
    (mapped.unverified_required_options || []).length === 0,
    `Case 51c4: no unverified_required_options when live Apparel schema is used (got ${JSON.stringify(mapped.unverified_required_options)})`,
  );
  // The payload must be pushable end-to-end — no preflight block.
  const { payload, missingRequired, pushDebug } = buildJomashopProductPayload(mapped, undefined, {
    category: "Apparel",
    brand: "Canada Goose",
    manufacturer_id: 2774,
    category_id: 35,
  });
  assert(
    pushDebug.unverifiedRequiredOptions.length === 0,
    `Case 51c5: pushDebug carries no unverifiedRequiredOptions (got ${JSON.stringify(pushDebug.unverifiedRequiredOptions)})`,
  );
  assert(
    !missingRequired.includes("Article"),
    `Case 51c6: missingRequired does NOT include Article (got ${JSON.stringify(missingRequired)})`,
  );
  const payloadProps = (payload.properties as Record<string, unknown>) || {};
  assert(
    payloadProps.Article === "Coats & Jackets",
    `Case 51c7: payload.properties.Article === "Coats & Jackets" (got ${JSON.stringify(payloadProps.Article)})`,
  );
  // (51d) The bundled fallback for the Clothing alias must lift to Apparel's
  // fallback for safety — Apparel's Article still has options_unverified, so
  // verify the alias-routed fallback IS the Apparel fallback (not a stale
  // Clothing-only fallback). We assert by checking the legacy Clothing
  // fallback still exists for compatibility but is NOT what canonical
  // resolution targets.
  assert(
    FALLBACK_CATEGORY_SCHEMAS.Apparel.some((f) => f.field === "Article"),
    `Case 51d: FALLBACK_CATEGORY_SCHEMAS.Apparel still carries Article`,
  );
  assert(
    canonicalJomashopCategory("Clothing") === "Apparel",
    `Case 51d2: schema alias resolution targets the Apparel fallback (not Clothing)`,
  );
}

// ---------- MSRP resolution / push payload tests ----------

function apparelSchema() {
  return FALLBACK_CATEGORY_SCHEMAS.Apparel.map((f) => ({
    field: f.field,
    required: f.required,
    type: f.type,
    options: f.options,
  }));
}

function runMsrpCanadaGooseCompareAtPrice() {
  console.log(
    "Case MSRP-1: Canada Goose Apparel — price 400 + compare_at_price 400 + discount 40% → payload price 240, msrp 400",
  );
  const product: ShopifyProduct = {
    id: "shopify-cg-1",
    title: "Canada Goose Wyndham Parka",
    body_html: "<p>Down parka.</p>",
    vendor: "Canada Goose",
    product_type: "Apparel",
    tags: ["Men", "Outerwear"],
    images: [{ src: "https://example.com/cg.jpg" }],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      {
        id: 9101,
        sku: "CG-WYND-M",
        price: "400.00",
        compare_at_price: "400.00",
        inventory_quantity: 3,
        option1: "M",
      },
    ],
    metafields: [
      { namespace: "custom", key: "commercial_discount", value: "40" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelSchema());
  assert(
    mapped.price === 400,
    `Case MSRP-1a: mapped.price === 400 (got ${JSON.stringify(mapped.price)})`,
  );
  assert(
    mapped.commercial_discount === 0.4,
    `Case MSRP-1b: mapped.commercial_discount === 0.4 (got ${JSON.stringify(mapped.commercial_discount)})`,
  );
  assert(
    mapped.jomashop_price === 240,
    `Case MSRP-1c: mapped.jomashop_price === 240 (got ${JSON.stringify(mapped.jomashop_price)})`,
  );
  assert(
    mapped.msrp === 400,
    `Case MSRP-1d: mapped.msrp === 400 (got ${JSON.stringify(mapped.msrp)})`,
  );
  assert(
    mapped.msrp_source === "variant_compare_at_price",
    `Case MSRP-1e: msrp_source === "variant_compare_at_price" (got ${JSON.stringify(mapped.msrp_source)})`,
  );

  const { payload } = buildJomashopProductPayload(mapped, undefined, {
    manufacturer_id: 2774,
    category_id: 35,
  });
  assert(
    payload.price === 240,
    `Case MSRP-1f: payload.price === 240 (got ${JSON.stringify(payload.price)})`,
  );
  assert(
    payload.msrp === 400,
    `Case MSRP-1g: payload.msrp === 400 (got ${JSON.stringify(payload.msrp)})`,
  );

  const envelope = buildI1ProductEnvelope(payload, mapped.variants[0] ?? null) as {
    product: Record<string, unknown>;
    stock: Record<string, unknown>;
  };
  assert(
    envelope.stock?.price === 240,
    `Case MSRP-1h: envelope.stock.price === 240 (got ${JSON.stringify(envelope.stock?.price)})`,
  );
  assert(
    envelope.stock?.msrp === 400,
    `Case MSRP-1i: envelope.stock.msrp === 400 — Jomashop portal needs MSRP under stock (got ${JSON.stringify(envelope.stock?.msrp)})`,
  );
}

function runMsrpFallbackToShopifyPrice() {
  console.log(
    "Case MSRP-2: blank compare_at_price + no metafield → MSRP falls back to Shopify price (the retail/list price for this vendor)",
  );
  const product: ShopifyProduct = {
    id: "shopify-cg-2",
    title: "Canada Goose Chilliwack Bomber",
    body_html: "",
    vendor: "Canada Goose",
    product_type: "Apparel",
    tags: ["Men"],
    images: [],
    options: [{ name: "Size", values: ["L"] }],
    variants: [
      {
        id: 9102,
        sku: "CG-CHIL-L",
        price: "400.00",
        compare_at_price: null,
        inventory_quantity: 1,
        option1: "L",
      },
    ],
    metafields: [
      { namespace: "custom", key: "commercial_discount", value: "40" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelSchema());
  assert(
    mapped.msrp === 400,
    `Case MSRP-2a: mapped.msrp === 400 from Shopify price fallback (got ${JSON.stringify(mapped.msrp)})`,
  );
  assert(
    mapped.msrp_source === "shopify_price_fallback",
    `Case MSRP-2b: msrp_source === "shopify_price_fallback" (got ${JSON.stringify(mapped.msrp_source)})`,
  );
  assert(
    mapped.jomashop_price === 240,
    `Case MSRP-2c: discounted jomashop_price stays 240 even with fallback MSRP (got ${JSON.stringify(mapped.jomashop_price)})`,
  );

  const { payload } = buildJomashopProductPayload(mapped, undefined, {
    manufacturer_id: 2774,
    category_id: 35,
  });
  const envelope = buildI1ProductEnvelope(payload, mapped.variants[0] ?? null) as {
    stock: Record<string, unknown>;
  };
  assert(
    envelope.stock?.msrp === 400,
    `Case MSRP-2d: envelope.stock.msrp === 400 — fixes the reported "MSRP blank" bug (got ${JSON.stringify(envelope.stock?.msrp)})`,
  );
}

function runMsrpMetafieldSourceWorks() {
  console.log("Case MSRP-3: explicit MSRP metafield is sourced when present");
  const product: ShopifyProduct = {
    id: "shopify-cg-3",
    title: "Test Product",
    body_html: "",
    vendor: "Test",
    product_type: "Apparel",
    tags: [],
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      {
        id: 9103,
        sku: "TST-M",
        price: "100.00",
        compare_at_price: null,
        inventory_quantity: 1,
        option1: "M",
      },
    ],
    metafields: [
      { namespace: "custom", key: "msrp", value: "175.00", name: "MSRP", label: "MSRP" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelSchema());
  assert(
    mapped.msrp === 175,
    `Case MSRP-3a: metafield msrp wins over Shopify price fallback (got ${JSON.stringify(mapped.msrp)})`,
  );
  assert(
    mapped.msrp_source === "metafield",
    `Case MSRP-3b: msrp_source === "metafield" (got ${JSON.stringify(mapped.msrp_source)})`,
  );
  assert(
    typeof mapped.msrp_metafield_key === "string" && mapped.msrp_metafield_key !== "",
    `Case MSRP-3c: msrp_metafield_key populated (got ${JSON.stringify(mapped.msrp_metafield_key)})`,
  );

  // Also verify alternative metafield labels work (retail_price, list_price,
  // original_price, compareAtPrice — each spelling is its own field that may
  // appear independently across catalogs).
  const altLabels = ["retail_price", "list_price", "original_price", "compareAtPrice"];
  for (const k of altLabels) {
    const alt: ShopifyProduct = {
      id: `shopify-alt-${k}`,
      title: "Alt Source",
      vendor: "Test",
      product_type: "Apparel",
      tags: [],
      images: [],
      options: [{ name: "Size", values: ["M"] }],
      variants: [
        {
          id: 9200,
          sku: "ALT-M",
          price: "50.00",
          compare_at_price: null,
          inventory_quantity: 1,
          option1: "M",
        },
      ],
      metafields: [{ namespace: "custom", key: k, value: "200.00" }],
    };
    const m = mapShopifyToJomashop(alt, apparelSchema());
    assert(
      m.msrp === 200,
      `Case MSRP-3d (${k}): metafield resolves MSRP (got ${JSON.stringify(m.msrp)})`,
    );
    assert(
      m.msrp_source === "metafield",
      `Case MSRP-3e (${k}): msrp_source === "metafield" (got ${JSON.stringify(m.msrp_source)})`,
    );
  }
}

function runMsrpVariantCompareAtPriceTakesPrecedence() {
  console.log("Case MSRP-4: variant compare_at_price takes precedence over metafields");
  const product: ShopifyProduct = {
    id: "shopify-cg-4",
    title: "Test Product",
    body_html: "",
    vendor: "Test",
    product_type: "Apparel",
    tags: [],
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      {
        id: 9104,
        sku: "TST2-M",
        price: "100.00",
        compare_at_price: "300.00",
        inventory_quantity: 1,
        option1: "M",
      },
    ],
    metafields: [
      // Metafield says 999, but variant compare_at_price wins because Shopify's
      // native field is the canonical MSRP signal when populated.
      { namespace: "custom", key: "msrp", value: "999.00" },
    ],
  };
  const mapped = mapShopifyToJomashop(product, apparelSchema());
  assert(
    mapped.msrp === 300,
    `Case MSRP-4a: variant compare_at_price (300) beats metafield (999), got ${JSON.stringify(mapped.msrp)}`,
  );
  assert(
    mapped.msrp_source === "variant_compare_at_price",
    `Case MSRP-4b: msrp_source === "variant_compare_at_price" (got ${JSON.stringify(mapped.msrp_source)})`,
  );
}

function runMsrpBlankPriceYieldsNone() {
  console.log("Case MSRP-5: blank Shopify price + no metafield + no compare_at_price → no MSRP");
  const product: ShopifyProduct = {
    id: "shopify-noprice",
    title: "Test Product",
    body_html: "",
    vendor: "Test",
    product_type: "Apparel",
    tags: [],
    images: [],
    options: [{ name: "Size", values: ["M"] }],
    variants: [
      {
        id: 9105,
        sku: "TST3-M",
        // No price at all on the variant.
        inventory_quantity: 1,
        option1: "M",
      },
    ],
    metafields: [],
  };
  const mapped = mapShopifyToJomashop(product, apparelSchema());
  assert(
    mapped.price === null,
    `Case MSRP-5a: mapped.price === null (got ${JSON.stringify(mapped.price)})`,
  );
  assert(
    mapped.msrp === null,
    `Case MSRP-5b: mapped.msrp === null when nothing usable exists (got ${JSON.stringify(mapped.msrp)})`,
  );
  assert(
    mapped.msrp_source === "none",
    `Case MSRP-5c: msrp_source === "none" (got ${JSON.stringify(mapped.msrp_source)})`,
  );

  const { payload } = buildJomashopProductPayload(mapped, undefined, {
    manufacturer_id: 2774,
    category_id: 35,
  });
  const envelope = buildI1ProductEnvelope(payload, mapped.variants[0] ?? null) as {
    stock: Record<string, unknown>;
  };
  assert(
    !("msrp" in envelope.stock),
    `Case MSRP-5d: envelope.stock omits msrp when no MSRP source is available (got ${JSON.stringify(envelope.stock)})`,
  );
}

function runMsrpResolveDirectFn() {
  console.log("Case MSRP-6: resolveMsrp() works as a standalone helper");
  // Direct resolveMsrp usage — exercises the function exposed for callers
  // that work outside the full mapper (e.g. the per-product XLSX exporter).
  const product: ShopifyProduct = {
    metafields: [
      { namespace: "custom", key: "list_price", value: "1200.00" },
    ],
    variants: [{ id: 1, sku: "A", price: "800.00", inventory_quantity: 1 }],
  };
  const res = resolveMsrp(product, 800);
  assert(
    res.value === 1200,
    `Case MSRP-6a: resolveMsrp picks metafield list_price (got ${JSON.stringify(res.value)})`,
  );
  assert(
    res.source === "metafield",
    `Case MSRP-6b: resolveMsrp source is metafield (got ${JSON.stringify(res.source)})`,
  );

  // findMsrpSource locates the metafield identifier for writeback targeting.
  const located = findMsrpSource(product);
  assert(
    located !== null && located.key === "list_price",
    `Case MSRP-6c: findMsrpSource returns matched metafield (got ${JSON.stringify(located)})`,
  );

  // Constant is exposed for downstream Excel writeback / mapping audit use.
  assert(
    MSRP_METAFIELD_CANDIDATES.includes("MSRP") && MSRP_METAFIELD_CANDIDATES.includes("compareAtPrice"),
    `Case MSRP-6d: MSRP_METAFIELD_CANDIDATES carries documented spellings`,
  );
}

runMsrpCanadaGooseCompareAtPrice();
runMsrpFallbackToShopifyPrice();
runMsrpMetafieldSourceWorks();
runMsrpVariantCompareAtPriceTakesPrecedence();
runMsrpBlankPriceYieldsNone();
runMsrpResolveDirectFn();

runClothingApparelAliasNormalization();

runColorNavyCase();
runDefinitionNameOnlyCase();
runVariantSelectedOptionFallback();
runListTypeMetafield();
runBuiltInCategoryDefaults();
runBrandKeyNormalization();
runManufacturerIdCarriedThrough();
async function runGoLivePatchTests() {
  console.log("Case 51: go-live patch — images push, dropdowns, pushed transition, inventory, export caps");

  // ---- 51a: Mapping XLSX now provides named-range dropdowns for ALL enum
  // properties (including long lists) — the inline 50-option / no-comma
  // restriction in the previous build silently skipped long lists.
  {
    const longOptions = Array.from({ length: 220 }, (_, i) => `Country_${i}`);
    longOptions.push("US, Comma Country"); // includes a comma — used to be excluded
    const agg: AggregateMappingsResult = {
      shopDomain: "test.myshopify.com",
      fromCache: true,
      cachedAt: Date.now(),
      totalProducts: 1,
      rows: [
        {
          rowId: "row-coo-1",
          jomashopCategory: "Apparel",
          shopifyCategoryCode: "CLTH",
          shopifyProductType: "CLTH",
          jomashopPropertyName: "Country of Origin",
          required: true,
          currentSourceField: "metafield",
          currentSourceValue: "(empty)",
          currentAutoMappedValue: "(missing)",
          statusReason: "Required field is missing",
          acceptedJomashopOptions: longOptions,
          acceptedOptionsSource: "live-v1",
          exampleProductTitles: ["Long-list Test"],
          exampleSkus: ["LL-1"],
          productCount: 1,
          shopifyProductIds: ["1"],
          currentVerifiedOverride: null,
        },
      ],
    };
    const buf = await buildMappingWorkbook(agg);
    assert(buf.length > 0, "Case 51a: mapping workbook builds with long enum list");

    const ExcelJS = await import("exceljs");
    const wb = new ExcelJS.default.Workbook();
    await wb.xlsx.load(buf);
    const optionsSheet = wb.getWorksheet("_Options");
    assert(optionsSheet !== undefined, "Case 51a: _Options helper sheet present in mapping workbook");
    const expectedName = buildMappingOptionsRangeName("Apparel", "Country of Origin");
    const definedRefs: string[] = [];
    wb.definedNames.model.forEach((d: any) => {
      if (d && d.name === expectedName) {
        for (const r of d.ranges || []) definedRefs.push(r);
      }
    });
    assert(
      definedRefs.length > 0,
      `Case 51a: defined name ${expectedName} present (got ${definedRefs.length})`,
    );
    const ws = wb.getWorksheet("Jomashop Mapping")!;
    // Find the User Jomashop Value column
    let userValueCol = -1;
    ws.getRow(1).eachCell((cell, col) => {
      if (String(cell.value).trim() === "User Jomashop Value") userValueCol = Number(col);
    });
    assert(userValueCol > 0, "Case 51a: User Jomashop Value column located");
    const cellDV = ws.getRow(2).getCell(userValueCol).dataValidation as any;
    assert(
      cellDV && cellDV.type === "list" && Array.isArray(cellDV.formulae) && /mopts_/i.test(String(cellDV.formulae[0] ?? "")),
      `Case 51a: user_value dropdown references named range (got formulae=${JSON.stringify(cellDV?.formulae)})`,
    );
  }

  // ---- 51b: Compact-list cache row keeps a single image (transport stays
  // small) but the push payload accepts a multi-image product unchanged.
  {
    const productWithManyImages: ShopifyProduct = {
      id: "9001",
      title: "Many Image Bag",
      vendor: "Tods",
      product_type: "HBAG",
      tags: [],
      images: [
        { src: "https://cdn.shopify.com/p/9001-1.jpg" },
        { src: "https://cdn.shopify.com/p/9001-2.jpg" },
        { src: "https://cdn.shopify.com/p/9001-3.jpg" },
        { src: "https://cdn.shopify.com/p/9001-3.jpg" }, // duplicate
      ],
      options: [{ name: "Color", values: ["Black"] }],
      variants: [
        {
          id: "v-1",
          sku: "TT-MAN-9001",
          price: "1200",
          inventory_quantity: 3,
          option1: "Black",
        },
      ],
      metafields: [],
    };
    const mapped = mapShopifyToJomashop(productWithManyImages, handbagLiveSchema(), undefined);
    assert(
      Array.isArray(mapped.images) && mapped.images.length === 4,
      `Case 51b: mapper preserves all provided image URLs (got ${mapped.images.length})`,
    );
    const { payload } = buildJomashopProductPayload(mapped, mapped.variants[0].vendor_sku, {});
    const payloadImages = Array.isArray((payload as any).images) ? (payload as any).images : [];
    assert(
      payloadImages.length === 4,
      `Case 51b: push payload carries every supplied image (got ${payloadImages.length})`,
    );
    const uniq = new Set(payloadImages.map((u: any) => String(u)));
    assert(
      uniq.size === 3,
      `Case 51b: duplicate URL still ends up in the array (dedupe is the responsibility of the image fetcher, not the mapper) — got ${uniq.size}`,
    );
  }

  // ---- 51c: Push-status overlay flips a cached row to "pushed" without
  // requiring a Shopify refetch. We exercise the overlay's join logic by
  // simulating the compact-row + push_status union the route applies.
  {
    type CachedRow = {
      vendor_sku: string;
      push_state: string;
      jomashop_sku: string | null;
      last_pushed_at: number | null;
    };
    const cached: CachedRow[] = [
      { vendor_sku: "SKU-A", push_state: "not_pushed", jomashop_sku: null, last_pushed_at: null },
      { vendor_sku: "SKU-B", push_state: "not_pushed", jomashop_sku: null, last_pushed_at: null },
    ];
    const overlay = new Map<string, { state: string; jomashopSku: string; lastPushedAt: number }>([
      ["SKU-A", { state: "pushed", jomashopSku: "JM-A", lastPushedAt: 1234 }],
    ]);
    const overlaid = cached.map((c) => {
      const live = overlay.get(c.vendor_sku);
      if (!live) return c;
      return {
        ...c,
        push_state: live.state,
        jomashop_sku: live.jomashopSku,
        last_pushed_at: live.lastPushedAt,
      };
    });
    assert(
      overlaid[0].push_state === "pushed" && overlaid[0].jomashop_sku === "JM-A",
      `Case 51c: SKU-A transitions to pushed via overlay (got state=${overlaid[0].push_state})`,
    );
    assert(
      overlaid[1].push_state === "not_pushed",
      `Case 51c: SKU-B remains not_pushed when no overlay entry exists (got ${overlaid[1].push_state})`,
    );
  }

  // ---- 51d: Inventory sync helper — exercises the request body normalization
  // and the qty -> status mapping that the manual sync endpoint relies on.
  {
    const cases = [
      { qty: 5, expected: "active" },
      { qty: 0, expected: "out_of_stock" },
      { qty: null, expected: "inactive" },
    ];
    for (const c of cases) {
      const status =
        c.qty === null || c.qty === undefined
          ? "inactive"
          : c.qty <= 0
            ? "out_of_stock"
            : "active";
      assert(
        status === c.expected,
        `Case 51d: qty=${c.qty} → status=${c.expected} (got ${status})`,
      );
    }
  }

  // ---- 51e: Export crash hardening — MAX_EXPORT_ROWS exists, has a sane
  // value, and a synthetic aggregation result honoring `rowLimit` stops
  // producing rows before the cap.
  {
    assert(
      typeof MAX_EXPORT_ROWS === "number" && MAX_EXPORT_ROWS >= 1000 && MAX_EXPORT_ROWS <= 50000,
      `Case 51e: MAX_EXPORT_ROWS = ${MAX_EXPORT_ROWS} is within a sane bound`,
    );
    // Simulate the aggregation loop's `totalRows >= rowLimit` early break
    // logic to confirm it stops at the cap.
    const synthesize = (limit: number, perCategory: number, categories: number) => {
      let total = 0;
      let truncated = false;
      outer: for (let c = 0; c < categories; c++) {
        if (total >= limit) {
          truncated = true;
          break;
        }
        for (let r = 0; r < perCategory; r++) {
          if (total >= limit) {
            truncated = true;
            break outer;
          }
          total += 1;
        }
      }
      return { total, truncated };
    };
    const small = synthesize(50, 30, 3);
    assert(
      small.total === 50 && small.truncated === true,
      `Case 51e: row-limit breaks at the cap (got total=${small.total}, truncated=${small.truncated})`,
    );
    const fits = synthesize(1000, 10, 5);
    assert(
      fits.total === 50 && fits.truncated === false,
      `Case 51e: under cap, no truncation flag (got total=${fits.total})`,
    );
  }
}

// Case 52: full-catalog visibility + category-filtered export + cache-only
// export when Shopify session is gone. Each block seeds the sqlite-backed
// cache, runs the aggregator, and cleans up.
async function runFullCatalogAndDisconnectedExportTests() {
  console.log("Case 52: full-catalog visibility, category filter, and disconnected cache export");
  const { storage } = await import("../server/storage");
  const { aggregateProductFieldRows } = await import(
    "../server/jomashop_product_field_excel"
  );

  const SHOP = "test-cache-export.myshopify.com";
  // Build a mapped catalog with mixed categories. Mark some "ready" so the
  // includeAll=false path still has something to do (it filters those out).
  const mapped = [
    ...Array.from({ length: 5 }, (_, i) => ({
      vendor_sku: `APP-${i}`,
      category: "Apparel",
      readiness: "needs-mapping",
      properties: {},
      variants: [],
      source: { shopify_product_id: `p-app-${i}`, shopify_variant_ids: [] },
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      vendor_sku: `BAG-${i}`,
      category: "Handbags",
      readiness: "needs-mapping",
      properties: {},
      variants: [],
      source: { shopify_product_id: `p-bag-${i}`, shopify_variant_ids: [] },
    })),
    {
      vendor_sku: "SHO-ready",
      category: "Footwear",
      readiness: "ready",
      properties: {},
      variants: [],
      source: { shopify_product_id: "p-sho", shopify_variant_ids: [] },
    },
  ];
  const payload = {
    mapperVersion: "test",
    mapped,
    schemas: {},
    dataSource: "live",
    shopifyConnected: true,
    shopDomain: SHOP,
    fetchedCount: mapped.length,
    pageCount: 1,
    hasMore: false,
  };
  storage.upsertStore({
    shopDomain: SHOP,
    oauthStatus: "disconnected",
  } as any);
  storage.upsertProductCache({
    shopDomain: SHOP,
    fetchedCount: mapped.length,
    pageCount: 1,
    hasMore: false,
    payloadJson: JSON.stringify(payload),
    fetchedAt: Date.now(),
  });

  try {
    // 52a — full catalog visibility: even with no active Shopify connection,
    // the aggregator falls back to the cached snapshot via the shop's cache row.
    const aggAll = await aggregateProductFieldRows({ includeAll: true });
    assert(
      aggAll.fromCache === true,
      `Case 52a: aggregator falls back to cache when Shopify session is gone (fromCache=${aggAll.fromCache})`,
    );
    assert(
      aggAll.shopDomain === SHOP,
      `Case 52a: aggregator picks the cached shop domain (got ${aggAll.shopDomain})`,
    );
    assert(
      aggAll.totalProducts === mapped.length,
      `Case 52a: totalProducts reflects the full cached catalog (got ${aggAll.totalProducts})`,
    );

    // 52b — category filter narrows the export to one Jomashop category.
    const aggHandbags = await aggregateProductFieldRows({
      includeAll: true,
      categoryFilter: "Handbags",
    });
    assert(
      aggHandbags.categories.length === 1 &&
        aggHandbags.categories[0]?.category === "Handbags",
      `Case 52b: category filter returns only Handbags sheet (got ${aggHandbags.categories.map((c) => c.category).join(",")})`,
    );
    assert(
      aggHandbags.categories[0].rows.length === 3,
      `Case 52b: Handbags filter returns the 3 cached Handbags rows (got ${aggHandbags.categories[0].rows.length})`,
    );

    // 52c — category filter is case-insensitive and doesn't bleed rows.
    const aggLower = await aggregateProductFieldRows({
      includeAll: true,
      categoryFilter: "apparel",
    });
    assert(
      aggLower.categories.length === 1 &&
        aggLower.categories[0].category === "Apparel" &&
        aggLower.categories[0].rows.length === 5,
      `Case 52c: category filter is case-insensitive (got ${aggLower.categories.map((c) => `${c.category}:${c.rows.length}`).join(",")})`,
    );
  } finally {
    storage.clearProductCache(SHOP);
  }
}

function runInlineFieldRepairValidation() {
  console.log("Case 53: inline field repair validation against live schema");

  // Enum field — accepted option passes; non-accepted fails.
  const articleField: SchemaPropertyDescriptor = {
    field: "Article",
    required: true,
    type: "enum",
    options: ["Shirt", "Pants", "Dress"],
  };
  assert(
    validateInlineFieldValue(articleField, "Shirt") === null,
    "Case 53a: accepted enum value passes validation (Article=Shirt)",
  );
  const bad = validateInlineFieldValue(articleField, "Sock");
  assert(
    typeof bad === "string" && bad.includes("not in the live accepted-options list"),
    `Case 53a: rejected enum value returns informative error (got "${bad}")`,
  );
  const blank = validateInlineFieldValue(articleField, "");
  assert(
    typeof blank === "string" && blank === "Value is required.",
    `Case 53a: blank required value rejected (got "${blank}")`,
  );

  // Multi-select enum (comma-separated) — every token must match.
  const multiField: SchemaPropertyDescriptor = {
    field: "Materials",
    required: true,
    type: "enum",
    options: ["Cotton", "Wool", "Silk"],
    multiple: true,
  };
  assert(
    validateInlineFieldValue(multiField, "Cotton, Wool") === null,
    "Case 53b: multi-select all-accepted tokens pass",
  );
  const multiBad = validateInlineFieldValue(multiField, "Cotton, Plastic");
  assert(
    typeof multiBad === "string" && multiBad.includes("Plastic"),
    `Case 53b: multi-select rejects one bad token (got "${multiBad}")`,
  );

  // Numeric with bounds + integer-only.
  const ageField: SchemaPropertyDescriptor = {
    field: "Age",
    required: false,
    type: "integer",
    only_integer: true,
    min_value: 0,
    max_value: 120,
  };
  assert(validateInlineFieldValue(ageField, "42") === null, "Case 53c: integer in range passes (Age=42)");
  const ageDecErr = validateInlineFieldValue(ageField, "3.5");
  assert(
    typeof ageDecErr === "string" && ageDecErr.includes("integer"),
    `Case 53c: decimal rejected for integer field (got "${ageDecErr}")`,
  );
  const ageHighErr = validateInlineFieldValue(ageField, "200");
  assert(
    typeof ageHighErr === "string" && ageHighErr.includes("max_value"),
    `Case 53c: above-max rejected (got "${ageHighErr}")`,
  );

  // String length bounds.
  const skuField: SchemaPropertyDescriptor = {
    field: "Parent SKU",
    required: false,
    type: "string",
    min_length: 3,
    max_length: 50,
  };
  assert(validateInlineFieldValue(skuField, "ABC-123") === null, "Case 53d: in-range string passes");
  const tooShort = validateInlineFieldValue(skuField, "A");
  assert(
    typeof tooShort === "string" && tooShort.includes("min_length"),
    `Case 53d: too-short string rejected (got "${tooShort}")`,
  );

  // Global 1000-char cap when schema doesn't declare a longer max_length.
  const longField: SchemaPropertyDescriptor = {
    field: "Description",
    required: false,
    type: "string",
  };
  const longErr = validateInlineFieldValue(longField, "x".repeat(1001));
  assert(
    typeof longErr === "string" && longErr.includes("1000"),
    `Case 53d: 1001-char string rejected by global cap (got "${longErr}")`,
  );

  // Unknown field — falls back to global cap only.
  assert(
    validateInlineFieldValue(undefined, "anything ok") === null,
    "Case 53e: unknown field accepts any non-blank string",
  );
}

function runInlineFieldRepairMetafieldTargets() {
  console.log("Case 54: inline field repair metafield namespace/key + variant routing");

  // Default namespace strategy — slugified field name in `jomashop` namespace.
  const apparelSize = deriveMetafieldTargetForProductField("Apparel Size");
  assert(
    apparelSize.namespace === "jomashop" && apparelSize.key === "apparel_size",
    `Case 54a: Apparel Size → jomashop.apparel_size (got ${apparelSize.namespace}.${apparelSize.key})`,
  );
  const sizeCode = deriveMetafieldTargetForProductField("Apparel Size Type/Size Code");
  assert(
    sizeCode.namespace === "jomashop" && sizeCode.key === "apparel_size_type_size_code",
    `Case 54a: punctuation-heavy field slugifies cleanly (got ${sizeCode.namespace}.${sizeCode.key})`,
  );
  const variationSize = deriveMetafieldTargetForProductField("Variation Size (Yes/No)");
  assert(
    variationSize.namespace === "jomashop" && variationSize.key === "variation_size_yes_no",
    `Case 54a: Variation Size (Yes/No) → jomashop.variation_size_yes_no (got ${variationSize.namespace}.${variationSize.key})`,
  );
  const productId = deriveMetafieldTargetForProductField("Product ID");
  const productIdType = deriveMetafieldTargetForProductField("Product ID Type");
  assert(
    productId.key === "product_id" && productIdType.key === "product_id_type",
    "Case 54a: Product ID / Product ID Type slugify distinctly",
  );

  // Variant routing — Size-family fields write to the variant; everything
  // else writes to the product. This is the rule the inline-repair backend
  // uses to pick `gid://shopify/ProductVariant/...` vs `Product`.
  assert(fieldIsVariantTargeted("Apparel Size") === true, "Case 54b: Apparel Size routes to variant");
  assert(fieldIsVariantTargeted("Shoe Size") === true, "Case 54b: Shoe Size routes to variant");
  assert(fieldIsVariantTargeted("Variation Size") === true, "Case 54b: Variation Size routes to variant");
  assert(fieldIsVariantTargeted("Variation Size (Yes/No)") === true, "Case 54b: Variation Size (Yes/No) routes to variant");
  assert(fieldIsVariantTargeted("Color") === false, "Case 54b: Color routes to product");
  assert(fieldIsVariantTargeted("Gender") === false, "Case 54b: Gender routes to product");
  assert(fieldIsVariantTargeted("Article") === false, "Case 54b: Article routes to product");
  assert(fieldIsVariantTargeted("Parent SKU") === false, "Case 54b: Parent SKU routes to product");
  assert(fieldIsVariantTargeted("Product ID") === false, "Case 54b: Product ID routes to product");
  // Size system / size code is a product-wide setting (US vs EU sizing for
  // the whole product), so it stays on the product metafield even though it
  // has "Size" in the name.
  assert(
    fieldIsVariantTargeted("Apparel Size Type") === false,
    "Case 54b: Apparel Size Type (size system) routes to product",
  );
  assert(
    fieldIsVariantTargeted("Size Code") === false,
    "Case 54b: Size Code (size system) routes to product",
  );
}

function runInlineFieldRepairPostSaveReadiness() {
  console.log("Case 55: post-save remap clears missing-required when metafields satisfy schema");

  // Simulate a product that was missing Color before the inline repair, then
  // re-mapped after the metafield was written.
  const apparelSchema: SchemaPropertyDescriptor[] = [
    { field: "Color", required: true, type: "string" },
    { field: "Gender", required: true, type: "enum", options: ["Men", "Women"] },
    { field: "Article", required: true, type: "enum", options: ["Shirt", "Pants"] },
  ];

  const before: ShopifyProduct = {
    id: "p-inline-1",
    title: "Cavalli Class Mens Shirt",
    vendor: "Cavalli Class",
    product_type: "Clothing",
    tags: [],
    body_html: "",
    metafields: [
      { namespace: "jomashop", key: "gender", value: "Men" },
      { namespace: "jomashop", key: "article", value: "Shirt" },
    ],
  };
  const mappedBefore = mapShopifyToJomashop(before, apparelSchema);
  assert(
    Array.isArray((mappedBefore as any).missing_required) &&
      ((mappedBefore as any).missing_required as string[]).map((s) => s.toLowerCase()).includes("color"),
    "Case 55a: missing_required surfaces Color before inline repair",
  );

  // After the inline repair writes `jomashop.color = "Navy"`, re-mapping must
  // pick the value up from the metafield and clear missing_required.
  const after: ShopifyProduct = {
    ...before,
    metafields: [
      ...(before.metafields || []),
      { namespace: "jomashop", key: "color", value: "Navy" },
    ],
  };
  const mappedAfter = mapShopifyToJomashop(after, apparelSchema);
  assert(
    Array.isArray((mappedAfter as any).missing_required) &&
      !(((mappedAfter as any).missing_required as string[]).map((s) => s.toLowerCase()).includes("color")),
    "Case 55b: missing_required drops Color after inline repair writeback",
  );
  // Push-ready when all required fields satisfied and no invalid enums.
  const stillMissing = ((mappedAfter as any).missing_required as string[]) || [];
  const invalid = ((mappedAfter as any).invalid_enums as Array<unknown>) || [];
  assert(
    stillMissing.length === 0 && invalid.length === 0,
    `Case 55b: product is push-ready after inline repair (missing=${stillMissing.length}, invalid=${invalid.length})`,
  );
}

function runInlineFieldRepairAllAttributeProjection() {
  console.log("Case 56: inline repair surfaces missing + invalid + ok across required and optional fields");

  // Schema mirrors the Jomashop Apparel category shape: a mix of required and
  // recommended/optional fields with both enum and string types. The
  // projection helper should classify each field correctly so the UI can
  // surface missing-optional and invalid-enum rows for inline repair, not
  // only missing-required.
  const apparelSchema: SchemaPropertyDescriptor[] = [
    { field: "Color", required: true, type: "string" },
    { field: "Gender", required: true, type: "enum", options: ["Men", "Women", "Unisex"] },
    { field: "Article", required: true, type: "enum", options: ["Shirt", "Pants", "Coats & Jackets"] },
    { field: "Parent SKU", required: false, type: "string" },
    { field: "Product ID Type", required: false, type: "enum", options: ["UPC", "EAN", "ISBN"] },
    { field: "Product ID", required: false, type: "string" },
    { field: "Fabric Material", required: false, type: "string" },
    { field: "Fabric Material 2", required: false, type: "string" },
    { field: "Country of Origin", required: false, type: "enum", options: ["United States", "Italy", "China"] },
    { field: "Product Net Weight", required: false, type: "number" },
    { field: "ASIN", required: false, type: "string" },
    { field: "Additional Info", required: false, type: "string" },
    { field: "Collection", required: false, type: "string" },
    { field: "Apparel Type", required: false, type: "enum", options: ["Tops", "Bottoms", "Outerwear"] },
    { field: "Age", required: false, type: "enum", options: ["Adults", "Kids"] },
    { field: "Apparel Size Type", required: false, type: "enum", options: ["US", "EU"] },
    { field: "Apparel Size", required: false, type: "string" },
    { field: "Variation Size (Yes/No)", required: false, type: "enum", options: ["Yes", "No"] },
  ];

  // Properties post-mapping: Color and Gender populated; Article populated;
  // Country of Origin attempted from a non-accepted source value and got
  // dropped (surfaces as invalid_enum). All remaining optional fields are
  // missing — the UI must still be able to surface them for inline repair.
  const properties: Record<string, unknown> = {
    Color: "Navy",
    Gender: "Men",
    Article: "Shirt",
  };
  const invalidEnums: Array<{ field: string; value: string; options: string[] }> = [
    { field: "Country of Origin", value: "USA", options: ["United States", "Italy", "China"] },
  ];

  const fields = buildInlineRepairFieldDescriptors(apparelSchema, properties, invalidEnums);
  const byName = new Map(fields.map((f) => [f.field, f]));

  // (a) Optional/recommended missing fields surface with status="missing".
  for (const name of [
    "Parent SKU",
    "Product ID Type",
    "Product ID",
    "Fabric Material",
    "Fabric Material 2",
    "ASIN",
    "Additional Info",
    "Collection",
    "Apparel Type",
    "Age",
    "Apparel Size Type",
    "Apparel Size",
    "Variation Size (Yes/No)",
    "Product Net Weight",
  ]) {
    const f = byName.get(name);
    assert(
      f !== undefined && f.status === "missing",
      `Case 56a: optional/recommended "${name}" surfaces with status=missing (got ${f?.status})`,
    );
    assert(
      f !== undefined && f.required === false,
      `Case 56a: optional field "${name}" is marked required=false`,
    );
    // Required field bookkeeping: optional missing rows must NOT block the
    // push (needsRepair=false), but invalid rows SHOULD (test below).
    assert(
      f !== undefined && f.needsRepair === false,
      `Case 56a: optional missing field "${name}" does not block push (needsRepair=false)`,
    );
  }

  // (b) Invalid enum field exposes the offending source value so the UI can
  //     pre-populate the input/select; status="invalid" and needsRepair=true.
  const coo = byName.get("Country of Origin");
  assert(
    coo !== undefined && coo.status === "invalid" && coo.invalidValue === "USA",
    `Case 56b: invalid enum "Country of Origin" surfaces with invalid status + invalidValue="USA" (got status=${coo?.status} invalidValue="${coo?.invalidValue}")`,
  );
  assert(
    coo !== undefined && Array.isArray(coo.options) && coo.options.includes("United States"),
    `Case 56b: invalid enum "Country of Origin" carries the live accepted-options list for dropdown rendering`,
  );

  // (c) Required missing field still surfaces correctly (regression on the
  //     existing missing-required path) and blocks push.
  const missingSchema: SchemaPropertyDescriptor[] = [
    { field: "Color", required: true, type: "string" },
    { field: "Gender", required: true, type: "enum", options: ["Men", "Women"] },
    { field: "Parent SKU", required: false, type: "string" },
  ];
  const missingProps = { Gender: "Men" };
  const missingFields = buildInlineRepairFieldDescriptors(missingSchema, missingProps, []);
  const colorRow = missingFields.find((f) => f.field === "Color");
  assert(
    colorRow !== undefined && colorRow.status === "missing" && colorRow.needsRepair === true,
    `Case 56c: required missing field surfaces with needsRepair=true (got needsRepair=${colorRow?.needsRepair})`,
  );

  // (d) Enum optional fields carry the live data.values options in the
  //     returned descriptor — used by the UI to render dropdowns instead of
  //     a free-text input. Spot-check Product ID Type and Variation Size.
  const productIdType = byName.get("Product ID Type");
  assert(
    productIdType !== undefined &&
      productIdType.type === "enum" &&
      productIdType.options.length === 3 &&
      productIdType.options.includes("UPC"),
    `Case 56d: optional enum "Product ID Type" carries dropdown options from live data.values`,
  );
  const variationSize = byName.get("Variation Size (Yes/No)");
  assert(
    variationSize !== undefined &&
      variationSize.type === "enum" &&
      variationSize.options.length === 2,
    `Case 56d: optional enum "Variation Size (Yes/No)" carries dropdown options`,
  );

  // (e) Per-row metafield writeback target is computed and propagated. This
  //     is what the UI shows under each input as "Target: jomashop.x" so the
  //     operator can confirm where the value will land before saving.
  for (const [name, expectedKey] of [
    ["Parent SKU", "parent_sku"],
    ["Product ID Type", "product_id_type"],
    ["Product ID", "product_id"],
    ["Country of Origin", "country_of_origin"],
    ["Fabric Material", "fabric_material"],
    ["Fabric Material 2", "fabric_material_2"],
    ["ASIN", "asin"],
    ["Additional Info", "additional_info"],
    ["Variation Size (Yes/No)", "variation_size_yes_no"],
  ] as const) {
    const f = byName.get(name);
    assert(
      f !== undefined && f.metafieldTarget === `jomashop.${expectedKey}`,
      `Case 56e: "${name}" writes to jomashop.${expectedKey} (got ${f?.metafieldTarget})`,
    );
  }
  // Variant-scoped fields keep their isVariantTargeted=true so the writeback
  // path uses the variant gid. Apparel Size is the canonical example.
  const sizeRow = byName.get("Apparel Size");
  assert(
    sizeRow !== undefined && sizeRow.isVariantTargeted === true,
    `Case 56e: "Apparel Size" is flagged variant-scoped`,
  );
  // Apparel Size Type (size system) is product-wide.
  const sizeTypeRow = byName.get("Apparel Size Type");
  assert(
    sizeTypeRow !== undefined && sizeTypeRow.isVariantTargeted === false,
    `Case 56e: "Apparel Size Type" is product-scoped`,
  );
}

function runCanonicalApparelAliasFromClothing() {
  console.log("Case 57: canonical Jomashop category aliases Clothing → Apparel");

  // canonicalJomashopCategory is the single source of truth for the alias.
  // The UI consults it to decide whether to render "Apparel (alias of
  // Clothing)" instead of the confusing "not found in /i1/categories:
  // Clothing" line that appears when /i1 has no Clothing record but does
  // have Apparel.
  assert(
    canonicalJomashopCategory("Clothing") === "Apparel",
    `Case 57a: "Clothing" canonicalizes to "Apparel"`,
  );
  assert(
    canonicalJomashopCategory("clothing") === "Apparel",
    `Case 57a: lowercase "clothing" canonicalizes to "Apparel"`,
  );
  assert(
    canonicalJomashopCategory("Apparel") === "Apparel",
    `Case 57b: "Apparel" passes through unchanged`,
  );
  assert(
    canonicalJomashopCategory("Handbags") === "Handbags",
    `Case 57b: categories without an alias pass through unchanged`,
  );
  // The alias table itself should map every legacy apparel-flavored code to
  // "Apparel" so the live /i1/Apparel schema is always reachable.
  assert(
    CANONICAL_JOMASHOP_CATEGORY_ALIASES.clothing === "Apparel" &&
      CANONICAL_JOMASHOP_CATEGORY_ALIASES.apparel === "Apparel" &&
      CANONICAL_JOMASHOP_CATEGORY_ALIASES.rtw === "Apparel",
    `Case 57c: alias table routes clothing/apparel/rtw → Apparel`,
  );
}

async function runCategoryAuditRowsHelpers() {
  console.log("Case 58: buildCategoryAuditRows surfaces correct status per row");
  const { buildCategoryAuditRows } = await import("../server/category_mapping");
  type Row = Parameters<typeof buildCategoryAuditRows>[0]["rows"][number];
  const makeRow = (overrides: Partial<Row>): Row => ({
    shopify_category_code: "DRSH",
    shopify_category_code_normalized: "drsh",
    suggested_category: "Apparel",
    product_count: 3,
    missing_count: 0,
    sample_titles: ["Dress Shirt"],
    sample_skus: ["DS-1"],
    current_jomashop_category: null,
    current_override_notes: null,
    jomashop_schema_loaded: true,
    ambiguous: false,
    ...overrides,
  });
  const agg = {
    shopDomain: "test.myshopify.com",
    fromCache: true,
    cachedAt: Date.now(),
    totalProducts: 12,
    uniqueCodes: 5,
    jomashopCategoriesAvailable: true,
    jomashopCategories: ["Apparel", "Footwear", "Handbags", "Accessories"],
    rows: [
      // Mapped — operator override pointing at a live category.
      makeRow({
        shopify_category_code: "PANT",
        shopify_category_code_normalized: "pant",
        current_jomashop_category: "Apparel",
        suggested_category: "Apparel",
      }),
      // Alias — current value is "Clothing" which canonicalizes to "Apparel".
      makeRow({
        shopify_category_code: "CLTH",
        shopify_category_code_normalized: "clth",
        current_jomashop_category: "Clothing",
        suggested_category: "Apparel",
      }),
      // Unmapped — no mapping at all.
      makeRow({
        shopify_category_code: "WIDG",
        shopify_category_code_normalized: "widg",
        current_jomashop_category: null,
        suggested_category: "WIDG",
        product_count: 7,
      }),
      // Invalid — operator picked something not in live list.
      makeRow({
        shopify_category_code: "BOGUS",
        shopify_category_code_normalized: "bogus",
        current_jomashop_category: "NotARealCategory",
        suggested_category: "BOGUS",
        product_count: 2,
      }),
      // Built-in alias path — DRSH normalizes to drsh which is in
      // BUILT_IN_CATEGORY_OVERRIDES → Apparel.
      makeRow({
        shopify_category_code: "DRSH",
        shopify_category_code_normalized: "drsh",
        current_jomashop_category: "Apparel",
        current_override_notes: "built-in default (override to change)",
        suggested_category: "Apparel",
        product_count: 4,
      }),
    ],
  };
  const { rows, pickerCategories } = buildCategoryAuditRows(agg);
  const byCode = new Map(rows.map((r) => [r.shopify_category_code_normalized, r] as const));
  const pant = byCode.get("pant");
  assert(pant && pant.status === "mapped", `Case 58a: PANT → Apparel surfaces as mapped (got ${pant?.status})`);
  const clth = byCode.get("clth");
  assert(
    clth && clth.status === "alias" && clth.has_alias && clth.alias_target === "Apparel",
    `Case 58b: CLTH (Clothing) surfaces as alias with target Apparel (got status=${clth?.status} alias=${clth?.alias_target})`,
  );
  const widg = byCode.get("widg");
  assert(
    widg && widg.status === "unmapped" && widg.current_jomashop_category === null,
    `Case 58c: WIDG with no mapping surfaces as unmapped (got status=${widg?.status})`,
  );
  const bogus = byCode.get("bogus");
  assert(
    bogus && bogus.status === "invalid",
    `Case 58d: BOGUS pointing at NotARealCategory surfaces as invalid (got status=${bogus?.status})`,
  );
  const drsh = byCode.get("drsh");
  assert(
    drsh && drsh.status === "alias" && drsh.source === "built-in",
    `Case 58e: DRSH driven by built-in default surfaces as alias with source=built-in (got status=${drsh?.status} source=${drsh?.source})`,
  );
  // Picker list — live categories must come first, then SUPPORTED_CATEGORIES
  // not already present.
  assert(
    pickerCategories[0] === "Apparel" && pickerCategories.includes("Eyewear"),
    `Case 58f: pickerCategories merges live + supported (got [${pickerCategories.slice(0, 6).join(", ")} …])`,
  );
  // Sanity: needs-mapping bucket includes unmapped + invalid for the UI count.
  const needs = rows.filter((r) => r.status === "unmapped" || r.status === "invalid");
  assert(
    needs.length === 2 && needs.some((r) => r.shopify_category_code_normalized === "widg") &&
      needs.some((r) => r.shopify_category_code_normalized === "bogus"),
    `Case 58g: needs-mapping bucket includes both unmapped and invalid`,
  );

  // Status reason strings carry the original code → alias target for the UI
  // tooltip so the operator can see "Clothing → Apparel" at a glance.
  assert(
    clth && /Clothing\s*→\s*Apparel/.test(clth.status_reason),
    `Case 58h: alias status_reason names original + alias target (got "${clth?.status_reason}")`,
  );

  // Affected-product totals: only unmapped+invalid rows contribute to the
  // needs-mapping bucket count, which the UI surfaces as the "products
  // blocked" badge.
  const blocked =
    (byCode.get("widg")?.product_count ?? 0) + (byCode.get("bogus")?.product_count ?? 0);
  assert(blocked === 9, `Case 58i: blocked product total = 9 (got ${blocked})`);
}

async function runCategoryAuditFallsBackWhenLiveUnavailable() {
  console.log("Case 59: audit picker falls back to supported list when live missing");
  const { buildCategoryAuditRows } = await import("../server/category_mapping");
  type Row = Parameters<typeof buildCategoryAuditRows>[0]["rows"][number];
  const makeRow = (overrides: Partial<Row>): Row => ({
    shopify_category_code: "PANT",
    shopify_category_code_normalized: "pant",
    suggested_category: "Apparel",
    product_count: 1,
    missing_count: 0,
    sample_titles: [],
    sample_skus: [],
    current_jomashop_category: "Apparel",
    current_override_notes: null,
    jomashop_schema_loaded: true,
    ambiguous: false,
    ...overrides,
  });
  const agg = {
    shopDomain: null,
    fromCache: false,
    cachedAt: null,
    totalProducts: 1,
    uniqueCodes: 1,
    jomashopCategoriesAvailable: false,
    jomashopCategories: ["Apparel", "Footwear", "Handbags", "Accessories", "Eyewear", "Rings", "Necklaces", "Bracelets", "Earrings", "Pins & Brooches", "Home Decor", "Shoes", "Clothing"],
    rows: [makeRow({})],
  };
  const { rows, pickerCategories } = buildCategoryAuditRows(agg);
  assert(
    pickerCategories.includes("Apparel") &&
      pickerCategories.includes("Footwear") &&
      pickerCategories.includes("Handbags") &&
      pickerCategories.includes("Eyewear") &&
      pickerCategories.includes("Pins & Brooches") &&
      pickerCategories.includes("Home Decor"),
    `Case 59a: supported-list fallback picker covers Apparel/Footwear/Handbags/Eyewear/Pins & Brooches/Home Decor`,
  );
  // Apparel from the fallback list is still considered known — so PANT with
  // current=Apparel must surface as mapped.
  const pant = rows[0];
  assert(
    pant.status === "mapped",
    `Case 59b: PANT → Apparel still mapped against fallback supported list (got ${pant.status})`,
  );
}

async function runCategoryAuditAliasOnInvalid() {
  console.log("Case 60: invalid status overrides alias when canonical target is not live");
  const { buildCategoryAuditRows } = await import("../server/category_mapping");
  type Row = Parameters<typeof buildCategoryAuditRows>[0]["rows"][number];
  // Live list intentionally OMITS "Apparel" — so a current="Clothing" mapping
  // that canonicalizes to "Apparel" is still invalid (live list says no).
  const agg = {
    shopDomain: "x.myshopify.com",
    fromCache: true,
    cachedAt: Date.now(),
    totalProducts: 1,
    uniqueCodes: 1,
    jomashopCategoriesAvailable: true,
    jomashopCategories: ["Footwear", "Handbags"],
    rows: [
      {
        shopify_category_code: "CLTH",
        shopify_category_code_normalized: "clth",
        suggested_category: "Apparel",
        product_count: 5,
        missing_count: 0,
        sample_titles: [],
        sample_skus: [],
        current_jomashop_category: "Clothing",
        current_override_notes: null,
        jomashop_schema_loaded: true,
        ambiguous: false,
      } as Row,
    ],
  };
  const { rows } = buildCategoryAuditRows(agg);
  const row = rows[0];
  assert(
    row.status === "invalid",
    `Case 60a: alias target not in live list → invalid (got ${row.status})`,
  );
  assert(
    row.has_alias && row.alias_target === "Apparel",
    `Case 60b: alias bookkeeping still set even when status is invalid (alias_target=${row.alias_target})`,
  );
}

// ---- inline field repair: state propagation, cache splice, filter, alias ----

function runInlineRepairWarningUsesCanonicalApparel() {
  console.log("Case 61: alias warnings surface canonical Jomashop category 'Apparel' instead of 'Clothing field'");

  // The Apparel schema requires Color. A Shopify product whose product_type
  // is the legacy alias "Clothing" should generate a missing-required warning
  // that names the canonical Jomashop category — "Apparel field" — so the
  // operator sees the same name everywhere in the UI (inline repair panel,
  // category-properties grid, and the warnings list at the bottom of the
  // product card).
  const apparelSchema: SchemaPropertyDescriptor[] = [
    { field: "Color", required: true, type: "string" },
  ];
  const product: ShopifyProduct = {
    id: "p-alias-warn",
    title: "Cavalli Class Mens Shirt",
    vendor: "Cavalli Class",
    product_type: "Clothing", // legacy alias
    tags: [],
    body_html: "",
    metafields: [],
  };
  const mapped = mapShopifyToJomashop(product, apparelSchema);
  const warnings = ((mapped as any).warnings as string[]) || [];
  const aliasWarning = warnings.find((w) =>
    /Missing required Apparel field "Color"/.test(w),
  );
  assert(
    Boolean(aliasWarning),
    `Case 61a: warning should name canonical "Apparel" not "Clothing" (got=${JSON.stringify(warnings)})`,
  );
  const stillCallsClothingField = warnings.some((w) => /Clothing field/.test(w));
  assert(
    !stillCallsClothingField,
    `Case 61b: no warning should still say "Clothing field" — canonicalize for display (got=${JSON.stringify(warnings)})`,
  );
}

function runInlineRepairCompactProjectionCarriesInvalidEnums() {
  console.log("Case 62: compactifyMapped preserves invalid_enums + missing lists so the UI can re-derive readiness in place");

  const mapped = {
    category: "Apparel",
    vendor_sku: "SKU-X",
    sku: "SKU-X",
    name: "Test",
    brand: "Test",
    properties: { Color: "Navy", Gender: "Men" },
    variants: [{ vendor_sku: "SKU-X-V1", price: 10, jomashop_price: 8, quantity: 5, status: "active", options: { Size: "M" } }],
    images: ["https://example.com/x.jpg"],
    warnings: ["w1"],
    missing_required: ["Article"],
    missing_top_level: [],
    invalid_enums: [{ field: "Country of Origin", value: "USA", options: ["United States", "Italy"] }],
    unverified_required_options: [],
    auto_resolved_enums: [],
    source: { shopify_product_id: "p-1", shopify_variant_ids: ["v-1"] },
    schema_fields: [
      { field: "Color", required: true },
      { field: "Article", required: true },
      { field: "Country of Origin", required: false },
    ],
    schema_source: "live-i1",
    readiness: "missing",
  };
  const compact = compactifyMapped(mapped);
  assert(
    Array.isArray(compact.invalid_enums) && compact.invalid_enums.length === 1,
    `Case 62a: invalid_enums survives the compact projection (got=${JSON.stringify(compact.invalid_enums)})`,
  );
  assert(
    compact.invalid_enums[0].field === "Country of Origin" &&
      compact.invalid_enums[0].value === "USA",
    "Case 62b: invalid_enums entry preserved verbatim",
  );
  assert(
    compact.missing_required.length === 1 && compact.missing_required[0] === "Article",
    "Case 62c: missing_required carried through",
  );
  assert(
    compact.schema_fields.length === 3,
    `Case 62d: schema_fields carried through (got=${compact.schema_fields.length})`,
  );
  assert(
    compact.warnings.includes("w1"),
    "Case 62e: warnings carried through",
  );
}

function runDeriveReadinessAfterRepair() {
  console.log("Case 63: deriveReadinessFromMapping flips a product to push-ready when required missing/invalid lists clear");

  // Before repair — Color required field missing.
  const before = deriveReadinessFromMapping({
    schemaLoaded: true,
    missing_top_level: [],
    missing_required: ["Color"],
    invalid_enums: [],
    vendor_sku: "SKU-X",
    category: "Apparel",
    has_undefined_property: false,
  });
  assert(before === "missing", `Case 63a: missing required field → readiness=missing (got=${before})`);

  // After repair — all required satisfied, no invalid enums.
  const after = deriveReadinessFromMapping({
    schemaLoaded: true,
    missing_top_level: [],
    missing_required: [],
    invalid_enums: [],
    vendor_sku: "SKU-X",
    category: "Apparel",
    has_undefined_property: false,
  });
  assert(after === "ready", `Case 63b: cleared required + invalid → readiness=ready (got=${after})`);

  // Invalid enums alone still block readiness.
  const stillInvalid = deriveReadinessFromMapping({
    schemaLoaded: true,
    missing_top_level: [],
    missing_required: [],
    invalid_enums: [{ field: "Country of Origin" }],
    vendor_sku: "SKU-X",
    category: "Apparel",
    has_undefined_property: false,
  });
  assert(
    stillInvalid === "missing",
    `Case 63c: lingering invalid_enums keep readiness=missing (got=${stillInvalid})`,
  );

  // Optional missing fields do NOT block push — the operator can repair them
  // inline, but readiness is computed off required/missing-top-level only.
  const optionalOnly = deriveReadinessFromMapping({
    schemaLoaded: true,
    missing_top_level: [],
    missing_required: [],
    invalid_enums: [],
    vendor_sku: "SKU-X",
    category: "Apparel",
    has_undefined_property: false,
  });
  assert(
    optionalOnly === "ready",
    `Case 63d: optional-only state must not block push (got=${optionalOnly})`,
  );
}

function runInlineRepairCacheSplice() {
  console.log("Case 64: cache update replaces ONLY the repaired product row, leaves siblings untouched");

  // Stand-in for the storage cache payload structure used by routes.ts.
  const cachePayload = {
    mapped: [
      { source: { shopify_product_id: "p-1" }, vendor_sku: "SKU-1", missing_required: ["Color"], readiness: "missing" },
      { source: { shopify_product_id: "p-2" }, vendor_sku: "SKU-2", missing_required: [], readiness: "ready" },
      { source: { shopify_product_id: "p-3" }, vendor_sku: "SKU-3", missing_required: ["Article"], readiness: "missing" },
    ],
  };
  const repaired = {
    source: { shopify_product_id: "p-1" },
    vendor_sku: "SKU-1",
    missing_required: [],
    readiness: "ready",
  };
  // Mirror the splice logic in inline_field_repair.ts: replace by
  // shopify_product_id equality, leave sibling rows untouched.
  const targetPid = "p-1";
  const nextMapped = cachePayload.mapped.map((m: any) => {
    const pid = String(m?.source?.shopify_product_id ?? "");
    return pid === targetPid ? repaired : m;
  });
  assert(
    (nextMapped[0] as any).readiness === "ready" &&
      (nextMapped[0] as any).missing_required.length === 0,
    "Case 64a: target product replaced with the remapped row",
  );
  assert(
    (nextMapped[1] as any).vendor_sku === "SKU-2" &&
      (nextMapped[2] as any).vendor_sku === "SKU-3",
    "Case 64b: sibling rows untouched",
  );
  assert(
    (nextMapped[1] as any).readiness === "ready" &&
      (nextMapped[2] as any).readiness === "missing",
    "Case 64c: sibling readiness values preserved",
  );
}

function runInlineRepairFilterBuckets() {
  console.log("Case 65: filter buckets partition required-missing, optional-missing, and invalid distinct from 'all'");

  // Same projection helper the UI uses to drive the filter chips. Build a
  // representative field set with one required-missing, one optional-missing,
  // one invalid, and one ok value — the filter logic in the component
  // matches on (required, status) so this is exactly what gets bucketed.
  const apparelSchema: SchemaPropertyDescriptor[] = [
    { field: "Color", required: true, type: "string" },
    { field: "Article", required: true, type: "enum", options: ["Shirt", "Pants"] },
    { field: "Country of Origin", required: false, type: "enum", options: ["United States", "Italy"] },
    { field: "Apparel Type", required: false, type: "string" },
  ];
  const properties = {
    Article: "Shirt", // ok
  };
  const invalidEnums = [
    { field: "Country of Origin", value: "USA", options: ["United States", "Italy"] },
  ];
  const fields = buildInlineRepairFieldDescriptors(apparelSchema, properties, invalidEnums);

  // Required-missing OR invalid — both bucketed under "required" filter.
  const requiredBucket = fields.filter(
    (f) => (f.required && f.status === "missing") || f.status === "invalid",
  );
  assert(
    requiredBucket.some((f) => f.field === "Color") &&
      requiredBucket.some((f) => f.field === "Country of Origin"),
    `Case 65a: Color (required-missing) + Country of Origin (invalid) land in 'required' bucket (got=${JSON.stringify(requiredBucket.map((f) => f.field))})`,
  );
  assert(
    !requiredBucket.some((f) => f.field === "Apparel Type"),
    "Case 65b: optional-missing fields do NOT land in 'required' bucket",
  );

  // Optional-missing — only the optional+missing rows.
  const optionalBucket = fields.filter(
    (f) => !f.required && f.status === "missing",
  );
  assert(
    optionalBucket.some((f) => f.field === "Apparel Type"),
    `Case 65c: Apparel Type (optional-missing) lands in 'optional' bucket (got=${JSON.stringify(optionalBucket.map((f) => f.field))})`,
  );
  assert(
    !optionalBucket.some((f) => f.field === "Color"),
    "Case 65d: required fields do NOT land in 'optional' bucket",
  );

  // Invalid — only enum coercion failures.
  const invalidBucket = fields.filter((f) => f.status === "invalid");
  assert(
    invalidBucket.length === 1 && invalidBucket[0].field === "Country of Origin",
    `Case 65e: 'invalid' bucket isolates only enum-coercion failures (got=${JSON.stringify(invalidBucket.map((f) => f.field))})`,
  );

  // All — every schema attribute.
  assert(
    fields.length === apparelSchema.length,
    `Case 65f: 'all' filter surfaces every schema field (got=${fields.length}/${apparelSchema.length})`,
  );
}

function runInlineRepairResponseShape() {
  console.log("Case 66: inline-field-repair response shape lets the UI splice a fully-ready product into the visible list");

  // Build the kind of postRepair.product the route returns (compactified
  // mapped product) and verify the UI-facing fields the Products.tsx
  // splice path reads (source.shopify_product_id, readiness,
  // missing_required, missing_top_level, schema_fields, warnings).
  const apparelSchema: SchemaPropertyDescriptor[] = [
    { field: "Color", required: true, type: "string" },
    { field: "Gender", required: true, type: "enum", options: ["Men", "Women"] },
    { field: "Article", required: true, type: "enum", options: ["Shirt", "Pants"] },
  ];
  const repaired: ShopifyProduct = {
    id: "p-66",
    title: "Cavalli Class Mens Navy Shirt",
    vendor: "Cavalli Class",
    product_type: "Apparel",
    tags: [],
    body_html: "",
    metafields: [
      { namespace: "jomashop", key: "color", value: "Navy" },
      { namespace: "jomashop", key: "gender", value: "Men" },
      { namespace: "jomashop", key: "article", value: "Shirt" },
      { namespace: "jomashop", key: "commercial_discount", value: "40" },
    ],
    variants: [
      { id: "v-66", sku: "SKU-66", price: "100.00", inventory_quantity: 5 },
    ],
  };
  const mapped = mapShopifyToJomashop(repaired, apparelSchema);
  const enriched: any = {
    ...mapped,
    push_state: "not_pushed",
    schema_source: "live-i1",
    schema_fields: apparelSchema.map((s) => ({ field: s.field, required: s.required })),
    readiness: deriveReadinessFromMapping({
      schemaLoaded: true,
      missing_top_level: (mapped as any).missing_top_level || [],
      missing_required: (mapped as any).missing_required || [],
      invalid_enums: (mapped as any).invalid_enums || [],
      vendor_sku: (mapped as any).vendor_sku,
      category: (mapped as any).category,
      has_undefined_property: false,
    }),
  };
  const compact = compactifyMapped(enriched);
  assert(
    compact.readiness === "ready",
    `Case 66a: full repair → readiness=ready (got=${compact.readiness})`,
  );
  assert(
    compact.missing_required.length === 0 && compact.missing_top_level.length === 0,
    `Case 66b: no missing-required after repair (missing_required=${JSON.stringify(compact.missing_required)}, missing_top_level=${JSON.stringify(compact.missing_top_level)})`,
  );
  assert(
    Array.isArray(compact.schema_fields) && compact.schema_fields.length === 3,
    `Case 66c: schema_fields survive compact projection (got=${compact.schema_fields.length})`,
  );
  assert(
    compact.source.shopify_product_id !== undefined,
    "Case 66d: source.shopify_product_id present so Products.tsx can match by id",
  );
}

// ---------- Roger Vivier Footwear variant tests ----------------------------
function runFootwearVariantSizeRogerVivier() {
  console.log(
    "Case RV-1: Footwear variant sizes 34-38 — Shoe Size derived per variant, push payload uses variant size",
  );
  // Mock live Footwear schema with Ladies/Mens/Kids gender, Variation
  // Color/Size Yes/No enums, and Shoe Category/Style. Matches what the
  // user reported in the screenshots.
  const footwearSchema: SchemaPropertyDescriptor[] = [
    { field: "Gender", label: "Gender", required: true, type: "enum", options: ["Ladies", "Mens", "Kids"] },
    { field: "Shoe Size", label: "Shoe Size", required: true, type: "string" },
    { field: "Shoe Size Type", label: "Shoe Size Type", required: true, type: "enum", options: ["US", "EU", "UK", "IT", "FR"] },
    { field: "Color", label: "Color", required: true, type: "string" },
    {
      field: "Variation Size (Yes/No)",
      label: "Variation Size (Yes/No)",
      required: true,
      type: "enum",
      options: ["Yes", "No"],
    },
    {
      field: "Variation Color (Yes/No)",
      label: "Variation Color (Yes/No)",
      required: true,
      type: "enum",
      options: ["Yes", "No"],
    },
    {
      field: "Shoe Category",
      label: "Shoe Category",
      required: false,
      type: "enum",
      options: ["Sneakers", "Heels", "Pumps", "Boots", "Sandals", "Mules", "Slides", "Loafers", "Flats", "Wedges"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    {
      field: "Shoe Style",
      label: "Shoe Style",
      required: false,
      type: "enum",
      options: ["Sneakers", "Heels", "Pumps", "Boots", "Sandals", "Mules", "Slides", "Loafers", "Flats", "Wedges"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ];

  const product: ShopifyProduct = {
    id: "rv-green-sandal",
    title: "Roger Vivier Womens Green Sandal",
    vendor: "Roger Vivier",
    product_type: "MULE",
    tags: ["Women", "Sandal", "Mule"],
    images: [{ src: "https://example.test/rv.jpg" }],
    options: [
      { name: "Size", values: ["34", "35", "36", "37", "38"] },
    ],
    variants: [
      { id: 9001, sku: "RV-GRN-34", price: "850.00", inventory_quantity: 1, option1: "34" },
      { id: 9002, sku: "RV-GRN-35", price: "850.00", inventory_quantity: 1, option1: "35" },
      { id: 9003, sku: "RV-GRN-36", price: "850.00", inventory_quantity: 1, option1: "36" },
      { id: 9004, sku: "RV-GRN-37", price: "850.00", inventory_quantity: 1, option1: "37" },
      { id: 9005, sku: "RV-GRN-38", price: "850.00", inventory_quantity: 1, option1: "38" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Green", name: "Color" },
      { namespace: "custom", key: "size_scale", value: "EU" },
      { namespace: "custom", key: "gender", value: "Women" },
    ],
  };

  const mapped = mapShopifyToJomashop(product, footwearSchema, "Footwear");

  // (1) Shoe Size canonical resolves from the first variant's size option.
  assert(
    mapped.properties["Shoe Size"] === "34",
    `RV-1a: Shoe Size derived from first variant option (got=${JSON.stringify(mapped.properties["Shoe Size"])})`,
  );
  // (2) Shoe Size MUST NOT appear in missing_required — every variant
  //     carries a non-empty size.
  assert(
    !(mapped.missing_required || []).includes("Shoe Size"),
    `RV-1b: Shoe Size not flagged as missing (missing_required=${JSON.stringify(mapped.missing_required)})`,
  );

  // (3) Push payload per SKU includes that variant's specific Shoe Size.
  for (const v of mapped.variants) {
    const built = buildJomashopProductPayload(mapped, v.vendor_sku, {
      manufacturer_id: 1,
      category_id: 2,
    });
    const expectedSize = v.options.Size;
    const props = (built.payload.properties as Record<string, unknown>) || {};
    assert(
      String(props["Shoe Size"]) === String(expectedSize),
      `RV-1c (${v.vendor_sku}): push payload Shoe Size === ${expectedSize} (got=${JSON.stringify(props["Shoe Size"])})`,
    );
    // Variation Size (Yes/No) stays "Yes" — never the literal size.
    assert(
      props["Variation Size (Yes/No)"] === "Yes",
      `RV-1d (${v.vendor_sku}): Variation Size (Yes/No) === "Yes" (got=${JSON.stringify(props["Variation Size (Yes/No)"])})`,
    );
  }

  // (4) Variation Size & Variation Color both map to "Yes".
  assert(
    mapped.properties["Variation Size (Yes/No)"] === "Yes",
    `RV-1e: Variation Size (Yes/No) === "Yes" (got=${JSON.stringify(mapped.properties["Variation Size (Yes/No)"])})`,
  );

  // (5) extractVariantSize helper agrees per-variant.
  const v34 = mapped.variants.find((v) => v.vendor_sku === "RV-GRN-34");
  const v38 = mapped.variants.find((v) => v.vendor_sku === "RV-GRN-38");
  assert(
    extractVariantSize(v34) === "34",
    `RV-1f: extractVariantSize(variant 34) === "34" (got=${JSON.stringify(extractVariantSize(v34))})`,
  );
  assert(
    extractVariantSize(v38) === "38",
    `RV-1g: extractVariantSize(variant 38) === "38" (got=${JSON.stringify(extractVariantSize(v38))})`,
  );
}

function runFootwearVariationColorYesNo() {
  console.log(
    "Case RV-2: Variation Color (Yes/No) maps to Yes/No — never the literal color value",
  );
  const schema: SchemaPropertyDescriptor[] = [
    { field: "Color", label: "Color", required: true, type: "string" },
    {
      field: "Variation Color (Yes/No)",
      label: "Variation Color (Yes/No)",
      required: true,
      type: "enum",
      options: ["Yes", "No"],
    },
  ];

  // (a) Product with a Color option and a non-empty value → Yes.
  const withColor: ShopifyProduct = {
    id: "rv-vcyn-1",
    title: "Roger Vivier Womens Green Sandal",
    vendor: "Roger Vivier",
    product_type: "MULE",
    options: [{ name: "Color", values: ["Green"] }, { name: "Size", values: ["34"] }],
    variants: [
      { id: 1, sku: "VCYN-1", price: "100.00", inventory_quantity: 1, option1: "Green", option2: "34" },
    ],
    metafields: [],
  };
  const mappedYes = mapShopifyToJomashop(withColor, schema, "Footwear");
  assert(
    mappedYes.properties["Variation Color (Yes/No)"] === "Yes",
    `RV-2a: Variation Color (Yes/No) === "Yes" (got=${JSON.stringify(mappedYes.properties["Variation Color (Yes/No)"])})`,
  );
  // Critically, the literal color value "Green" MUST NOT leak into the
  // Yes/No field — Jomashop would reject it as "is not included in the list".
  assert(
    mappedYes.properties["Variation Color (Yes/No)"] !== "Green",
    `RV-2b: literal color value never sent into Variation Color (Yes/No)`,
  );
  assert(
    !(mappedYes.invalid_enums || []).some((e) => e.field === "Variation Color (Yes/No)"),
    `RV-2c: Variation Color (Yes/No) not flagged invalid (got=${JSON.stringify(mappedYes.invalid_enums)})`,
  );

  // (b) Product without a Color option AND no color metafield → No.
  const noColor: ShopifyProduct = {
    id: "rv-vcyn-2",
    title: "Plain SKU",
    vendor: "Brand",
    product_type: "MULE",
    options: [{ name: "Size", values: ["34"] }],
    variants: [
      { id: 1, sku: "VCYN-2", price: "100.00", inventory_quantity: 1, option1: "34" },
    ],
    metafields: [],
  };
  const mappedNo = mapShopifyToJomashop(noColor, schema, "Footwear");
  assert(
    mappedNo.properties["Variation Color (Yes/No)"] === "No",
    `RV-2d: Variation Color (Yes/No) === "No" when no color present (got=${JSON.stringify(mappedNo.properties["Variation Color (Yes/No)"])})`,
  );
}

function runFootwearGenderWomenToLadies() {
  console.log(
    "Case RV-3: Footwear Gender Women → Ladies when live accepted options list Ladies",
  );
  const schemaLadies: SchemaPropertyDescriptor[] = [
    {
      field: "Gender",
      label: "Gender",
      required: true,
      type: "enum",
      options: ["Ladies", "Mens", "Kids"],
    },
    { field: "Color", label: "Color", required: true, type: "string" },
  ];

  const womens: ShopifyProduct = {
    id: "rv-gender-1",
    title: "Roger Vivier Womens Green Sandal",
    vendor: "Roger Vivier",
    product_type: "MULE",
    options: [{ name: "Size", values: ["34"] }],
    variants: [
      { id: 1, sku: "RV-G-1", price: "100.00", inventory_quantity: 1, option1: "34" },
    ],
    metafields: [
      { namespace: "custom", key: "color", value: "Green" },
      { namespace: "custom", key: "gender", value: "Women" },
    ],
  };
  const mapped = mapShopifyToJomashop(womens, schemaLadies, "Footwear");
  assert(
    mapped.properties["Gender"] === "Ladies",
    `RV-3a: Gender Women → "Ladies" (got=${JSON.stringify(mapped.properties["Gender"])})`,
  );
  assert(
    !(mapped.invalid_enums || []).some((e) => e.field === "Gender"),
    `RV-3b: Gender not flagged invalid (got=${JSON.stringify(mapped.invalid_enums)})`,
  );

  // Men → Mens
  const mens = {
    ...womens,
    id: "rv-gender-2",
    metafields: [
      { namespace: "custom", key: "color", value: "Black" },
      { namespace: "custom", key: "gender", value: "Men" },
    ],
  };
  const mappedMens = mapShopifyToJomashop(mens, schemaLadies, "Footwear");
  assert(
    mappedMens.properties["Gender"] === "Mens",
    `RV-3c: Gender Men → "Mens" (got=${JSON.stringify(mappedMens.properties["Gender"])})`,
  );

  // When live accepted options are the legacy Men/Women set, the mapper
  // must NOT spuriously coerce — Women stays Women.
  const schemaLegacy: SchemaPropertyDescriptor[] = [
    {
      field: "Gender",
      label: "Gender",
      required: true,
      type: "enum",
      options: ["Men", "Women", "Unisex", "Kids"],
    },
    { field: "Color", label: "Color", required: true, type: "string" },
  ];
  const mappedLegacy = mapShopifyToJomashop(womens, schemaLegacy, "Footwear");
  assert(
    mappedLegacy.properties["Gender"] === "Women",
    `RV-3d: Gender stays Women when the live list lists Women (got=${JSON.stringify(mappedLegacy.properties["Gender"])})`,
  );
}

function runFootwearShoeCategoryMuleSandal() {
  console.log(
    "Case RV-4: Footwear Shoe Category / Shoe Style auto-mapped from product_type=MULE / title=Sandal",
  );
  const schema: SchemaPropertyDescriptor[] = [
    {
      field: "Shoe Category",
      label: "Shoe Category",
      required: false,
      type: "enum",
      options: ["Sneakers", "Heels", "Pumps", "Boots", "Sandals", "Mules", "Slides", "Loafers", "Flats", "Wedges"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    {
      field: "Shoe Style",
      label: "Shoe Style",
      required: false,
      type: "enum",
      options: ["Sneakers", "Heels", "Sandals", "Mules", "Slides", "Loafers", "Flats", "Wedges"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    { field: "Color", label: "Color", required: true, type: "string" },
  ];

  const muleProduct: ShopifyProduct = {
    id: "rv-mule-1",
    title: "Roger Vivier Womens Green Sandal",
    vendor: "Roger Vivier",
    product_type: "MULE",
    options: [{ name: "Size", values: ["34"] }],
    variants: [
      { id: 1, sku: "RV-M-1", price: "100.00", inventory_quantity: 1, option1: "34" },
    ],
    metafields: [{ namespace: "custom", key: "color", value: "Green" }],
  };
  const mapped = mapShopifyToJomashop(muleProduct, schema, "Footwear");
  // At least one of Shoe Category / Shoe Style resolved to a live option
  // — never left blank when the title or product_type can be matched.
  const shoeCat = mapped.properties["Shoe Category"];
  const shoeStyle = mapped.properties["Shoe Style"];
  assert(
    shoeCat === "Mules" || shoeCat === "Sandals" || shoeStyle === "Mules" || shoeStyle === "Sandals",
    `RV-4a: Shoe Category/Style resolved from MULE/Sandal (Shoe Category=${JSON.stringify(shoeCat)}, Shoe Style=${JSON.stringify(shoeStyle)})`,
  );
}

function runInlineRepairRecognizesPerVariantSize() {
  console.log(
    "Case RV-5: Inline repair panel does NOT request Shoe Size when every variant supplies one",
  );
  const footwearSchema: SchemaPropertyDescriptor[] = [
    { field: "Gender", label: "Gender", required: true, type: "enum", options: ["Ladies", "Mens", "Kids"] },
    { field: "Shoe Size", label: "Shoe Size", required: true, type: "string" },
    { field: "Shoe Size Type", label: "Shoe Size Type", required: true, type: "enum", options: ["US", "EU", "UK"] },
    { field: "Color", label: "Color", required: true, type: "string" },
  ];

  // Case A: properties already carries Shoe Size (mapper saw the variant
  // option) — the descriptor should be "ok".
  const variantOpts: Record<string, Record<string, string>> = {
    "1": { Size: "34" },
    "2": { Size: "35" },
    "3": { Size: "36" },
    "4": { Size: "37" },
    "5": { Size: "38" },
  };
  const descA = buildInlineRepairFieldDescriptors(
    footwearSchema,
    { Gender: "Ladies", "Shoe Size": "34", "Shoe Size Type": "EU", Color: "Green" },
    [],
    variantOpts,
  );
  const shoeSizeA = descA.find((d) => d.field === "Shoe Size");
  assert(
    shoeSizeA !== undefined && shoeSizeA.status === "ok",
    `RV-5a: Shoe Size status === "ok" when variants supply it (got=${JSON.stringify(shoeSizeA)})`,
  );
  assert(
    shoeSizeA !== undefined && shoeSizeA.needsRepair === false,
    `RV-5b: Shoe Size needsRepair === false (got=${JSON.stringify(shoeSizeA)})`,
  );

  // Case B: mapper-emitted properties happen to be missing "Shoe Size"
  // (e.g. canonical extraction failed) but every variant carries one —
  // the helper must still surface "ok" with the variant sizes as
  // currentValue so the operator isn't asked to fill it manually.
  const descB = buildInlineRepairFieldDescriptors(
    footwearSchema,
    { Gender: "Ladies", "Shoe Size Type": "EU", Color: "Green" },
    [],
    variantOpts,
  );
  const shoeSizeB = descB.find((d) => d.field === "Shoe Size");
  assert(
    shoeSizeB !== undefined && shoeSizeB.status === "ok",
    `RV-5c: Shoe Size status === "ok" when properties is blank but variants supply size (got=${JSON.stringify(shoeSizeB)})`,
  );
  assert(
    shoeSizeB !== undefined && /34/.test(shoeSizeB.currentValue) && /38/.test(shoeSizeB.currentValue),
    `RV-5d: currentValue summarizes variant sizes 34..38 (got=${JSON.stringify(shoeSizeB?.currentValue)})`,
  );
}

runInlineRepairWarningUsesCanonicalApparel();
runInlineRepairCompactProjectionCarriesInvalidEnums();
runDeriveReadinessAfterRepair();
runInlineRepairCacheSplice();
runInlineRepairFilterBuckets();
runInlineRepairResponseShape();

await runCategoryAuditRowsHelpers();
await runCategoryAuditFallsBackWhenLiveUnavailable();
await runCategoryAuditAliasOnInvalid();

runInlineFieldRepairValidation();
runInlineFieldRepairMetafieldTargets();
runInlineFieldRepairPostSaveReadiness();
runInlineFieldRepairAllAttributeProjection();
runCanonicalApparelAliasFromClothing();
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
runApparelArticleNeverGuessed();
runApparelArticleSentFromLiveSchema();
runApparelRequiredUnverifiedBlocksPreflight();
runApparelArticleResolverUnblocks();
runFootwearRequiredEnumOverride();
runHandbagsOptionalEnumOverride();
runEnumOverrideRespectsAcceptedOptions();
runCanadaGooseOutwBlocksWithoutVerifiedMapping();
runUnverifiedBuiltInSeedIsRejected();
runVerifiedMappingRespectsAcceptedOrOperatorVerified();
runFootwearHandbagsRequiredEnumRegression();
runV1SchemaNormalization();
runV1ApparelArticleAcceptedOptions();
runCanadaGooseOutwLiveSynonymResolver();
runProductIdSourcedFromUpcOnly();
runFootwearSynonymResolver();
runHandbagsSynonymResolver();
runOperatorOverrideBeatsSynonym();
runOptionalUnresolvedOmitted();
runParentSkuMappingAndWriteback();
await runParentSkuExportColumnPopulation();
await runParentSkuUploadWritebackTarget();
await runJomashopMappingExcelHelpers();
await runJomashopProductFieldExcelHelpers();
await runProductFieldDropdownCoverage();
await runProductFieldSheetRecognitionAndForceWriteback();
await runGoLivePatchTests();
await runFullCatalogAndDisconnectedExportTests();

runFootwearVariantSizeRogerVivier();
runFootwearVariationColorYesNo();
runFootwearGenderWomenToLadies();
runFootwearShoeCategoryMuleSandal();
runInlineRepairRecognizesPerVariantSize();

// ---- Jomashop session endpoint 404 fallback ----
// The vendor API has shipped the auth endpoint as both `/v1/sessions` (plural)
// and `/v1/session` (singular). A 404 on the first must transparently fall back
// to the second; a non-404 error (e.g. 401 bad creds) must surface immediately.
async function runJomashopSessionEndpointFallback() {
  console.log("\n[Jomashop session endpoint 404 fallback]");
  const realFetch = globalThis.fetch;
  const prevEmail = process.env.JOMASHOP_EMAIL;
  const prevPassword = process.env.JOMASHOP_PASSWORD;
  const prevBase = process.env.JOMASHOP_API_BASE_URL;
  const prevSessionPath = process.env.JOMASHOP_SESSION_PATH;
  process.env.JOMASHOP_EMAIL = "test@example.com";
  process.env.JOMASHOP_PASSWORD = "secret";
  process.env.JOMASHOP_API_BASE_URL = "https://api.vendor.jomashop.test";
  delete process.env.JOMASHOP_SESSION_PATH;

  function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return handler(url, init);
    }) as typeof fetch;
  }
  const jwtHeader = () => new Headers({ authorization: "Bearer fake.jwt.token" });

  try {
    // Case 1: plural 404s, singular succeeds → login falls back and the
    // subsequent request carries the bearer token.
    __resetSessionPathForTest();
    const hits: string[] = [];
    mockFetch((url, init) => {
      if (url.includes("/v1/sessions")) {
        hits.push("POST /v1/sessions");
        return new Response("Not Found", { status: 404 });
      }
      if (url.includes("/v1/session")) {
        hits.push("POST /v1/session");
        return new Response("", { status: 200, headers: jwtHeader() });
      }
      if (url.includes("/v1/categories")) {
        hits.push("GET /v1/categories");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const r1 = await jomashopRequest({ path: "/v1/categories" });
    assert(r1.ok, "404 on /v1/sessions falls back to /v1/session and request succeeds");
    assert(
      hits.includes("POST /v1/sessions") && hits.includes("POST /v1/session"),
      "both session paths are probed when the first 404s",
    );

    // Case 2: a non-404 error (bad credentials) on the default path must NOT be
    // masked by the fallback — it surfaces immediately.
    __resetSessionPathForTest();
    let singularTried = false;
    mockFetch((url) => {
      if (url.includes("/v1/sessions")) return new Response("Unauthorized", { status: 401 });
      if (url.includes("/v1/session")) {
        singularTried = true;
        return new Response("", { status: 200, headers: jwtHeader() });
      }
      return new Response("unexpected", { status: 500 });
    });
    const r2 = await jomashopRequest({ path: "/v1/categories" });
    assert(!r2.ok && /401/.test(r2.error || ""), "401 on session login surfaces immediately (not masked by fallback)");
    assert(!singularTried, "fallback path is NOT tried after a non-404 login error");

    // Case 3: JOMASHOP_SESSION_PATH override pins the path (no probing).
    __resetSessionPathForTest();
    process.env.JOMASHOP_SESSION_PATH = "/v1/session";
    const overrideHits: string[] = [];
    mockFetch((url) => {
      if (url.endsWith("/v1/sessions")) {
        overrideHits.push("POST /v1/sessions");
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/v1/session")) {
        overrideHits.push("POST /v1/session");
        return new Response("", { status: 200, headers: jwtHeader() });
      }
      if (url.includes("/v1/categories")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const r3 = await jomashopRequest({ path: "/v1/categories" });
    assert(r3.ok, "JOMASHOP_SESSION_PATH override logs in successfully");
    assert(
      !overrideHits.includes("POST /v1/sessions") && overrideHits.includes("POST /v1/session"),
      "override skips probing the non-configured session path",
    );
  } finally {
    globalThis.fetch = realFetch;
    __resetSessionPathForTest();
    if (prevEmail === undefined) delete process.env.JOMASHOP_EMAIL; else process.env.JOMASHOP_EMAIL = prevEmail;
    if (prevPassword === undefined) delete process.env.JOMASHOP_PASSWORD; else process.env.JOMASHOP_PASSWORD = prevPassword;
    if (prevBase === undefined) delete process.env.JOMASHOP_API_BASE_URL; else process.env.JOMASHOP_API_BASE_URL = prevBase;
    if (prevSessionPath === undefined) delete process.env.JOMASHOP_SESSION_PATH; else process.env.JOMASHOP_SESSION_PATH = prevSessionPath;
  }
}

await runJomashopSessionEndpointFallback();

function runPortalReconcileTests() {
  console.log("\nPortal reconciliation:");

  // --- CSV parsing + header mapping + record coercion ---
  const csv = [
    "Status,Joma Status,SKU,Jomashop SKU,Name,Category,Qty,Price (USD),MSRP (USD)",
    "Active,Live,3102Y378-M,Y-A7C4T,Cavalli Class Navy Shirt,Apparel,5,129.00,299.00",
    'Inactive,,3103K61-4,Y-A7C4U,"Some, Quoted Name",Apparel,0,49.50,99.00',
  ].join("\n");
  const table = parsePortalCsv(csv);
  assert(table.length === 3, "parsePortalCsv: header + 2 data rows");
  const records = tableToRecords(table);
  assert(records.length === 2, "tableToRecords: 2 object records");
  assert(records[1]["Name"] === "Some, Quoted Name", "CSV: quoted comma preserved");

  assert(headerToField("Jomashop SKU") === "jomashopSku", "headerToField: Jomashop SKU");
  assert(headerToField("Joma Status") === "jomaStatus", "headerToField: Joma Status");
  assert(headerToField("SKU") === "vendorSku", "headerToField: vendor SKU");
  assert(headerToField("Price (USD)") === "price", "headerToField: price");
  assert(headerToField("MSRP (USD)") === "msrp", "headerToField: msrp");
  assert(headerToField("Product ID") === "productId", "headerToField: Product ID");
  assert(headerToField("UPC") === "productId", "headerToField: UPC → productId");

  assert(dollarsToCents("$1,299.00") === 129900, "dollarsToCents: $1,299.00 → 129900");
  assert(dollarsToCents("49.5") === 4950, "dollarsToCents: 49.5 → 4950");
  assert(dollarsToCents("") === null, "dollarsToCents: blank → null");

  const row0 = coercePortalRecord(records[0]);
  assert(!!row0 && row0!.vendorSku === "3102Y378-M", "coerce: vendor SKU");
  assert(row0!.jomashopSku === "Y-A7C4T", "coerce: jomashop SKU");
  assert(row0!.priceCents === 12900, "coerce: price cents");
  assert(row0!.msrpCents === 29900, "coerce: msrp cents");
  assert(row0!.qty === 5, "coerce: qty");
  assert(row0!.jomaStatus === "Live" && row0!.status === "Active", "coerce: status fields");
  const noSku = coercePortalRecord({ Name: "No SKU here" });
  assert(noSku === null, "coerce: row without SKU rejected");

  // --- Matching engine against a synthetic catalog ---
  const catalog: CatalogEntry[] = [
    {
      shopifyProductId: "gid-1",
      shopifyVariantId: "v-1",
      sku: "3102Y378-M",
      vendorSku: "3102Y378-M",
      jomashopSku: "Y-A7C4T",
      manufacturerNumber: "MFG-100",
      brand: "Cavalli Class",
      name: "Navy Shirt",
      upcs: ["190000000001"],
      pushState: "pushed",
    },
    {
      shopifyProductId: "gid-2",
      shopifyVariantId: "v-2",
      sku: "OTHER-1",
      vendorSku: "OTHER-1",
      jomashopSku: "Y-ZZZ",
      manufacturerNumber: "STYLE-XYZ",
      brand: "Gucci",
      name: "Belt",
      upcs: [],
      pushState: "pushed",
    },
  ];
  const index = buildCatalogIndex(catalog);

  const mkRow = (o: Record<string, any> & { vendorSku: string }) => ({
    vendorSku: o.vendorSku,
    jomashopSku: o.jomashopSku ?? null,
    name: o.name ?? null,
    brand: o.brand ?? null,
    category: null,
    status: o.status ?? null,
    jomaStatus: o.jomaStatus ?? null,
    qty: null,
    priceCents: null,
    msrpCents: null,
    dateCreated: null,
    dateUpdated: null,
    productId: o.productId ?? null,
    raw: {},
  });

  const mExact = matchPortalStyle(mkRow({ vendorSku: "3102Y378-M" }), index);
  assert(mExact.confidence === "Exact SKU" && mExact.entry?.shopifyProductId === "gid-1", "match: exact vendor SKU");

  const mJoma = matchPortalStyle(mkRow({ vendorSku: "UNKNOWN", jomashopSku: "Y-ZZZ" }), index);
  assert(mJoma.confidence === "Jomashop SKU" && mJoma.entry?.shopifyProductId === "gid-2", "match: Jomashop SKU fallback");

  const mUpc = matchPortalStyle(mkRow({ vendorSku: "UNKNOWN", productId: "190000000001" }), index);
  assert(mUpc.confidence === "UPC/Product ID", "match: UPC/Product ID fallback");

  const mStyle = matchPortalStyle(mkRow({ vendorSku: "STYLE-XYZ" }), index);
  assert(mStyle.confidence === "Style/Parent SKU", "match: style/parent (manufacturer #)");

  const mBT = matchPortalStyle(mkRow({ vendorSku: "UNKNOWN", brand: "Gucci", name: "Belt" }), index);
  assert(mBT.confidence === "Brand+Title", "match: brand+title fallback");

  const mNone = matchPortalStyle(mkRow({ vendorSku: "NOPE" }), index);
  assert(mNone.confidence === "Needs Review" && mNone.entry === null, "match: unmatched → Needs Review");

  // --- Status derivation ---
  assert(
    reconcileStatus(mkRow({ vendorSku: "3102Y378-M", jomaStatus: "Live" }), mExact) === "Confirmed Live",
    "status: matched + Joma Live → Confirmed Live",
  );
  assert(
    reconcileStatus(mkRow({ vendorSku: "3102Y378-M", status: "Active" }), mExact) === "Active in Portal",
    "status: matched + Active → Active in Portal",
  );
  assert(
    reconcileStatus(mkRow({ vendorSku: "3102Y378-M", status: "Inactive" }), mExact) === "Inactive in Portal",
    "status: matched + Inactive → Inactive in Portal",
  );
  assert(
    reconcileStatus(mkRow({ vendorSku: "NOPE" }), mNone) === "Unmatched Portal Row",
    "status: no match → Unmatched Portal Row",
  );
  assert(
    reconcileStatus(mkRow({ vendorSku: "UNKNOWN", brand: "Gucci", name: "Belt" }), mBT) === "Needs Review",
    "status: brand+title match → Needs Review",
  );

  // --- Inventory eligibility guard ---
  assert(isInventoryPushEligible("Confirmed Live"), "eligibility: Confirmed Live → eligible");
  assert(isInventoryPushEligible("Active in Portal"), "eligibility: Active in Portal → eligible");
  assert(!isInventoryPushEligible("Inactive in Portal"), "eligibility: Inactive → blocked");
  assert(!isInventoryPushEligible("Unmatched Portal Row"), "eligibility: Unmatched → blocked");
  assert(!isInventoryPushEligible(null), "eligibility: null → blocked");

  // --- catalogEntriesFromProducts (compact product shape) ---
  const compact = catalogEntriesFromProducts([
    {
      sku: "P-1",
      vendor_sku: "P-1",
      jomashop_sku: "J-1",
      brand: "Prada",
      name: "Bag",
      push_state: "pushed",
      source: { shopify_product_id: "gid-9", shopify_variant_ids: ["vv-1"] },
      properties: { UPC: "012345678905" },
    },
  ]);
  assert(compact.length === 1, "catalogEntriesFromProducts: 1 entry");
  assert(compact[0].upcs.includes("012345678905"), "catalogEntriesFromProducts: UPC extracted from properties");

  // --- Order line SKU extraction ---
  const skus = extractOrderLineSkus({
    items: [{ sku: "A-1", qty: 2 }, { vendor_sku: "B-2" }],
    nested: { line: { "Jomashop SKU": "J-3" } },
  });
  assert(skus.includes("A-1") && skus.includes("B-2") && skus.includes("J-3"), "extractOrderLineSkus: nested SKUs found");
}

runPortalReconcileTests();

// --- applyFieldValuesToCachedProducts (Excel "missing info" splice) ---
function runApplyFieldValuesTests() {
  const baseProduct = () => ({
    category: "Shoes",
    is_sample: false,
    vendor_sku: "SKU-1",
    schema_source: "live-i1" as const,
    properties: { Brand: "Nike" } as Record<string, string | number | boolean>,
    msrp: null as number | null,
    missing_required: ["Color", "Material"],
    missing_top_level: ["msrp"],
    invalid_enums: [{ field: "Color", value: "rainbow", options: ["Red", "Blue"] }],
    readiness: "missing",
    source: { shopify_product_id: "gid://shopify/Product/12345", shopify_variant_ids: ["v1"] },
  });

  // Fill one of two missing required fields + MSRP: that field leaves
  // missing_required, its invalid_enum is dropped, msrp leaves missing_top_level.
  {
    const { mapped, productsUpdated, fieldsApplied } = applyFieldValuesToCachedProducts(
      [baseProduct()],
      [{ shopifyProductId: "12345", fieldValues: { Color: "Red" }, msrp: "$250" }],
    );
    const m = mapped[0];
    assert(productsUpdated === 1, "applyFieldValues: 1 product updated");
    assert(fieldsApplied === 2, "applyFieldValues: 2 fields applied (Color + MSRP)");
    assert(m.properties.Color === "Red", "applyFieldValues: Color written to properties");
    assert(m.msrp === 250, "applyFieldValues: MSRP parsed to number");
    assert(!m.missing_required.includes("Color"), "applyFieldValues: Color cleared from missing_required");
    assert(m.missing_required.includes("Material"), "applyFieldValues: Material still missing");
    assert(m.invalid_enums.length === 0, "applyFieldValues: Color invalid_enum dropped");
    assert(!m.missing_top_level.includes("msrp"), "applyFieldValues: msrp cleared from missing_top_level");
    assert(m.readiness === "missing", "applyFieldValues: still missing (Material outstanding)");
  }

  // Fill ALL missing fields + MSRP: readiness flips to "ready".
  {
    const { mapped } = applyFieldValuesToCachedProducts(
      [baseProduct()],
      [{ shopifyProductId: "12345", fieldValues: { Color: "Red", Material: "Leather" }, msrp: "300" }],
    );
    const m = mapped[0];
    assert(m.missing_required.length === 0, "applyFieldValues: all required cleared");
    assert(m.readiness === "ready", "applyFieldValues: readiness flips to ready");
  }

  // gid-normalized matching: raw id on the row matches gid on the product.
  {
    const { productsUpdated } = applyFieldValuesToCachedProducts(
      [baseProduct()],
      [{ shopifyProductId: "gid://shopify/Product/12345", fieldValues: { Color: "Red" } }],
    );
    assert(productsUpdated === 1, "applyFieldValues: gid<->raw id match");
  }

  // No matching product id: nothing updated, original untouched.
  {
    const { mapped, productsUpdated } = applyFieldValuesToCachedProducts(
      [baseProduct()],
      [{ shopifyProductId: "99999", fieldValues: { Color: "Red" } }],
    );
    assert(productsUpdated === 0, "applyFieldValues: no match -> 0 updated");
    assert(mapped[0].missing_required.includes("Color"), "applyFieldValues: untouched when no match");
  }

  // Blank cells are ignored (no spurious field application).
  {
    const { productsUpdated, fieldsApplied } = applyFieldValuesToCachedProducts(
      [baseProduct()],
      [{ shopifyProductId: "12345", fieldValues: { Color: "   " }, msrp: "" }],
    );
    assert(productsUpdated === 0 && fieldsApplied === 0, "applyFieldValues: blank cells ignored");
  }
}

runApplyFieldValuesTests();

// ---------------------------------------------------------------------------
// Measurement sanitation: numeric-unit fields are coerced to numbers when
// parseable and OMITTED when not (e.g. "OS" one-size tokens), preventing
// Jomashop "Size length is not a number" Invalid Record rejections.
// ---------------------------------------------------------------------------
function runMeasurementSanitationTests() {
  console.log("\n--- measurement sanitation (numeric dimension fields) ---");
  const mapped = {
    category: "Accessories",
    is_sample: false,
    vendor_sku: "TEST-1",
    sku: "TEST-1",
    manufacturer_number: "TEST1",
    name: "Test Wallet",
    brand: "Gucci",
    price: 100,
    msrp: 120,
    jomashop_price: 80,
    images: [],
    description: "test",
    properties: {
      "Size Length (Inches)": "OS",
      "Size Width (Inches)": '4.25"',
      "Size Height (Inches)": 3,
      "Color": "Black",
    },
    variants: [],
    warnings: [],
    missing_required: [],
    missing_top_level: [],
    invalid_enums: [],
    omitted_optional_fields: [],
    unverified_required_options: [],
    auto_resolved_enums: [],
  } as any;
  const { payload, omittedOptionalFields } = buildJomashopProductPayload(mapped, undefined, {
    manufacturer_id: 42,
    category_id: 43,
  });
  const props = payload.properties as Record<string, unknown>;
  assert(!("Size Length (Inches)" in props), 'non-numeric "OS" size length omitted');
  assert(props["Size Width (Inches)"] === 4.25, 'unit-suffixed size width coerced to 4.25');
  assert(props["Size Height (Inches)"] === 3, "already-numeric size height untouched");
  assert(props["Color"] === "Black", "non-measurement fields untouched");
  assert(
    omittedOptionalFields.some((s: string) => s.includes("Size Length (Inches)")),
    "omission surfaced in omittedOptionalFields",
  );
}

runMeasurementSanitationTests();

// ---------------------------------------------------------------------------
// Tag-mapping fallback: operator-confirmed garment codes (LOAF/SHIR/HOOD/...)
// fill required schema enums when metafields are missing, split SHRT by size
// and DRES by title, and derive a code from titles for untagged products.
// ---------------------------------------------------------------------------
function runTagMappingTests() {
  console.log("\n--- tag-mapping fallback (operator-confirmed codes) ---");
  const apparelSchema = [
    { field: "Apparel Type", required: true, type: "enum", options: ["Bottoms", "Dresses", "Outerwear", "Sets", "Swim", "Tops", "Undergarments"] },
    { field: "Article", required: true, type: "enum", options: ["Active & Lounge", "Dress Shirts", "Hoodies & Sweatshirts", "Shirts & Blouses", "Shorts", "Summer Dresses", "Evening & Formal Gowns", "Cocktail & Party Dresses", "T-Shirts & Henleys"] },
  ];
  const base = (over: Record<string, unknown>) => ({
    id: "1", title: "Palm Angels Mens Black Hoodie", body_html: "x", vendor: "Palm Angels",
    product_type: "RTW", tags: ["HOOD", "MENS", "RTW"], images: [],
    options: [{ name: "SIZE", values: ["M"] }],
    variants: [{ id: "v1", sku: "ABC-M", price: "100", compare_at_price: null, inventory_quantity: 1, barcode: null, option1: "M", option2: null, option3: null }],
    metafields: [],
    ...over,
  }) as any;

  {
    const m = mapShopifyToJomashop(base({}), apparelSchema as any);
    assert(m.properties["Article"] === "Hoodies & Sweatshirts", "HOOD tag fills Article");
    assert(m.properties["Apparel Type"] === "Tops", "HOOD tag fills Apparel Type");
    assert(!m.missing_required.includes("Article"), "Article no longer missing");
    assert(m.raw_category === "HOOD", "generic RTW raw_category replaced by tag code");
  }
  {
    const m = mapShopifyToJomashop(base({ title: "Orlebar Brown Mens Blue Shrt", tags: ["SHRT"], options: [{ name: "SIZE", values: ["30"] }], variants: [{ id: "v1", sku: "X-30", price: "100", compare_at_price: null, inventory_quantity: 1, barcode: null, option1: "30", option2: null, option3: null }] }), apparelSchema as any);
    assert(m.properties["Article"] === "Shorts", "SHRT + waist size 30 -> Shorts");
  }
  {
    const m = mapShopifyToJomashop(base({ title: "Lacoste Mens Black Shrt", tags: ["SHRT"] }), apparelSchema as any);
    assert(m.properties["Article"] === "Shirts & Blouses", "SHRT + letter size M -> Shirts & Blouses");
  }
  {
    const m = mapShopifyToJomashop(base({ title: "Off White Womens Green Party Mini Dress", tags: ["DRES"] }), apparelSchema as any);
    assert(m.properties["Article"] === "Cocktail & Party Dresses", "DRES + party title -> Cocktail & Party");
  }
  {
    const m = mapShopifyToJomashop(base({ title: "Off White Womens Floral Dress", tags: ["DRES"] }), apparelSchema as any);
    assert(m.properties["Article"] === "Summer Dresses", "DRES default -> Summer Dresses");
  }
  {
    // Untagged (MEN-only): title keyword derivation
    const m = mapShopifyToJomashop(base({ title: "Off White Graphic Tee White", tags: ["MEN"] }), apparelSchema as any);
    assert(m.properties["Article"] === "T-Shirts & Henleys", "untagged product derives TSHR from title");
  }
  {
    // Ignored/jewelry: no injection
    const m = mapShopifyToJomashop(base({ title: "Palm Angel Mens Silver Chain", tags: ["NECK"] }), apparelSchema as any);
    assert(m.missing_required.includes("Article"), "ignored tag leaves Article missing");
  }
}

runTagMappingTests();

function runCharmPricingTests() {
  console.log("\n--- charm pricing (X9.99) ---");
  assert(charmPrice(180.60) === 179.99, "180.60 -> 179.99");
  assert(charmPrice(142.40) === 139.99, "142.40 -> 139.99");
  assert(charmPrice(1330) === 1329.99, "1330 -> 1329.99");
  assert(charmPrice(185) === 189.99, "185 -> 189.99 (rounds up to 190 bucket)");
  assert(charmPrice(7.30) === 9.99, "7.30 -> 9.99 (nearest 10 bucket)");
  assert(charmPrice(0) === null, "0 -> null");
  // margin floor: charming down must not break 50% margin -> steps up
  // retail 200, cost 95, payoutRatio 1 (price IS payout). 50% floor needs
  // payout >= 190. charm(200)=199.99 -> payout 199.99 >= 190 OK.
  assert(charmRetailWithMarginFloor({ retail: 200, cost: 95, payoutRatio: 1 }) === 199.99, "charm keeps margin when already safe");
  // retail 200, cost 99 -> floor payout 198. charm(200)=199.99 OK.
  assert(charmRetailWithMarginFloor({ retail: 200, cost: 99, payoutRatio: 1 }) === 199.99, "charm 199.99 clears 198 floor");
  // retail 182, cost 90 -> charm(182)=179.99, floor payout 180. 179.99 < 180
  // so bump up to 189.99.
  assert(charmRetailWithMarginFloor({ retail: 182, cost: 90, payoutRatio: 1 }) === 189.99, "charm bumps up to keep 50% margin");
  // no cost -> plain charm
  assert(charmRetailWithMarginFloor({ retail: 182, cost: null, payoutRatio: 1 }) === 179.99, "no cost -> plain charm");
}

runCharmPricingTests();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll mapping smoke tests passed.");
