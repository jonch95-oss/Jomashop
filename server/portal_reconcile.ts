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
  /** Style / parent number (Shopify manufacturer_number), when the export has one. */
  styleNumber: string | null;
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

/**
 * Synthetic key prefix used by `tableToRecords` for columns whose header cell
 * is blank. The Jomashop workbook ships the style/parent number under exactly
 * such a column, so dropping unnamed columns loses a real match key.
 */
export const UNNAMED_COLUMN_PREFIX = "__col";

export function headerToField(header: string): PortalHeaderField | null {
  const n = normHeader(header);
  if (!n) return null;
  const has = (s: string) => n.includes(s);
  if (n.startsWith(UNNAMED_COLUMN_PREFIX)) return null;
  // "Joma Status" must be tested before the SKU rules below, which also
  // accept the short "joma" spelling.
  if (has("joma") && has("status")) return "jomaStatus";
  // The live Jomashop workbook labels this column "Joma SKU"; the web export
  // labels it "Jomashop SKU". Accept both — this is the identifier that says
  // an item exists on Jomashop, so losing it makes every row unmatchable.
  if (has("joma") && has("sku")) return "jomashopSku";
  if (n === "status") return "status";
  if (has("style") || has("parent") || has("manufacturer") || n === "mpn" || has("model")) {
    return "styleNumber";
  }
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

/**
 * Turn a header row + data rows into raw records keyed by original header.
 *
 * Columns whose header cell is blank are kept under a synthetic
 * `__col<index>` key rather than dropped: the Jomashop workbook puts the
 * style/parent number in an unnamed column and we need it to match.
 */
export function tableToRecords(table: string[][]): Array<Record<string, string>> {
  if (table.length === 0) return [];
  const width = table.reduce((w, row) => Math.max(w, row.length), 0);
  const headers: string[] = [];
  for (let c = 0; c < width; c++) {
    const label = String(table[0][c] ?? "").trim();
    headers.push(label || `${UNNAMED_COLUMN_PREFIX}${c}`);
  }
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < table.length; r++) {
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      rec[headers[c]] = String(table[r][c] ?? "").trim();
    }
    out.push(rec);
  }
  return out;
}

/**
 * Recover a style/parent number from an unlabeled column.
 *
 * The Jomashop workbook has no header on the column holding the style number,
 * but the relationship is unambiguous: the vendor SKU is the style plus a size
 * suffix ("L1833LCL395X1N001-OS" -> "L1833LCL395X1N001"). So an unnamed cell
 * whose value is a strict prefix of the vendor SKU is the style number.
 */
export function inferStyleNumber(
  vendorSku: string,
  raw: Record<string, string>,
): string | null {
  const skuKey = normMatchKey(vendorSku);
  if (!skuKey) return null;
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith(UNNAMED_COLUMN_PREFIX)) continue;
    const val = String(v ?? "").trim();
    if (!val) continue;
    const valKey = normMatchKey(val);
    if (!valKey || valKey === skuKey) continue;
    if (skuKey.startsWith(valKey)) return val;
  }
  return null;
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
    styleNumber: blankToNull(picked.styleNumber) ?? inferStyleNumber(vendorSku, rawStr),
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
  // Explicit style column (or the one recovered from the workbook's unnamed
  // column) — the Jomashop export's vendor SKU carries a size suffix, so the
  // style number is what actually lines up with manufacturer_number.
  const styleKey = normMatchKey(row.styleNumber);
  if (styleKey) {
    if (index.byManufacturer.has(styleKey)) {
      return { confidence: "Style/Parent SKU", entry: index.byManufacturer.get(styleKey)! };
    }
    if (index.bySku.has(styleKey)) {
      return { confidence: "Style/Parent SKU", entry: index.bySku.get(styleKey)! };
    }
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

/**
 * Derive the reconciliation status from the match + the portal status fields.
 *
 * `opts.statusColumnsPresent` describes the EXPORT, not the row: the Jomashop
 * "Manage Inventory" workbook has no Status / Joma Status columns at all — it
 * is simply the list of what the vendor has on Jomashop. When the export
 * carries no status columns anywhere, a blank status is not "unknown", it is
 * "present in the portal" — and a row that already has a Jomashop SKU is live.
 * When the export DOES have status columns, a blank one is genuinely
 * unreviewed and stays Needs Review.
 */
export function reconcileStatus(
  row: PortalRowInput,
  match: PortalMatch,
  opts?: { statusColumnsPresent?: boolean },
): PortalMatchStatus {
  if (!match.entry) return "Unmatched Portal Row";
  if (match.confidence === "Brand+Title") return "Needs Review";
  if (isLive(row.jomaStatus)) return "Confirmed Live";
  if (isActive(row.status)) return "Active in Portal";
  if (isInactive(row.status)) return "Inactive in Portal";
  const statusColumnsPresent = opts?.statusColumnsPresent ?? true;
  if (!statusColumnsPresent && !row.status && !row.jomaStatus) {
    // A Jomashop SKU is only assigned once the style exists on Jomashop, so on
    // a status-column-less export it IS the live signal. Rows still waiting on
    // one are in the vendor's portal but not yet on the storefront.
    return row.jomashopSku ? "Confirmed Live" : "Active in Portal";
  }
  return "Needs Review";
}

/**
 * Does this batch of rows carry any status signal at all? Used to decide
 * whether a blank status means "unreviewed" or "the export just has no status
 * columns" (see reconcileStatus).
 */
export function anyStatusColumnPresent(
  rows: Array<{ status?: string | null; jomaStatus?: string | null }>,
): boolean {
  return rows.some((r) => !!blankToNull(r.status) || !!blankToNull(r.jomaStatus));
}

/** Inventory pushes are only safe for styles confirmed present + sellable. */
export function isInventoryPushEligible(matchStatus: PortalMatchStatus | null | undefined): boolean {
  return matchStatus === "Confirmed Live" || matchStatus === "Active in Portal";
}

// ---------- "Is this already on Jomashop?" lookup ----------
//
// The Products page and every push path need a cheap answer to one question:
// does the Vendor Portal already have this style, and has Jomashop already
// assigned it a SKU? That is what stops the same item being pushed twice.
// It is deliberately separate from reconcileAll(), which walks the whole
// Shopify cache — this only reads the imported portal rows.

export type PortalLiveState = "live" | "in_portal" | "unknown";

export type PortalLiveHit = {
  state: PortalLiveState;
  vendorSku: string | null;
  jomashopSku: string | null;
  jomaStatus: string | null;
  status: string | null;
  /** Which candidate key produced the hit — shown in the UI / block message. */
  matchedOn: string | null;
};

export type PortalLiveLookup = {
  byKey: Map<string, PortalLiveHit>;
  /** 0 when nothing has been imported — callers should then say "unknown", not "not live". */
  rowCount: number;
};

const UNKNOWN_HIT: PortalLiveHit = {
  state: "unknown",
  vendorSku: null,
  jomashopSku: null,
  jomaStatus: null,
  status: null,
  matchedOn: null,
};

/**
 * Index every imported portal row by each identifier it can be recognized by:
 * its vendor SKU, its style/parent number, and its Jomashop SKU.
 *
 * A row counts as "live" when the portal has assigned it a Jomashop SKU (the
 * signal the Manage Inventory workbook carries) or explicitly says so via Joma
 * Status — unless the portal Status marks it Inactive, in which case it is not
 * something we should treat as live. A row with no Jomashop SKU yet is
 * "in_portal": known to the portal, not yet on Jomashop.
 */
export function buildPortalLiveLookup(): PortalLiveLookup {
  const byKey = new Map<string, PortalLiveHit>();
  const rows = storage.listPortalStyles();
  for (const r of rows) {
    const jomashopSku = r.jomashopSku ?? null;
    const jomaStatus = r.jomaStatus ?? null;
    const status = r.status ?? null;
    const state: PortalLiveState =
      isInactive(status) ? "in_portal" : jomashopSku || isLive(jomaStatus) ? "live" : "in_portal";
    const set = (raw: string | null | undefined) => {
      const key = normMatchKey(raw);
      if (!key) return;
      const existing = byKey.get(key);
      // A live row always wins the key — two rows sharing a style number where
      // one is already on Jomashop means the style IS on Jomashop.
      if (existing && !(state === "live" && existing.state !== "live")) return;
      byKey.set(key, {
        state,
        vendorSku: r.vendorSku,
        jomashopSku,
        jomaStatus,
        status,
        matchedOn: raw ? String(raw) : null,
      });
    };
    set(r.vendorSku);
    set(r.styleNumber);
    set(jomashopSku);
  }
  return { byKey, rowCount: rows.length };
}

/**
 * Resolve a product's identifiers against the portal lookup. Returns the
 * strongest hit — "live" beats "in_portal" beats "unknown" — so a product
 * whose style is live counts as live even if one of its size SKUs is not in
 * the export.
 */
export function portalLiveStateFor(
  lookup: PortalLiveLookup,
  candidates: Array<string | null | undefined>,
): PortalLiveHit {
  if (lookup.rowCount === 0) return UNKNOWN_HIT;
  let best: PortalLiveHit = UNKNOWN_HIT;
  for (const c of candidates) {
    const key = normMatchKey(c);
    if (!key) continue;
    const hit = lookup.byKey.get(key);
    if (!hit) continue;
    if (hit.state === "live") return { ...hit, matchedOn: String(c) };
    if (best.state === "unknown") best = { ...hit, matchedOn: String(c) };
  }
  return best;
}

/** Every identifier a mapped product can be recognized by in the portal. */
export function portalCandidatesForProduct(m: Record<string, any> | null | undefined): string[] {
  if (!m || typeof m !== "object") return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (v === null || v === undefined) return;
    const s = String(v).trim();
    if (s) out.push(s);
  };
  push(m.vendor_sku);
  push(m.sku);
  push(m.manufacturer_number);
  push(m.jomashop_sku);
  if (Array.isArray(m.variants)) for (const v of m.variants) push(v?.vendor_sku);
  return Array.from(new Set(out));
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
  style_number: string | null;
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
  // Whole-dataset question, so it is computed once outside the row loop.
  const statusColumnsPresent = anyStatusColumnPresent(stored);

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
      styleNumber: s.styleNumber ?? null,
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
    const matchStatus = reconcileStatus(row, match, { statusColumnsPresent });
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
      style_number: s.styleNumber ?? null,
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

/** Cells the Jomashop workbook uses as per-column annotations, never as data. */
const TEMPLATE_MARKER_CELLS = new Set([
  "required",
  "readonly",
  "read only",
  "optional",
  "conditional",
  "n/a",
  "na",
  "-",
]);

/** Flatten one ExcelJS cell value (rich text, formula, hyperlink, date) to text. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.trim();
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r?.text ?? "").join("").trim();
    }
    if (o.result !== undefined && o.result !== null) return String(o.result).trim();
    if (typeof o.hyperlink === "string") return o.hyperlink.trim();
  }
  return String(v).trim();
}

/** Read a worksheet into a dense, column-aligned string table. */
function sheetToTable(ws: ExcelJS.Worksheet): string[][] {
  const table: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (wsRow) => {
    const cells: string[] = [];
    wsRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell.value);
    });
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === undefined) cells[i] = "";
    }
    table.push(cells);
  });
  return table;
}

/**
 * Locate the header row in a table. Exports rarely put it on row 1 — the
 * Jomashop workbook opens with a title/banner block — so scan the top of the
 * sheet for the row that maps to the most known fields and includes a SKU
 * column. Returns -1 when no row qualifies (e.g. the "Instructions" sheet).
 */
export function findHeaderRow(table: string[][]): number {
  const limit = Math.min(table.length, 25);
  let best = -1;
  let bestScore = 0;
  for (let r = 0; r < limit; r++) {
    const fields = new Set<PortalHeaderField>();
    for (const cell of table[r] ?? []) {
      const f = headerToField(cell);
      if (f) fields.add(f);
    }
    const hasSku = fields.has("vendorSku") || fields.has("jomashopSku");
    if (!hasSku || fields.size < 2) continue;
    if (fields.size > bestScore) {
      bestScore = fields.size;
      best = r;
    }
  }
  return best;
}

/** Does this cell look like an actual SKU/style token (vs. prose)? */
function looksLikeSkuToken(s: string): boolean {
  const t = s.trim();
  return t.length >= 4 && !/\s/.test(t) && /\d/.test(t) && /^[A-Za-z0-9._/\-]+$/.test(t);
}

/**
 * Is this one of the template's sub-header rows?
 *
 * The Jomashop workbook puts two annotation rows directly under the header:
 * a prose description ("Your unique vendor SKU") and a requirement flag
 * ("required" / "readonly"). Imported as-is they become phantom styles. Both
 * are recognizable: either every filled cell is an annotation keyword, or the
 * row is pure prose — no SKU-shaped token and no number anywhere.
 */
export function isTemplateNoiseRow(cells: string[]): boolean {
  const filled = cells.map((c) => String(c ?? "").trim()).filter((c) => c !== "");
  if (filled.length === 0) return true;
  if (filled.every((c) => TEMPLATE_MARKER_CELLS.has(c.toLowerCase()))) return true;
  const hasSkuToken = filled.some(looksLikeSkuToken);
  const hasNumber = filled.some((c) => dollarsToCents(c) !== null);
  return !hasSkuToken && !hasNumber;
}

/**
 * Slice a raw sheet table down to [header row, ...data rows], dropping the
 * template's annotation rows that sit between them. Only the LEADING run
 * after the header is inspected, so a legitimate data row can never be
 * discarded from the middle of the sheet.
 */
export function trimTemplateRows(table: string[][], headerRow: number): string[][] {
  const out: string[][] = [table[headerRow]];
  let r = headerRow + 1;
  while (r < table.length && isTemplateNoiseRow(table[r])) r++;
  for (; r < table.length; r++) out.push(table[r]);
  return out;
}

/** True when the buffer is a ZIP container — every modern Excel format is. */
function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export type ParsedUpload = {
  records: Array<Record<string, string>>;
  /** Human-readable note about what was parsed, surfaced in the import response. */
  note: string;
};

/**
 * Parse an uploaded buffer (CSV or any zipped Excel format) into raw
 * header→value records.
 *
 * Format is decided by CONTENT, not by extension: the Jomashop portal hands
 * out a macro-enabled .xlsm workbook, and matching only ".xlsx"/".xls" sent it
 * down the CSV path, where the binary parsed into gibberish and every import
 * failed with "no usable rows". Sheet and header row are then discovered
 * rather than assumed — the workbook's first sheet is "Instructions" and its
 * header sits under a banner, so worksheets[0] / row 1 both pointed at the
 * wrong cells.
 */
export async function recordsFromBuffer(
  buffer: Buffer,
  filename: string,
): Promise<ParsedUpload> {
  const lower = filename.toLowerCase();
  const zipped = looksLikeZip(buffer);
  const excelExt = /\.(xlsx|xlsm|xltx|xltm|xls)$/.test(lower);
  if (zipped || excelExt) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    let picked: { name: string; table: string[][]; headerRow: number } | null = null;
    for (const ws of wb.worksheets) {
      const table = sheetToTable(ws);
      const headerRow = findHeaderRow(table);
      if (headerRow < 0) continue;
      const dataRows = table.length - headerRow - 1;
      if (!picked || dataRows > picked.table.length - picked.headerRow - 1) {
        picked = { name: ws.name, table, headerRow };
      }
    }
    if (!picked) {
      const names = wb.worksheets.map((w) => w.name).join(", ") || "(none)";
      throw new Error(
        `No sheet in this workbook has a recognizable header row with a SKU column. Sheets found: ${names}.`,
      );
    }
    const trimmed = trimTemplateRows(picked.table, picked.headerRow);
    return {
      records: tableToRecords(trimmed),
      note: `sheet "${picked.name}", header on row ${picked.headerRow + 1}`,
    };
  }
  return { records: tableToRecords(parsePortalCsv(buffer.toString("utf8"))), note: "CSV" };
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
      let parseNote = "";
      if (req.file) {
        const parsed = await recordsFromBuffer(req.file.buffer, req.file.originalname || "upload.csv");
        records = parsed.records;
        parseNote = parsed.note;
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
          styleNumber: row.styleNumber,
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
      res.json({
        ok: true,
        imported: normalized.length,
        skipped,
        replaced: replace,
        parsed_from: parseNote || null,
        summary,
      });
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
