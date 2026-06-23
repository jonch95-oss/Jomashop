import {
  stores,
  credentialStatus,
  skuMappings,
  categoryMappings,
  categoryOverrides,
  brandOverrides,
  enumOverrides,
  syncJobs,
  syncLogs,
  importedOrders,
  pushStatuses,
  productCache,
  webhookEvents,
  portalStyles,
} from "@shared/schema";
import type {
  Store,
  InsertStore,
  CredentialStatus,
  InsertCredentialStatus,
  SkuMapping,
  InsertSkuMapping,
  CategoryMapping,
  InsertCategoryMapping,
  CategoryOverride,
  InsertCategoryOverride,
  BrandOverride,
  InsertBrandOverride,
  EnumOverride,
  InsertEnumOverride,
  SyncJob,
  InsertSyncJob,
  SyncLog,
  InsertSyncLog,
  ImportedOrder,
  InsertImportedOrder,
  PushStatus,
  InsertPushStatus,
  ProductCache,
  InsertProductCache,
  WebhookEvent,
  InsertWebhookEvent,
  PortalStyle,
  InsertPortalStyle,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs";

// Allow Render (or any other host with a persistent disk mount) to point
// the sqlite file at a writable volume via DATA_DB_PATH. Falls back to a
// relative "data.db" in the working directory, which is fine for local dev
// but is wiped on every Render redeploy unless DATA_DB_PATH points at a
// disk mount. Critically, if the file is unreadable/corrupt, do NOT crash
// the process — log loudly and back off to an in-memory database so the
// HTTP server still listens and the operator can fix the disk via the
// dashboard.
const DATA_DB_PATH = (process.env.DATA_DB_PATH || "data.db").trim() || "data.db";
try {
  const dir = path.dirname(DATA_DB_PATH);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("[storage] failed to ensure data.db directory:", (err as Error)?.message);
}

function openDatabase(): Database.Database {
  try {
    const db = new Database(DATA_DB_PATH);
    db.pragma("journal_mode = WAL");
    return db;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[storage] failed to open ${DATA_DB_PATH} (${(err as Error)?.message}). ` +
        `Falling back to in-memory sqlite so the server can still listen on PORT. ` +
        `Set DATA_DB_PATH to a writable location to persist state.`,
    );
    const mem = new Database(":memory:");
    try {
      mem.pragma("journal_mode = MEMORY");
    } catch {
      // ignore
    }
    return mem;
  }
}

const sqlite = openDatabase();

export const db = drizzle(sqlite);

// Auto-create tables (lightweight, dev-friendly; for production use drizzle-kit push)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT 'LuxeSupply',
    oauth_status TEXT NOT NULL DEFAULT 'pending',
    scopes TEXT,
    installed_at INTEGER,
    token_storage TEXT NOT NULL DEFAULT 'env',
    access_token_enc TEXT
  );
  CREATE TABLE IF NOT EXISTS credential_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    configured INTEGER NOT NULL DEFAULT 0,
    last_checked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sku_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_variant_id TEXT NOT NULL,
    shopify_product_id TEXT NOT NULL,
    shopify_sku TEXT NOT NULL,
    jomashop_sku TEXT,
    jomashop_product_id TEXT,
    category_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    last_error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS category_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_product_type TEXT NOT NULL UNIQUE,
    jomashop_category TEXT NOT NULL,
    field_map_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS category_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_category_code TEXT NOT NULL UNIQUE,
    jomashop_category TEXT NOT NULL,
    notes TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS brand_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_brand TEXT NOT NULL UNIQUE,
    jomashop_brand TEXT NOT NULL,
    notes TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS enum_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jomashop_category TEXT NOT NULL,
    jomashop_field TEXT NOT NULL,
    source_value TEXT NOT NULL,
    jomashop_option TEXT NOT NULL,
    notes TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    operator_verified INTEGER NOT NULL DEFAULT 0,
    accepted_options_json TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (jomashop_category, jomashop_field, source_value)
  );
  CREATE INDEX IF NOT EXISTS enum_overrides_lookup_idx
    ON enum_overrides (jomashop_category, jomashop_field);
  CREATE TABLE IF NOT EXISTS sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    total_items INTEGER NOT NULL DEFAULT 0,
    success_items INTEGER NOT NULL DEFAULT 0,
    error_items INTEGER NOT NULL DEFAULT 0,
    summary TEXT
  );
  CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    details_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS imported_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_order_number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    shopify_order_id TEXT,
    imported_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT NOT NULL,
    shopify_product_id TEXT NOT NULL,
    shopify_variant_id TEXT,
    shopify_sku TEXT NOT NULL,
    jomashop_sku TEXT,
    state TEXT NOT NULL DEFAULT 'pushed',
    last_status INTEGER,
    last_error TEXT,
    last_payload_json TEXT,
    last_invalid_params TEXT,
    last_rejected_category TEXT,
    last_rejected_brand TEXT,
    last_pushed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (shop_domain, shopify_sku)
  );
  CREATE INDEX IF NOT EXISTS push_statuses_sku_idx ON push_statuses (shopify_sku);
  CREATE TABLE IF NOT EXISTS product_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_domain TEXT NOT NULL UNIQUE,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    has_more INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    shop_domain TEXT,
    body_hash TEXT,
    hmac_verified INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    message TEXT,
    details_json TEXT,
    received_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portal_styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_sku TEXT NOT NULL UNIQUE,
    jomashop_sku TEXT,
    name TEXT,
    brand TEXT,
    category TEXT,
    status TEXT,
    joma_status TEXT,
    qty INTEGER,
    price INTEGER,
    msrp INTEGER,
    date_created TEXT,
    date_updated TEXT,
    source TEXT NOT NULL DEFAULT 'portal-import',
    imported_at INTEGER NOT NULL,
    raw_json TEXT,
    match_status TEXT,
    match_confidence TEXT,
    matched_shopify_product_id TEXT,
    matched_shopify_variant_id TEXT,
    matched_shopify_sku TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS portal_styles_jomashop_sku_idx ON portal_styles (jomashop_sku);
`);

// Lightweight migration: add access_token_enc to stores if it's missing
// (table may exist from a pre-token-storage build).
try {
  const cols = sqlite.prepare("PRAGMA table_info(stores)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "access_token_enc")) {
    sqlite.exec("ALTER TABLE stores ADD COLUMN access_token_enc TEXT");
  }
} catch {
  // ignore — fresh installs already have the column via CREATE TABLE above
}

// Lightweight migration: add rejection-detail columns to push_statuses for
// pre-existing tables. New installs already have these via CREATE TABLE above.
try {
  const cols = sqlite.prepare("PRAGMA table_info(push_statuses)").all() as Array<{ name: string }>;
  const existing = new Set(cols.map((c) => c.name));
  if (!existing.has("last_invalid_params")) {
    sqlite.exec("ALTER TABLE push_statuses ADD COLUMN last_invalid_params TEXT");
  }
  if (!existing.has("last_rejected_category")) {
    sqlite.exec("ALTER TABLE push_statuses ADD COLUMN last_rejected_category TEXT");
  }
  if (!existing.has("last_rejected_brand")) {
    sqlite.exec("ALTER TABLE push_statuses ADD COLUMN last_rejected_brand TEXT");
  }
} catch {
  // ignore
}

// Lightweight migration: add verification columns to enum_overrides for
// pre-existing tables. Older rows default verified=0 so the strict trust gate
// in lookupEnumOverride treats them as unverified until the operator re-saves
// them via /api/enum-mapping/overrides (which runs the live-options check).
try {
  const cols = sqlite.prepare("PRAGMA table_info(enum_overrides)").all() as Array<{ name: string }>;
  const existing = new Set(cols.map((c) => c.name));
  if (!existing.has("verified")) {
    sqlite.exec("ALTER TABLE enum_overrides ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!existing.has("operator_verified")) {
    sqlite.exec("ALTER TABLE enum_overrides ADD COLUMN operator_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!existing.has("accepted_options_json")) {
    sqlite.exec("ALTER TABLE enum_overrides ADD COLUMN accepted_options_json TEXT");
  }
} catch {
  // ignore
}

export interface IStorage {
  // Stores
  getStore(shopDomain: string): Store | undefined;
  upsertStore(input: InsertStore): Store;
  listStores(): Store[];

  // Credentials status (no raw secrets stored here)
  upsertCredentialStatus(input: InsertCredentialStatus): CredentialStatus;
  listCredentialStatuses(): CredentialStatus[];

  // SKU mappings
  listSkuMappings(): SkuMapping[];
  upsertSkuMapping(input: InsertSkuMapping): SkuMapping;

  // Category mappings
  listCategoryMappings(): CategoryMapping[];
  upsertCategoryMapping(input: InsertCategoryMapping): CategoryMapping;

  // Category overrides (Shopify code → Jomashop category, Excel-driven)
  listCategoryOverrides(): CategoryOverride[];
  getCategoryOverride(shopifyCategoryCode: string): CategoryOverride | undefined;
  upsertCategoryOverride(input: InsertCategoryOverride): CategoryOverride;
  deleteCategoryOverride(shopifyCategoryCode: string): void;

  // Brand overrides (Shopify brand → exact Jomashop brand)
  listBrandOverrides(): BrandOverride[];
  getBrandOverride(shopifyBrand: string): BrandOverride | undefined;
  upsertBrandOverride(input: InsertBrandOverride): BrandOverride;
  deleteBrandOverride(shopifyBrand: string): void;

  // Enum overrides (source value → exact Jomashop option per category+field)
  listEnumOverrides(): EnumOverride[];
  getEnumOverride(
    jomashopCategory: string,
    jomashopField: string,
    sourceValue: string,
  ): EnumOverride | undefined;
  upsertEnumOverride(input: InsertEnumOverride): EnumOverride;
  deleteEnumOverride(
    jomashopCategory: string,
    jomashopField: string,
    sourceValue: string,
  ): void;

  // Sync jobs/logs
  createSyncJob(input: InsertSyncJob): SyncJob;
  updateSyncJob(id: number, patch: Partial<SyncJob>): SyncJob | undefined;
  listSyncJobs(limit?: number): SyncJob[];
  appendLog(input: InsertSyncLog): SyncLog;
  listLogs(limit?: number): SyncLog[];

  // Orders
  upsertImportedOrder(input: InsertImportedOrder): ImportedOrder;
  listImportedOrders(): ImportedOrder[];

  // Push status tracking
  listPushStatuses(shopDomain?: string): PushStatus[];
  getPushStatusBySku(shopDomain: string, shopifySku: string): PushStatus | undefined;
  upsertPushStatus(input: InsertPushStatus): PushStatus;

  // Product cache
  getProductCache(shopDomain: string): ProductCache | undefined;
  upsertProductCache(input: InsertProductCache): ProductCache;
  clearProductCache(shopDomain: string): void;

  // Webhook events
  appendWebhookEvent(input: InsertWebhookEvent): WebhookEvent;
  listWebhookEvents(limit?: number): WebhookEvent[];

  // Portal styles (Jomashop Vendor Portal reconciliation)
  listPortalStyles(): PortalStyle[];
  getPortalStyleBySku(vendorSku: string): PortalStyle | undefined;
  upsertPortalStyle(input: InsertPortalStyle): PortalStyle;
  clearPortalStyles(): number;
}

export class DatabaseStorage implements IStorage {
  getStore(shopDomain: string): Store | undefined {
    return db.select().from(stores).where(eq(stores.shopDomain, shopDomain)).get();
  }
  upsertStore(input: InsertStore): Store {
    const existing = this.getStore(input.shopDomain);
    if (existing) {
      // Preserve any persisted column (notably accessTokenEnc) when the
      // caller did not supply a new value. Treat undefined as "leave alone".
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) patch[k] = v;
      }
      return db
        .update(stores)
        .set(patch)
        .where(eq(stores.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(stores).values(input).returning().get();
  }
  listStores(): Store[] {
    return db.select().from(stores).all();
  }

  upsertCredentialStatus(input: InsertCredentialStatus): CredentialStatus {
    const existing = db
      .select()
      .from(credentialStatus)
      .where(eq(credentialStatus.key, input.key))
      .get();
    if (existing) {
      return db
        .update(credentialStatus)
        .set({ ...input })
        .where(eq(credentialStatus.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(credentialStatus).values(input).returning().get();
  }
  listCredentialStatuses(): CredentialStatus[] {
    return db.select().from(credentialStatus).all();
  }

  listSkuMappings(): SkuMapping[] {
    return db.select().from(skuMappings).orderBy(desc(skuMappings.updatedAt)).all();
  }
  upsertSkuMapping(input: InsertSkuMapping): SkuMapping {
    const existing = db
      .select()
      .from(skuMappings)
      .where(eq(skuMappings.shopifyVariantId, input.shopifyVariantId))
      .get();
    if (existing) {
      return db
        .update(skuMappings)
        .set({ ...input })
        .where(eq(skuMappings.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(skuMappings).values(input).returning().get();
  }

  listCategoryMappings(): CategoryMapping[] {
    return db.select().from(categoryMappings).all();
  }
  upsertCategoryMapping(input: InsertCategoryMapping): CategoryMapping {
    const existing = db
      .select()
      .from(categoryMappings)
      .where(eq(categoryMappings.shopifyProductType, input.shopifyProductType))
      .get();
    if (existing) {
      return db
        .update(categoryMappings)
        .set({ ...input })
        .where(eq(categoryMappings.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(categoryMappings).values(input).returning().get();
  }

  listCategoryOverrides(): CategoryOverride[] {
    return db.select().from(categoryOverrides).all();
  }
  getCategoryOverride(shopifyCategoryCode: string): CategoryOverride | undefined {
    return db
      .select()
      .from(categoryOverrides)
      .where(eq(categoryOverrides.shopifyCategoryCode, shopifyCategoryCode))
      .get();
  }
  upsertCategoryOverride(input: InsertCategoryOverride): CategoryOverride {
    const existing = this.getCategoryOverride(input.shopifyCategoryCode);
    if (existing) {
      return db
        .update(categoryOverrides)
        .set({ ...input })
        .where(eq(categoryOverrides.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(categoryOverrides).values(input).returning().get();
  }
  deleteCategoryOverride(shopifyCategoryCode: string): void {
    db.delete(categoryOverrides)
      .where(eq(categoryOverrides.shopifyCategoryCode, shopifyCategoryCode))
      .run();
  }

  listBrandOverrides(): BrandOverride[] {
    return db.select().from(brandOverrides).all();
  }
  getBrandOverride(shopifyBrand: string): BrandOverride | undefined {
    return db
      .select()
      .from(brandOverrides)
      .where(eq(brandOverrides.shopifyBrand, shopifyBrand))
      .get();
  }
  upsertBrandOverride(input: InsertBrandOverride): BrandOverride {
    const existing = this.getBrandOverride(input.shopifyBrand);
    if (existing) {
      return db
        .update(brandOverrides)
        .set({ ...input })
        .where(eq(brandOverrides.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(brandOverrides).values(input).returning().get();
  }
  deleteBrandOverride(shopifyBrand: string): void {
    db.delete(brandOverrides).where(eq(brandOverrides.shopifyBrand, shopifyBrand)).run();
  }

  listEnumOverrides(): EnumOverride[] {
    return db.select().from(enumOverrides).all();
  }
  getEnumOverride(
    jomashopCategory: string,
    jomashopField: string,
    sourceValue: string,
  ): EnumOverride | undefined {
    return db
      .select()
      .from(enumOverrides)
      .where(
        and(
          eq(enumOverrides.jomashopCategory, jomashopCategory),
          eq(enumOverrides.jomashopField, jomashopField),
          eq(enumOverrides.sourceValue, sourceValue),
        ),
      )
      .get();
  }
  upsertEnumOverride(input: InsertEnumOverride): EnumOverride {
    const existing = this.getEnumOverride(
      input.jomashopCategory,
      input.jomashopField,
      input.sourceValue,
    );
    if (existing) {
      return db
        .update(enumOverrides)
        .set({ ...input })
        .where(eq(enumOverrides.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(enumOverrides).values(input).returning().get();
  }
  deleteEnumOverride(
    jomashopCategory: string,
    jomashopField: string,
    sourceValue: string,
  ): void {
    db.delete(enumOverrides)
      .where(
        and(
          eq(enumOverrides.jomashopCategory, jomashopCategory),
          eq(enumOverrides.jomashopField, jomashopField),
          eq(enumOverrides.sourceValue, sourceValue),
        ),
      )
      .run();
  }

  createSyncJob(input: InsertSyncJob): SyncJob {
    return db.insert(syncJobs).values(input).returning().get();
  }
  updateSyncJob(id: number, patch: Partial<SyncJob>): SyncJob | undefined {
    return db.update(syncJobs).set(patch).where(eq(syncJobs.id, id)).returning().get();
  }
  listSyncJobs(limit = 25): SyncJob[] {
    return db.select().from(syncJobs).orderBy(desc(syncJobs.startedAt)).limit(limit).all();
  }
  appendLog(input: InsertSyncLog): SyncLog {
    return db.insert(syncLogs).values(input).returning().get();
  }
  listLogs(limit = 100): SyncLog[] {
    return db.select().from(syncLogs).orderBy(desc(syncLogs.createdAt)).limit(limit).all();
  }

  upsertImportedOrder(input: InsertImportedOrder): ImportedOrder {
    const existing = db
      .select()
      .from(importedOrders)
      .where(eq(importedOrders.salesOrderNumber, input.salesOrderNumber))
      .get();
    if (existing) {
      return db
        .update(importedOrders)
        .set({ ...input })
        .where(eq(importedOrders.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(importedOrders).values(input).returning().get();
  }
  listImportedOrders(): ImportedOrder[] {
    return db.select().from(importedOrders).orderBy(desc(importedOrders.updatedAt)).all();
  }

  listPushStatuses(shopDomain?: string): PushStatus[] {
    const q = db.select().from(pushStatuses).orderBy(desc(pushStatuses.updatedAt));
    if (shopDomain) {
      return db
        .select()
        .from(pushStatuses)
        .where(eq(pushStatuses.shopDomain, shopDomain))
        .orderBy(desc(pushStatuses.updatedAt))
        .all();
    }
    return q.all();
  }
  getPushStatusBySku(shopDomain: string, shopifySku: string): PushStatus | undefined {
    return db
      .select()
      .from(pushStatuses)
      .where(and(eq(pushStatuses.shopDomain, shopDomain), eq(pushStatuses.shopifySku, shopifySku)))
      .get();
  }
  upsertPushStatus(input: InsertPushStatus): PushStatus {
    const existing = this.getPushStatusBySku(input.shopDomain, input.shopifySku);
    if (existing) {
      return db
        .update(pushStatuses)
        .set({ ...input })
        .where(eq(pushStatuses.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(pushStatuses).values(input).returning().get();
  }

  getProductCache(shopDomain: string): ProductCache | undefined {
    return db.select().from(productCache).where(eq(productCache.shopDomain, shopDomain)).get();
  }
  upsertProductCache(input: InsertProductCache): ProductCache {
    const existing = this.getProductCache(input.shopDomain);
    if (existing) {
      return db
        .update(productCache)
        .set({ ...input })
        .where(eq(productCache.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(productCache).values(input).returning().get();
  }
  clearProductCache(shopDomain: string): void {
    db.delete(productCache).where(eq(productCache.shopDomain, shopDomain)).run();
  }

  appendWebhookEvent(input: InsertWebhookEvent): WebhookEvent {
    return db.insert(webhookEvents).values(input).returning().get();
  }
  listWebhookEvents(limit = 50): WebhookEvent[] {
    return db
      .select()
      .from(webhookEvents)
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(limit)
      .all();
  }

  listPortalStyles(): PortalStyle[] {
    return db.select().from(portalStyles).orderBy(desc(portalStyles.updatedAt)).all();
  }
  getPortalStyleBySku(vendorSku: string): PortalStyle | undefined {
    return db.select().from(portalStyles).where(eq(portalStyles.vendorSku, vendorSku)).get();
  }
  upsertPortalStyle(input: InsertPortalStyle): PortalStyle {
    const existing = this.getPortalStyleBySku(input.vendorSku);
    if (existing) {
      return db
        .update(portalStyles)
        .set({ ...input })
        .where(eq(portalStyles.id, existing.id))
        .returning()
        .get();
    }
    return db.insert(portalStyles).values(input).returning().get();
  }
  clearPortalStyles(): number {
    const before = db.select().from(portalStyles).all().length;
    db.delete(portalStyles).run();
    return before;
  }
}

export const storage = new DatabaseStorage();
