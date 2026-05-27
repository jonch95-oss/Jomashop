import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------- Shopify stores ----------
// One row per connected Shopify store. We DO NOT store credentials here when
// they exist in env; instead we track connection status + metadata.
export const stores = sqliteTable("stores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopDomain: text("shop_domain").notNull().unique(), // e.g. luxesupply.myshopify.com
  displayName: text("display_name").notNull().default("LuxeSupply"),
  // Status of the OAuth flow: "pending" | "connected" | "disconnected"
  oauthStatus: text("oauth_status").notNull().default("pending"),
  // Scopes granted (comma-separated)
  scopes: text("scopes"),
  // Last installed timestamp (epoch ms)
  installedAt: integer("installed_at"),
  // Access token storage policy: "env" | "db_encrypted" | "db_plain" | "none"
  // The scaffold prefers env vars. If user opts in to DB storage we encrypt at rest.
  tokenStorage: text("token_storage").notNull().default("env"),
  // Encrypted Shopify Admin API access token (AES-256-GCM keyed off SESSION_SECRET).
  // Empty/null when not yet captured. Required for live product fetch.
  accessTokenEnc: text("access_token_enc"),
});

// ---------- Credential status (no raw secrets unless explicitly env-backed) ----------
export const credentialStatus = sqliteTable("credential_status", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // "shopify_client_id" | "shopify_client_secret" | "jomashop_email" | "jomashop_password" etc.
  key: text("key").notNull().unique(),
  source: text("source").notNull(), // "env" | "missing"
  // True if env var is present; we never persist the value itself.
  configured: integer("configured", { mode: "boolean" }).notNull().default(false),
  lastCheckedAt: integer("last_checked_at"),
});

// ---------- SKU mapping (Shopify variant SKU ↔ Jomashop vendor SKU) ----------
export const skuMappings = sqliteTable("sku_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopifyVariantId: text("shopify_variant_id").notNull(),
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifySku: text("shopify_sku").notNull(),
  jomashopSku: text("jomashop_sku"), // null until first sync
  jomashopProductId: text("jomashop_product_id"),
  // "shoes" | "handbags" | "clothing"
  categoryKey: text("category_key").notNull(),
  status: text("status").notNull().default("draft"), // draft | active | error
  lastError: text("last_error"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------- Category mapping (Shopify product type/tag → Jomashop category) ----------
export const categoryMappings = sqliteTable("category_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopifyProductType: text("shopify_product_type").notNull().unique(),
  jomashopCategory: text("jomashop_category").notNull(), // Shoes | Handbags | Clothing
  // JSON object: { jomashop_field: shopify_path } for dynamic field mapping
  fieldMapJson: text("field_map_json").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------- Category override (operator-supplied Shopify code → Jomashop category) ----------
// Saved by the Excel-driven category mapping workflow. Keyed by the lowercased
// Shopify category code (product_type / `category` metafield, e.g. "drsh"). When
// a product preview is built the override is looked up first and replaces the
// inferred category, so a single mapping for "drsh" → "Dress Shirts" can flip
// every dress shirt at once.
export const categoryOverrides = sqliteTable("category_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopifyCategoryCode: text("shopify_category_code").notNull().unique(),
  jomashopCategory: text("jomashop_category").notNull(),
  notes: text("notes"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------- Enum override (operator-supplied source value → exact Jomashop enum option) ----------
// Saved per Jomashop category + schema-field (e.g. Apparel + Article). Keyed
// by the lowercased Jomashop category, the normalized Jomashop field label
// (lowercased, non-alphanumerics stripped), and a normalized source value
// (typically the Shopify product_type / category code / metafield value).
// Used at push time to translate ANY unverified or out-of-list source value
// into a Jomashop-accepted option for a required enum field, so the push
// isn't blocked indefinitely. Mirrors brand_overrides / category_overrides
// but at the schema-property level rather than category-level.
//
// `verified` is the trust gate the payload builder consults before emitting
// any override. A row is verified when one of the following holds:
//   - it was checked against the live Jomashop accepted option list at save
//     time (`acceptedOptionsJson` captured the live list and the target
//     option is in it), or
//   - the operator explicitly flagged it verified (`operatorVerified`) when
//     no live option list is available.
// Unverified rows are NEVER used to satisfy a required enum field — the
// preflight surfaces "Fix mapping for X" instead so a bad guess never lands
// in a Jomashop payload again (see commit history for "Article=Outerwear"
// regression).
export const enumOverrides = sqliteTable("enum_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jomashopCategory: text("jomashop_category").notNull(),
  jomashopField: text("jomashop_field").notNull(),
  sourceValue: text("source_value").notNull(),
  jomashopOption: text("jomashop_option").notNull(),
  notes: text("notes"),
  // 1 when the override has passed the trust gate (live-options check or
  // explicit operator confirmation). 0 otherwise. Stored as integer because
  // SQLite booleans are integers. Default 0 so any pre-existing rows from
  // earlier builds are treated as untrusted until the operator re-saves them.
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  // When the operator confirmed without a live option list (e.g. Jomashop
  // hasn't published Apparel "Article" accepted values). The audit endpoint
  // requires explicit confirmation so a no-live-options save is auditable.
  operatorVerified: integer("operator_verified", { mode: "boolean" }).notNull().default(false),
  // Snapshot of the accepted Jomashop option list at the moment the row was
  // saved (JSON string array). Empty / null when no live list was reachable.
  // Used to render audit context and to gate future re-validations.
  acceptedOptionsJson: text("accepted_options_json"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------- Brand override (operator-supplied Shopify brand → exact Jomashop brand) ----------
// Used at push time to translate Shopify vendor/designer values into the exact
// brand spelling Jomashop expects. Keyed by the normalized Shopify brand string
// (lowercased, non-alphanumerics stripped) so "Tod's", "Tods", and "TODS" all
// resolve to the same row. Mirror of category_overrides for brands.
export const brandOverrides = sqliteTable("brand_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopifyBrand: text("shopify_brand").notNull().unique(),
  jomashopBrand: text("jomashop_brand").notNull(),
  notes: text("notes"),
  updatedAt: integer("updated_at").notNull(),
});

// ---------- Sync jobs / logs ----------
export const syncJobs = sqliteTable("sync_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobType: text("job_type").notNull(), // products_push | inventory_push | orders_pull | fulfillment_push | session_test
  status: text("status").notNull().default("pending"), // pending | running | success | failed
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  totalItems: integer("total_items").notNull().default(0),
  successItems: integer("success_items").notNull().default(0),
  errorItems: integer("error_items").notNull().default(0),
  summary: text("summary"),
});

export const syncLogs = sqliteTable("sync_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id"),
  level: text("level").notNull().default("info"), // info | warn | error
  message: text("message").notNull(),
  // JSON details (request id, sku, status code, etc.)
  detailsJson: text("details_json"),
  createdAt: integer("created_at").notNull(),
});

// ---------- Push status per Shopify product/variant ----------
// Tracks whether a Shopify product/variant has been pushed to Jomashop, the
// last push outcome, and the most recent payload for inventory webhook
// updates. Used to:
//  - hide already-pushed items from the "needs pushing" filter,
//  - label the button "Update on Jomashop" instead of "Push",
//  - decide whether an inventory webhook should call PUT /v1/inventory/:sku.
export const pushStatuses = sqliteTable("push_statuses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopDomain: text("shop_domain").notNull(),
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifyVariantId: text("shopify_variant_id"),
  shopifySku: text("shopify_sku").notNull(),
  jomashopSku: text("jomashop_sku"),
  // "pushed" — last push succeeded.
  // "rejected" — last push call returned a validation error (e.g. "Brand must exist").
  // "failed" — non-validation error (network, 5xx, etc).
  state: text("state").notNull().default("pushed"),
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
  // Stored mapped product JSON used as the base for inventory updates when a
  // Shopify webhook arrives without price/title context.
  lastPayloadJson: text("last_payload_json"),
  // Jomashop validation context from the last rejection. invalid_params is the
  // server's machine list ("category", "brand"); rejectedCategory / Brand are
  // the exact strings sent in the most recent rejected payload so the UI can
  // show "Jomashop rejected Footwear" without re-decoding payload JSON.
  lastInvalidParams: text("last_invalid_params"),
  lastRejectedCategory: text("last_rejected_category"),
  lastRejectedBrand: text("last_rejected_brand"),
  lastPushedAt: integer("last_pushed_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ---------- Cached Shopify product preview ----------
// Caches /api/sync/preview-products responses by shop domain so the Products
// page can load instantly without re-paginating Shopify on every visit.
// A single row per shop domain is kept; "Refresh from Shopify" overwrites it.
export const productCache = sqliteTable("product_cache", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopDomain: text("shop_domain").notNull().unique(),
  fetchedCount: integer("fetched_count").notNull().default(0),
  pageCount: integer("page_count").notNull().default(0),
  hasMore: integer("has_more", { mode: "boolean" }).notNull().default(false),
  // Full preview payload (mapped + schemas + flags) serialized as JSON so
  // the products page can rehydrate without recomputing anything server-side.
  payloadJson: text("payload_json").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

// ---------- Webhook events ----------
// Append-only log of Shopify webhook deliveries we've processed (or refused).
// Lets the operator audit auto-sync activity and see why a delivery was
// dropped (HMAC mismatch, unknown SKU, etc.).
export const webhookEvents = sqliteTable("webhook_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  topic: text("topic").notNull(),
  shopDomain: text("shop_domain"),
  // sha256 hash of the request body — used to dedupe Shopify retries.
  bodyHash: text("body_hash"),
  hmacVerified: integer("hmac_verified", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull(), // received | applied | skipped | rejected
  message: text("message"),
  detailsJson: text("details_json"),
  receivedAt: integer("received_at").notNull(),
});

// ---------- Imported orders (from Jomashop) ----------
export const importedOrders = sqliteTable("imported_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  salesOrderNumber: text("sales_order_number").notNull().unique(),
  status: text("status").notNull(), // new | pending | fulfilled | rejected | cancelled | partial
  // JSON snapshot of the order payload
  payloadJson: text("payload_json").notNull(),
  shopifyOrderId: text("shopify_order_id"),
  importedAt: integer("imported_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ---------- Insert schemas ----------
export const insertStoreSchema = createInsertSchema(stores).omit({ id: true });
export const insertCredentialStatusSchema = createInsertSchema(credentialStatus).omit({ id: true });
export const insertSkuMappingSchema = createInsertSchema(skuMappings).omit({ id: true });
export const insertCategoryMappingSchema = createInsertSchema(categoryMappings).omit({ id: true });
export const insertCategoryOverrideSchema = createInsertSchema(categoryOverrides).omit({ id: true });
export const insertBrandOverrideSchema = createInsertSchema(brandOverrides).omit({ id: true });
export const insertEnumOverrideSchema = createInsertSchema(enumOverrides).omit({ id: true });
export const insertSyncJobSchema = createInsertSchema(syncJobs).omit({ id: true });
export const insertSyncLogSchema = createInsertSchema(syncLogs).omit({ id: true });
export const insertImportedOrderSchema = createInsertSchema(importedOrders).omit({ id: true });
export const insertPushStatusSchema = createInsertSchema(pushStatuses).omit({ id: true });
export const insertProductCacheSchema = createInsertSchema(productCache).omit({ id: true });
export const insertWebhookEventSchema = createInsertSchema(webhookEvents).omit({ id: true });

// ---------- Types ----------
export type Store = typeof stores.$inferSelect;
export type InsertStore = z.infer<typeof insertStoreSchema>;
export type CredentialStatus = typeof credentialStatus.$inferSelect;
export type InsertCredentialStatus = z.infer<typeof insertCredentialStatusSchema>;
export type SkuMapping = typeof skuMappings.$inferSelect;
export type InsertSkuMapping = z.infer<typeof insertSkuMappingSchema>;
export type CategoryMapping = typeof categoryMappings.$inferSelect;
export type InsertCategoryMapping = z.infer<typeof insertCategoryMappingSchema>;
export type CategoryOverride = typeof categoryOverrides.$inferSelect;
export type InsertCategoryOverride = z.infer<typeof insertCategoryOverrideSchema>;
export type BrandOverride = typeof brandOverrides.$inferSelect;
export type InsertBrandOverride = z.infer<typeof insertBrandOverrideSchema>;
export type EnumOverride = typeof enumOverrides.$inferSelect;
export type InsertEnumOverride = z.infer<typeof insertEnumOverrideSchema>;
export type SyncJob = typeof syncJobs.$inferSelect;
export type InsertSyncJob = z.infer<typeof insertSyncJobSchema>;
export type SyncLog = typeof syncLogs.$inferSelect;
export type InsertSyncLog = z.infer<typeof insertSyncLogSchema>;
export type ImportedOrder = typeof importedOrders.$inferSelect;
export type InsertImportedOrder = z.infer<typeof insertImportedOrderSchema>;
export type PushStatus = typeof pushStatuses.$inferSelect;
export type InsertPushStatus = z.infer<typeof insertPushStatusSchema>;
export type ProductCache = typeof productCache.$inferSelect;
export type InsertProductCache = z.infer<typeof insertProductCacheSchema>;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type InsertWebhookEvent = z.infer<typeof insertWebhookEventSchema>;

// ---------- Shared domain constants ----------
// SupportedCategory enumerates every Jomashop top-level category this app
// pushes to. Each entry must have a corresponding entry in
// FALLBACK_CATEGORY_SCHEMAS using the EXACT property labels Jomashop accepts
// (Title Case / spaced) — never lowercase legacy field names. Adding a new
// category here without a matching schema entry will cause schema-driven
// payload construction to fail visibly at preflight (this is intentional).
export const SUPPORTED_CATEGORIES = [
  // Original three (kept for backward compatibility with existing data).
  "Shoes",
  "Handbags",
  "Clothing",
  // Categories Jomashop accepts and the app maps to via BUILT_IN_CATEGORY_OVERRIDES.
  "Apparel",
  "Footwear",
  "Accessories",
  "Eyewear",
  "Rings",
  "Necklaces",
  "Bracelets",
  "Earrings",
  "Pins & Brooches",
  "Home Decor",
] as const;
export type SupportedCategory = (typeof SUPPORTED_CATEGORIES)[number];

// Maps legacy / Shopify-flavored category names to the canonical name Jomashop
// uses in /v1/categories and /i1/categories. The live Jomashop API never had
// "Clothing" — apparel lives under "Apparel" — so schema and enum lookups MUST
// hit the canonical name even when the mapper internally still labels a
// product as "Clothing" for backward compatibility.
//
// Why: /api/jomashop/category-enum-options/Apparel correctly returns the live
// Article options (Coats & Jackets, etc.), but push/preflight was calling
// getV1CategoryDescriptors("Clothing") which 404s and falls back to the
// bundled Clothing schema where Article is options_unverified — triggering
// "accepted option list ... has not been loaded" even when Apparel was live.
export const CANONICAL_JOMASHOP_CATEGORY_ALIASES: Record<string, SupportedCategory> = {
  clothing: "Apparel",
  apparel: "Apparel",
  rtw: "Apparel",
  "ready-to-wear": "Apparel",
  shoes: "Footwear",
  footwear: "Footwear",
};

/**
 * Return the canonical Jomashop category name for schema / enum-option
 * lookups. Pass through unchanged when no alias exists so callers stay
 * compatible with categories already on the canonical name (Handbags, etc.).
 */
export function canonicalJomashopCategory<T extends string>(
  category: T | null | undefined,
): T | SupportedCategory {
  if (!category) return category as T;
  const key = String(category).toLowerCase().trim();
  const hit = CANONICAL_JOMASHOP_CATEGORY_ALIASES[key];
  return (hit ?? category) as T | SupportedCategory;
}

export const INVENTORY_STATUSES = ["active", "out_of_stock", "inactive"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const ORDER_STATUSES = [
  "new",
  "cancelled",
  "pending",
  "fulfilled",
  "rejected",
  "partial",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Conservative allowed-value lists for Apparel "Apparel Type" / "Article"
// and "Country of Origin" fields. These mirror the values Jomashop accepts on
// its live /i1 Apparel category — a free-text submission that isn't in this
// list is rejected with "Article is not included in the list" /
// "Country of origin is not included in the list".
//
// The lists are intentionally conservative: they include the apparel
// sub-types and countries the catalog has historically accepted. If a live
// schema response is available (via /i1/categories/:id) it ALWAYS takes
// precedence — these lists exist purely as a safety net so the bundled
// fallback never sends free-text into an enum-only field.
const APPAREL_TYPE_OPTIONS_INTERNAL = [
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

const COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL = [
  "Italy",
  "France",
  "USA",
  "United States",
  "Spain",
  "Portugal",
  "Switzerland",
  "Germany",
  "United Kingdom",
  "UK",
  "China",
  "Japan",
  "Vietnam",
  "Romania",
  "Turkey",
  "India",
  "Thailand",
  "Bangladesh",
  "Sri Lanka",
  "Indonesia",
  "Mexico",
  "Brazil",
  "Cambodia",
  "Tunisia",
  "Bulgaria",
];

// Static fallback schema used when /i1/categories/:id cannot be reached.
// The app prefers fetching live category schemas from Jomashop, but when the
// live lookup fails these are used as a last-resort source of EXACT property
// labels (Title Case / spaced) — never legacy lowercase names. When push-time
// payload construction sees only lowercase fallback labels it refuses the
// push at preflight rather than producing a payload Jomashop will reject
// (the rejected /i1 endpoint requires Title Case labels and forbids the
// legacy lowercase fields).
//
// Per-field flags:
//   - required: schema-required by Jomashop. Missing → preflight 422.
//   - options: allowed enum values. A canonical value not in this list is
//     coerced to a matching option if possible; otherwise behaviour depends
//     on `allow_omit` below.
//   - allow_omit: when true (and the field is not required), the payload
//     OMITS the key entirely if no value can be safely mapped. Used for
//     fields Jomashop accepts an absent key for but rejects a wrong value
//     (e.g. Apparel Material — Jomashop demands a specific enum list and
//     rejects free-text material strings with "Material must be blank").
//   - omit_when_unknown_enum: when true and the canonical value can't be
//     coerced to any of `options`, the field is dropped from the payload
//     rather than sent with an invalid value. Used to avoid Jomashop's
//     "X is not included in the list" rejections for optional fields.
export type FallbackPropertyDef = {
  field: string;
  type: "string" | "number" | "enum" | "boolean";
  required: boolean;
  options?: string[];
  example?: string;
  allow_omit?: boolean;
  omit_when_unknown_enum?: boolean;
  // When true, the bundled `options` list is a best-guess that Jomashop has
  // NOT confirmed as the live accepted set. The payload builder treats this
  // field as unsafe to send:
  //   - optional + options_unverified → field is omitted entirely from the
  //     payload (never guessed), even when the canonical value matches one
  //     of the guessed options.
  //   - required + options_unverified → preflight blocks the push with a
  //     "load live options for X" error rather than emitting a guess that
  //     would trigger Jomashop's "X is not included in the list" rejection.
  // Lifted as soon as a live schema response provides confirmed options.
  options_unverified?: boolean;
};

export const FALLBACK_CATEGORY_SCHEMAS: Record<SupportedCategory, FallbackPropertyDef[]> = {
  // ----- Apparel (Title Case Jomashop labels per /i1/categories/Apparel) -----
  // Gender accepts only Men/Women/Unisex on the live Jomashop Apparel schema —
  // "Kids" is rejected ("Gender is not included in the list"). Kids products
  // route through Age=Kids with Gender mapped to Unisex (or omitted).
  // Material is REJECTED for Apparel ("Material must be blank") so it is
  // deliberately absent from this schema. The schema-driven payload builder
  // refuses to send keys not in the schema for the category, so Material
  // simply never reaches Jomashop for Apparel pushes.
  // Article is a Jomashop enum whose accepted list is NOT published — the
  // bundled APPAREL_TYPE_OPTIONS_INTERNAL guesses (Outerwear, Pants, ...) do
  // NOT match what Jomashop actually accepts (it rejected "Outerwear" on the
  // live Apparel category). We tag Article with `options_unverified: true`
  // so the payload builder NEVER sends a guess: when live options haven't
  // been loaded the field is dropped entirely. The Apparel Type field carries
  // the broad apparel-class signal instead.
  // Country of Origin carries the published Jomashop country list. Values
  // outside the list (e.g. "Canada", which Jomashop rejected) are dropped
  // via omit_when_unknown_enum so the push isn't blocked.
  Apparel: [
    {
      field: "Gender",
      type: "enum",
      required: true,
      options: ["Men", "Women", "Unisex"],
      omit_when_unknown_enum: false,
    },
    { field: "Age", type: "enum", required: true, options: ["Adult", "Kids"] },
    {
      field: "Apparel Type",
      type: "enum",
      required: true,
      options: APPAREL_TYPE_OPTIONS_INTERNAL,
    },
    { field: "Detailed Description", type: "string", required: true },
    { field: "Total Number of Pieces", type: "string", required: true, example: "1" },
    { field: "Color", type: "string", required: true },
    // Article is required on the live Jomashop Apparel category — pushing
    // without it triggers "Article can't be blank". The bundled options list
    // is a best-guess so we keep options_unverified: true so the payload
    // builder NEVER emits a guessed value; instead, when no operator-supplied
    // enum override resolves the source value, preflight blocks the push
    // with an actionable "Fix mapping for Article" error.
    {
      field: "Article",
      type: "enum",
      required: true,
      options: APPAREL_TYPE_OPTIONS_INTERNAL,
      options_unverified: true,
    },
    {
      field: "Apparel Size Type",
      type: "enum",
      required: false,
      options: ["US", "EU", "UK", "IT", "FR"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    { field: "Apparel Size", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Footwear -----
  Footwear: [
    { field: "Gender", type: "enum", required: true, options: ["Men", "Women", "Unisex", "Kids"] },
    { field: "Shoe Size", type: "string", required: true },
    { field: "Shoe Size Type", type: "enum", required: true, options: ["US", "EU", "UK", "IT", "FR"] },
    { field: "Color", type: "string", required: true },
    { field: "Material", type: "string", required: false, allow_omit: true },
    { field: "Style", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Handbags -----
  Handbags: [
    { field: "Color", type: "string", required: true, example: "Noir" },
    { field: "Material", type: "string", required: true, example: "Calfskin leather" },
    { field: "Style", type: "enum", required: false, options: ["Shoulder", "Tote", "Crossbody", "Clutch", "Backpack", "Top-handle"], allow_omit: true, omit_when_unknown_enum: true },
    { field: "Hardware", type: "enum", required: false, options: ["Gold", "Silver", "Gunmetal", "Mixed"], allow_omit: true, omit_when_unknown_enum: true },
    { field: "Interior Material", type: "string", required: false, allow_omit: true },
    { field: "Dimensions", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Accessories (wallets/belts/cardholders) -----
  Accessories: [
    { field: "Gender", type: "enum", required: false, options: ["Men", "Women", "Unisex", "Kids"], allow_omit: true, omit_when_unknown_enum: true },
    { field: "Color", type: "string", required: true },
    { field: "Material", type: "string", required: false, allow_omit: true },
    { field: "Style", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Eyewear -----
  Eyewear: [
    { field: "Gender", type: "enum", required: true, options: ["Men", "Women", "Unisex", "Kids"] },
    { field: "Frame Color", type: "string", required: true },
    { field: "Lens Color", type: "string", required: false, allow_omit: true },
    { field: "Frame Material", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Jewelry sub-categories — Rings -----
  Rings: [
    { field: "Gender", type: "enum", required: true, options: ["Men", "Women", "Unisex"] },
    { field: "Metal", type: "string", required: true },
    { field: "Ring Size", type: "string", required: false, allow_omit: true },
    { field: "Stone", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Necklaces -----
  Necklaces: [
    { field: "Gender", type: "enum", required: true, options: ["Men", "Women", "Unisex"] },
    { field: "Metal", type: "string", required: true },
    { field: "Length", type: "string", required: false, allow_omit: true },
    { field: "Stone", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Bracelets -----
  Bracelets: [
    { field: "Gender", type: "enum", required: true, options: ["Men", "Women", "Unisex"] },
    { field: "Metal", type: "string", required: true },
    { field: "Length", type: "string", required: false, allow_omit: true },
    { field: "Stone", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Earrings -----
  Earrings: [
    { field: "Gender", type: "enum", required: true, options: ["Men", "Women", "Unisex"] },
    { field: "Metal", type: "string", required: true },
    { field: "Stone", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Pins & Brooches -----
  "Pins & Brooches": [
    { field: "Metal", type: "string", required: true },
    { field: "Color", type: "string", required: true },
    { field: "Stone", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Home Decor -----
  "Home Decor": [
    { field: "Color", type: "string", required: true },
    { field: "Material", type: "string", required: false, allow_omit: true },
    { field: "Dimensions", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  // ----- Legacy buckets kept for backward compatibility -----
  // Shoes / Clothing predate the strict-label rewrite and are aliased to the
  // new schemas below so older code paths still resolve. New code should
  // route to "Footwear" / "Apparel".
  Shoes: [
    { field: "Gender", type: "enum", required: true, options: ["Men", "Women", "Unisex", "Kids"] },
    { field: "Shoe Size", type: "string", required: true },
    { field: "Shoe Size Type", type: "enum", required: true, options: ["US", "EU", "UK", "IT", "FR"] },
    { field: "Color", type: "string", required: true },
    { field: "Material", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
  Clothing: [
    {
      field: "Gender",
      type: "enum",
      required: true,
      options: ["Men", "Women", "Unisex"],
    },
    { field: "Age", type: "enum", required: true, options: ["Adult", "Kids"] },
    {
      field: "Apparel Type",
      type: "enum",
      required: true,
      options: APPAREL_TYPE_OPTIONS_INTERNAL,
    },
    { field: "Detailed Description", type: "string", required: true },
    { field: "Total Number of Pieces", type: "string", required: true, example: "1" },
    { field: "Color", type: "string", required: true },
    // Article is required on the live Jomashop Apparel category — pushing
    // without it triggers "Article can't be blank". The bundled options list
    // is a best-guess so we keep options_unverified: true so the payload
    // builder NEVER emits a guessed value; instead, when no operator-supplied
    // enum override resolves the source value, preflight blocks the push
    // with an actionable "Fix mapping for Article" error.
    {
      field: "Article",
      type: "enum",
      required: true,
      options: APPAREL_TYPE_OPTIONS_INTERNAL,
      options_unverified: true,
    },
    {
      field: "Apparel Size Type",
      type: "enum",
      required: false,
      options: ["US", "EU", "UK", "IT", "FR"],
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
    { field: "Apparel Size", type: "string", required: false, allow_omit: true },
    {
      field: "Country of Origin",
      type: "enum",
      required: false,
      options: COUNTRY_OF_ORIGIN_OPTIONS_INTERNAL,
      allow_omit: true,
      omit_when_unknown_enum: true,
    },
  ],
};
