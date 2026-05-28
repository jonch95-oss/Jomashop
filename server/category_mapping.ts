// Category mapping workflow: aggregate Shopify category codes seen in the
// product preview, let the operator download an XLSX, fill in the Jomashop
// category for each code, then upload and apply. The applied mappings are
// stored in the `category_overrides` table and consulted by buildPreview so
// the readiness status flips from "needs verification" to "ready" without a
// full Shopify re-pagination.

import crypto from "node:crypto";
import ExcelJS from "exceljs";
import type { Express } from "express";
import multer from "multer";
import { storage } from "./storage";
import {
  SUPPORTED_CATEGORIES,
  type SupportedCategory,
} from "@shared/schema";
import {
  BUILT_IN_CATEGORY_OVERRIDES,
  coerceJomashopToSupported,
  lookupBuiltInCategoryDefault,
  normalizeCategoryCode,
  type MappedProduct,
} from "./mapping";
import { getActiveShopifyConnection } from "./shopify";
import { getCategories } from "./jomashop";
import {
  CANONICAL_JOMASHOP_CATEGORY_ALIASES,
  canonicalJomashopCategory,
} from "@shared/schema";
import {
  MAX_IMPORT_ROWS,
  rejectIfTooManyRows,
} from "./stability";

const MAX_CATEGORY_MAPPING_SESSIONS = 8;

// ---------- Aggregation ----------

export type CategoryAggregateRow = {
  shopify_category_code: string; // raw value as last seen
  shopify_category_code_normalized: string;
  suggested_category: string;
  product_count: number;
  missing_count: number;
  sample_titles: string[];
  sample_skus: string[];
  current_jomashop_category: string | null;
  current_override_notes: string | null;
  jomashop_schema_loaded: boolean;
  ambiguous: boolean;
};

export type CategoryAggregateResult = {
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  uniqueCodes: number;
  jomashopCategoriesAvailable: boolean;
  jomashopCategories: string[];
  rows: CategoryAggregateRow[];
};

/**
 * Read the cached preview for the active shop and aggregate distinct Shopify
 * category codes. Each row carries product/missing counts, sample titles +
 * SKUs, the currently-saved override if any, and whether the live Jomashop
 * category list is available so the UI can render a dropdown vs. free-text
 * input.
 */
export async function aggregateCategoryCodes(): Promise<CategoryAggregateResult> {
  const conn = getActiveShopifyConnection();
  const shopDomain =
    conn?.shopDomain ??
    storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
    null;

  // Fetch live Jomashop category names (for dropdown / validation). Best-effort.
  let jomashopCategoryNames: string[] = [];
  let jomashopCategoriesAvailable = false;
  try {
    const liveCats = await getCategories();
    if (liveCats.ok) {
      const raw = liveCats.data as unknown;
      const arr =
        (Array.isArray(raw) ? raw : (raw as { data?: unknown }).data) ||
        (raw as { categories?: unknown }).categories;
      if (Array.isArray(arr)) {
        const names = arr
          .map((c) => (typeof c === "string" ? c : (c as { name?: string }).name))
          .filter((s): s is string => Boolean(s));
        if (names.length > 0) {
          jomashopCategoryNames = names;
          jomashopCategoriesAvailable = true;
        }
      }
    }
  } catch {
    // best-effort; fall back to SUPPORTED_CATEGORIES
  }
  if (jomashopCategoryNames.length === 0) {
    jomashopCategoryNames = [...SUPPORTED_CATEGORIES];
  }

  const overrides = new Map<string, { jomashopCategory: string; notes: string | null }>();
  for (const o of storage.listCategoryOverrides()) {
    overrides.set(o.shopifyCategoryCode, {
      jomashopCategory: o.jomashopCategory,
      notes: o.notes ?? null,
    });
  }

  // Read the cached preview (already mapped) — we don't want to re-paginate
  // Shopify just to build this list.
  const cached = shopDomain ? storage.getProductCache(shopDomain) : undefined;
  const result: CategoryAggregateResult = {
    shopDomain,
    fromCache: Boolean(cached),
    cachedAt: cached?.fetchedAt ?? null,
    totalProducts: 0,
    uniqueCodes: 0,
    jomashopCategoriesAvailable,
    jomashopCategories: jomashopCategoryNames,
    rows: [],
  };
  if (!cached) return result;

  let payload: any;
  try {
    payload = JSON.parse(cached.payloadJson);
  } catch {
    return result;
  }
  if (!payload || !Array.isArray(payload.mapped)) return result;

  const byCode = new Map<
    string,
    {
      raw: string;
      suggested: string;
      products: Set<string>;
      missing: number;
      titles: string[];
      skus: string[];
      schemaLoaded: boolean;
      ambiguous: boolean;
    }
  >();

  type CachedMapped = MappedProduct & {
    readiness?: string;
  };

  for (const m of payload.mapped as CachedMapped[]) {
    const raw = (m.raw_category || "").toString();
    const norm = normalizeCategoryCode(raw);
    if (!raw && !norm) continue;
    const key = norm || raw.toLowerCase();
    let entry = byCode.get(key);
    if (!entry) {
      entry = {
        raw: raw || key,
        suggested: m.suggested_category || raw,
        products: new Set<string>(),
        missing: 0,
        titles: [],
        skus: [],
        schemaLoaded: false,
        ambiguous: Boolean(m.ambiguous_category),
      };
      byCode.set(key, entry);
    }
    const pid =
      m.source?.shopify_product_id !== undefined && m.source?.shopify_product_id !== null
        ? String(m.source.shopify_product_id)
        : (m.vendor_sku || m.name);
    entry.products.add(String(pid));
    const missingTop = m.missing_top_level ?? [];
    const missingReq = m.missing_required ?? [];
    if (missingTop.length > 0 || missingReq.length > 0) entry.missing += 1;
    if (entry.titles.length < 5 && m.name) entry.titles.push(m.name);
    if (entry.skus.length < 5 && m.vendor_sku) entry.skus.push(m.vendor_sku);
    // Schema is considered loaded if mapping produced at least one non-null
    // property (i.e. the category schema had usable fields).
    if (
      !entry.schemaLoaded &&
      m.properties &&
      Object.values(m.properties).some((v) => v !== null && v !== undefined && v !== "")
    ) {
      entry.schemaLoaded = true;
    }
  }

  const rows: CategoryAggregateRow[] = [];
  byCode.forEach((entry, key) => {
    const override = overrides.get(key);
    const builtIn = BUILT_IN_CATEGORY_OVERRIDES[key] ?? null;
    rows.push({
      shopify_category_code: entry.raw,
      shopify_category_code_normalized: key,
      suggested_category: entry.suggested,
      product_count: entry.products.size,
      missing_count: entry.missing,
      sample_titles: entry.titles,
      sample_skus: entry.skus,
      current_jomashop_category:
        override?.jomashopCategory ?? builtIn ?? null,
      current_override_notes:
        override?.notes ??
        (builtIn ? "built-in default (override to change)" : null),
      jomashop_schema_loaded: entry.schemaLoaded,
      ambiguous: entry.ambiguous,
    });
  });
  rows.sort((a, b) => b.product_count - a.product_count);

  result.totalProducts = payload.mapped.length;
  result.uniqueCodes = rows.length;
  result.rows = rows;
  return result;
}

// ---------- Audit (embedded UI) ----------

export type CategoryAuditStatus =
  | "mapped" // operator-saved override resolves to a category present in live (or supported) list
  | "alias" // built-in default OR alias rewrite (Clothing → Apparel) drives the result
  | "unmapped" // no operator override, no built-in default — needs decision
  | "invalid"; // a mapping exists but the target is not in live Jomashop categories OR supported list

export type CategoryAuditRow = {
  shopify_category_code: string;
  shopify_category_code_normalized: string;
  product_count: number;
  missing_count: number;
  sample_titles: string[];
  sample_skus: string[];
  /** What the operator (or built-in) currently says the category should be.
   *  null when no mapping exists. */
  current_jomashop_category: string | null;
  /** Final category name after the canonical alias step (e.g. Clothing → Apparel). */
  resolved_jomashop_category: string | null;
  /** True when the canonical alias step changed the value. UI uses this to
   *  render "Clothing → Apparel" badges. */
  has_alias: boolean;
  alias_target: string | null;
  /** Where the mapping comes from. "operator" wins over "built-in". */
  source: "operator" | "built-in" | "none";
  status: CategoryAuditStatus;
  /** Human-readable explanation surfaced to the UI. */
  status_reason: string;
  suggested_category: string;
  ambiguous: boolean;
  jomashop_schema_loaded: boolean;
};

export type CategoryAuditResult = {
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  uniqueCodes: number;
  jomashopCategoriesAvailable: boolean;
  jomashopCategories: string[];
  /** Combined choice list for the inline dropdown — live categories when
   *  available, plus any SUPPORTED_CATEGORIES not already in the live list. */
  pickerCategories: string[];
  totals: {
    mapped: number;
    alias: number;
    unmapped: number;
    invalid: number;
    needsMapping: number; // unmapped + invalid (i.e. the "needs decision" bucket)
    productsAffectedNeedsMapping: number;
  };
  rows: CategoryAuditRow[];
};

/**
 * Pure helper: compute audit rows for a given aggregate + Jomashop category
 * list. Extracted so the unit tests can call it without spinning up Express.
 */
export function buildCategoryAuditRows(
  agg: CategoryAggregateResult,
): { rows: CategoryAuditRow[]; pickerCategories: string[] } {
  // Build the combined picker list — live Jomashop categories first (in their
  // original order), then any SUPPORTED_CATEGORIES not already present.
  const seen = new Set<string>();
  const pickerCategories: string[] = [];
  for (const name of agg.jomashopCategories) {
    const key = name.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      pickerCategories.push(name);
    }
  }
  for (const name of SUPPORTED_CATEGORIES) {
    const key = name.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      pickerCategories.push(name);
    }
  }

  const liveSet = new Set(
    agg.jomashopCategories.map((c) => c.toLowerCase().trim()),
  );
  const supportedSet = new Set(
    (SUPPORTED_CATEGORIES as readonly string[]).map((c) => c.toLowerCase().trim()),
  );

  const rows: CategoryAuditRow[] = agg.rows.map((r) => {
    const current = r.current_jomashop_category;
    // The override notes column on the aggregate row tells us which source
    // provided the mapping. We re-check the storage layer indirectly via the
    // built-in table to determine the precise source.
    const builtInDefault = BUILT_IN_CATEGORY_OVERRIDES[r.shopify_category_code_normalized] ?? null;
    let source: CategoryAuditRow["source"];
    if (current && builtInDefault && current === builtInDefault && !r.current_override_notes?.startsWith("built-in")) {
      // Ambiguous — could be either. Default to operator when notes don't say built-in.
      source = "operator";
    } else if (current && builtInDefault && current === builtInDefault) {
      source = "built-in";
    } else if (current) {
      source = "operator";
    } else {
      source = "none";
    }

    // Apply the canonical alias step (Clothing → Apparel etc.) to surface the
    // value that actually lands in live calls.
    const canonical = current ? canonicalJomashopCategory(current) : null;
    const hasAlias = Boolean(current && canonical && canonical !== current);
    const aliasTarget = hasAlias ? (canonical as string) : null;
    const resolved = canonical;

    let status: CategoryAuditStatus;
    let statusReason: string;
    if (!current) {
      status = "unmapped";
      statusReason = "No Jomashop category mapping for this Shopify code yet.";
    } else {
      // Validate against live list (if available) or supported list.
      const finalLower = (resolved ?? current).toLowerCase().trim();
      const inLive = liveSet.size > 0 && liveSet.has(finalLower);
      const inSupported = supportedSet.has(finalLower);
      const known = agg.jomashopCategoriesAvailable ? inLive : inSupported;
      if (!known) {
        status = "invalid";
        statusReason = agg.jomashopCategoriesAvailable
          ? `"${resolved ?? current}" is not in the live Jomashop categories list.`
          : `"${resolved ?? current}" is not in the supported categories list and live list is unavailable.`;
      } else if (hasAlias) {
        status = "alias";
        statusReason = `Resolves via alias: ${current} → ${aliasTarget}.`;
      } else if (source === "built-in") {
        status = "alias";
        statusReason = `Using built-in default mapping (${current}). Override to change.`;
      } else {
        status = "mapped";
        statusReason = `Saved mapping → ${current}.`;
      }
    }

    return {
      shopify_category_code: r.shopify_category_code,
      shopify_category_code_normalized: r.shopify_category_code_normalized,
      product_count: r.product_count,
      missing_count: r.missing_count,
      sample_titles: r.sample_titles,
      sample_skus: r.sample_skus,
      current_jomashop_category: current,
      resolved_jomashop_category: resolved,
      has_alias: hasAlias,
      alias_target: aliasTarget,
      source,
      status,
      status_reason: statusReason,
      suggested_category: r.suggested_category,
      ambiguous: r.ambiguous,
      jomashop_schema_loaded: r.jomashop_schema_loaded,
    };
  });
  return { rows, pickerCategories };
}

/**
 * Build the full audit response (consumed by `GET /api/category-mapping/audit`
 * and by the unit tests).
 */
export async function buildCategoryAudit(): Promise<CategoryAuditResult> {
  const agg = await aggregateCategoryCodes();
  const { rows, pickerCategories } = buildCategoryAuditRows(agg);
  const totals = {
    mapped: 0,
    alias: 0,
    unmapped: 0,
    invalid: 0,
    needsMapping: 0,
    productsAffectedNeedsMapping: 0,
  };
  for (const r of rows) {
    totals[r.status] += 1;
    if (r.status === "unmapped" || r.status === "invalid") {
      totals.needsMapping += 1;
      totals.productsAffectedNeedsMapping += r.product_count;
    }
  }
  return {
    shopDomain: agg.shopDomain,
    fromCache: agg.fromCache,
    cachedAt: agg.cachedAt,
    totalProducts: agg.totalProducts,
    uniqueCodes: agg.uniqueCodes,
    jomashopCategoriesAvailable: agg.jomashopCategoriesAvailable,
    jomashopCategories: agg.jomashopCategories,
    pickerCategories,
    totals,
    rows,
  };
}

/**
 * Re-export so the audit/save endpoints can use the same alias as the
 * canonical resolver. Kept here to avoid cross-server imports inside tests.
 */
export const CATEGORY_CANONICAL_ALIASES = CANONICAL_JOMASHOP_CATEGORY_ALIASES;

// ---------- XLSX export ----------

const EXPORT_COLUMNS = [
  { header: "shopify_category_code", key: "shopify_category_code", width: 28 },
  { header: "suggested_category", key: "suggested_category", width: 22 },
  { header: "product_count", key: "product_count", width: 14 },
  { header: "sample_titles", key: "sample_titles", width: 52 },
  { header: "sample_skus", key: "sample_skus", width: 32 },
  { header: "current_jomashop_category", key: "current_jomashop_category", width: 24 },
  { header: "jomashop_category_to_use", key: "jomashop_category_to_use", width: 24 },
  { header: "notes", key: "notes", width: 32 },
] as const;

async function buildCategoryMappingWorkbook(
  agg: CategoryAggregateResult,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LuxeSupply Category Mapping";
  wb.created = new Date();

  const ws = wb.addWorksheet("Category Mapping", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", horizontal: "center" };

  // Identifier columns (locked-looking): orange. Editable target: green.
  // Status columns: purple.
  const IDENT_COLS = new Set([
    "shopify_category_code",
    "suggested_category",
    "product_count",
    "sample_titles",
    "sample_skus",
    "current_jomashop_category",
  ]);
  for (let i = 1; i <= EXPORT_COLUMNS.length; i++) {
    const colKey = EXPORT_COLUMNS[i - 1].key;
    const cell = header.getCell(i);
    if (IDENT_COLS.has(colKey)) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE0B2" } };
      cell.note = "Identifier / context column — do not edit.";
    } else if (colKey === "jomashop_category_to_use") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8E6C9" } };
      cell.note = "Fill this with the Jomashop category name to apply for this Shopify code.";
    } else {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE1BEE7" } };
    }
  }

  for (const r of agg.rows) {
    ws.addRow({
      shopify_category_code: r.shopify_category_code,
      suggested_category: r.suggested_category,
      product_count: r.product_count,
      sample_titles: r.sample_titles.join(" | "),
      sample_skus: r.sample_skus.join(", "),
      current_jomashop_category: r.current_jomashop_category ?? "",
      jomashop_category_to_use: r.current_jomashop_category ?? "",
      notes: r.current_override_notes ?? "",
    });
  }
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: EXPORT_COLUMNS.length },
  };

  // Second sheet listing Jomashop category names — both as reference for the
  // operator and as the source list for the dropdown on the mapping sheet.
  const catSheet = wb.addWorksheet("Jomashop Categories");
  catSheet.columns = [{ header: "name", key: "name", width: 40 }];
  catSheet.getRow(1).font = { bold: true };
  for (const name of agg.jomashopCategories) {
    catSheet.addRow({ name });
  }

  // Data validation dropdown for jomashop_category_to_use referencing the
  // Categories sheet. ExcelJS supports list validation via formulae — we
  // point at the named range on the second sheet.
  const lastDataRow = Math.max(agg.rows.length + 1, 2);
  const targetColIdx =
    EXPORT_COLUMNS.findIndex((c) => c.key === "jomashop_category_to_use") + 1;
  if (targetColIdx > 0 && agg.jomashopCategories.length > 0) {
    const letter = ws.getColumn(targetColIdx).letter;
    const range = `'Jomashop Categories'!$A$2:$A$${agg.jomashopCategories.length + 1}`;
    for (let r = 2; r <= lastDataRow; r++) {
      ws.getCell(`${letter}${r}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [range],
      };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------- XLSX upload / dry-run ----------

type ParsedMappingRow = {
  rowNumber: number;
  shopify_category_code: string;
  shopify_category_code_normalized: string;
  jomashop_category_to_use: string;
  notes: string;
  errors: string[];
  unknown_jomashop_category: boolean;
  is_clear: boolean;
  product_count_estimate: number;
};

async function parseCategoryMappingUpload(
  buffer: Buffer,
  jomashopCategoryNames: string[],
  productCountByCode: Map<string, number>,
): Promise<{ rows: ParsedMappingRow[]; headerErrors: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws =
    wb.getWorksheet("Category Mapping") ||
    wb.worksheets.find((w) => w.name !== "Jomashop Categories") ||
    wb.worksheets[0];
  if (!ws) {
    return { rows: [], headerErrors: ["No worksheet found in uploaded file."] };
  }
  const header = ws.getRow(1);
  const headerByCol: Record<number, string> = {};
  header.eachCell((cell, col) => {
    headerByCol[col] = String(cell.value ?? "").trim();
  });
  const headerErrors: string[] = [];
  for (const required of ["shopify_category_code", "jomashop_category_to_use"]) {
    if (!Object.values(headerByCol).includes(required)) {
      headerErrors.push(`Missing required column: ${required}`);
    }
  }

  const liveLower = new Set(jomashopCategoryNames.map((s) => s.toLowerCase()));

  const get = (wsRow: ReturnType<typeof ws.getRow>, key: string): string => {
    const col = Object.entries(headerByCol).find(([, name]) => name === key);
    if (!col) return "";
    const cell = wsRow.getCell(Number(col[0]));
    const v = cell.value;
    if (v === null || v === undefined) return "";
    if (typeof v === "object" && "richText" in (v as any)) {
      return ((v as any).richText as Array<{ text: string }>).map((t) => t.text).join("");
    }
    if (typeof v === "object" && "text" in (v as any)) {
      return String((v as any).text ?? "");
    }
    return String(v).trim();
  };

  const rows: ParsedMappingRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const wsRow = ws.getRow(r);
    if (!wsRow || !wsRow.hasValues) continue;
    const code = get(wsRow, "shopify_category_code");
    const target = get(wsRow, "jomashop_category_to_use");
    const notes = get(wsRow, "notes");
    if (!code && !target) continue;
    const norm = normalizeCategoryCode(code);
    const errors: string[] = [];
    if (!code) errors.push("Missing shopify_category_code");
    const isClear = target.trim() === "";
    const unknown =
      !isClear && jomashopCategoryNames.length > 0 && !liveLower.has(target.trim().toLowerCase());
    rows.push({
      rowNumber: r,
      shopify_category_code: code,
      shopify_category_code_normalized: norm,
      jomashop_category_to_use: target,
      notes,
      errors,
      unknown_jomashop_category: unknown,
      is_clear: isClear,
      product_count_estimate: productCountByCode.get(norm) ?? 0,
    });
  }
  return { rows, headerErrors };
}

// In-memory session store for the apply step — mirrors bulk_repair.ts.
type CategoryMappingSession = {
  id: string;
  createdAt: number;
  rows: ParsedMappingRow[];
};
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSIONS = new Map<string, CategoryMappingSession>();

function newSessionId(): string {
  return crypto.randomBytes(16).toString("hex");
}
function gcSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const stale: string[] = [];
  SESSIONS.forEach((s, id) => {
    if (s.createdAt < cutoff) stale.push(id);
  });
  for (const id of stale) SESSIONS.delete(id);
  while (SESSIONS.size > MAX_CATEGORY_MAPPING_SESSIONS) {
    const oldest = SESSIONS.keys().next();
    if (oldest.done) break;
    SESSIONS.delete(oldest.value);
  }
}

// ---------- Override application helpers ----------

/**
 * Look up the override for a given Shopify category code.
 *
 * Precedence:
 *   1. Operator-saved row in `category_overrides` (SQLite, Excel-driven).
 *   2. Built-in seed mapping shipped with the tool (BUILT_IN_CATEGORY_OVERRIDES).
 *
 * Used by buildPreview to flip readiness without a full Shopify re-fetch.
 * Returns null only when neither source has a mapping.
 */
export function lookupCategoryOverride(
  rawCategory: string | null | undefined,
): {
  jomashopCategory: string;
  supportedCategory: SupportedCategory | null;
  source: "operator" | "built-in";
} | null {
  const norm = normalizeCategoryCode(rawCategory);
  if (!norm) return null;
  const row = storage.getCategoryOverride(norm);
  if (row) {
    return {
      jomashopCategory: row.jomashopCategory,
      supportedCategory: coerceJomashopToSupported(row.jomashopCategory),
      source: "operator",
    };
  }
  const builtIn = lookupBuiltInCategoryDefault(rawCategory);
  if (builtIn) {
    return {
      jomashopCategory: builtIn,
      supportedCategory: coerceJomashopToSupported(builtIn),
      source: "built-in",
    };
  }
  return null;
}

// Re-export the built-in table so callers (e.g. XLSX export) can surface the
// default mapped category alongside operator-saved rows.
export { BUILT_IN_CATEGORY_OVERRIDES };

// ---------- Route registration ----------

export function registerCategoryMappingRoutes(app: Express): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  // GET: aggregated list of Shopify category codes (cached preview based).
  app.get("/api/category-mapping/aggregate", async (_req, res) => {
    try {
      const result = await aggregateCategoryCodes();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // GET: download XLSX (export).
  app.get("/api/category-mapping/export.xlsx", async (_req, res) => {
    try {
      const agg = await aggregateCategoryCodes();
      if (!agg.shopDomain) {
        return res.status(503).json({
          ok: false,
          error: "No connected Shopify store. Complete OAuth install first.",
        });
      }
      if (agg.rows.length === 0) {
        return res.status(409).json({
          ok: false,
          error:
            "No category codes found in the cached preview. Click Refresh from Shopify first, then re-export.",
        });
      }
      const buf = await buildCategoryMappingWorkbook(agg);
      const filename = `category-mapping-${agg.shopDomain.replace(/\.myshopify\.com$/, "")}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Export-Rows", String(agg.rows.length));
      res.setHeader("X-Export-Shop", agg.shopDomain);
      storage.appendLog({
        level: "info",
        message: `Exported category mapping XLSX (${agg.rows.length} code(s)) for ${agg.shopDomain}`,
        detailsJson: JSON.stringify({ unique: agg.uniqueCodes, total: agg.totalProducts }),
        createdAt: Date.now(),
      });
      res.end(buf);
    } catch (err) {
      const msg = (err as Error).message;
      storage.appendLog({
        level: "error",
        message: `Category mapping XLSX export failed: ${msg}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST: dry-run upload preview.
  app.post(
    "/api/category-mapping/import-preview",
    upload.single("file"),
    async (req, res) => {
      gcSessions();
      const file = req.file;
      if (!file) {
        return res.status(400).json({ ok: false, error: "Missing uploaded file." });
      }
      try {
        const agg = await aggregateCategoryCodes();
        const productCountByCode = new Map<string, number>();
        for (const r of agg.rows) {
          productCountByCode.set(r.shopify_category_code_normalized, r.product_count);
        }
        const { rows, headerErrors } = await parseCategoryMappingUpload(
          file.buffer,
          agg.jomashopCategories,
          productCountByCode,
        );
        if (rejectIfTooManyRows(res, rows.length, MAX_IMPORT_ROWS)) {
          return;
        }
        const validRows = rows.filter((r) => r.errors.length === 0 && !r.is_clear);
        const errorRows = rows.filter((r) => r.errors.length > 0);
        const clearRows = rows.filter((r) => r.is_clear && r.errors.length === 0);
        const unknownRows = validRows.filter((r) => r.unknown_jomashop_category);
        const affectedProducts = validRows.reduce(
          (sum, r) => sum + (r.product_count_estimate || 0),
          0,
        );

        const sessionId = newSessionId();
        SESSIONS.set(sessionId, { id: sessionId, createdAt: Date.now(), rows });

        storage.appendLog({
          level: "info",
          message: `Category mapping preview parsed ${rows.length} row(s)`,
          detailsJson: JSON.stringify({
            sessionId,
            valid: validRows.length,
            errors: errorRows.length,
            unknown: unknownRows.length,
            clear: clearRows.length,
            affectedProducts,
          }),
          createdAt: Date.now(),
        });

        res.json({
          ok: headerErrors.length === 0,
          sessionId,
          headerErrors,
          jomashopCategoriesAvailable: agg.jomashopCategoriesAvailable,
          jomashopCategories: agg.jomashopCategories,
          totals: {
            total: rows.length,
            valid: validRows.length,
            errors: errorRows.length,
            unknownCategory: unknownRows.length,
            clear: clearRows.length,
            affectedProducts,
          },
          rows: rows.map((r) => ({
            rowNumber: r.rowNumber,
            shopify_category_code: r.shopify_category_code,
            shopify_category_code_normalized: r.shopify_category_code_normalized,
            jomashop_category_to_use: r.jomashop_category_to_use,
            notes: r.notes,
            errors: r.errors,
            unknown_jomashop_category: r.unknown_jomashop_category,
            is_clear: r.is_clear,
            product_count_estimate: r.product_count_estimate,
          })),
        });
      } catch (err) {
        const msg = (err as Error).message;
        res.status(400).json({ ok: false, error: `Could not parse XLSX: ${msg}` });
      }
    },
  );

  // POST: apply (write to SQLite). Requires confirm + sessionId.
  app.post("/api/category-mapping/apply", async (req, res) => {
    gcSessions();
    const { sessionId, confirm, allowUnknown } = (req.body ?? {}) as {
      sessionId?: string;
      confirm?: boolean;
      allowUnknown?: boolean;
    };
    if (!confirm) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing confirmation. Set `confirm: true` to acknowledge this will save category overrides.",
      });
    }
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "Missing sessionId." });
    }
    const session = SESSIONS.get(sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ ok: false, error: "Session not found or expired. Re-upload the XLSX." });
    }
    const validRows = session.rows.filter((r) => r.errors.length === 0 && !r.is_clear);
    if (validRows.length === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "No valid rows to apply. Fill jomashop_category_to_use for at least one code and re-upload.",
      });
    }
    if (!allowUnknown && validRows.some((r) => r.unknown_jomashop_category)) {
      const unknowns = validRows
        .filter((r) => r.unknown_jomashop_category)
        .map((r) => `${r.shopify_category_code} → ${r.jomashop_category_to_use}`);
      return res.status(409).json({
        ok: false,
        error:
          "Some rows reference Jomashop categories not in the live category list. Re-upload after fixing, or set `allowUnknown: true` to apply anyway.",
        unknowns,
      });
    }
    const clearRows = session.rows.filter((r) => r.is_clear && r.shopify_category_code_normalized);

    const applied: Array<{ code: string; category: string }> = [];
    for (const r of validRows) {
      storage.upsertCategoryOverride({
        shopifyCategoryCode: r.shopify_category_code_normalized,
        jomashopCategory: r.jomashop_category_to_use.trim(),
        notes: r.notes || null,
        updatedAt: Date.now(),
      });
      applied.push({ code: r.shopify_category_code_normalized, category: r.jomashop_category_to_use });
    }
    for (const r of clearRows) {
      storage.deleteCategoryOverride(r.shopify_category_code_normalized);
    }

    // Invalidate the product cache for the connected shop so the next preview
    // load re-runs readiness with the new overrides applied.
    const conn = getActiveShopifyConnection();
    const shopDomain =
      conn?.shopDomain ??
      storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
      null;
    if (shopDomain) {
      try {
        storage.clearProductCache(shopDomain);
      } catch {
        // non-fatal — cache will be rebuilt on next refresh
      }
    }

    storage.appendLog({
      level: "info",
      message: `Saved ${applied.length} category override(s); cleared ${clearRows.length}`,
      detailsJson: JSON.stringify({ applied, cleared: clearRows.map((r) => r.shopify_category_code_normalized) }),
      createdAt: Date.now(),
    });

    SESSIONS.delete(sessionId);
    res.json({
      ok: true,
      applied: applied.length,
      cleared: clearRows.length,
      shopDomain,
      cacheInvalidated: Boolean(shopDomain),
      note: shopDomain
        ? "Saved. Click Refresh from Shopify on the Products page to recompute readiness."
        : "Saved.",
    });
  });

  // GET: list of currently saved overrides for the compact UI table.
  app.get("/api/category-mapping/overrides", (_req, res) => {
    const overrides = storage.listCategoryOverrides();
    res.json({
      ok: true,
      count: overrides.length,
      overrides: overrides.map((o) => ({
        shopify_category_code: o.shopifyCategoryCode,
        jomashop_category: o.jomashopCategory,
        notes: o.notes,
        updated_at: o.updatedAt,
      })),
    });
  });

  // GET: embedded audit — lists every distinct Shopify code with its status
  // (mapped / alias / unmapped / invalid), affected products, and the picker
  // list for the inline dropdown.
  app.get("/api/category-mapping/audit", async (_req, res) => {
    try {
      const result = await buildCategoryAudit();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // POST: inline save — single or batch. Body shape:
  //   { mappings: [{ shopify_category_code, jomashop_category, notes? }, ...] }
  // Each non-empty target is upserted; empty target deletes the override.
  // Cache is invalidated once at the end. Unknown Jomashop categories (not
  // in the live list) are rejected unless { allowUnknown: true } is set.
  app.post("/api/category-mapping/save", async (req, res) => {
    const body = (req.body ?? {}) as {
      mappings?: Array<{
        shopify_category_code?: string;
        jomashop_category?: string;
        notes?: string | null;
      }>;
      allowUnknown?: boolean;
    };
    const mappings = Array.isArray(body.mappings) ? body.mappings : [];
    if (mappings.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "No mappings supplied. Send at least one entry." });
    }
    if (mappings.length > MAX_IMPORT_ROWS) {
      return res
        .status(400)
        .json({ ok: false, error: `Too many mappings — limit is ${MAX_IMPORT_ROWS}.` });
    }

    // Resolve the live Jomashop category list once for validation.
    let liveCategories: string[] = [];
    try {
      const live = await getCategories();
      if (live.ok) {
        const raw = live.data as unknown;
        const arr =
          (Array.isArray(raw) ? raw : (raw as { data?: unknown }).data) ||
          (raw as { categories?: unknown }).categories;
        if (Array.isArray(arr)) {
          liveCategories = arr
            .map((c) => (typeof c === "string" ? c : (c as { name?: string }).name))
            .filter((s): s is string => Boolean(s));
        }
      }
    } catch {
      // best-effort
    }
    const liveLower = new Set(liveCategories.map((c) => c.toLowerCase().trim()));
    const supportedLower = new Set(
      (SUPPORTED_CATEGORIES as readonly string[]).map((c) => c.toLowerCase().trim()),
    );
    const knownSet = liveLower.size > 0 ? liveLower : supportedLower;

    const applied: Array<{ code: string; category: string }> = [];
    const cleared: string[] = [];
    const unknown: Array<{ code: string; category: string }> = [];
    const errors: Array<{ code: string; error: string }> = [];

    for (const m of mappings) {
      const codeRaw = m.shopify_category_code ?? "";
      const norm = normalizeCategoryCode(codeRaw);
      if (!norm) {
        errors.push({ code: codeRaw, error: "Missing or empty shopify_category_code." });
        continue;
      }
      const target = (m.jomashop_category ?? "").trim();
      if (target === "") {
        storage.deleteCategoryOverride(norm);
        cleared.push(norm);
        continue;
      }
      const isKnown = knownSet.has(target.toLowerCase().trim());
      if (!isKnown && !body.allowUnknown) {
        unknown.push({ code: norm, category: target });
        continue;
      }
      storage.upsertCategoryOverride({
        shopifyCategoryCode: norm,
        jomashopCategory: target,
        notes: m.notes ?? null,
        updatedAt: Date.now(),
      });
      applied.push({ code: norm, category: target });
    }

    // Invalidate cache so the next preview shows the new resolution.
    const conn = getActiveShopifyConnection();
    const shopDomain =
      conn?.shopDomain ??
      storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
      null;
    if (shopDomain && (applied.length > 0 || cleared.length > 0)) {
      try {
        storage.clearProductCache(shopDomain);
      } catch {
        // non-fatal
      }
    }

    storage.appendLog({
      level: applied.length > 0 || cleared.length > 0 ? "info" : "warn",
      message: `Inline category mapping save: applied ${applied.length}, cleared ${cleared.length}, unknown ${unknown.length}, errors ${errors.length}`,
      detailsJson: JSON.stringify({ applied, cleared, unknown, errors }),
      createdAt: Date.now(),
    });

    if (unknown.length > 0 && !body.allowUnknown) {
      return res.status(409).json({
        ok: false,
        applied: applied.length,
        cleared: cleared.length,
        unknown,
        errors,
        shopDomain,
        cacheInvalidated: Boolean(shopDomain) && (applied.length > 0 || cleared.length > 0),
        error:
          "One or more mappings reference Jomashop categories not in the live list. Re-submit with `allowUnknown: true` to save anyway, or pick a value from the live list.",
      });
    }

    res.json({
      ok: errors.length === 0,
      applied: applied.length,
      cleared: cleared.length,
      unknown,
      errors,
      shopDomain,
      cacheInvalidated: Boolean(shopDomain) && (applied.length > 0 || cleared.length > 0),
      note:
        shopDomain && (applied.length > 0 || cleared.length > 0)
          ? "Saved. Click Refresh from Shopify on the Products page to recompute readiness."
          : "Saved.",
    });
  });

  // DELETE: remove a single override (used by inline "remove" button).
  app.delete("/api/category-mapping/overrides/:code", (req, res) => {
    const norm = normalizeCategoryCode(req.params.code);
    if (!norm) return res.status(400).json({ ok: false, error: "Missing code" });
    storage.deleteCategoryOverride(norm);
    // Invalidate cache so the change takes effect on next preview.
    const conn = getActiveShopifyConnection();
    const shopDomain =
      conn?.shopDomain ??
      storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
      null;
    if (shopDomain) {
      try {
        storage.clearProductCache(shopDomain);
      } catch {
        // non-fatal
      }
    }
    res.json({ ok: true, removed: norm, cacheInvalidated: Boolean(shopDomain) });
  });
}

export type { ParsedMappingRow };
