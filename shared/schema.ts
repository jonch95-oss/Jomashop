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
export const SUPPORTED_CATEGORIES = ["Shoes", "Handbags", "Clothing"] as const;
export type SupportedCategory = (typeof SUPPORTED_CATEGORIES)[number];

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

// Static fallback schema used when /v1/categories cannot be reached.
// The app prefers fetching live category schemas from Jomashop.
export const FALLBACK_CATEGORY_SCHEMAS: Record<
  SupportedCategory,
  { field: string; type: "string" | "number" | "enum" | "boolean"; required: boolean; options?: string[]; example?: string }[]
> = {
  Shoes: [
    { field: "brand", type: "string", required: true, example: "Gucci" },
    { field: "model", type: "string", required: true, example: "Ace Sneaker" },
    { field: "gender", type: "enum", required: true, options: ["Men", "Women", "Unisex", "Kids"] },
    { field: "size", type: "string", required: true, example: "US 10" },
    { field: "size_system", type: "enum", required: true, options: ["US", "EU", "UK"] },
    { field: "color", type: "string", required: true, example: "Black" },
    { field: "material", type: "string", required: false, example: "Leather" },
    { field: "style", type: "string", required: false, example: "Low-top sneaker" },
    { field: "country_of_origin", type: "string", required: false, example: "Italy" },
  ],
  Handbags: [
    { field: "brand", type: "string", required: true, example: "Saint Laurent" },
    { field: "model", type: "string", required: true, example: "Loulou Small" },
    { field: "color", type: "string", required: true, example: "Noir" },
    { field: "material", type: "string", required: true, example: "Calfskin leather" },
    { field: "style", type: "enum", required: false, options: ["Shoulder", "Tote", "Crossbody", "Clutch", "Backpack", "Top-handle"] },
    { field: "hardware", type: "enum", required: false, options: ["Gold", "Silver", "Gunmetal", "Mixed"] },
    { field: "interior_material", type: "string", required: false },
    { field: "dimensions", type: "string", required: false, example: "9.4 x 6.7 x 3.5 in" },
    { field: "country_of_origin", type: "string", required: false, example: "Italy" },
  ],
  Clothing: [
    { field: "brand", type: "string", required: true, example: "Burberry" },
    { field: "model", type: "string", required: false, example: "Vintage Check Shirt" },
    { field: "gender", type: "enum", required: true, options: ["Men", "Women", "Unisex", "Kids"] },
    { field: "size", type: "string", required: true, example: "M" },
    { field: "size_system", type: "enum", required: true, options: ["US", "EU", "UK", "IT", "FR"] },
    { field: "color", type: "string", required: true, example: "Beige" },
    { field: "material", type: "string", required: true, example: "Cotton" },
    { field: "category_type", type: "enum", required: false, options: ["Tops", "Bottoms", "Outerwear", "Dresses", "Suits", "Activewear"] },
    { field: "country_of_origin", type: "string", required: false },
  ],
};
