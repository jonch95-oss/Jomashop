// Jomashop Vendor Portal reconciliation.
//
// The Jomashop Vendor Portal ("Manage Inventory") is the source of truth for
// what is actually LIVE on Jomashop. The portal has no public API, so this
// module is import/export driven: the operator exports the Manage Inventory
// list (CSV / XLSX) or pastes JSON, and we persist + reconcile those rows
// against the cached Shopify catalog. The result tells the operator, per
// style, whether it is confirmed live, active/inactive in the portal, missing,
// or unmatched — so inventory updates and order pulls only act on confirmed
// styles.
//
// Everything matching-related is implemented as pure functions (no DB / no
// network) so it can be unit-tested in script/test-mapping.ts. The route
// handlers at the bottom wire those pure functions to storage + the product
// cache.

import type { Express } from "express";
import multer from "multer";
import ExcelJS from "exceljs";

import { storage } from "./storage";
import type { PortalMatchConfidence, PortalMatchStatus, InsertPortalStyle } from "@shared/schema";

// ---------- Normalized portal row ----------

export type PortalRowInput = {
  vendorSku: string;
  jomashopSku: string | null;
  name: string | null;
  brand: string | null;
  category: string | null;
  status: string | null;
  jomaStatus: string | null;
  qty: number | null;
  priceCents: number | null;
  msrpCents: number | null;
  dateCreated: string | null;
  dateUpdated: string | null;
  productId: string | null;
  raw: Record<string, string>;
};

// ---------- Catalog entry (one per Shopify product OR variant) ----------

export type CatalogEntry = {
  shopifyProductId: string;
  shopifyVariantId: string | null;
  sku: string;
  vendorSku: string;
  jomashopSku: string | null;
  manufacturerNumber: string | null;
  brand: string;
  name: string;
  upcs: string[];
  pushState: string;
};

export type CatalogIndex = {
  bySku: Map<string, CatalogEntry>;
  byJomashopSku: Map<string, CatalogEntry>;
  byUpc: Map<string, CatalogEntry>;
  byManufacturer: Map<string, CatalogEntry>;
  byBrandTitle: Map<string, CatalogEntry>;
  entries: CatalogEntry[];
};

export type PortalMatch = {
  confidence: PortalMatchConfidence;
  entry: CatalogEntry | null;
};

// ---------- Normalization helpers ----------

/** Collapse a value to a comparison key: lowercase, alphanumerics only. */
export function normMatchKey(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Normalize a header label to lowercase words separated by single spaces. */
function normHeader(h: string): string {
  return String(h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Map a (possibly messy) column header to a canonical portal field name. */
/** Intermediate header-field keys: like PortalRowInput but with raw "price"/"msrp" strings. */
export type PortalHeaderField =
  | Exclude<keyof Omit<PortalRowInput, "raw">, "priceCents" | "msrpCents">
  | "price"
  | "msrp";

export function headerToField(header: string): PortalHeaderField | null {
  const n = normHeader(header);
  if (!n) return null;
  const has = (s: string) => n.includes(s);
  if (has("jomashop") && has("sku")) return "jomashopSku";
  if (has("joma") && has("status")) return "jomaStatus";
  if (n === "status") return "status";
  if (has("sku")) return "vendorSku";
  if ((has("product") && has("id")) || has("upc") || has("barcode") || has("gtin")) return "productId";
  if (has("name") || has("title")) return "name";
  if (has("brand")) return "brand";
  if (has("category")) return "category";
  if ((has("date") && has("creat")) || n === "created") return "dateCreated";
  if ((has("date") && has("updat")) || n === "updated") return "dateUpdated";
  if (has("qty") || has("quantity")) return "qty";
  if (has("msrp")) return "msrp";
  if (has("price")) return "price";
  return null;
}

/** Parse a money-ish string ("$1,299.00", "1299") to integer cents. */
export function dollarsToCents(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToDollars(c: number | null | undefined): number | null {
  if (c === null || c === undefined) return null;
  return Math.round(c) / 100;
}

function toInt(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const cleaned = String(v).replace(/[^0-9\-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function blankToNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t === "" ? null : t;
}

// ---------- CSV parsing ----------

/** Minimal RFC-4180-ish CSV parser. Handles quotes, escaped quotes, CRLF. */
export function parsePortalCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // swallow — \r\n handled by the \n branch; lone \r ends the row
      if (text[i + 1] !== "\n") pushRow();
    } else {
      field += c;
    }
  }
  // Trailing field/row (file not ending in newline).
  if (field !== "" || row.length > 0) pushRow();
  // Drop fully-empty trailing rows.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Turn a header row + data rows into raw records keyed by original header. */
export function tableToRecords(table: string[][]): Array<Record<string, string>> {
  if (table.length === 0) return [];
  const headers = table[0].map((h) => String(h ?? "").trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < table.length; r++) {
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      rec[key] = String(table[r][c] ?? "").trim();
    }
    out.push(rec);
  }
  return out;
}

/** Normalize one raw record (header→value) into a typed portal row. */
export function coercePortalRecord(raw: Record<string, unknown>): PortalRowInput | null {
  const picked: Partial<Record<PortalHeaderField, string>> = {};
  const rawStr: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const val = v === null || v === undefined ? "" : String(v);
    rawStr[k] = val;
    const field = headerToField(k);
    if (field && picked[field] === undefined && val.trim() !== "") {
      picked[field] = val.trim();
    }
  }
  const vendorSku = blankToNull(picked.vendorSku);
  if (!vendorSku) return null; // a portal row without a SKU can't be reconciled
  return {
    vendorSku,
    jomashopSku: blankToNull(picked.jomashopSku),
    name: blankToNull(picked.name),
    brand: blankToNull(picked.brand),
    category: blankToNull(picked.category),
    status: blankToNull(picked.status),
    jomaStatus: blankToNull(picked.jomaStatus),
    qty: toInt(picked.qty),
    priceCents: dollarsToCents(picked.price),
    msrpCents: dollarsToCents(picked.msrp),
    dateCreated: blankToNull(picked.dateCreated),
    dateUpdated: blankToNull(picked.dateUpdated),
    productId: blankToNull(picked.productId),
    raw: rawStr,
  };
}

// ---------- Catalog index ----------

/** Pull UPC-like values out of a compact product's properties bag. */
function extractUpcs(properties: Record<string, unknown> | undefined): string[] {
  if (!properties || typeof properties !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(properties)) {
    const nk = normHeader(k);
    if (
      nk.includes("upc") ||
      nk.includes("barcode") ||
      nk.includes("gtin") ||
      (nk.includes("product") && nk.includes("id"))
    ) {
      const val = v === null || v === undefined ? "" : String(v).trim();
      if (val) out.push(val);
    }
  }
  return out;
}

/** Build CatalogEntry rows (product-level + variant-level) from compact products. */
export function catalogEntriesFromProducts(products: Array<Record<string, any>>): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const p of products) {
    if (!p || typeof p !== "object" || p.is_sample) continue;
    const productId = String(p?.source?.shopify_product_id ?? "");
    const variantIds: Array<string | number> = Array.isArray(p?.source?.shopify_variant_ids)
      ? p.source.shopify_variant_ids
      : [];
    const upcs = extractUpcs(p.properties);
    entries.push({
      shopifyProductId: productId,
      shopifyVariantId: variantIds.length > 0 ? String(variantIds[0]) : null,
      sku: String(p.sku ?? p.vendor_sku ?? ""),
      vendorSku: String(p.vendor_sku ?? p.sku ?? ""),
      jomashopSku: p.jomashop_sku ? String(p.jomashop_sku) : null,
      manufacturerNumber: p.manufacturer_number ? String(p.manufacturer_number) : null,
      brand: String(p.brand ?? ""),
      name: String(p.name ?? ""),
      upcs,
      pushState: String(p.push_state ?? "not_pushed"),
    });
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const vsku = String(v?.vendor_sku ?? "");
      if (!vsku) continue;
      entries.push({
        shopifyProductId: productId,
        shopifyVariantId: variantIds[i] !== undefined ? String(variantIds[i]) : null,
        sku: vsku,
        vendorSku: vsku,
        jomashopSku: p.jomashop_sku ? String(p.jomashop_sku) : null,
        manufacturerNumber: p.manufacturer_number ? String(p.manufacturer_number) : null,
        brand: String(p.brand ?? ""),
        name: String(p.name ?? ""),
        upcs,
        pushState: String(p.push_state ?? "not_pushed"),
      });
    }
  }
  return entries;
}

/** Index catalog entries by every key the matcher consults. First write wins. */
export function buildCatalogIndex(entries: CatalogEntry[]): CatalogIndex {
  const index: CatalogIndex = {
    bySku: new Map(),
    byJomashopSku: new Map(),
    byUpc: new Map(),
    byManufacturer: new Map(),
    byBrandTitle: new Map(),
    entries,
  };
  const set = (map: Map<string, CatalogEntry>, key: string, entry: CatalogEntry) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, entry);
  };
  for (const e of entries) {
    set(index.bySku, normMatchKey(e.sku), e);
    set(index.bySku, normMatchKey(e.vendorSku), e);
    if (e.jomashopSku) set(index.byJomashopSku, normMatchKey(e.jomashopSku), e);
    for (const upc of e.upcs) set(index.byUpc, normMatchKey(upc), e);
    if (e.manufacturerNumber) set(index.byManufacturer, normMatchKey(e.manufacturerNumber), e);
    if (e.brand && e.name) set(index.byBrandTitle, normMatchKey(`${e.brand} ${e.name}`), e);
  }
  return index;
}

// ---------- Matching ----------

/**
 * Resolve a portal row to a Shopify catalog entry using multiple keys in
 * descending trust order. Returns the confidence label naming the key that
 * matched, plus the entry (null when nothing matched → "Needs Review").
 */
export function matchPortalStyle(row: PortalRowInput, index: CatalogIndex): PortalMatch {
  const skuKey = normMatchKey(row.vendorSku);
  if (skuKey && index.bySku.has(skuKey)) {
    return { confidence: "Exact SKU", entry: index.bySku.get(skuKey)! };
  }
  const jomaKey = normMatchKey(row.jomashopSku);
  if (jomaKey && index.byJomashopSku.has(jomaKey)) {
    return { confidence: "Jomashop SKU", entry: index.byJomashopSku.get(jomaKey)! };
  }
  const upcKey = normMatchKey(row.productId);
  if (upcKey && index.byUpc.has(upcKey)) {
    return { confidence: "UPC/Product ID", entry: index.byUpc.get(upcKey)! };
  }
  // Style/parent: the portal SKU often equals the Shopify manufacturer/style #.
  if (skuKey && index.byManufacturer.has(skuKey)) {
    return { confidence: "Style/Parent SKU", entry: index.byManufacturer.get(skuKey)! };
  }
  const btKey = row.brand && row.name ? normMatchKey(`${row.brand} ${row.name}`) : "";
  if (btKey && index.byBrandTitle.has(btKey)) {
    return { confidence: "Brand+Title", entry: index.byBrandTitle.get(btKey)! };
  }
  return { confidence: "Needs Review", entry: null };
}

function isLive(jomaStatus: string | null): boolean {
  return !!jomaStatus && jomaStatus.toLowerCase().includes("live");
}
function isActive(status: string | null): boolean {
  return !!status && status.toLowerCase().trim() === "active";
}
function isInactive(status: string | null): boolean {
  return !!status && status.toLowerCase().trim() === "inactive";
}

/** Derive the reconciliation status from the match + the portal status fields. */
export function reconcileStatus(row: PortalRowInput, match: PortalMatch): PortalMatchStatus {
  if (!match.entry) return "Unmatched Portal Row";
  if (match.confidence === "Brand+Title") return "Needs Review";
  if (isLive(row.jomaStatus)) return "Confirmed Live";
  if (isActive(row.status)) return "Active in Portal";
  if (isInactive(row.status)) return "Inactive in Portal";
  return "Needs Review";
}

/** Inventory pushes are only safe for styles confirmed present + sellable. */
export function isInventoryPushEligible(matchStatus: PortalMatchStatus | null | undefined): boolean {
  return matchStatus === "Confirmed Live" || matchStatus === "Active in Portal";
}

// ---------- Reconciliation against the live cache ----------

type CachedRow = Record<string, any>;

function readAllCachedProducts(): CachedRow[] {
  const out: CachedRow[] = [];
  for (const store of storage.listStores()) {
    const cache = storage.getProductCache(store.shopDomain);
    if (!cache) continue;
    let payload: any;
    try {
      payload = JSON.parse(cache.payloadJson);
    } catch {
      continue;
    }
    if (Array.isArray(payload?.mapped)) {
      for (const m of payload.mapped) {
        if (m && typeof m === "object") out.push(m);
      }
    }
  }
  return out;
}

export type ReconciledStyle = {
  vendor_sku: string;
  jomashop_sku: string | null;
  name: string | null;
  brand: string | null;
  category: string | null;
  status: string | null;
  joma_status: string | null;
  qty: number | null;
  price: number | null;
  msrp: number | null;
  date_created: string | null;
  date_updated: string | null;
  match_status: PortalMatchStatus;
  match_confidence: PortalMatchConfidence;
  matched_shopify_product_id: string | null;
  matched_shopify_variant_id: string | null;
  matched_shopify_sku: string | null;
  inventory_eligible: boolean;
  imported_at: number;
};

/**
 * Recompute matches for every stored portal style against the current product
 * cache, persist the refreshed match fields, and return the enriched rows plus
 * a summary. Also computes "Portal Missing" — pushed Shopify products that have
 * no corresponding portal row (a live-gap the operator should investigate).
 */
export function reconcileAll(): {
  styles: ReconciledStyle[];
  index: CatalogIndex;
  summary: Record<string, number> & { portal_missing: number; total: number };
  portalMissing: Array<{ vendor_sku: string; brand: string; name: string; push_state: string }>;
} {
  const products = readAllCachedProducts();
  const index = buildCatalogIndex(catalogEntriesFromProducts(products));
  const stored = storage.listPortalStyles();
  const now = Date.now();

  const matchedShopifyKeys = new Set<string>();
  const styles: ReconciledStyle[] = [];
  const summary: Record<string, number> & { portal_missing: number; total: number } = {
    "Confirmed Live": 0,
    "Active in Portal": 0,
    "Inactive in Portal": 0,
    "Needs Review": 0,
    "Unmatched Portal Row": 0,
    portal_missing: 0,
    total: 0,
  };

  for (const s of stored) {
    const row: PortalRowInput = {
      vendorSku: s.vendorSku,
      jomashopSku: s.jomashopSku ?? null,
      name: s.name ?? null,
      brand: s.brand ?? null,
      category: s.category ?? null,
      status: s.status ?? null,
      jomaStatus: s.jomaStatus ?? null,
      qty: s.qty ?? null,
      priceCents: s.price ?? null,
      msrpCents: s.msrp ?? null,
      dateCreated: s.dateCreated ?? null,
      dateUpdated: s.dateUpdated ?? null,
      productId: null,
      raw: {},
    };
    const match = matchPortalStyle(row, index);
    const matchStatus = reconcileStatus(row, match);
    if (match.entry?.shopifyProductId) matchedShopifyKeys.add(match.entry.shopifyProductId);

    // Persist the refreshed match result so inventory/order guards read fresh.
    storage.upsertPortalStyle({
      ...toInsert(s),
      matchStatus,
      matchConfidence: match.confidence,
      matchedShopifyProductId: match.entry?.shopifyProductId ?? null,
      matchedShopifyVariantId: match.entry?.shopifyVariantId ?? null,
      matchedShopifySku: match.entry?.sku ?? null,
      updatedAt: now,
    });

    summary[matchStatus] = (summary[matchStatus] ?? 0) + 1;
    summary.total += 1;
    styles.push({
      vendor_sku: s.vendorSku,
      jomashop_sku: s.jomashopSku ?? null,
      name: s.name ?? null,
      brand: s.brand ?? null,
      category: s.category ?? null,
      status: s.status ?? null,
      joma_status: s.jomaStatus ?? null,
      qty: s.qty ?? null,
      price: centsToDollars(s.price),
      msrp: centsToDollars(s.msrp),
      date_created: s.dateCreated ?? null,
      date_updated: s.dateUpdated ?? null,
      match_status: matchStatus,
      match_confidence: match.confidence,
      matched_shopify_product_id: match.entry?.shopifyProductId ?? null,
      matched_shopify_variant_id: match.entry?.shopifyVariantId ?? null,
      matched_shopify_sku: match.entry?.sku ?? null,
      inventory_eligible: isInventoryPushEligible(matchStatus),
      imported_at: s.importedAt,
    });
  }

  // Portal Missing: products pushed to Jomashop but absent from the portal import.
  const portalMissing: Array<{ vendor_sku: string; brand: string; name: string; push_state: string }> = [];
  const seenMissing = new Set<string>();
  for (const e of index.entries) {
    if (e.pushState !== "pushed") continue;
    if (!e.shopifyProductId) continue;
    if (matchedShopifyKeys.has(e.shopifyProductId)) continue;
    const key = normMatchKey(e.vendorSku);
    if (!key || seenMissing.has(key)) continue;
    seenMissing.add(key);
    portalMissing.push({
      vendor_sku: e.vendorSku,
      brand: e.brand,
      name: e.name,
      push_state: e.pushState,
    });
  }
  summary.portal_missing = portalMissing.length;

  return { styles, index, summary, portalMissing };
}

/** Strip a stored PortalStyle row to the insert shape (drop the id). */
function toInsert(s: ReturnType<typeof storage.listPortalStyles>[number]): InsertPortalStyle {
  const { id: _id, ...rest } = s;
  return rest as InsertPortalStyle;
}

// ---------- Import ----------

/** Parse an uploaded buffer (CSV or XLSX) into raw header→value records. */
async function recordsFromBuffer(
  buffer: Buffer,
  filename: string,
): Promise<Array<Record<string, string>>> {
  const lower = filename.toLowerCase();
  const looksXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");
  if (looksXlsx) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const table: string[][] = [];
    ws.eachRow((wsRow) => {
      const cells: string[] = [];
      wsRow.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        cells.push(v === null || v === undefined ? "" : String(typeof v === "object" && "text" in (v as any) ? (v as any).text : v));
      });
      table.push(cells);
    });
    return tableToRecords(table);
  }
  return tableToRecords(parsePortalCsv(buffer.toString("utf8")));
}

// ---------- Routes ----------

export function registerPortalRoutes(app: Express): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
  });

  // Import portal styles. Accepts ONE of:
  //   - multipart file upload (field "file"): .csv / .xlsx
  //   - JSON body { rows: [{...}, ...] }  (objects keyed by portal headers)
  //   - JSON body { csv: "<raw csv text>" }
  // Query/body `replace=false` keeps existing rows (default true clears first).
  app.post("/api/portal/import", upload.single("file"), async (req, res) => {
    try {
      const replace =
        String((req.query.replace ?? (req.body && req.body.replace) ?? "true")).toLowerCase() !==
        "false";

      let records: Array<Record<string, string>> = [];
      if (req.file) {
        records = await recordsFromBuffer(req.file.buffer, req.file.originalname || "upload.csv");
      } else if (req.body && Array.isArray(req.body.rows)) {
        records = req.body.rows.map((r: Record<string, unknown>) => {
          const rec: Record<string, string> = {};
          for (const [k, v] of Object.entries(r ?? {})) rec[k] = v === null || v === undefined ? "" : String(v);
          return rec;
        });
      } else if (req.body && typeof req.body.csv === "string") {
        records = tableToRecords(parsePortalCsv(req.body.csv));
      } else {
        return res.status(400).json({
          ok: false,
          error: "Provide a file upload, a JSON { rows: [...] }, or { csv: \"...\" }.",
        });
      }

      const normalized: PortalRowInput[] = [];
      let skipped = 0;
      for (const rec of records) {
        const row = coercePortalRecord(rec);
        if (row) normalized.push(row);
        else skipped += 1;
      }
      if (normalized.length === 0) {
        return res.status(400).json({
          ok: false,
          error: `No usable rows found (every row was missing a SKU column). Parsed ${records.length} row(s).`,
          skipped,
        });
      }

      if (replace) storage.clearPortalStyles();
      const now = Date.now();
      for (const row of normalized) {
        storage.upsertPortalStyle({
          vendorSku: row.vendorSku,
          jomashopSku: row.jomashopSku,
          name: row.name,
          brand: row.brand,
          category: row.category,
          status: row.status,
          jomaStatus: row.jomaStatus,
          qty: row.qty,
          price: row.priceCents,
          msrp: row.msrpCents,
          dateCreated: row.dateCreated,
          dateUpdated: row.dateUpdated,
          source: req.file ? "portal-file" : "portal-json",
          importedAt: now,
          rawJson: JSON.stringify(row.raw),
          matchStatus: null,
          matchConfidence: null,
          matchedShopifyProductId: null,
          matchedShopifyVariantId: null,
          matchedShopifySku: null,
          updatedAt: now,
        });
      }

      // Reconcile immediately so the response reflects live match status.
      const { summary } = reconcileAll();
      storage.appendLog({
        level: "info",
        message: `Imported ${normalized.length} portal style(s) (${skipped} skipped, replace=${replace})`,
        detailsJson: JSON.stringify(summary),
        createdAt: Date.now(),
      });
      res.json({ ok: true, imported: normalized.length, skipped, replaced: replace, summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Reconciled list of portal styles (recomputed against the current cache).
  app.get("/api/portal/styles", (_req, res) => {
    try {
      const { styles, summary, portalMissing } = reconcileAll();
      res.json({ ok: true, count: styles.length, summary, styles, portal_missing: portalMissing });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Reconciliation summary only (cheap counts for badges / overview).
  app.get("/api/portal/summary", (_req, res) => {
    try {
      const { summary, portalMissing } = reconcileAll();
      res.json({ ok: true, summary, portal_missing: portalMissing.slice(0, 50), portal_missing_count: portalMissing.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Inventory eligibility guard. Without ?sku= returns eligible/blocked
  // buckets; with ?sku= returns the single style's eligibility. Inventory
  // pushes should be gated on `eligible` so we never update quantity on a
  // style that isn't confirmed live/active in the portal.
  app.get("/api/portal/inventory-eligibility", (req, res) => {
    try {
      const { styles } = reconcileAll();
      const sku = typeof req.query.sku === "string" ? req.query.sku.trim() : "";
      if (sku) {
        const key = normMatchKey(sku);
        const hit = styles.find(
          (s) => normMatchKey(s.vendor_sku) === key || normMatchKey(s.matched_shopify_sku) === key,
        );
        if (!hit) {
          return res.json({
            ok: true,
            sku,
            found: false,
            eligible: false,
            reason: "No portal style imported for this SKU. Import the Vendor Portal export first.",
          });
        }
        return res.json({
          ok: true,
          sku,
          found: true,
          eligible: hit.inventory_eligible,
          match_status: hit.match_status,
          reason: hit.inventory_eligible
            ? "Confirmed in portal — inventory push allowed."
            : `Not eligible (status: ${hit.match_status}). Push blocked.`,
        });
      }
      const eligible = styles.filter((s) => s.inventory_eligible);
      const blocked = styles.filter((s) => !s.inventory_eligible);
      res.json({
        ok: true,
        eligible_count: eligible.length,
        blocked_count: blocked.length,
        eligible: eligible.map((s) => s.vendor_sku),
        blocked: blocked.map((s) => ({ vendor_sku: s.vendor_sku, match_status: s.match_status })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Order-pull matching foundation. Reads imported orders and matches each
  // line's SKU candidates against confirmed-live portal styles + the Shopify
  // catalog. Lines that don't match a confirmed style are flagged so the
  // operator doesn't fulfill against an unverified mapping. Read-only.
  app.get("/api/portal/order-match-preview", (_req, res) => {
    try {
      const { styles, index } = reconcileAll();
      const liveBySku = new Map<string, ReconciledStyle>();
      for (const s of styles) {
        if (s.match_status === "Confirmed Live" || s.match_status === "Active in Portal") {
          liveBySku.set(normMatchKey(s.vendor_sku), s);
          if (s.matched_shopify_sku) liveBySku.set(normMatchKey(s.matched_shopify_sku), s);
        }
      }
      const orders = storage.listImportedOrders();
      const lines: Array<{
        sales_order_number: string;
        sku: string;
        matched: boolean;
        match_source: "portal-live" | "shopify-catalog" | "none";
        match_status: PortalMatchStatus | null;
      }> = [];
      for (const o of orders) {
        let payload: any;
        try {
          payload = JSON.parse(o.payloadJson);
        } catch {
          continue;
        }
        for (const sku of extractOrderLineSkus(payload)) {
          const key = normMatchKey(sku);
          const live = liveBySku.get(key);
          if (live) {
            lines.push({
              sales_order_number: o.salesOrderNumber,
              sku,
              matched: true,
              match_source: "portal-live",
              match_status: live.match_status,
            });
          } else if (index.bySku.has(key)) {
            lines.push({
              sales_order_number: o.salesOrderNumber,
              sku,
              matched: true,
              match_source: "shopify-catalog",
              match_status: null,
            });
          } else {
            lines.push({
              sales_order_number: o.salesOrderNumber,
              sku,
              matched: false,
              match_source: "none",
              match_status: null,
            });
          }
        }
      }
      const unmatched = lines.filter((l) => !l.matched).length;
      const portalUnconfirmed = lines.filter((l) => l.matched && l.match_source !== "portal-live").length;
      res.json({
        ok: true,
        orders: orders.length,
        line_count: lines.length,
        unmatched,
        portal_unconfirmed: portalUnconfirmed,
        lines,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });
}

/** Heuristically pull line-item SKU strings out of an imported-order payload. */
export function extractOrderLineSkus(payload: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const nk = normHeader(k);
        if ((nk === "sku" || nk.includes("vendor sku") || nk.includes("jomashop sku") || nk.includes("vendor item")) &&
            (typeof v === "string" || typeof v === "number")) {
          const s = String(v).trim();
          if (s) out.push(s);
        } else {
          visit(v);
        }
      }
    }
  };
  visit(payload);
  return Array.from(new Set(out));
}
