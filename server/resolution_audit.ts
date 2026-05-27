// Brand & category resolution audit.
//
// Walks the cached product preview (the one served from /api/products/cache)
// and aggregates every distinct Shopify brand and every distinct Shopify
// category code, then resolves each one against the live Jomashop
// /i1/manufacturers and /i1/categories lists. The audit answers a single
// question for every distinct value: will the next push for this brand /
// category succeed without operator intervention?
//
// Pure aggregation — no Shopify or Jomashop writes happen here. The apply
// endpoint writes operator-supplied targets into the existing
// brand_overrides / category_overrides tables so the existing resolver
// precedence (operator → built-in → raw) automatically picks them up.

import crypto from "node:crypto";
import ExcelJS from "exceljs";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { storage } from "./storage";
import {
  getCategoriesI1,
  getManufacturers,
  type JomashopCategoryRecord,
  type JomashopManufacturer,
} from "./jomashop";
import {
  BUILT_IN_CATEGORY_OVERRIDES,
  lookupCategoryOverride,
} from "./category_mapping";
import {
  BUILT_IN_BRAND_OVERRIDES,
  lookupBrandOverride,
  normalizeBrandKey,
} from "./brand_mapping";
import { normalizeCategoryCode, type MappedProduct } from "./mapping";
import { getActiveShopifyConnection } from "./shopify";
import {
  MAX_IMPORT_ROWS,
  rejectIfTooManyRows,
} from "./stability";

const MAX_AUDIT_SESSIONS = 8;

// ---------- Types ----------

export type BrandAuditRow = {
  shopify_brand: string;
  shopify_brand_normalized: string;
  product_count: number;
  sample_titles: string[];
  sample_skus: string[];
  /** Operator override (from brand_overrides table), if any. */
  current_override: string | null;
  current_override_source: "operator" | "built-in" | null;
  /** Brand string actually sent to Jomashop on next push (override → raw). */
  outbound_brand: string;
  /** Live /i1/manufacturers exact match for outbound_brand. */
  exact_match: { id: number | string; name: string } | null;
  /** Closest fuzzy suggestion when no exact match. */
  suggestion: { id: number | string; name: string } | null;
  suggestion_distance: number | null;
  /** "exact" | "override" (override present and matches) | "fuzzy" | "unresolved". */
  status: "exact" | "override" | "fuzzy" | "unresolved";
};

export type CategoryAuditRow = {
  shopify_category_code: string;
  shopify_category_code_normalized: string;
  /** Suggested mapped Jomashop category from heuristics (preview's suggested_category). */
  suggested_category: string;
  product_count: number;
  sample_titles: string[];
  sample_skus: string[];
  current_override: string | null;
  current_override_source: "operator" | "built-in" | null;
  outbound_category: string;
  exact_match: { id: number | string; name: string } | null;
  suggestion: { id: number | string; name: string } | null;
  suggestion_distance: number | null;
  status: "exact" | "override" | "fuzzy" | "unresolved";
};

export type ResolutionAuditResult = {
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  i1Available: boolean;
  jomashopManufacturers: Array<{ id: number | string; name: string }>;
  jomashopCategories: Array<{ id: number | string; name: string }>;
  brandRows: BrandAuditRow[];
  categoryRows: CategoryAuditRow[];
  summary: {
    distinctBrands: number;
    unresolvedBrands: number;
    fuzzyBrands: number;
    exactBrands: number;
    overrideBrands: number;
    distinctCategories: number;
    unresolvedCategories: number;
    fuzzyCategories: number;
    exactCategories: number;
    overrideCategories: number;
    totalProducts: number;
    notReadyProducts: number;
  };
  /** Warning surfaced when /i1 calls failed (audit still returns whatever it could). */
  warnings: string[];
};

// ---------- Helpers ----------

function brandLookupKey(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev;
      else dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function bestFuzzyMatch<T extends { name: string; id: number | string }>(
  queryKey: string,
  items: T[],
): { item: T | null; distance: number } {
  if (!queryKey) return { item: null, distance: Infinity };
  let bestItem: T | null = null;
  let bestDist = Infinity;
  for (const it of items) {
    const k = brandLookupKey(it.name);
    if (!k || k === queryKey) continue;
    const d = editDistance(k, queryKey);
    if (d < bestDist) {
      bestDist = d;
      bestItem = it;
    }
  }
  const maxAllowed = Math.max(2, Math.ceil(queryKey.length * 0.25));
  if (bestItem && bestDist > maxAllowed) return { item: null, distance: bestDist };
  return { item: bestItem, distance: bestDist };
}

function pickActiveShopDomain(): string | null {
  const conn = getActiveShopifyConnection();
  if (conn?.shopDomain) return conn.shopDomain;
  const fromDb = storage.listStores().find((s) => s.oauthStatus === "connected");
  return fromDb?.shopDomain ?? null;
}

// ---------- Core aggregation ----------

export async function runResolutionAudit(): Promise<ResolutionAuditResult> {
  const warnings: string[] = [];
  const shopDomain = pickActiveShopDomain();

  // Live Jomashop lookup tables.
  const i1Mfg = await getManufacturers().catch((e: Error) => {
    warnings.push(`getManufacturers failed: ${e.message}`);
    return null;
  });
  const i1Cat = await getCategoriesI1().catch((e: Error) => {
    warnings.push(`getCategoriesI1 failed: ${e.message}`);
    return null;
  });
  if (i1Mfg && !i1Mfg.ok) warnings.push(`/i1/manufacturers: ${i1Mfg.error}`);
  if (i1Cat && !i1Cat.ok) warnings.push(`/i1/categories: ${i1Cat.error}`);

  const manufacturers: JomashopManufacturer[] =
    i1Mfg && i1Mfg.ok ? i1Mfg.items : [];
  const categories: JomashopCategoryRecord[] = i1Cat && i1Cat.ok ? i1Cat.items : [];
  const mfgByKey = new Map<string, JomashopManufacturer>();
  for (const m of manufacturers) {
    const k = brandLookupKey(m.name);
    if (k) mfgByKey.set(k, m);
  }
  const catByKey = new Map<string, JomashopCategoryRecord>();
  for (const c of categories) {
    const k = brandLookupKey(c.name);
    if (k) catByKey.set(k, c);
  }
  const i1Available = mfgByKey.size > 0 || catByKey.size > 0;

  // Read cached preview.
  const cached = shopDomain ? storage.getProductCache(shopDomain) : undefined;
  let mapped: Array<MappedProduct & { readiness?: string }> = [];
  if (cached) {
    try {
      const payload = JSON.parse(cached.payloadJson);
      if (payload && Array.isArray(payload.mapped)) mapped = payload.mapped;
    } catch (err) {
      warnings.push(`Could not parse cached preview: ${(err as Error).message}`);
    }
  }

  // --- Aggregate brands ---
  type BrandBucket = {
    raw: string;
    productIds: Set<string>;
    titles: string[];
    skus: string[];
  };
  const brandsByKey = new Map<string, BrandBucket>();
  // --- Aggregate categories ---
  type CategoryBucket = {
    raw: string;
    suggested: string;
    productIds: Set<string>;
    titles: string[];
    skus: string[];
  };
  const catsByKey = new Map<string, CategoryBucket>();

  let notReadyProducts = 0;

  for (const m of mapped) {
    const rawBrand = (m.brand || "").toString();
    const brandKey = brandLookupKey(rawBrand) || "__blank__";
    let bb = brandsByKey.get(brandKey);
    if (!bb) {
      bb = { raw: rawBrand || "(blank)", productIds: new Set(), titles: [], skus: [] };
      brandsByKey.set(brandKey, bb);
    }
    const pid =
      m.source?.shopify_product_id != null
        ? String(m.source.shopify_product_id)
        : m.vendor_sku || m.name;
    bb.productIds.add(String(pid));
    if (bb.titles.length < 5 && m.name) bb.titles.push(m.name);
    if (bb.skus.length < 5 && m.vendor_sku) bb.skus.push(m.vendor_sku);

    const rawCode = (m.raw_category || "").toString();
    const catKey = normalizeCategoryCode(rawCode) || rawCode.toLowerCase() || "__blank__";
    let cb = catsByKey.get(catKey);
    if (!cb) {
      cb = {
        raw: rawCode || "(blank)",
        suggested: m.suggested_category || rawCode || "",
        productIds: new Set(),
        titles: [],
        skus: [],
      };
      catsByKey.set(catKey, cb);
    }
    cb.productIds.add(String(pid));
    if (cb.titles.length < 5 && m.name) cb.titles.push(m.name);
    if (cb.skus.length < 5 && m.vendor_sku) cb.skus.push(m.vendor_sku);

    if (m.readiness && m.readiness !== "ready" && m.readiness !== "sample") {
      notReadyProducts += 1;
    }
  }

  // --- Build brand rows ---
  const brandRows: BrandAuditRow[] = [];
  brandsByKey.forEach((bucket, key) => {
    const override = lookupBrandOverride(bucket.raw);
    const outbound = (override?.jomashopBrand || bucket.raw).trim();
    const outboundKey = brandLookupKey(outbound);
    const exact = outboundKey ? mfgByKey.get(outboundKey) ?? null : null;
    let suggestion: JomashopManufacturer | null = null;
    let suggestionDistance: number | null = null;
    if (!exact && manufacturers.length > 0 && outboundKey) {
      const fuzz = bestFuzzyMatch(outboundKey, manufacturers);
      suggestion = fuzz.item;
      suggestionDistance = fuzz.item ? fuzz.distance : null;
    }
    let status: BrandAuditRow["status"];
    if (exact && override) status = "override";
    else if (exact) status = "exact";
    else if (suggestion) status = "fuzzy";
    else status = "unresolved";

    brandRows.push({
      shopify_brand: bucket.raw,
      shopify_brand_normalized: key === "__blank__" ? "" : key,
      product_count: bucket.productIds.size,
      sample_titles: bucket.titles,
      sample_skus: bucket.skus,
      current_override: override?.jomashopBrand ?? null,
      current_override_source: override?.source ?? null,
      outbound_brand: outbound,
      exact_match: exact ? { id: exact.id, name: exact.name } : null,
      suggestion: suggestion ? { id: suggestion.id, name: suggestion.name } : null,
      suggestion_distance: suggestionDistance,
      status,
    });
  });
  brandRows.sort((a, b) => b.product_count - a.product_count);

  // --- Build category rows ---
  const categoryRows: CategoryAuditRow[] = [];
  catsByKey.forEach((bucket, key) => {
    const override = lookupCategoryOverride(bucket.raw);
    const outbound = (
      override?.jomashopCategory ||
      bucket.suggested ||
      bucket.raw ||
      ""
    ).trim();
    const outboundKey = brandLookupKey(outbound);
    const exact = outboundKey ? catByKey.get(outboundKey) ?? null : null;
    let suggestion: JomashopCategoryRecord | null = null;
    let suggestionDistance: number | null = null;
    if (!exact && categories.length > 0 && outboundKey) {
      const fuzz = bestFuzzyMatch(outboundKey, categories);
      suggestion = fuzz.item;
      suggestionDistance = fuzz.item ? fuzz.distance : null;
    }
    let status: CategoryAuditRow["status"];
    if (exact && override) status = "override";
    else if (exact) status = "exact";
    else if (suggestion) status = "fuzzy";
    else status = "unresolved";

    categoryRows.push({
      shopify_category_code: bucket.raw,
      shopify_category_code_normalized: key === "__blank__" ? "" : key,
      suggested_category: bucket.suggested,
      product_count: bucket.productIds.size,
      sample_titles: bucket.titles,
      sample_skus: bucket.skus,
      current_override: override?.jomashopCategory ?? null,
      current_override_source: override?.source ?? null,
      outbound_category: outbound,
      exact_match: exact ? { id: exact.id, name: exact.name } : null,
      suggestion: suggestion ? { id: suggestion.id, name: suggestion.name } : null,
      suggestion_distance: suggestionDistance,
      status,
    });
  });
  categoryRows.sort((a, b) => b.product_count - a.product_count);

  const summary = {
    distinctBrands: brandRows.length,
    unresolvedBrands: brandRows.filter((r) => r.status === "unresolved").length,
    fuzzyBrands: brandRows.filter((r) => r.status === "fuzzy").length,
    exactBrands: brandRows.filter((r) => r.status === "exact").length,
    overrideBrands: brandRows.filter((r) => r.status === "override").length,
    distinctCategories: categoryRows.length,
    unresolvedCategories: categoryRows.filter((r) => r.status === "unresolved").length,
    fuzzyCategories: categoryRows.filter((r) => r.status === "fuzzy").length,
    exactCategories: categoryRows.filter((r) => r.status === "exact").length,
    overrideCategories: categoryRows.filter((r) => r.status === "override").length,
    totalProducts: mapped.length,
    notReadyProducts,
  };

  return {
    shopDomain,
    fromCache: Boolean(cached),
    cachedAt: cached?.fetchedAt ?? null,
    totalProducts: mapped.length,
    i1Available,
    jomashopManufacturers: manufacturers.map((m) => ({ id: m.id, name: m.name })),
    jomashopCategories: categories.map((c) => ({ id: c.id, name: c.name })),
    brandRows,
    categoryRows,
    summary,
    warnings,
  };
}

// ---------- XLSX export ----------

const BRAND_COLS = [
  { header: "shopify_brand", key: "shopify_brand", width: 28 },
  { header: "product_count", key: "product_count", width: 12 },
  { header: "sample_titles", key: "sample_titles", width: 52 },
  { header: "sample_skus", key: "sample_skus", width: 32 },
  { header: "current_override", key: "current_override", width: 22 },
  { header: "exact_match", key: "exact_match", width: 22 },
  { header: "suggested_jomashop_brand", key: "suggested_jomashop_brand", width: 24 },
  { header: "brand_to_use", key: "brand_to_use", width: 24 },
  { header: "status", key: "status", width: 14 },
  { header: "notes", key: "notes", width: 32 },
] as const;

const CATEGORY_COLS = [
  { header: "shopify_category_code", key: "shopify_category_code", width: 24 },
  { header: "suggested_category", key: "suggested_category", width: 22 },
  { header: "product_count", key: "product_count", width: 12 },
  { header: "sample_titles", key: "sample_titles", width: 52 },
  { header: "current_override", key: "current_override", width: 22 },
  { header: "exact_match", key: "exact_match", width: 22 },
  { header: "suggested_jomashop_category", key: "suggested_jomashop_category", width: 24 },
  { header: "category_to_use", key: "category_to_use", width: 24 },
  { header: "status", key: "status", width: 14 },
  { header: "notes", key: "notes", width: 32 },
] as const;

export async function buildResolutionAuditWorkbook(
  audit: ResolutionAuditResult,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LuxeSupply Brand & Category Audit";
  wb.created = new Date();

  // ---- Sheet 1: Brand Mapping ----
  const brandSheet = wb.addWorksheet("Brand Mapping", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  brandSheet.columns = BRAND_COLS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
  }));
  const brandHeader = brandSheet.getRow(1);
  brandHeader.font = { bold: true };
  for (let i = 1; i <= BRAND_COLS.length; i++) {
    const colKey = BRAND_COLS[i - 1].key;
    const cell = brandHeader.getCell(i);
    if (colKey === "brand_to_use") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8E6C9" } };
      cell.note = "Fill with the exact Jomashop brand to use for this Shopify brand.";
    } else if (colKey === "notes") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE1BEE7" } };
    } else {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE0B2" } };
    }
  }
  for (const r of audit.brandRows) {
    const exactStr = r.exact_match ? `${r.exact_match.name} (#${r.exact_match.id})` : "";
    const sugg = r.suggestion ? `${r.suggestion.name} (#${r.suggestion.id})` : "";
    brandSheet.addRow({
      shopify_brand: r.shopify_brand,
      product_count: r.product_count,
      sample_titles: r.sample_titles.join(" | "),
      sample_skus: r.sample_skus.join(", "),
      current_override: r.current_override ?? "",
      exact_match: exactStr,
      suggested_jomashop_brand: sugg,
      brand_to_use:
        r.current_override ?? r.exact_match?.name ?? r.suggestion?.name ?? "",
      status: r.status,
      notes: "",
    });
  }
  brandSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: BRAND_COLS.length },
  };

  // ---- Sheet 2: Category Mapping ----
  const catSheet = wb.addWorksheet("Category Mapping", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  catSheet.columns = CATEGORY_COLS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
  }));
  const catHeader = catSheet.getRow(1);
  catHeader.font = { bold: true };
  for (let i = 1; i <= CATEGORY_COLS.length; i++) {
    const colKey = CATEGORY_COLS[i - 1].key;
    const cell = catHeader.getCell(i);
    if (colKey === "category_to_use") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8E6C9" } };
      cell.note = "Fill with the exact Jomashop category to use for this Shopify code.";
    } else if (colKey === "notes") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE1BEE7" } };
    } else {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE0B2" } };
    }
  }
  for (const r of audit.categoryRows) {
    const exactStr = r.exact_match ? `${r.exact_match.name} (#${r.exact_match.id})` : "";
    const sugg = r.suggestion ? `${r.suggestion.name} (#${r.suggestion.id})` : "";
    catSheet.addRow({
      shopify_category_code: r.shopify_category_code,
      suggested_category: r.suggested_category,
      product_count: r.product_count,
      sample_titles: r.sample_titles.join(" | "),
      current_override: r.current_override ?? "",
      exact_match: exactStr,
      suggested_jomashop_category: sugg,
      category_to_use:
        r.current_override ?? r.exact_match?.name ?? r.suggestion?.name ?? "",
      status: r.status,
      notes: "",
    });
  }
  catSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: CATEGORY_COLS.length },
  };

  // ---- Sheet 3: Jomashop Brands ----
  const mfgSheet = wb.addWorksheet("Jomashop Brands");
  mfgSheet.columns = [
    { header: "id", key: "id", width: 10 },
    { header: "name", key: "name", width: 40 },
  ];
  mfgSheet.getRow(1).font = { bold: true };
  for (const m of audit.jomashopManufacturers) {
    mfgSheet.addRow({ id: m.id, name: m.name });
  }

  // ---- Sheet 4: Jomashop Categories ----
  const catRefSheet = wb.addWorksheet("Jomashop Categories");
  catRefSheet.columns = [
    { header: "id", key: "id", width: 10 },
    { header: "name", key: "name", width: 40 },
  ];
  catRefSheet.getRow(1).font = { bold: true };
  for (const c of audit.jomashopCategories) {
    catRefSheet.addRow({ id: c.id, name: c.name });
  }

  // Dropdown validation for brand_to_use referencing Jomashop Brands sheet.
  if (audit.jomashopManufacturers.length > 0 && audit.brandRows.length > 0) {
    const colIdx = BRAND_COLS.findIndex((c) => c.key === "brand_to_use") + 1;
    if (colIdx > 0) {
      const letter = brandSheet.getColumn(colIdx).letter;
      const range = `'Jomashop Brands'!$B$2:$B$${audit.jomashopManufacturers.length + 1}`;
      const lastRow = audit.brandRows.length + 1;
      for (let r = 2; r <= lastRow; r++) {
        brandSheet.getCell(`${letter}${r}`).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [range],
        };
      }
    }
  }
  // Dropdown validation for category_to_use referencing Jomashop Categories sheet.
  if (audit.jomashopCategories.length > 0 && audit.categoryRows.length > 0) {
    const colIdx = CATEGORY_COLS.findIndex((c) => c.key === "category_to_use") + 1;
    if (colIdx > 0) {
      const letter = catSheet.getColumn(colIdx).letter;
      const range = `'Jomashop Categories'!$B$2:$B$${audit.jomashopCategories.length + 1}`;
      const lastRow = audit.categoryRows.length + 1;
      for (let r = 2; r <= lastRow; r++) {
        catSheet.getCell(`${letter}${r}`).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [range],
        };
      }
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------- XLSX import / dry-run ----------

export type ParsedAuditBrandRow = {
  rowNumber: number;
  shopify_brand: string;
  shopify_brand_normalized: string;
  brand_to_use: string;
  notes: string;
  errors: string[];
  unknown_jomashop_brand: boolean;
  is_clear: boolean;
};
export type ParsedAuditCategoryRow = {
  rowNumber: number;
  shopify_category_code: string;
  shopify_category_code_normalized: string;
  category_to_use: string;
  notes: string;
  errors: string[];
  unknown_jomashop_category: boolean;
  is_clear: boolean;
};

function readCellString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "richText" in (v as any)) {
    return ((v as any).richText as Array<{ text: string }>)
      .map((t) => t.text)
      .join("")
      .trim();
  }
  if (typeof v === "object" && "text" in (v as any)) {
    return String((v as any).text ?? "").trim();
  }
  return String(v).trim();
}

async function parseAuditUpload(
  buffer: Buffer,
  liveBrands: string[],
  liveCategories: string[],
): Promise<{
  brandRows: ParsedAuditBrandRow[];
  categoryRows: ParsedAuditCategoryRow[];
  headerErrors: string[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const headerErrors: string[] = [];
  const brandSheet = wb.getWorksheet("Brand Mapping");
  const catSheet = wb.getWorksheet("Category Mapping");
  if (!brandSheet && !catSheet) {
    headerErrors.push(
      "Neither 'Brand Mapping' nor 'Category Mapping' sheet found. Re-export and edit that workbook.",
    );
    return { brandRows: [], categoryRows: [], headerErrors };
  }

  const brandRows: ParsedAuditBrandRow[] = [];
  const categoryRows: ParsedAuditCategoryRow[] = [];

  const lowerBrands = new Set(liveBrands.map((s) => s.toLowerCase()));
  const lowerCats = new Set(liveCategories.map((s) => s.toLowerCase()));

  if (brandSheet) {
    const headerByCol: Record<number, string> = {};
    brandSheet.getRow(1).eachCell((cell, col) => {
      headerByCol[col] = String(cell.value ?? "").trim();
    });
    for (const required of ["shopify_brand", "brand_to_use"]) {
      if (!Object.values(headerByCol).includes(required)) {
        headerErrors.push(`Brand Mapping sheet is missing required column: ${required}`);
      }
    }
    const colOf = (name: string): number | null => {
      const entry = Object.entries(headerByCol).find(([, n]) => n === name);
      return entry ? Number(entry[0]) : null;
    };
    const cShopify = colOf("shopify_brand");
    const cTarget = colOf("brand_to_use");
    const cNotes = colOf("notes");
    if (cShopify && cTarget) {
      for (let r = 2; r <= brandSheet.rowCount; r++) {
        const row = brandSheet.getRow(r);
        if (!row.hasValues) continue;
        const shopifyBrand = readCellString(row.getCell(cShopify));
        const target = readCellString(row.getCell(cTarget));
        const notes = cNotes ? readCellString(row.getCell(cNotes)) : "";
        if (!shopifyBrand && !target) continue;
        const norm = normalizeBrandKey(shopifyBrand);
        const errors: string[] = [];
        if (!shopifyBrand) errors.push("Missing shopify_brand");
        if (!norm && shopifyBrand) errors.push("shopify_brand normalizes to empty");
        const isClear = target.trim() === "";
        const unknown =
          !isClear && liveBrands.length > 0 && !lowerBrands.has(target.trim().toLowerCase());
        brandRows.push({
          rowNumber: r,
          shopify_brand: shopifyBrand,
          shopify_brand_normalized: norm,
          brand_to_use: target,
          notes,
          errors,
          unknown_jomashop_brand: unknown,
          is_clear: isClear,
        });
      }
    }
  }

  if (catSheet) {
    const headerByCol: Record<number, string> = {};
    catSheet.getRow(1).eachCell((cell, col) => {
      headerByCol[col] = String(cell.value ?? "").trim();
    });
    for (const required of ["shopify_category_code", "category_to_use"]) {
      if (!Object.values(headerByCol).includes(required)) {
        headerErrors.push(`Category Mapping sheet is missing required column: ${required}`);
      }
    }
    const colOf = (name: string): number | null => {
      const entry = Object.entries(headerByCol).find(([, n]) => n === name);
      return entry ? Number(entry[0]) : null;
    };
    const cShopify = colOf("shopify_category_code");
    const cTarget = colOf("category_to_use");
    const cNotes = colOf("notes");
    if (cShopify && cTarget) {
      for (let r = 2; r <= catSheet.rowCount; r++) {
        const row = catSheet.getRow(r);
        if (!row.hasValues) continue;
        const code = readCellString(row.getCell(cShopify));
        const target = readCellString(row.getCell(cTarget));
        const notes = cNotes ? readCellString(row.getCell(cNotes)) : "";
        if (!code && !target) continue;
        const norm = normalizeCategoryCode(code);
        const errors: string[] = [];
        if (!code) errors.push("Missing shopify_category_code");
        if (!norm && code) errors.push("shopify_category_code normalizes to empty");
        const isClear = target.trim() === "";
        const unknown =
          !isClear && liveCategories.length > 0 && !lowerCats.has(target.trim().toLowerCase());
        categoryRows.push({
          rowNumber: r,
          shopify_category_code: code,
          shopify_category_code_normalized: norm,
          category_to_use: target,
          notes,
          errors,
          unknown_jomashop_category: unknown,
          is_clear: isClear,
        });
      }
    }
  }

  return { brandRows, categoryRows, headerErrors };
}

// In-memory upload session, same pattern as bulk_repair / category_mapping.
type AuditSession = {
  id: string;
  createdAt: number;
  brandRows: ParsedAuditBrandRow[];
  categoryRows: ParsedAuditCategoryRow[];
};
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSIONS = new Map<string, AuditSession>();

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
  while (SESSIONS.size > MAX_AUDIT_SESSIONS) {
    const oldest = SESSIONS.keys().next();
    if (oldest.done) break;
    SESSIONS.delete(oldest.value);
  }
}

// ---------- Route registration ----------

export function registerResolutionAuditRoutes(app: Express): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  // GET/POST: run audit (POST so the UI can request a fresh /i1 fetch).
  const auditHandler = async (req: Request, res: Response) => {
    try {
      const audit = await runResolutionAudit();
      res.json({ ok: true, ...audit });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  };
  app.get("/api/jomashop/resolution-audit", auditHandler);
  app.post("/api/jomashop/resolution-audit", auditHandler);

  // Download XLSX export of the current audit.
  app.get("/api/jomashop/resolution-audit/export.xlsx", async (_req, res) => {
    try {
      const audit = await runResolutionAudit();
      if (!audit.shopDomain) {
        return res.status(503).json({
          ok: false,
          error:
            "No connected Shopify store. Complete OAuth install (/#/setup) before exporting the audit.",
        });
      }
      if (audit.brandRows.length === 0 && audit.categoryRows.length === 0) {
        return res.status(409).json({
          ok: false,
          error:
            "Audit is empty — no cached Shopify products. Click 'Refresh from Shopify' on the Products page, then re-run the audit.",
        });
      }
      const buf = await buildResolutionAuditWorkbook(audit);
      const stem = audit.shopDomain.replace(/\.myshopify\.com$/, "");
      const filename = `resolution-audit-${stem}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Audit-Brand-Rows", String(audit.brandRows.length));
      res.setHeader("X-Audit-Category-Rows", String(audit.categoryRows.length));
      res.setHeader("X-Audit-Shop", audit.shopDomain);
      storage.appendLog({
        level: "info",
        message: `Exported brand/category audit XLSX (${audit.brandRows.length} brand(s), ${audit.categoryRows.length} category code(s)) for ${audit.shopDomain}`,
        detailsJson: JSON.stringify(audit.summary),
        createdAt: Date.now(),
      });
      res.end(buf);
    } catch (err) {
      const msg = (err as Error).message;
      storage.appendLog({
        level: "error",
        message: `Brand/category audit XLSX export failed: ${msg}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // Dry-run upload preview.
  app.post(
    "/api/jomashop/resolution-audit/import-preview",
    upload.single("file"),
    async (req, res) => {
      gcSessions();
      const file = req.file;
      if (!file) {
        return res.status(400).json({ ok: false, error: "Missing uploaded file." });
      }
      try {
        const audit = await runResolutionAudit();
        const { brandRows, categoryRows, headerErrors } = await parseAuditUpload(
          file.buffer,
          audit.jomashopManufacturers.map((m) => m.name),
          audit.jomashopCategories.map((c) => c.name),
        );
        if (rejectIfTooManyRows(res, brandRows.length + categoryRows.length, MAX_IMPORT_ROWS)) {
          return;
        }
        const validBrand = brandRows.filter((r) => r.errors.length === 0 && !r.is_clear);
        const validCategory = categoryRows.filter((r) => r.errors.length === 0 && !r.is_clear);
        const unknownBrand = validBrand.filter((r) => r.unknown_jomashop_brand);
        const unknownCategory = validCategory.filter((r) => r.unknown_jomashop_category);

        const sessionId = newSessionId();
        SESSIONS.set(sessionId, {
          id: sessionId,
          createdAt: Date.now(),
          brandRows,
          categoryRows,
        });

        storage.appendLog({
          level: "info",
          message: `Brand/category audit upload parsed ${brandRows.length} brand row(s), ${categoryRows.length} category row(s)`,
          detailsJson: JSON.stringify({
            sessionId,
            validBrand: validBrand.length,
            validCategory: validCategory.length,
            unknownBrand: unknownBrand.length,
            unknownCategory: unknownCategory.length,
          }),
          createdAt: Date.now(),
        });

        res.json({
          ok: headerErrors.length === 0,
          sessionId,
          headerErrors,
          totals: {
            brandRows: brandRows.length,
            categoryRows: categoryRows.length,
            validBrand: validBrand.length,
            validCategory: validCategory.length,
            unknownBrand: unknownBrand.length,
            unknownCategory: unknownCategory.length,
            errorRows:
              brandRows.filter((r) => r.errors.length > 0).length +
              categoryRows.filter((r) => r.errors.length > 0).length,
            clearRows:
              brandRows.filter((r) => r.is_clear && r.errors.length === 0).length +
              categoryRows.filter((r) => r.is_clear && r.errors.length === 0).length,
          },
          brandRows,
          categoryRows,
        });
      } catch (err) {
        res
          .status(400)
          .json({ ok: false, error: `Could not parse XLSX: ${(err as Error).message}` });
      }
    },
  );

  // Apply: writes brand_overrides + category_overrides.
  app.post("/api/jomashop/resolution-audit/apply", async (req, res) => {
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
          "Missing confirmation. Set `confirm: true` to acknowledge this will save brand & category overrides.",
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
    const validBrand = session.brandRows.filter((r) => r.errors.length === 0 && !r.is_clear);
    const validCategory = session.categoryRows.filter((r) => r.errors.length === 0 && !r.is_clear);

    if (!allowUnknown) {
      const ub = validBrand
        .filter((r) => r.unknown_jomashop_brand)
        .map((r) => `${r.shopify_brand} → ${r.brand_to_use}`);
      const uc = validCategory
        .filter((r) => r.unknown_jomashop_category)
        .map((r) => `${r.shopify_category_code} → ${r.category_to_use}`);
      if (ub.length > 0 || uc.length > 0) {
        return res.status(409).json({
          ok: false,
          error:
            "Some rows reference Jomashop brands/categories not in the live lists. Re-upload after fixing, or set `allowUnknown: true` to apply anyway.",
          unknownBrands: ub,
          unknownCategories: uc,
        });
      }
    }

    if (validBrand.length === 0 && validCategory.length === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "No valid rows to apply. Fill brand_to_use or category_to_use for at least one row and re-upload.",
      });
    }

    const appliedBrands: Array<{ shopify: string; jomashop: string }> = [];
    for (const r of validBrand) {
      if (!r.shopify_brand_normalized) continue;
      storage.upsertBrandOverride({
        shopifyBrand: r.shopify_brand_normalized,
        jomashopBrand: r.brand_to_use.trim(),
        notes: r.notes || null,
        updatedAt: Date.now(),
      });
      appliedBrands.push({ shopify: r.shopify_brand_normalized, jomashop: r.brand_to_use });
    }
    const clearedBrands = session.brandRows
      .filter((r) => r.is_clear && r.errors.length === 0 && r.shopify_brand_normalized)
      .map((r) => r.shopify_brand_normalized);
    for (const key of clearedBrands) storage.deleteBrandOverride(key);

    const appliedCats: Array<{ code: string; category: string }> = [];
    for (const r of validCategory) {
      if (!r.shopify_category_code_normalized) continue;
      storage.upsertCategoryOverride({
        shopifyCategoryCode: r.shopify_category_code_normalized,
        jomashopCategory: r.category_to_use.trim(),
        notes: r.notes || null,
        updatedAt: Date.now(),
      });
      appliedCats.push({
        code: r.shopify_category_code_normalized,
        category: r.category_to_use,
      });
    }
    const clearedCats = session.categoryRows
      .filter(
        (r) => r.is_clear && r.errors.length === 0 && r.shopify_category_code_normalized,
      )
      .map((r) => r.shopify_category_code_normalized);
    for (const key of clearedCats) storage.deleteCategoryOverride(key);

    const shopDomain = pickActiveShopDomain();
    if (shopDomain) {
      try {
        storage.clearProductCache(shopDomain);
      } catch {
        // non-fatal
      }
    }

    storage.appendLog({
      level: "info",
      message: `Applied resolution audit: ${appliedBrands.length} brand override(s), ${appliedCats.length} category override(s); cleared ${clearedBrands.length} brand(s), ${clearedCats.length} category(ies)`,
      detailsJson: JSON.stringify({
        appliedBrands,
        appliedCats,
        clearedBrands,
        clearedCats,
      }),
      createdAt: Date.now(),
    });

    SESSIONS.delete(sessionId);
    res.json({
      ok: true,
      appliedBrands: appliedBrands.length,
      appliedCategories: appliedCats.length,
      clearedBrands: clearedBrands.length,
      clearedCategories: clearedCats.length,
      shopDomain,
      cacheInvalidated: Boolean(shopDomain),
      note: shopDomain
        ? "Saved. Click 'Refresh from Shopify' on the Products page so readiness recomputes."
        : "Saved.",
    });
  });
}

// Re-export internal helpers used by smoke tests.
export { brandLookupKey, editDistance };
// Quiet "unused" for built-in maps referenced for type only by other files.
void BUILT_IN_BRAND_OVERRIDES;
void BUILT_IN_CATEGORY_OVERRIDES;
