// Farfetch-style automatic sync foundation.
//
// Two scheduled jobs, BOTH default-off and dry-run-first:
//
//   1. Inventory sync (Shopify → Jomashop): pushes quantity/status for
//      styles the Portal Styles reconciliation confirms are live/active on
//      Jomashop. Anything unmatched, inactive, never-pushed, or moving by
//      more than MAX_INVENTORY_DELTA units is skipped and flagged.
//
//   2. Order pull (Jomashop → preview): fetches "new" Jomashop orders and
//      matches each line to a Shopify variant via SKU / Jomashop SKU /
//      portal reconciliation. The scheduled pull NEVER creates Shopify
//      orders — live import stays behind the existing explicit
//      POST /api/jomashop/orders/import-to-shopify { confirm: true } flow.
//
// Safety model (all defaults are the safe ones):
//   AUTO_SYNC_ENABLED=false   → scheduler does not start at all.
//   AUTO_SYNC_DRY_RUN=true    → even when enabled, runs only PLAN and log.
//   Manual "now" endpoints    → dry-run unless the env explicitly disables
//                               dry-run AND the caller passes dryRun:false.
//   MAX_INVENTORY_DELTA       → per-SKU change cap; larger swings are
//                               skipped and flagged for human review.
//
// Every run (dry or live) is recorded as a sync_jobs row + sync_logs entry,
// and the full item-level audit for the most recent runs is kept in memory
// for the Automation UI.

import type { Express } from "express";
import { storage } from "./storage";
import { reconcileAll, isInventoryPushEligible, normMatchKey } from "./portal_reconcile";
import { pushInventoryUpdate } from "./webhooks";
import { jomashopConfigured, jomashopRequest } from "./jomashop";
import { getActiveShopifyConnection } from "./shopify";
import { logMemory } from "./memlog";

// -------------------- config --------------------

export type AutoSyncConfig = {
  enabled: boolean;
  dryRun: boolean;
  inventoryIntervalMinutes: number;
  orderIntervalMinutes: number;
  maxInventoryDelta: number;
  /** Live Shopify order creation stays behind the explicit import endpoint;
   *  this flag only surfaces intent in the status payload. */
  orderImportEnabled: boolean;
};

function envBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function envInt(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function getAutoSyncConfig(): AutoSyncConfig {
  return {
    enabled: envBool(process.env.AUTO_SYNC_ENABLED, false),
    dryRun: envBool(process.env.AUTO_SYNC_DRY_RUN, true),
    inventoryIntervalMinutes: envInt(process.env.INVENTORY_SYNC_INTERVAL_MINUTES, 30, 5, 1440),
    orderIntervalMinutes: envInt(process.env.ORDER_PULL_INTERVAL_MINUTES, 15, 5, 1440),
    maxInventoryDelta: envInt(process.env.MAX_INVENTORY_DELTA, 25, 1, 1000000),
    orderImportEnabled: envBool(process.env.ORDER_IMPORT_ENABLED, false),
  };
}

// -------------------- shared helpers --------------------

/** Read cached Shopify variant quantities (vendor SKU → quantity). */
function readCachedVariantQuantities(): {
  bySku: Map<string, { quantity: number; sku: string }>;
  fetchedAt: number | null;
} {
  const bySku = new Map<string, { quantity: number; sku: string }>();
  let fetchedAt: number | null = null;
  for (const store of storage.listStores()) {
    const cache = storage.getProductCache(store.shopDomain);
    if (!cache) continue;
    fetchedAt = Math.max(fetchedAt ?? 0, cache.fetchedAt);
    let payload: any;
    try {
      payload = JSON.parse(cache.payloadJson);
    } catch {
      continue;
    }
    if (!Array.isArray(payload?.mapped)) continue;
    for (const m of payload.mapped) {
      for (const v of m?.variants ?? []) {
        const sku = typeof v?.vendor_sku === "string" ? v.vendor_sku : "";
        const key = normMatchKey(sku);
        if (!key || bySku.has(key)) continue;
        const qty = typeof v?.quantity === "number" && Number.isFinite(v.quantity) ? v.quantity : 0;
        bySku.set(key, { quantity: qty, sku });
      }
    }
  }
  return { bySku, fetchedAt };
}

// -------------------- inventory sync --------------------

export type InventoryPlanItem = {
  vendor_sku: string;
  jomashop_sku: string | null;
  matched_shopify_sku: string | null;
  match_status: string | null;
  shopify_qty: number | null;
  portal_qty: number | null;
  delta: number | null;
  action: "update" | "skip";
  reason: string | null;
  flagged: boolean;
};

export type InventorySyncResult = {
  ok: boolean;
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  jobId: number | null;
  cacheFetchedAt: number | null;
  counts: {
    total: number;
    planned: number;
    applied: number;
    rejected: number;
    skipped: number;
    flagged: number;
  };
  items: InventoryPlanItem[];
  errors: string[];
  note: string;
};

/** Cap of item-level audit rows kept per run (memory bound for the UI). */
const AUDIT_ITEM_CAP = 1000;
/** Cap of live PUTs per run so one pass can't hammer Jomashop for an hour. */
const MAX_LIVE_UPDATES_PER_RUN = 250;

export function buildInventorySyncPlan(maxDelta: number): {
  items: InventoryPlanItem[];
  cacheFetchedAt: number | null;
} {
  const { styles } = reconcileAll();
  const { bySku, fetchedAt } = readCachedVariantQuantities();
  const pushBySku = new Map(storage.listPushStatuses().map((p) => [normMatchKey(p.shopifySku), p]));

  const items: InventoryPlanItem[] = [];
  for (const s of styles) {
    const item: InventoryPlanItem = {
      vendor_sku: s.vendor_sku,
      jomashop_sku: s.jomashop_sku,
      matched_shopify_sku: s.matched_shopify_sku,
      match_status: s.match_status,
      shopify_qty: null,
      portal_qty: s.qty,
      delta: null,
      action: "skip",
      reason: null,
      flagged: false,
    };
    if (!isInventoryPushEligible(s.match_status)) {
      item.reason = `Not eligible: portal status is "${s.match_status}" (needs Confirmed Live or Active in Portal)`;
      items.push(item);
      continue;
    }
    const skuKey = normMatchKey(s.matched_shopify_sku || s.vendor_sku);
    const cached = skuKey ? bySku.get(skuKey) : undefined;
    if (!cached) {
      item.reason = "No cached Shopify quantity for this SKU — run Refresh from Shopify first";
      item.flagged = true;
      items.push(item);
      continue;
    }
    item.shopify_qty = cached.quantity;
    item.delta = s.qty === null || s.qty === undefined ? null : cached.quantity - s.qty;
    if (item.delta === 0) {
      item.reason = "Already in sync (Shopify qty == portal qty)";
      items.push(item);
      continue;
    }
    if (item.delta !== null && Math.abs(item.delta) > maxDelta) {
      item.reason = `Delta ${item.delta} exceeds MAX_INVENTORY_DELTA=${maxDelta} — flagged for manual review`;
      item.flagged = true;
      items.push(item);
      continue;
    }
    const push = pushBySku.get(normMatchKey(s.matched_shopify_sku || s.vendor_sku));
    if (!push) {
      item.reason = "No push-status row (product was never pushed from this app) — cannot address it on Jomashop";
      item.flagged = true;
      items.push(item);
      continue;
    }
    item.action = "update";
    items.push(item);
  }
  return { items, cacheFetchedAt: fetchedAt };
}

let inventoryRunning = false;
let lastInventoryRun: InventorySyncResult | null = null;

export async function runInventorySync(opts: {
  dryRun: boolean;
  source: "manual" | "scheduler";
}): Promise<InventorySyncResult> {
  const cfg = getAutoSyncConfig();
  // Belt and braces: even if a caller passes dryRun:false, live mode also
  // requires the env to have explicitly disabled dry-run.
  const dryRun = opts.dryRun || cfg.dryRun;
  const startedAt = Date.now();

  if (inventoryRunning) {
    return {
      ok: false,
      dryRun,
      startedAt,
      finishedAt: Date.now(),
      jobId: null,
      cacheFetchedAt: null,
      counts: { total: 0, planned: 0, applied: 0, rejected: 0, skipped: 0, flagged: 0 },
      items: [],
      errors: ["An inventory sync is already running."],
      note: "Skipped — previous run still in progress.",
    };
  }
  inventoryRunning = true;
  const job = storage.createSyncJob({
    jobType: "auto_inventory_sync",
    status: "running",
    startedAt,
    finishedAt: null,
    totalItems: 0,
    successItems: 0,
    errorItems: 0,
    summary: `${dryRun ? "DRY-RUN" : "LIVE"} inventory sync (${opts.source})`,
  });
  const errors: string[] = [];
  try {
    logMemory("autoSync.inventory.start", { dryRun, source: opts.source });
    const { items, cacheFetchedAt } = buildInventorySyncPlan(cfg.maxInventoryDelta);
    const planned = items.filter((i) => i.action === "update");
    let applied = 0;
    let rejected = 0;

    if (!dryRun) {
      const conn = getActiveShopifyConnection();
      if (!jomashopConfigured()) {
        errors.push("Jomashop credentials not configured — live sync aborted.");
      } else {
        const toApply = planned.slice(0, MAX_LIVE_UPDATES_PER_RUN);
        if (planned.length > toApply.length) {
          errors.push(
            `Capped at ${MAX_LIVE_UPDATES_PER_RUN} live updates this run; ${planned.length - toApply.length} remain for the next interval.`,
          );
        }
        for (const item of toApply) {
          const sku = item.matched_shopify_sku || item.vendor_sku;
          try {
            const r = await pushInventoryUpdate({
              shopifySku: sku,
              quantity: item.shopify_qty,
              topic: "auto-sync",
              shopDomain: conn?.shopDomain ?? null,
            });
            if (r.status === "applied") {
              applied += 1;
            } else if (r.status === "rejected") {
              rejected += 1;
              item.flagged = true;
              item.reason = `Live update rejected: ${r.message}`;
            } else {
              item.reason = `Live update skipped: ${r.message}`;
            }
          } catch (err) {
            rejected += 1;
            item.flagged = true;
            item.reason = `Live update error: ${(err as Error).message}`;
          }
        }
      }
    }

    const counts = {
      total: items.length,
      planned: planned.length,
      applied,
      rejected,
      skipped: items.filter((i) => i.action === "skip").length,
      flagged: items.filter((i) => i.flagged).length,
    };
    const finishedAt = Date.now();
    const summary = dryRun
      ? `DRY-RUN inventory sync: ${counts.planned} would update / ${counts.skipped} skipped / ${counts.flagged} flagged (of ${counts.total})`
      : `LIVE inventory sync: ${applied} applied / ${rejected} rejected / ${counts.skipped} skipped / ${counts.flagged} flagged (of ${counts.total})`;
    storage.updateSyncJob(job.id, {
      status: errors.length > 0 || rejected > 0 ? "failed" : "success",
      finishedAt,
      totalItems: counts.total,
      successItems: dryRun ? counts.planned : applied,
      errorItems: rejected + errors.length,
      summary,
    });
    storage.appendLog({
      jobId: job.id,
      level: errors.length > 0 || rejected > 0 ? "warn" : "info",
      message: summary,
      detailsJson: JSON.stringify({
        dryRun,
        source: opts.source,
        counts,
        errors,
        cacheFetchedAt,
        sampleFlagged: items.filter((i) => i.flagged).slice(0, 25),
      }),
      createdAt: finishedAt,
    });
    const result: InventorySyncResult = {
      ok: errors.length === 0,
      dryRun,
      startedAt,
      finishedAt,
      jobId: job.id,
      cacheFetchedAt,
      counts,
      items: items.slice(0, AUDIT_ITEM_CAP),
      errors,
      note: dryRun
        ? "Dry run — no Jomashop writes were performed."
        : "Live run — Jomashop inventory statuses were updated for applied items.",
    };
    lastInventoryRun = result;
    logMemory("autoSync.inventory.done", { dryRun, ...counts });
    return result;
  } catch (err) {
    const finishedAt = Date.now();
    const message = (err as Error).message || "Inventory sync failed";
    storage.updateSyncJob(job.id, {
      status: "failed",
      finishedAt,
      errorItems: 1,
      summary: `Inventory sync error: ${message}`,
    });
    const result: InventorySyncResult = {
      ok: false,
      dryRun,
      startedAt,
      finishedAt,
      jobId: job.id,
      cacheFetchedAt: null,
      counts: { total: 0, planned: 0, applied: 0, rejected: 0, skipped: 0, flagged: 0 },
      items: [],
      errors: [message],
      note: "Run aborted with an error.",
    };
    lastInventoryRun = result;
    return result;
  } finally {
    inventoryRunning = false;
  }
}

// -------------------- order pull --------------------

export type OrderPullLine = {
  sales_order_number: string;
  sku: string;
  quantity: number | null;
  matched: boolean;
  match_source: "portal-live" | "shopify-catalog" | "none";
  match_status: string | null;
  matched_shopify_sku: string | null;
  matched_shopify_variant_id: string | null;
};

export type OrderPullResult = {
  ok: boolean;
  dryRun: true;
  startedAt: number;
  finishedAt: number;
  jobId: number | null;
  counts: {
    orders: number;
    lines: number;
    matched: number;
    portal_confirmed: number;
    unmatched: number;
    already_imported: number;
  };
  orders: Array<{
    sales_order_number: string;
    status: string | null;
    already_imported: boolean;
    lines: OrderPullLine[];
  }>;
  unmatchedLines: OrderPullLine[];
  errors: string[];
  note: string;
};

type RawOrder = Record<string, any>;

function extractOrders(data: unknown): RawOrder[] {
  if (Array.isArray(data)) return data.filter((o) => o && typeof o === "object");
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["data", "orders", "items", "results"]) {
      if (Array.isArray(obj[key])) {
        return (obj[key] as unknown[]).filter((o): o is RawOrder => Boolean(o && typeof o === "object"));
      }
    }
  }
  return [];
}

function extractOrderLines(order: RawOrder): Array<{ sku: string; quantity: number | null }> {
  const out: Array<{ sku: string; quantity: number | null }> = [];
  const candidates = [order.line_items, order.items, order.lines, order.order_lines, order.products];
  for (const arr of candidates) {
    if (!Array.isArray(arr)) continue;
    for (const li of arr) {
      if (!li || typeof li !== "object") continue;
      const sku = String((li as any).sku ?? (li as any).vendor_sku ?? (li as any).item_sku ?? "").trim();
      if (!sku) continue;
      const qRaw = (li as any).quantity ?? (li as any).qty ?? null;
      const q = typeof qRaw === "number" ? qRaw : parseInt(String(qRaw ?? ""), 10);
      out.push({ sku, quantity: Number.isFinite(q) ? q : null });
    }
    if (out.length > 0) break;
  }
  return out;
}

let orderPullRunning = false;
let lastOrderPull: OrderPullResult | null = null;

/**
 * Pull "new" Jomashop orders and match every line against the catalog.
 * ALWAYS preview-only: this function never creates Shopify orders. Live
 * import remains behind POST /api/jomashop/orders/import-to-shopify with
 * an explicit { confirm: true } body.
 */
export async function runOrderPull(opts: {
  source: "manual" | "scheduler";
  status?: string;
  limit?: number;
}): Promise<OrderPullResult> {
  const startedAt = Date.now();
  const emptyCounts = {
    orders: 0,
    lines: 0,
    matched: 0,
    portal_confirmed: 0,
    unmatched: 0,
    already_imported: 0,
  };
  if (orderPullRunning) {
    return {
      ok: false,
      dryRun: true,
      startedAt,
      finishedAt: Date.now(),
      jobId: null,
      counts: emptyCounts,
      orders: [],
      unmatchedLines: [],
      errors: ["An order pull is already running."],
      note: "Skipped — previous run still in progress.",
    };
  }
  if (!jomashopConfigured()) {
    return {
      ok: false,
      dryRun: true,
      startedAt,
      finishedAt: Date.now(),
      jobId: null,
      counts: emptyCounts,
      orders: [],
      unmatchedLines: [],
      errors: ["Jomashop credentials not configured."],
      note: "Set JOMASHOP_EMAIL and JOMASHOP_PASSWORD to enable order pulls.",
    };
  }
  orderPullRunning = true;
  const status = (opts.status || "new").trim();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const job = storage.createSyncJob({
    jobType: "auto_order_pull",
    status: "running",
    startedAt,
    finishedAt: null,
    totalItems: 0,
    successItems: 0,
    errorItems: 0,
    summary: `DRY-RUN order pull (${opts.source}, status=${status})`,
  });
  const errors: string[] = [];
  try {
    const result = await jomashopRequest({
      path: "/v1/orders",
      query: { status, page: "1", per_page: String(limit) },
    });
    if (!result.ok) {
      throw new Error(`Jomashop orders fetch failed: ${result.error ?? result.status}`);
    }
    const rawOrders = extractOrders(result.data).slice(0, limit);

    // Build the match index from portal reconciliation + catalog.
    const { styles, index } = reconcileAll();
    const liveBySku = new Map<string, (typeof styles)[number]>();
    for (const s of styles) {
      if (s.match_status === "Confirmed Live" || s.match_status === "Active in Portal") {
        liveBySku.set(normMatchKey(s.vendor_sku), s);
        if (s.jomashop_sku) liveBySku.set(normMatchKey(s.jomashop_sku), s);
        if (s.matched_shopify_sku) liveBySku.set(normMatchKey(s.matched_shopify_sku), s);
      }
    }
    const importedBySo = new Map(storage.listImportedOrders().map((o) => [o.salesOrderNumber, o]));

    const orders: OrderPullResult["orders"] = [];
    const unmatchedLines: OrderPullLine[] = [];
    let lineCount = 0;
    let matched = 0;
    let portalConfirmed = 0;
    let alreadyImported = 0;

    for (const raw of rawOrders) {
      const so = String(raw.sales_order_number ?? raw.order_number ?? raw.id ?? "").trim();
      const existing = so ? importedBySo.get(so) : undefined;
      if (existing?.shopifyOrderId) alreadyImported += 1;
      const lines: OrderPullLine[] = [];
      for (const li of extractOrderLines(raw)) {
        lineCount += 1;
        const key = normMatchKey(li.sku);
        const live = key ? liveBySku.get(key) : undefined;
        const catalogHit =
          (key && index.bySku.get(key)) ||
          (key && index.byJomashopSku.get(key)) ||
          null;
        const line: OrderPullLine = {
          sales_order_number: so,
          sku: li.sku,
          quantity: li.quantity,
          matched: Boolean(live || catalogHit),
          match_source: live ? "portal-live" : catalogHit ? "shopify-catalog" : "none",
          match_status: live?.match_status ?? null,
          matched_shopify_sku: live?.matched_shopify_sku ?? catalogHit?.sku ?? null,
          matched_shopify_variant_id:
            live?.matched_shopify_variant_id ?? catalogHit?.shopifyVariantId ?? null,
        };
        if (line.matched) {
          matched += 1;
          if (line.match_source === "portal-live") portalConfirmed += 1;
        } else {
          unmatchedLines.push(line);
        }
        lines.push(line);
      }
      orders.push({
        sales_order_number: so,
        status: raw.status ? String(raw.status) : null,
        already_imported: Boolean(existing?.shopifyOrderId),
        lines,
      });
    }

    const counts = {
      orders: orders.length,
      lines: lineCount,
      matched,
      portal_confirmed: portalConfirmed,
      unmatched: unmatchedLines.length,
      already_imported: alreadyImported,
    };
    const finishedAt = Date.now();
    const summary = `DRY-RUN order pull: ${counts.orders} orders / ${counts.lines} lines — ${counts.matched} matched (${counts.portal_confirmed} portal-confirmed), ${counts.unmatched} UNMATCHED, ${counts.already_imported} already imported`;
    storage.updateSyncJob(job.id, {
      status: counts.unmatched > 0 ? "failed" : "success",
      finishedAt,
      totalItems: counts.lines,
      successItems: counts.matched,
      errorItems: counts.unmatched,
      summary,
    });
    storage.appendLog({
      jobId: job.id,
      level: counts.unmatched > 0 ? "warn" : "info",
      message: summary,
      detailsJson: JSON.stringify({
        source: opts.source,
        status,
        counts,
        unmatched: unmatchedLines.slice(0, 50),
      }),
      createdAt: finishedAt,
    });
    const out: OrderPullResult = {
      ok: true,
      dryRun: true,
      startedAt,
      finishedAt,
      jobId: job.id,
      counts,
      orders: orders.slice(0, 100),
      unmatchedLines: unmatchedLines.slice(0, 200),
      errors,
      note:
        "Preview only — no Shopify orders were created. Use Orders → Import (confirm required) to create matched orders.",
    };
    lastOrderPull = out;
    return out;
  } catch (err) {
    const finishedAt = Date.now();
    const message = (err as Error).message || "Order pull failed";
    storage.updateSyncJob(job.id, {
      status: "failed",
      finishedAt,
      errorItems: 1,
      summary: `Order pull error: ${message}`,
    });
    const out: OrderPullResult = {
      ok: false,
      dryRun: true,
      startedAt,
      finishedAt,
      jobId: job.id,
      counts: emptyCounts,
      orders: [],
      unmatchedLines: [],
      errors: [message],
      note: "Run aborted with an error.",
    };
    lastOrderPull = out;
    return out;
  } finally {
    orderPullRunning = false;
  }
}

// -------------------- scheduler --------------------

type SchedulerState = {
  running: boolean;
  startedAt: number | null;
  inventoryIntervalMinutes: number | null;
  orderIntervalMinutes: number | null;
  nextInventoryRunAt: number | null;
  nextOrderRunAt: number | null;
};

let inventoryTimer: NodeJS.Timeout | null = null;
let orderTimer: NodeJS.Timeout | null = null;
const schedulerState: SchedulerState = {
  running: false,
  startedAt: null,
  inventoryIntervalMinutes: null,
  orderIntervalMinutes: null,
  nextInventoryRunAt: null,
  nextOrderRunAt: null,
};

/**
 * Start the interval jobs. Called once at boot. No-op (and logged) unless
 * AUTO_SYNC_ENABLED=true. Timers are unref'd so they never keep the process
 * alive on shutdown.
 */
export function startAutoSyncScheduler(): void {
  const cfg = getAutoSyncConfig();
  if (!cfg.enabled) {
    console.log("[auto-sync] disabled (AUTO_SYNC_ENABLED != true) — scheduler not started");
    return;
  }
  const invMs = cfg.inventoryIntervalMinutes * 60 * 1000;
  const ordMs = cfg.orderIntervalMinutes * 60 * 1000;
  schedulerState.running = true;
  schedulerState.startedAt = Date.now();
  schedulerState.inventoryIntervalMinutes = cfg.inventoryIntervalMinutes;
  schedulerState.orderIntervalMinutes = cfg.orderIntervalMinutes;
  schedulerState.nextInventoryRunAt = Date.now() + invMs;
  schedulerState.nextOrderRunAt = Date.now() + ordMs;

  inventoryTimer = setInterval(() => {
    schedulerState.nextInventoryRunAt = Date.now() + invMs;
    // Re-read config each tick so flipping AUTO_SYNC_DRY_RUN takes effect on
    // restart-free platforms that support live env updates. dryRun:true here
    // is only a floor — runInventorySync ORs it with the env value anyway.
    const tickCfg = getAutoSyncConfig();
    runInventorySync({ dryRun: tickCfg.dryRun, source: "scheduler" }).catch((err) => {
      storage.appendLog({
        level: "error",
        message: `Scheduled inventory sync crashed: ${(err as Error).message}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
    });
  }, invMs);
  inventoryTimer.unref();

  orderTimer = setInterval(() => {
    schedulerState.nextOrderRunAt = Date.now() + ordMs;
    runOrderPull({ source: "scheduler" }).catch((err) => {
      storage.appendLog({
        level: "error",
        message: `Scheduled order pull crashed: ${(err as Error).message}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
    });
  }, ordMs);
  orderTimer.unref();

  console.log(
    `[auto-sync] scheduler started (dryRun=${cfg.dryRun}, inventory every ${cfg.inventoryIntervalMinutes}m, orders every ${cfg.orderIntervalMinutes}m)`,
  );
  storage.appendLog({
    level: "info",
    message: `Auto-sync scheduler started (dryRun=${cfg.dryRun}, inventory=${cfg.inventoryIntervalMinutes}m, orders=${cfg.orderIntervalMinutes}m)`,
    detailsJson: null,
    createdAt: Date.now(),
  });
}

export function stopAutoSyncScheduler(): void {
  if (inventoryTimer) clearInterval(inventoryTimer);
  if (orderTimer) clearInterval(orderTimer);
  inventoryTimer = null;
  orderTimer = null;
  schedulerState.running = false;
  schedulerState.nextInventoryRunAt = null;
  schedulerState.nextOrderRunAt = null;
}

// -------------------- routes --------------------

export function registerAutoSyncRoutes(app: Express): void {
  // Status: config (no secrets), scheduler state, last runs, recent jobs.
  app.get("/api/automation/status", (_req, res) => {
    const cfg = getAutoSyncConfig();
    const jobs = storage
      .listSyncJobs(50)
      .filter((j) => j.jobType === "auto_inventory_sync" || j.jobType === "auto_order_pull")
      .slice(0, 20);
    res.json({
      ok: true,
      config: cfg,
      scheduler: schedulerState,
      lastInventoryRun: lastInventoryRun
        ? { ...lastInventoryRun, items: lastInventoryRun.items.slice(0, 200) }
        : null,
      lastOrderPull,
      recentJobs: jobs,
      safety: {
        liveInventoryWrites: cfg.enabled && !cfg.dryRun,
        liveOrderCreation: false,
        note:
          "Order creation is never automatic — it requires the explicit Orders import endpoint with confirm:true.",
      },
    });
  });

  // Manual "Sync inventory now". Dry-run by default; a live run requires
  // BOTH AUTO_SYNC_DRY_RUN=false in the environment AND dryRun:false in the
  // request body.
  app.post("/api/automation/inventory-sync-now", async (req, res) => {
    const cfg = getAutoSyncConfig();
    const requestedLive = req.body?.dryRun === false;
    const dryRun = !(requestedLive && !cfg.dryRun);
    const result = await runInventorySync({ dryRun, source: "manual" });
    res.status(result.ok ? 200 : 409).json({
      ...result,
      requestedLive,
      liveBlockedByEnv: requestedLive && cfg.dryRun,
    });
  });

  // Manual "Pull orders now" — always a preview.
  app.post("/api/automation/pull-orders-now", async (req, res) => {
    const status = typeof req.body?.status === "string" ? req.body.status : "new";
    const limit = parseInt(String(req.body?.limit ?? "50"), 10) || 50;
    const result = await runOrderPull({ source: "manual", status, limit });
    res.status(result.ok ? 200 : 409).json(result);
  });

  // Recent automation audit trail (jobs + logs already exposed generally;
  // this filters to auto-sync entries for the Automation page).
  app.get("/api/automation/audit", (_req, res) => {
    const jobs = storage
      .listSyncJobs(100)
      .filter((j) => j.jobType === "auto_inventory_sync" || j.jobType === "auto_order_pull");
    res.json({ ok: true, jobs });
  });
}
