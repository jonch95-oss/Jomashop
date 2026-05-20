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
export const insertSyncJobSchema = createInsertSchema(syncJobs).omit({ id: true });
export const insertSyncLogSchema = createInsertSchema(syncLogs).omit({ id: true });
export const insertImportedOrderSchema = createInsertSchema(importedOrders).omit({ id: true });

// ---------- Types ----------
export type Store = typeof stores.$inferSelect;
export type InsertStore = z.infer<typeof insertStoreSchema>;
export type CredentialStatus = typeof credentialStatus.$inferSelect;
export type InsertCredentialStatus = z.infer<typeof insertCredentialStatusSchema>;
export type SkuMapping = typeof skuMappings.$inferSelect;
export type InsertSkuMapping = z.infer<typeof insertSkuMappingSchema>;
export type CategoryMapping = typeof categoryMappings.$inferSelect;
export type InsertCategoryMapping = z.infer<typeof insertCategoryMappingSchema>;
export type SyncJob = typeof syncJobs.$inferSelect;
export type InsertSyncJob = z.infer<typeof insertSyncJobSchema>;
export type SyncLog = typeof syncLogs.$inferSelect;
export type InsertSyncLog = z.infer<typeof insertSyncLogSchema>;
export type ImportedOrder = typeof importedOrders.$inferSelect;
export type InsertImportedOrder = z.infer<typeof insertImportedOrderSchema>;

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
