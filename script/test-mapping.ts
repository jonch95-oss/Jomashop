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

import { mapShopifyToJomashop, type ShopifyProduct } from "../server/mapping";
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

runColorNavyCase();
runDefinitionNameOnlyCase();
runVariantSelectedOptionFallback();
runListTypeMetafield();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll mapping smoke tests passed.");
