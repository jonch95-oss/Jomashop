import {
  stores,
  credentialStatus,
  skuMappings,
  categoryMappings,
  syncJobs,
  syncLogs,
  importedOrders,
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
  SyncJob,
  InsertSyncJob,
  SyncLog,
  InsertSyncLog,
  ImportedOrder,
  InsertImportedOrder,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

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
    token_storage TEXT NOT NULL DEFAULT 'env'
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
`);

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

  // Sync jobs/logs
  createSyncJob(input: InsertSyncJob): SyncJob;
  updateSyncJob(id: number, patch: Partial<SyncJob>): SyncJob | undefined;
  listSyncJobs(limit?: number): SyncJob[];
  appendLog(input: InsertSyncLog): SyncLog;
  listLogs(limit?: number): SyncLog[];

  // Orders
  upsertImportedOrder(input: InsertImportedOrder): ImportedOrder;
  listImportedOrders(): ImportedOrder[];
}

export class DatabaseStorage implements IStorage {
  getStore(shopDomain: string): Store | undefined {
    return db.select().from(stores).where(eq(stores.shopDomain, shopDomain)).get();
  }
  upsertStore(input: InsertStore): Store {
    const existing = this.getStore(input.shopDomain);
    if (existing) {
      return db
        .update(stores)
        .set({ ...input })
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
}

export const storage = new DatabaseStorage();
