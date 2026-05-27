// Bulk Jomashop mapping workflow via XLSX.
//
// Sits on top of the existing required-enum-audit / enum-overrides plumbing
// and adds an end-to-end operator workflow:
//
//   1. Export: aggregate every unresolved Jomashop required/recommended enum
//      mapping across the cached product preview into one XLSX, grouped by
//      (Jomashop Category, Jomashop Property, Source Value). One row per
//      mapping NEED — not one per product.
//   2. Operator fills in `User Jomashop Value` (and optionally
//      `Write Back To Shopify`, `Shopify Metafield Namespace/Key`, `Notes`).
//   3. Upload: parse + validate accepted values against the live v1
//      accepted-options list when available; reject invalid rows.
//   4. Apply: create verified rows in `enum_overrides` (verified=1 so the
//      resolver honors them), invalidate the product cache so existing
//      mapped products pick up the new mapping, and optionally write the
//      accepted value back to the appropriate Shopify product metafield.
//
// The manual verified overrides created here take strict precedence over the
// auto-synonym resolver — `lookupEnumOverride` is consulted FIRST inside the
// schema-driven payload builder (see server/mapping.ts), and only falls
// through to the live-options-aware synonym table if no operator row was
// found. We mirror that ordering when applying mappings to cached products.

import crypto from "node:crypto";
import ExcelJS from "exceljs";
import type { Express } from "express";
import multer from "multer";

import { storage } from "./storage";
import { FALLBACK_CATEGORY_SCHEMAS } from "@shared/schema";
import {
  lookupEnumOverride,
  normalizeEnumCategoryKey,
  normalizeEnumFieldKey,
  normalizeEnumSourceValue,
} from "./enum_mapping";
import {
  getV1CategoryDescriptors,
  resolveCategoryRecord,
  getCategoryPropertiesI1,
  jomashopConfigured,
} from "./jomashop";
import { normalizeI1CategorySchema } from "./mapping";
import { getActiveShopifyConnection } from "./shopify";
import {
  MAX_IMPORT_ROWS,
  rejectIfTooManyRows,
  releaseLock,
  withLockOr409,
} from "./stability";
import { logMemory } from "./memlog";

const MAX_MAPPING_SESSIONS = 8;

// ---------- Types ----------

export type MappingRowExportRecord = {
  /** Stable per-row id used to round-trip identity through the XLSX. */
  rowId: string;
  jomashopCategory: string;
  shopifyCategoryCode: string;
  shopifyProductType: string;
  jomashopPropertyName: string;
  required: boolean;
  currentSourceField: string;
  currentSourceValue: string;
  currentAutoMappedValue: string;
  statusReason: string;
  acceptedJomashopOptions: string[] | null;
  acceptedOptionsSource: "live-v1" | "live-i1" | "fallback" | "unknown";
  exampleProductTitles: string[];
  exampleSkus: string[];
  productCount: number;
  shopifyProductIds: string[];
  /** Already-saved verified value if any. */
  currentVerifiedOverride: string | null;
};

export type AggregateMappingsResult = {
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  rows: MappingRowExportRecord[];
};

// ---------- Workbook columns ----------

// Stable column keys used by both the export builder and the upload parser.
const COLUMNS = [
  { header: "Row ID", key: "row_id", width: 14, locked: true },
  { header: "Jomashop Category", key: "jomashop_category", width: 22, locked: true },
  { header: "Shopify Category Code", key: "shopify_category_code", width: 22, locked: true },
  { header: "Shopify Product Type", key: "shopify_product_type", width: 22, locked: true },
  { header: "Jomashop Property Name", key: "jomashop_property", width: 24, locked: true },
  { header: "Required?", key: "required", width: 10, locked: true },
  { header: "Current Source Field", key: "current_source_field", width: 22, locked: true },
  { header: "Current Source Value", key: "current_source_value", width: 22, locked: true },
  { header: "Current Auto-Mapped Value", key: "current_auto_value", width: 24, locked: true },
  { header: "Status / Reason", key: "status_reason", width: 30, locked: true },
  { header: "Accepted Jomashop Options", key: "accepted_options", width: 60, locked: true },
  { header: "Example Product Titles", key: "example_titles", width: 50, locked: true },
  { header: "Example SKUs", key: "example_skus", width: 32, locked: true },
  { header: "Product Count", key: "product_count", width: 14, locked: true },
  // Editable columns:
  { header: "User Jomashop Value", key: "user_value", width: 24, locked: false },
  { header: "Write Back To Shopify? (Yes/No)", key: "write_back", width: 18, locked: false },
  { header: "Shopify Metafield Namespace", key: "metafield_namespace", width: 22, locked: false },
  { header: "Shopify Metafield Key", key: "metafield_key", width: 24, locked: false },
  { header: "Notes", key: "notes", width: 32, locked: false },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

// ---------- Aggregation ----------

/**
 * Walk the cached product preview for the active shop and aggregate every
 * unresolved Jomashop required/recommended enum mapping into a single row
 * per (category, property, source value).
 *
 * Two row sources feed the result:
 *   - `unverified_required_options`: schema-required enums that the mapper
 *     could not resolve (Article, etc.).
 *   - `missing_required`: required schema fields whose value is missing or
 *     unmapped (covers non-enum required fields too).
 *
 * Each row is decorated with the LIVE accepted-options list when reachable
 * (preferred /v1/categories/:name, secondary /i1/categories/:id/properties)
 * so the XLSX can render a data-validation dropdown.
 */
export async function aggregateUnresolvedMappings(): Promise<AggregateMappingsResult> {
  const conn = getActiveShopifyConnection();
  const shopDomain =
    conn?.shopDomain ??
    storage.listStores().find((s) => s.oauthStatus === "connected")?.shopDomain ??
    null;

  const result: AggregateMappingsResult = {
    shopDomain,
    fromCache: false,
    cachedAt: null,
    totalProducts: 0,
    rows: [],
  };
  if (!shopDomain) return result;

  const cache = storage.getProductCache(shopDomain);
  if (!cache) return result;
  result.fromCache = true;
  result.cachedAt = cache.fetchedAt;

  let payload: any;
  try {
    payload = JSON.parse(cache.payloadJson);
  } catch {
    return result;
  }
  const allMapped: any[] = Array.isArray(payload?.mapped) ? payload.mapped : [];
  result.totalProducts = allMapped.length;

  type Entry = {
    jomashopCategory: string;
    shopifyCategoryCode: string;
    shopifyProductType: string;
    jomashopPropertyName: string;
    required: boolean;
    currentSourceField: string;
    currentSourceValue: string;
    currentAutoMappedValue: string;
    statusReason: string;
    titles: string[];
    skus: string[];
    productIds: Set<string>;
  };

  const byKey = new Map<string, Entry>();

  const addEntry = (
    keyFields: {
      cat: string;
      field: string;
      sourceValue: string;
      sourceField: string;
      required: boolean;
      autoMapped: string;
      reason: string;
      shopifyCategoryCode: string;
      shopifyProductType: string;
    },
    m: any,
  ) => {
    const { cat, field } = keyFields;
    if (!cat || !field) return;
    const normValue = normalizeEnumSourceValue(keyFields.sourceValue);
    const key = `${cat.toLowerCase()}|${field.toLowerCase()}|${normValue}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        jomashopCategory: cat,
        shopifyCategoryCode: keyFields.shopifyCategoryCode,
        shopifyProductType: keyFields.shopifyProductType,
        jomashopPropertyName: field,
        required: keyFields.required,
        currentSourceField: keyFields.sourceField,
        currentSourceValue: keyFields.sourceValue || "(empty)",
        currentAutoMappedValue: keyFields.autoMapped,
        statusReason: keyFields.reason,
        titles: [],
        skus: [],
        productIds: new Set<string>(),
      };
      byKey.set(key, entry);
    }
    // Required dominates — if any product needs the field as required, mark required.
    if (keyFields.required) entry.required = true;
    if (entry.titles.length < 5 && m.name) entry.titles.push(String(m.name));
    if (entry.skus.length < 5 && m.vendor_sku) entry.skus.push(String(m.vendor_sku));
    if (m.source?.shopify_product_id !== undefined && m.source?.shopify_product_id !== null) {
      entry.productIds.add(String(m.source.shopify_product_id));
    } else if (m.vendor_sku) {
      entry.productIds.add(String(m.vendor_sku));
    }
  };

  for (const m of allMapped) {
    const cat = String(m.category || "").trim();
    const shopifyCategoryCode = String(m.raw_category || "").trim();
    const shopifyProductType = shopifyCategoryCode; // synonym in this app
    // 1. Schema-required enums that the mapper could not resolve.
    const unverified = Array.isArray(m.unverified_required_options)
      ? m.unverified_required_options
      : [];
    for (const u of unverified) {
      const field = String((u as any)?.field || "").trim();
      const sourceValue =
        (u as any)?.value !== undefined && (u as any)?.value !== null
          ? String((u as any).value)
          : shopifyCategoryCode;
      addEntry(
        {
          cat,
          field,
          sourceValue,
          sourceField: "Shopify category code",
          required: true,
          autoMapped: "(none — accepted list unverified or no synonym)",
          reason: "Unverified accepted-options list; needs operator-confirmed value.",
          shopifyCategoryCode,
          shopifyProductType,
        },
        m,
      );
    }

    // 2. Missing required schema fields (covers non-enum required and any
    //    required field whose value was dropped because it didn't match an
    //    accepted option).
    const missingRequired: string[] = Array.isArray(m.missing_required) ? m.missing_required : [];
    for (const f of missingRequired) {
      const field = String(f || "").trim();
      if (!field) continue;
      // Skip ones already captured by unverified_required_options.
      const probe = normalizeEnumSourceValue(shopifyCategoryCode || "");
      const probeKey = `${cat.toLowerCase()}|${field.toLowerCase()}|${probe}`;
      if (byKey.has(probeKey)) continue;
      addEntry(
        {
          cat,
          field,
          sourceValue: shopifyCategoryCode || "",
          sourceField: "Shopify product source (metafield/product_type)",
          required: true,
          autoMapped: "(missing)",
          reason: "Required Jomashop field is missing — fill an accepted value.",
          shopifyCategoryCode,
          shopifyProductType,
        },
        m,
      );
    }
  }

  // Decorate with live accepted options + auto-resolved value where present.
  const acceptedByCatField = new Map<
    string,
    { options: string[]; source: "live-v1" | "live-i1" | "fallback" }
  >();
  const seenCats = new Set<string>();
  byKey.forEach((e) => seenCats.add(e.jomashopCategory));
  for (const c of Array.from(seenCats)) {
    // Fallback bundled options first — overlaid by live below.
    const fallback = (FALLBACK_CATEGORY_SCHEMAS as any)[c] || [];
    for (const f of fallback) {
      if (f?.type === "enum" && Array.isArray(f.options) && f.options.length > 0) {
        const verified = f.options_unverified !== true;
        if (verified) {
          acceptedByCatField.set(`${c.toLowerCase()}|${normalizeEnumFieldKey(f.field)}`, {
            options: [...f.options],
            source: "fallback",
          });
        }
      }
    }
    if (!jomashopConfigured()) continue;
    try {
      const v1 = await getV1CategoryDescriptors(c).catch(() => null);
      if (v1 && (v1 as any).ok && Array.isArray((v1 as any).descriptors)) {
        for (const p of (v1 as any).descriptors as Array<{
          field: string;
          options?: string[];
        }>) {
          if (Array.isArray(p.options) && p.options.length > 0) {
            acceptedByCatField.set(`${c.toLowerCase()}|${normalizeEnumFieldKey(p.field)}`, {
              options: [...p.options],
              source: "live-v1",
            });
          }
        }
      }
      const catResolve = await resolveCategoryRecord(c).catch(() => null);
      const liveId =
        catResolve && (catResolve as any).ok && (catResolve as any).exact
          ? (catResolve as any).exact.id
          : null;
      if (liveId !== null) {
        const propsResp = await getCategoryPropertiesI1(liveId).catch(() => null);
        if (propsResp && (propsResp as any).ok && (propsResp as any).data) {
          const liveSchema = normalizeI1CategorySchema((propsResp as any).data);
          for (const p of liveSchema) {
            if (Array.isArray(p.options) && p.options.length > 0) {
              const key = `${c.toLowerCase()}|${normalizeEnumFieldKey(p.field)}`;
              if (acceptedByCatField.get(key)?.source === "live-v1") continue;
              acceptedByCatField.set(key, {
                options: [...p.options],
                source: "live-i1",
              });
            }
          }
        }
      }
    } catch {
      // ignore — fall through to unknown
    }
  }

  for (const e of Array.from(byKey.values())) {
    const k = `${e.jomashopCategory.toLowerCase()}|${normalizeEnumFieldKey(e.jomashopPropertyName)}`;
    const accepted = acceptedByCatField.get(k) ?? null;
    const existing = lookupEnumOverride(
      e.jomashopCategory,
      e.jomashopPropertyName,
      e.currentSourceValue,
      accepted?.options ?? null,
    );
    const rowId = crypto
      .createHash("sha1")
      .update(
        `${e.jomashopCategory}|${e.jomashopPropertyName}|${normalizeEnumSourceValue(e.currentSourceValue)}`,
      )
      .digest("hex")
      .slice(0, 12);
    result.rows.push({
      rowId,
      jomashopCategory: e.jomashopCategory,
      shopifyCategoryCode: e.shopifyCategoryCode,
      shopifyProductType: e.shopifyProductType,
      jomashopPropertyName: e.jomashopPropertyName,
      required: e.required,
      currentSourceField: e.currentSourceField,
      currentSourceValue: e.currentSourceValue,
      currentAutoMappedValue: e.currentAutoMappedValue,
      statusReason: e.statusReason,
      acceptedJomashopOptions: accepted?.options ?? null,
      acceptedOptionsSource: accepted?.source ?? "unknown",
      exampleProductTitles: e.titles,
      exampleSkus: e.skus,
      productCount: e.productIds.size,
      shopifyProductIds: Array.from(e.productIds),
      currentVerifiedOverride: existing?.jomashopOption ?? null,
    });
  }

  // Sort: required first, then most-impactful (highest product count).
  result.rows.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return b.productCount - a.productCount;
  });
  return result;
}

// ---------- Workbook build ----------

// Defined-name builder mirrored from jomashop_product_field_excel — same rules
// (letters/digits/underscore only, no leading digit) so the two workbooks can
// share helper logic in tests.
export function buildMappingOptionsRangeName(category: string, field: string): string {
  const slug = (s: string) =>
    String(s).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `mopts_${slug(category)}_${slug(field)}`.slice(0, 255);
}

function columnLetter(idx: number): string {
  let n = idx;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function buildMappingWorkbook(agg: AggregateMappingsResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LuxeSupply Jomashop Mapping";
  wb.created = new Date();

  // Hidden helper sheet that holds the accepted-values list for every enum
  // field across every (category, property). One COLUMN per pair; the
  // workbook defines a name pointing at that column's data range so the
  // main sheet's data validation can reference an arbitrarily long list
  // (Excel's ~255-char inline cap doesn't apply via named ranges).
  const optionsSheet = wb.addWorksheet("_Options");
  optionsSheet.state = "hidden";

  type OptionCol = {
    category: string;
    field: string;
    rangeName: string;
    columnIndex: number;
    options: string[];
  };
  const optionCols: OptionCol[] = [];
  const optionColByKey = new Map<string, OptionCol>();
  let nextCol = 1;
  for (const r of agg.rows) {
    const key = `${r.jomashopCategory}::${r.jomashopPropertyName}`;
    if (optionColByKey.has(key)) continue;
    const opts = Array.isArray(r.acceptedJomashopOptions)
      ? r.acceptedJomashopOptions.filter((o) => o && o.trim())
      : [];
    if (opts.length === 0) continue;
    const oc: OptionCol = {
      category: r.jomashopCategory,
      field: r.jomashopPropertyName,
      rangeName: buildMappingOptionsRangeName(r.jomashopCategory, r.jomashopPropertyName),
      columnIndex: nextCol,
      options: opts,
    };
    optionCols.push(oc);
    optionColByKey.set(key, oc);
    nextCol += 1;
  }
  if (optionCols.length > 0) {
    for (const oc of optionCols) {
      optionsSheet.getCell(1, oc.columnIndex).value = `${oc.category} :: ${oc.field}`;
      optionsSheet.getCell(1, oc.columnIndex).font = { bold: true };
      for (let i = 0; i < oc.options.length; i++) {
        optionsSheet.getCell(i + 2, oc.columnIndex).value = oc.options[i];
      }
      const lastRow = oc.options.length + 1;
      const letter = columnLetter(oc.columnIndex);
      const ref = `_Options!$${letter}$2:$${letter}$${lastRow}`;
      wb.definedNames.add(ref, oc.rangeName);
    }
    optionsSheet.getColumn(1).width = 32;
  }

  const ws = wb.addWorksheet("Jomashop Mapping", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  // Header styling: orange = identifier (do not edit); green = editable.
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", horizontal: "center" };
  for (let i = 1; i <= COLUMNS.length; i++) {
    const def = COLUMNS[i - 1];
    const cell = header.getCell(i);
    if (def.locked) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE0B2" } };
      cell.note = "Identifier / context column — do not edit.";
    } else {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8E6C9" } };
      if (def.key === "user_value") {
        cell.note =
          "Fill with the EXACT Jomashop-accepted value. Validated against the live options list on upload.";
      }
    }
  }

  // Collect a per-category accepted-options list for the helper sheet so the
  // operator can see what's available without leaving the file.
  const acceptedSheet = wb.addWorksheet("Accepted Options");
  acceptedSheet.columns = [
    { header: "Jomashop Category", key: "category", width: 22 },
    { header: "Jomashop Property", key: "property", width: 24 },
    { header: "Source", key: "source", width: 14 },
    { header: "Accepted Options (one per line)", key: "options", width: 80 },
  ];
  acceptedSheet.getRow(1).font = { bold: true };
  const seenAccepted = new Set<string>();
  for (const r of agg.rows) {
    const k = `${r.jomashopCategory}|${r.jomashopPropertyName}|${r.acceptedOptionsSource}`;
    if (seenAccepted.has(k)) continue;
    seenAccepted.add(k);
    acceptedSheet.addRow({
      category: r.jomashopCategory,
      property: r.jomashopPropertyName,
      source: r.acceptedOptionsSource,
      options: r.acceptedJomashopOptions ? r.acceptedJomashopOptions.join("\n") : "(no live list)",
    });
  }

  // Body rows.
  for (const r of agg.rows) {
    ws.addRow({
      row_id: r.rowId,
      jomashop_category: r.jomashopCategory,
      shopify_category_code: r.shopifyCategoryCode,
      shopify_product_type: r.shopifyProductType,
      jomashop_property: r.jomashopPropertyName,
      required: r.required ? "Yes" : "No",
      current_source_field: r.currentSourceField,
      current_source_value: r.currentSourceValue,
      current_auto_value: r.currentAutoMappedValue,
      status_reason: r.statusReason,
      accepted_options:
        r.acceptedJomashopOptions && r.acceptedJomashopOptions.length > 0
          ? r.acceptedJomashopOptions.join(" | ")
          : "(live list unavailable)",
      example_titles: r.exampleProductTitles.join(" | "),
      example_skus: r.exampleSkus.join(", "),
      product_count: r.productCount,
      user_value: r.currentVerifiedOverride ?? "",
      write_back: "",
      metafield_namespace: "",
      metafield_key: "",
      notes: "",
    });
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  // Per-row data validation for user_value. We attach a list dropdown that
  // references the hidden _Options sheet via a workbook-level defined name,
  // which lifts the Excel ~255-char inline-list cap and gives operators a
  // dropdown for EVERY enum field — including long lists (Country of Origin,
  // Article, ...) that the previous inline approach silently skipped.
  const userValueColIdx = COLUMNS.findIndex((c) => c.key === "user_value") + 1;
  const writeBackColIdx = COLUMNS.findIndex((c) => c.key === "write_back") + 1;
  if (userValueColIdx > 0) {
    const colLetter = ws.getColumn(userValueColIdx).letter;
    for (let i = 0; i < agg.rows.length; i++) {
      const r = agg.rows[i];
      const rowNumber = i + 2;
      const oc = optionColByKey.get(`${r.jomashopCategory}::${r.jomashopPropertyName}`);
      if (oc) {
        ws.getCell(`${colLetter}${rowNumber}`).dataValidation = {
          type: "list",
          allowBlank: true,
          showErrorMessage: true,
          errorStyle: "stop",
          errorTitle: `Invalid ${r.jomashopPropertyName}`,
          error: `Value must be one of the Jomashop-accepted options for "${r.jomashopPropertyName}".`,
          formulae: [`=${oc.rangeName}`],
        };
      }
    }
  }
  if (writeBackColIdx > 0) {
    const wbLetter = ws.getColumn(writeBackColIdx).letter;
    for (let i = 0; i < agg.rows.length; i++) {
      const rowNumber = i + 2;
      ws.getCell(`${wbLetter}${rowNumber}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"Yes,No"'],
      };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------- Upload parsing ----------

export type ParsedMappingUploadRow = {
  rowNumber: number;
  rowId: string;
  jomashopCategory: string;
  shopifyCategoryCode: string;
  jomashopPropertyName: string;
  required: boolean;
  currentSourceValue: string;
  userValue: string;
  writeBack: boolean;
  metafieldNamespace: string;
  metafieldKey: string;
  notes: string;
  acceptedOptions: string[] | null;
  acceptedOptionsSource: "live-v1" | "live-i1" | "fallback" | "unknown";
  isValid: boolean;
  errors: string[];
};

function readCell(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in (v as any) && Array.isArray((v as any).richText)) {
      return ((v as any).richText as Array<{ text: string }>).map((t) => t.text).join("").trim();
    }
    if ("text" in (v as any)) return String((v as any).text ?? "").trim();
    if ("result" in (v as any)) return String((v as any).result ?? "").trim();
  }
  return String(v).trim();
}

export async function parseMappingUpload(
  buffer: Buffer,
  agg: AggregateMappingsResult,
): Promise<{ rows: ParsedMappingUploadRow[]; headerErrors: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws =
    wb.getWorksheet("Jomashop Mapping") ||
    wb.worksheets.find((w) => w.name !== "Accepted Options") ||
    wb.worksheets[0];
  if (!ws) {
    return { rows: [], headerErrors: ["No worksheet found in the uploaded file."] };
  }
  const headerByCol: Record<number, string> = {};
  ws.getRow(1).eachCell((cell, col) => {
    headerByCol[col] = String(cell.value ?? "").trim();
  });
  const headerErrors: string[] = [];
  // Required headers: Row ID, Jomashop Category, Jomashop Property Name, User Jomashop Value.
  const requiredHeaders = [
    "Row ID",
    "Jomashop Category",
    "Jomashop Property Name",
    "User Jomashop Value",
  ];
  const headerValues = Object.values(headerByCol);
  for (const h of requiredHeaders) {
    if (!headerValues.includes(h)) headerErrors.push(`Missing required column: ${h}`);
  }
  const colByHeader = new Map<string, number>();
  for (const [col, name] of Object.entries(headerByCol)) {
    colByHeader.set(name, Number(col));
  }
  const get = (rowNum: number, header: string): string => {
    const col = colByHeader.get(header);
    if (!col) return "";
    return readCell(ws.getRow(rowNum).getCell(col));
  };

  const aggByRowId = new Map(agg.rows.map((r) => [r.rowId, r]));
  const out: ParsedMappingUploadRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const wsRow = ws.getRow(r);
    if (!wsRow || !wsRow.hasValues) continue;
    const rowId = get(r, "Row ID");
    const userValue = get(r, "User Jomashop Value");
    // Skip blank rows entirely (operator left a row untouched).
    if (!rowId && !userValue) continue;

    const aggRow = rowId ? aggByRowId.get(rowId) ?? null : null;
    const jomashopCategory =
      get(r, "Jomashop Category") || aggRow?.jomashopCategory || "";
    const shopifyCategoryCode =
      get(r, "Shopify Category Code") || aggRow?.shopifyCategoryCode || "";
    const jomashopProperty =
      get(r, "Jomashop Property Name") || aggRow?.jomashopPropertyName || "";
    const requiredVal = get(r, "Required?").toLowerCase();
    const required = aggRow?.required ?? (requiredVal === "yes" || requiredVal === "true");
    const currentSourceValue =
      get(r, "Current Source Value") || aggRow?.currentSourceValue || "";
    const writeBackRaw = get(r, "Write Back To Shopify? (Yes/No)").toLowerCase();
    const writeBack = writeBackRaw === "yes" || writeBackRaw === "y" || writeBackRaw === "true";
    const metafieldNamespace = get(r, "Shopify Metafield Namespace");
    const metafieldKey = get(r, "Shopify Metafield Key");
    const notes = get(r, "Notes");

    const errors: string[] = [];
    if (!jomashopCategory) errors.push("Missing Jomashop Category.");
    if (!jomashopProperty) errors.push("Missing Jomashop Property Name.");
    if (!userValue) errors.push("Missing User Jomashop Value.");

    const accepted = aggRow?.acceptedJomashopOptions ?? null;
    const acceptedSource = aggRow?.acceptedOptionsSource ?? "unknown";
    if (userValue && accepted && accepted.length > 0) {
      const target = userValue.toLowerCase().trim();
      const ok = accepted.some((o) => o.toLowerCase().trim() === target);
      if (!ok) {
        errors.push(
          `User value "${userValue}" is not an accepted Jomashop option (${acceptedSource}). Accepted: ${accepted.join(", ")}`,
        );
      }
    }

    out.push({
      rowNumber: r,
      rowId,
      jomashopCategory,
      shopifyCategoryCode,
      jomashopPropertyName: jomashopProperty,
      required,
      currentSourceValue,
      userValue,
      writeBack,
      metafieldNamespace,
      metafieldKey,
      notes,
      acceptedOptions: accepted,
      acceptedOptionsSource: acceptedSource,
      isValid: errors.length === 0,
      errors,
    });
  }

  return { rows: out, headerErrors };
}

// ---------- Apply: write overrides + invalidate cache + (optional) Shopify metafields ----------

export type MetafieldWriteResult = {
  rowId: string;
  productId: string;
  namespace: string;
  key: string;
  ok: boolean;
  error: string | null;
};

/**
 * Derive a safe app namespace + key when the operator didn't supply explicit
 * targets. We use `jomashop` as the namespace and slugify the property name
 * into a metafield key.
 */
export function deriveDefaultMetafieldTarget(propertyName: string): {
  namespace: string;
  key: string;
} {
  const key = String(propertyName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return { namespace: "jomashop", key: key || "value" };
}

const ADMIN_API_VERSION = "2024-10";

async function writeShopifyMetafield(
  conn: { shopDomain: string; accessToken: string },
  ownerId: string,
  namespace: string,
  key: string,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const endpoint = `https://${conn.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const query = `
    mutation Set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      {
        ownerId,
        namespace,
        key,
        type: "single_line_text_field",
        value,
      },
    ],
  };
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": conn.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const body = (await res.json().catch(() => null)) as
    | {
        data?: {
          metafieldsSet?: {
            userErrors?: Array<{ field: string[]; message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      }
    | null;
  if (!res.ok || !body) return { ok: false, error: `Shopify Admin API ${res.status}` };
  if (body.errors && body.errors.length > 0) {
    return { ok: false, error: body.errors.map((e) => e.message).join("; ") };
  }
  const ue = body.data?.metafieldsSet?.userErrors ?? [];
  if (ue.length > 0) {
    return { ok: false, error: ue.map((e) => e.message).join("; ") };
  }
  return { ok: true };
}

/**
 * Override write helper. Marks each row VERIFIED so the resolver honors it.
 * Verification model:
 *  - When the row has live accepted options AND the user value is in the
 *    list, we save `verified=true, operatorVerified=false` and capture the
 *    live options for audit.
 *  - When the row has no live options (or only an unverified fallback), we
 *    save `verified=true, operatorVerified=true` — the operator's explicit
 *    upload of the value is the trust signal. This matches the
 *    "operator_verified_no_live_options" path in registerEnumMappingRoutes.
 */
function saveOverride(row: ParsedMappingUploadRow): void {
  const normValue = normalizeEnumSourceValue(row.currentSourceValue);
  if (!normValue) return;
  const hasLive =
    row.acceptedOptions !== null &&
    row.acceptedOptions.length > 0 &&
    (row.acceptedOptionsSource === "live-v1" || row.acceptedOptionsSource === "live-i1");
  storage.upsertEnumOverride({
    jomashopCategory: row.jomashopCategory,
    jomashopField: row.jomashopPropertyName,
    sourceValue: normValue,
    jomashopOption: row.userValue,
    notes: row.notes || null,
    verified: true,
    operatorVerified: !hasLive,
    acceptedOptionsJson:
      row.acceptedOptions && row.acceptedOptions.length > 0
        ? JSON.stringify(row.acceptedOptions)
        : null,
    updatedAt: Date.now(),
  });
}

// ---------- Route registration ----------

type Session = {
  id: string;
  createdAt: number;
  rows: ParsedMappingUploadRow[];
  aggSnapshot: AggregateMappingsResult;
};
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSIONS = new Map<string, Session>();
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
  while (SESSIONS.size > MAX_MAPPING_SESSIONS) {
    const oldest = SESSIONS.keys().next();
    if (oldest.done) break;
    SESSIONS.delete(oldest.value);
  }
}

export function registerJomashopMappingExcelRoutes(app: Express): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  // GET: aggregate JSON (debug / UI preview).
  app.get("/api/jomashop-mapping/unresolved", async (_req, res) => {
    try {
      const agg = await aggregateUnresolvedMappings();
      res.json({ ok: true, ...agg });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // GET: XLSX export.
  app.get("/api/jomashop-mapping/export.xlsx", async (_req, res) => {
    try {
      const agg = await aggregateUnresolvedMappings();
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
            "No unresolved Jomashop mappings found in the cached preview. If you expect rows here, click Refresh from Shopify on the Products page first.",
        });
      }
      const buf = await buildMappingWorkbook(agg);
      const filename = `jomashop-mapping-${agg.shopDomain.replace(/\.myshopify\.com$/, "")}-${new Date()
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
        message: `Exported Jomashop mapping XLSX (${agg.rows.length} row(s)) for ${agg.shopDomain}`,
        detailsJson: JSON.stringify({
          totalProducts: agg.totalProducts,
          requiredRows: agg.rows.filter((r) => r.required).length,
        }),
        createdAt: Date.now(),
      });
      res.end(buf);
    } catch (err) {
      const msg = (err as Error).message;
      storage.appendLog({
        level: "error",
        message: `Jomashop mapping XLSX export failed: ${msg}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST: upload XLSX, validate, store in a session for confirm/apply.
  app.post(
    "/api/jomashop-mapping/import-preview",
    upload.single("file"),
    async (req, res) => {
      gcSessions();
      const file = req.file;
      if (!file) {
        return res.status(400).json({ ok: false, error: "Missing uploaded file." });
      }
      if (!withLockOr409(res, "import.mapping")) return;
      try {
        logMemory("import.mapping.start", { bytes: file.size });
        const agg = await aggregateUnresolvedMappings();
        const { rows, headerErrors } = await parseMappingUpload(file.buffer, agg);
        if (rejectIfTooManyRows(res, rows.length, MAX_IMPORT_ROWS)) {
          return;
        }
        const sessionId = newSessionId();
        SESSIONS.set(sessionId, {
          id: sessionId,
          createdAt: Date.now(),
          rows,
          aggSnapshot: agg,
        });
        const validRows = rows.filter((r) => r.isValid);
        const errorRows = rows.filter((r) => !r.isValid);
        const writebackRows = validRows.filter((r) => r.writeBack);
        res.json({
          ok: headerErrors.length === 0,
          sessionId,
          headerErrors,
          totals: {
            total: rows.length,
            valid: validRows.length,
            errors: errorRows.length,
            writeback: writebackRows.length,
          },
          rows: rows.map((r) => ({
            rowNumber: r.rowNumber,
            rowId: r.rowId,
            jomashop_category: r.jomashopCategory,
            shopify_category_code: r.shopifyCategoryCode,
            jomashop_property: r.jomashopPropertyName,
            required: r.required,
            current_source_value: r.currentSourceValue,
            user_value: r.userValue,
            write_back: r.writeBack,
            metafield_namespace: r.metafieldNamespace,
            metafield_key: r.metafieldKey,
            notes: r.notes,
            accepted_options_source: r.acceptedOptionsSource,
            is_valid: r.isValid,
            errors: r.errors,
          })),
        });
      } catch (err) {
        const msg = (err as Error).message;
        logMemory("import.mapping.failed", { message: msg });
        res.status(400).json({ ok: false, error: `Could not parse XLSX: ${msg}` });
      } finally {
        releaseLock("import.mapping");
        logMemory("import.mapping.done");
      }
    },
  );

  // POST: apply — write overrides, optionally write Shopify metafields.
  app.post("/api/jomashop-mapping/apply", async (req, res) => {
    gcSessions();
    const body = (req.body ?? {}) as {
      sessionId?: string;
      confirm?: boolean;
      ignoreErrors?: boolean;
      performShopifyWriteback?: boolean;
    };
    if (!body.confirm) {
      return res.status(400).json({
        ok: false,
        error: "Missing confirmation. Set `confirm: true` to apply mappings.",
      });
    }
    if (!body.sessionId) {
      return res.status(400).json({ ok: false, error: "Missing sessionId." });
    }
    const session = SESSIONS.get(body.sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ ok: false, error: "Session not found or expired. Re-upload the XLSX." });
    }
    const ignoreErrors = body.ignoreErrors === true;
    const performShopifyWriteback = body.performShopifyWriteback === true;
    const validRows = session.rows.filter((r) => r.isValid || ignoreErrors);
    if (validRows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No valid rows to apply. Fix errors in the XLSX and re-upload.",
      });
    }

    // Capture the agg snapshot BEFORE cache clear so we still have product
    // ids available for metafield write-back.
    const conn = getActiveShopifyConnection();
    const aggByRowId = new Map(session.aggSnapshot.rows.map((r) => [r.rowId, r]));

    // 1. Save verified enum overrides.
    for (const r of validRows) saveOverride(r);

    // 2. Invalidate cache so existing items will be re-mapped on next refresh.
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

    // 3. Optional Shopify metafield write-back.
    const writes: MetafieldWriteResult[] = [];
    if (performShopifyWriteback && conn) {
      for (const r of validRows) {
        if (!r.writeBack) continue;
        const aggRow = aggByRowId.get(r.rowId);
        if (!aggRow) continue;
        const productIds = aggRow.shopifyProductIds;
        if (productIds.length === 0) continue;
        const target = r.metafieldNamespace && r.metafieldKey
          ? { namespace: r.metafieldNamespace, key: r.metafieldKey }
          : deriveDefaultMetafieldTarget(r.jomashopPropertyName);
        for (const pid of productIds) {
          const ownerId = pid.startsWith("gid://")
            ? pid
            : `gid://shopify/Product/${pid}`;
          const result = await writeShopifyMetafield(
            conn,
            ownerId,
            target.namespace,
            target.key,
            r.userValue,
          );
          writes.push({
            rowId: r.rowId,
            productId: pid,
            namespace: target.namespace,
            key: target.key,
            ok: result.ok,
            error: result.ok ? null : result.error,
          });
        }
      }
    }

    storage.appendLog({
      level: "info",
      message: `Applied ${validRows.length} Jomashop mapping override(s)${
        performShopifyWriteback ? ` + ${writes.length} metafield write(s)` : ""
      }`,
      detailsJson: JSON.stringify({
        sessionId: session.id,
        overrides: validRows.map((r) => ({
          category: r.jomashopCategory,
          field: r.jomashopPropertyName,
          source: r.currentSourceValue,
          target: r.userValue,
        })),
        writebackPerformed: performShopifyWriteback,
        writebackResults: writes.length,
      }),
      createdAt: Date.now(),
    });

    SESSIONS.delete(session.id);
    res.json({
      ok: true,
      appliedOverrides: validRows.length,
      cacheInvalidatedFor: shopDomain,
      shopifyConnected: Boolean(conn),
      shopifyWritebackPerformed: performShopifyWriteback,
      metafieldWrites: writes,
      metafieldWriteSummary: {
        attempted: writes.length,
        succeeded: writes.filter((w) => w.ok).length,
        failed: writes.filter((w) => !w.ok).length,
      },
      note: shopDomain
        ? "Applied. Click Refresh from Shopify on the Products page to recompute readiness with the new mappings."
        : "Applied.",
    });
  });

}
