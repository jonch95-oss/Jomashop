// Bulk repair workflow: export products missing required metafields to XLSX,
// import an edited XLSX, dry-run validate, then optionally apply metafield
// updates to Shopify and push corrected rows to Jomashop.
//
// All mutating routes require an explicit `confirm: true` flag in the body,
// and the import endpoint never mutates on upload — it only dry-runs and
// stores the parsed rows in-memory under a session id that the caller passes
// back to the apply/push endpoints.

import crypto from "node:crypto";
import ExcelJS from "exceljs";
import type { Express } from "express";
import multer from "multer";
import { storage } from "./storage";
import {
  buildJomashopProductPayload,
  isSampleProduct,
  mapShopifyToJomashop,
  type MappedProduct,
  type ShopifyProduct,
} from "./mapping";
import {
  FALLBACK_CATEGORY_SCHEMAS,
  type SupportedCategory,
} from "@shared/schema";
import { resolveCategorySchema, jomashopConfigured, jomashopRequest } from "./jomashop";
import { getActiveShopifyConnection, streamShopifyProducts } from "./shopify";
import { logMemory } from "./memlog";
import {
  MAX_IMPORT_ROWS,
  rejectIfTooManyRows,
} from "./stability";

const MAX_BULK_REPAIR_SESSIONS = 8;

// ---------- Editable column model ----------

export const EDITABLE_FIELDS = [
  "brand",
  "category",
  "color",
  "material",
  "gender",
  "size",
  "size_system",
  "country_of_origin",
  "manufacturer_number",
  "ff_sku",
  "ff_designer_id",
  "upc",
  "composition",
  "collection",
  "season",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

// Shopify metafield namespace+key each editable field maps to. The Shopify
// Admin metafieldsSet mutation upserts by (ownerId, namespace, key) so we
// pick a single canonical namespace per field. Existing metafields under
// "luxe" continue to work via the read path; new writes consolidate under
// "custom".
const METAFIELD_TARGET: Record<EditableField, { namespace: string; key: string; type: string } | null> = {
  brand: null, // top-level: written via product update (vendor), not metafield
  category: null, // top-level: written via product update (productType)
  color: { namespace: "custom", key: "color", type: "single_line_text_field" },
  material: { namespace: "custom", key: "material", type: "single_line_text_field" },
  gender: { namespace: "custom", key: "gender", type: "single_line_text_field" },
  size: { namespace: "custom", key: "size", type: "single_line_text_field" },
  size_system: { namespace: "custom", key: "size_system", type: "single_line_text_field" },
  country_of_origin: { namespace: "custom", key: "country_of_origin", type: "single_line_text_field" },
  manufacturer_number: { namespace: "custom", key: "ff_designer_id", type: "single_line_text_field" },
  ff_sku: { namespace: "custom", key: "ff_sku", type: "single_line_text_field" },
  ff_designer_id: { namespace: "custom", key: "ff_designer_id", type: "single_line_text_field" },
  upc: { namespace: "custom", key: "upc", type: "single_line_text_field" },
  composition: { namespace: "custom", key: "composition", type: "single_line_text_field" },
  collection: { namespace: "custom", key: "collection", type: "single_line_text_field" },
  season: { namespace: "custom", key: "season", type: "single_line_text_field" },
};

const IDENTIFIER_COLUMNS = [
  "shop_domain",
  "shopify_product_id",
  "shopify_variant_id",
  "product_title",
  "variant_title",
  "sku",
  "vendor_sku",
  "current_brand",
  "current_category",
  "missing_fields",
  "commercial_discount",
  "jomashop_price",
] as const;

const STATUS_COLUMNS = ["row_status", "notes"] as const;

const SIZE_SYSTEM_OPTIONS = ["US", "EU", "UK", "IT", "FR", "JP"];
const GENDER_OPTIONS = ["Men", "Women", "Unisex", "Kids"];
const STATUS_OPTIONS = ["", "ready", "skip", "needs-review"];

// ---------- Excel-friendly row builder ----------

type ExportRow = {
  shop_domain: string;
  shopify_product_id: string;
  shopify_variant_id: string;
  product_title: string;
  variant_title: string;
  sku: string;
  vendor_sku: string;
  current_brand: string;
  current_category: string;
  missing_fields: string;
  commercial_discount: string;
  jomashop_price: string;
} & Record<EditableField, string> & Record<(typeof STATUS_COLUMNS)[number], string>;

function exportRowFromMapped(
  shopDomain: string,
  p: MappedProduct,
  variantSku: string | null,
): ExportRow {
  const v =
    variantSku !== null
      ? p.variants.find((x) => x.vendor_sku === variantSku) ?? null
      : p.variants[0] ?? null;
  const variantId =
    variantSku !== null && p.source.shopify_variant_ids.length > 0
      ? // Best-effort: align indexes between mapped variants and source variant ids
        p.source.shopify_variant_ids[
          Math.max(
            0,
            p.variants.findIndex((x) => x.vendor_sku === variantSku),
          )
        ] ?? p.source.shopify_variant_ids[0]
      : p.source.shopify_variant_ids[0] ?? "";

  const props = p.properties;
  const propStr = (k: string): string => {
    const val = props[k];
    if (val === null || val === undefined) return "";
    return String(val);
  };

  return {
    shop_domain: shopDomain,
    shopify_product_id: String(p.source.shopify_product_id ?? ""),
    shopify_variant_id: String(variantId ?? ""),
    product_title: p.name,
    variant_title: v
      ? Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(" • ")
      : "",
    sku: v?.vendor_sku ?? p.sku ?? p.vendor_sku ?? "",
    vendor_sku: p.vendor_sku ?? "",
    current_brand: p.brand ?? "",
    current_category: p.category ?? "",
    missing_fields: [
      ...(p.missing_top_level ?? []),
      ...(p.missing_required ?? []),
    ].join(", "),
    commercial_discount:
      p.commercial_discount > 0 ? String(p.commercial_discount) : "",
    jomashop_price: p.jomashop_price !== null ? String(p.jomashop_price) : "",
    brand: p.brand ?? "",
    category: p.category ?? "",
    color: propStr("color"),
    material: propStr("material"),
    gender: propStr("gender"),
    size: propStr("size") || (v?.options?.Size ?? ""),
    size_system: propStr("size_system"),
    country_of_origin: propStr("country_of_origin"),
    manufacturer_number: p.manufacturer_number ?? "",
    ff_sku: propStr("ff_sku") || (v?.vendor_sku ?? ""),
    ff_designer_id: p.manufacturer_number ?? "",
    upc: propStr("upc"),
    composition: propStr("composition"),
    collection: propStr("collection"),
    season: propStr("season"),
    row_status: "",
    notes: "",
  };
}

async function buildMissingExportRows(): Promise<{
  rows: ExportRow[];
  shopDomain: string | null;
  fetchedCount: number;
  pageCount: number;
  hasMore: boolean;
}> {
  const conn = getActiveShopifyConnection();
  if (!conn) {
    return { rows: [], shopDomain: null, fetchedCount: 0, pageCount: 0, hasMore: false };
  }

  // Resolve schemas for the legacy three-category bucket bulk repair was
  // built around (live preferred). Done once up-front so each streamed page
  // can map without re-fetching. Newer categories (Apparel/Footwear/etc.)
  // flow through the single-product push route directly.
  const schemas: Partial<Record<SupportedCategory, Array<any>>> = {};
  for (const cat of ["Shoes", "Handbags", "Clothing"] as const) {
    const { schema } = await resolveCategorySchema(cat);
    const props =
      (schema as { properties?: Array<any> } | undefined)?.properties ??
      FALLBACK_CATEGORY_SCHEMAS[cat];
    schemas[cat] = props;
  }

  // Stream pages from Shopify and process in batches. We never retain the
  // full ShopifyProduct[] — only the ExportRow projections (a few hundred
  // bytes each), which keeps the working set bounded even for catalogs with
  // thousands of products.
  const rows: ExportRow[] = [];
  let fetchedCount = 0;
  logMemory("bulk-repair.export.start", { shopDomain: conn.shopDomain });
  const stream = await streamShopifyProducts((pageProducts, pageIndex) => {
    for (const product of pageProducts) {
      fetchedCount += 1;
      if (isSampleProduct(product)) continue;
      const tmp = mapShopifyToJomashop(product, []);
      const props = schemas[tmp.category] ?? [];
      const mapped = mapShopifyToJomashop(product, props);
      const missing = [
        ...(mapped.missing_top_level ?? []),
        ...(mapped.missing_required ?? []),
      ];
      if (missing.length === 0) continue;
      if (mapped.variants.length === 0) {
        rows.push(exportRowFromMapped(conn.shopDomain, mapped, null));
      } else {
        for (const v of mapped.variants) {
          rows.push(exportRowFromMapped(conn.shopDomain, mapped, v.vendor_sku));
        }
      }
    }
    if (pageIndex % 5 === 0) {
      logMemory("bulk-repair.export.page", { pageIndex, fetchedCount, rowsSoFar: rows.length });
    }
  }, { pageSize: 100 });

  if (!stream.ok) {
    return { rows: [], shopDomain: conn.shopDomain, fetchedCount: 0, pageCount: 0, hasMore: false };
  }
  logMemory("bulk-repair.export.done", { rows: rows.length, fetchedCount: stream.totalFetched });
  return {
    rows,
    shopDomain: conn.shopDomain,
    fetchedCount: stream.totalFetched,
    pageCount: stream.pageCount,
    hasMore: stream.hasMore,
  };
}

async function buildWorkbook(rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LuxeSupply Bulk Repair";
  wb.created = new Date();
  const ws = wb.addWorksheet("Missing required", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const columns: Array<{ header: string; key: string; width: number }> = [
    ...IDENTIFIER_COLUMNS.map((k) => ({ header: k, key: k, width: 22 })),
    ...EDITABLE_FIELDS.map((k) => ({ header: k, key: k, width: 20 })),
    ...STATUS_COLUMNS.map((k) => ({ header: k, key: k, width: 24 })),
  ];
  ws.columns = columns;

  // Header style + identifier protection (visual cue; ExcelJS protection
  // requires sheet protection which we leave off so the operator can still
  // sort/filter).
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  for (let i = 1; i <= IDENTIFIER_COLUMNS.length; i++) {
    const cell = headerRow.getCell(i);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFE0B2" },
    };
    cell.note = "Do not edit — identifier column. Used to match the row back to Shopify on import.";
  }
  for (let i = IDENTIFIER_COLUMNS.length + 1; i <= IDENTIFIER_COLUMNS.length + EDITABLE_FIELDS.length; i++) {
    const cell = headerRow.getCell(i);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFC8E6C9" },
    };
  }
  for (let i = IDENTIFIER_COLUMNS.length + EDITABLE_FIELDS.length + 1; i <= columns.length; i++) {
    const cell = headerRow.getCell(i);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE1BEE7" },
    };
  }

  for (const row of rows) {
    ws.addRow(row);
  }

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  const lastDataRow = Math.max(rows.length + 1, 2);
  const colIndex = (key: string): number => columns.findIndex((c) => c.key === key) + 1;

  function addListValidation(key: string, values: string[]) {
    const ci = colIndex(key);
    if (ci <= 0) return;
    const letter = ws.getColumn(ci).letter;
    for (let r = 2; r <= lastDataRow; r++) {
      ws.getCell(`${letter}${r}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`"${values.join(",")}"`],
      };
    }
  }
  addListValidation("size_system", SIZE_SYSTEM_OPTIONS);
  addListValidation("gender", GENDER_OPTIONS);
  addListValidation("category", ["Shoes", "Handbags", "Clothing"]);
  addListValidation("row_status", STATUS_OPTIONS.filter((s) => s !== ""));

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---------- Import parsing + dry-run ----------

type ParsedRow = ExportRow & {
  rowNumber: number;
  has_changes: boolean;
  changed_fields: EditableField[];
  errors: string[];
};

async function parseUpload(buffer: Buffer): Promise<{
  rows: ParsedRow[];
  headerErrors: string[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], headerErrors: ["No worksheet found in uploaded file."] };

  const header = ws.getRow(1);
  const headerByCol: Record<number, string> = {};
  header.eachCell((cell, col) => {
    headerByCol[col] = String(cell.value ?? "").trim();
  });
  const expected = new Set<string>([
    ...IDENTIFIER_COLUMNS,
    ...EDITABLE_FIELDS,
    ...STATUS_COLUMNS,
  ]);
  const headerErrors: string[] = [];
  for (const req of ["shopify_product_id", "shopify_variant_id", "sku"]) {
    if (!Object.values(headerByCol).includes(req)) {
      headerErrors.push(`Missing required identifier column: ${req}`);
    }
  }
  // Extra columns are tolerated; unknown ones are simply ignored.
  Object.values(headerByCol).forEach((h) => {
    if (h && !expected.has(h) && !h.startsWith("__")) {
      // tolerate but note nothing — operators sometimes add scratch columns
    }
  });

  const rows: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const wsRow = ws.getRow(r);
    if (!wsRow || !wsRow.hasValues) continue;
    const get = (key: string): string => {
      const col = Object.entries(headerByCol).find(([, name]) => name === key);
      if (!col) return "";
      const cell = wsRow.getCell(Number(col[0]));
      const v = cell.value;
      if (v === null || v === undefined) return "";
      if (typeof v === "object" && "richText" in (v as any)) {
        return ((v as any).richText as Array<{ text: string }>)
          .map((t) => t.text)
          .join("");
      }
      if (typeof v === "object" && "text" in (v as any)) {
        return String((v as any).text ?? "");
      }
      return String(v).trim();
    };

    const parsed: ParsedRow = {
      rowNumber: r,
      shop_domain: get("shop_domain"),
      shopify_product_id: get("shopify_product_id"),
      shopify_variant_id: get("shopify_variant_id"),
      product_title: get("product_title"),
      variant_title: get("variant_title"),
      sku: get("sku"),
      vendor_sku: get("vendor_sku"),
      current_brand: get("current_brand"),
      current_category: get("current_category"),
      missing_fields: get("missing_fields"),
      commercial_discount: get("commercial_discount"),
      jomashop_price: get("jomashop_price"),
      brand: get("brand"),
      category: get("category"),
      color: get("color"),
      material: get("material"),
      gender: get("gender"),
      size: get("size"),
      size_system: get("size_system"),
      country_of_origin: get("country_of_origin"),
      manufacturer_number: get("manufacturer_number"),
      ff_sku: get("ff_sku"),
      ff_designer_id: get("ff_designer_id"),
      upc: get("upc"),
      composition: get("composition"),
      collection: get("collection"),
      season: get("season"),
      row_status: get("row_status"),
      notes: get("notes"),
      has_changes: false,
      changed_fields: [],
      errors: [],
    };

    if (!parsed.shopify_product_id) {
      parsed.errors.push("Missing shopify_product_id (identifier column must not be blank).");
    }
    if (/^shopify-1\d{3}$/.test(parsed.shopify_product_id)) {
      parsed.errors.push("Refusing sample fixture id (shopify-1xxx).");
    }
    if (parsed.shop_domain && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(parsed.shop_domain)) {
      parsed.errors.push(`Invalid shop_domain: ${parsed.shop_domain}`);
    }

    const changed: EditableField[] = [];
    for (const f of EDITABLE_FIELDS) {
      if (parsed[f] && parsed[f].trim() !== "") {
        changed.push(f);
      }
    }
    parsed.changed_fields = changed;
    parsed.has_changes = changed.length > 0;

    rows.push(parsed);
  }

  return { rows, headerErrors };
}

// ---------- Session storage (in-memory) ----------

type ImportSession = {
  id: string;
  createdAt: number;
  rows: ParsedRow[];
  shopifyApplied: boolean;
  shopifyResults: ShopifyApplyResult[];
};

const SESSIONS = new Map<string, ImportSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;

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
  while (SESSIONS.size > MAX_BULK_REPAIR_SESSIONS) {
    const oldest = SESSIONS.keys().next();
    if (oldest.done) break;
    SESSIONS.delete(oldest.value);
  }
}

// ---------- Shopify apply (metafields + product update) ----------

type ShopifyApplyResult = {
  rowNumber: number;
  shopify_product_id: string;
  sku: string;
  ok: boolean;
  updated_fields: EditableField[];
  errors: string[];
};

const ADMIN_API_VERSION = "2024-10";

async function shopifyGraphQL<T = unknown>(
  conn: { shopDomain: string; accessToken: string },
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const endpoint = `https://${conn.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
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
    | { data?: T; errors?: Array<{ message: string }> }
    | null;
  if (!res.ok || !body) {
    return { ok: false, error: `Shopify Admin API ${res.status}` };
  }
  if (body.errors && body.errors.length > 0) {
    return { ok: false, error: body.errors.map((e) => e.message).join("; ") };
  }
  return { ok: true, data: body.data as T };
}

async function applyRowToShopify(
  conn: { shopDomain: string; accessToken: string },
  row: ParsedRow,
): Promise<ShopifyApplyResult> {
  const result: ShopifyApplyResult = {
    rowNumber: row.rowNumber,
    shopify_product_id: row.shopify_product_id,
    sku: row.sku,
    ok: true,
    updated_fields: [],
    errors: [],
  };

  if (row.errors.length > 0) {
    result.ok = false;
    result.errors.push(...row.errors);
    return result;
  }
  if (!row.shopify_product_id) {
    result.ok = false;
    result.errors.push("Missing shopify_product_id.");
    return result;
  }

  const productGid = row.shopify_product_id.startsWith("gid://")
    ? row.shopify_product_id
    : `gid://shopify/Product/${row.shopify_product_id}`;

  // 1) Top-level fields (vendor for brand, productType for category).
  const productInput: Record<string, unknown> = { id: productGid };
  let hasProductUpdate = false;
  if (row.changed_fields.includes("brand")) {
    productInput.vendor = row.brand;
    hasProductUpdate = true;
  }
  if (row.changed_fields.includes("category")) {
    productInput.productType = row.category;
    hasProductUpdate = true;
  }
  if (hasProductUpdate) {
    const q = `
      mutation Update($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id }
          userErrors { field message }
        }
      }
    `;
    const r = await shopifyGraphQL<{
      productUpdate?: { userErrors?: Array<{ field: string[]; message: string }> };
    }>(conn, q, { input: productInput });
    if (!r.ok) {
      result.ok = false;
      result.errors.push(`productUpdate: ${r.error}`);
    } else {
      const ue = r.data.productUpdate?.userErrors ?? [];
      if (ue.length > 0) {
        result.ok = false;
        result.errors.push(...ue.map((e) => `productUpdate: ${e.message}`));
      } else {
        if (row.changed_fields.includes("brand")) result.updated_fields.push("brand");
        if (row.changed_fields.includes("category")) result.updated_fields.push("category");
      }
    }
  }

  // 2) Metafields via metafieldsSet.
  const metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [];
  const metafieldFields: EditableField[] = [];
  for (const f of row.changed_fields) {
    const target = METAFIELD_TARGET[f];
    if (!target) continue;
    const value = row[f]?.trim() ?? "";
    if (!value) continue;
    metafields.push({
      ownerId: productGid,
      namespace: target.namespace,
      key: target.key,
      type: target.type,
      value,
    });
    metafieldFields.push(f);
  }

  if (metafields.length > 0) {
    const q = `
      mutation Set($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key }
          userErrors { field message }
        }
      }
    `;
    const r = await shopifyGraphQL<{
      metafieldsSet?: { userErrors?: Array<{ field: string[]; message: string }> };
    }>(conn, q, { metafields });
    if (!r.ok) {
      result.ok = false;
      result.errors.push(`metafieldsSet: ${r.error}`);
    } else {
      const ue = r.data.metafieldsSet?.userErrors ?? [];
      if (ue.length > 0) {
        result.ok = false;
        result.errors.push(...ue.map((e) => `metafieldsSet ${e.field?.join(".")}: ${e.message}`));
      } else {
        for (const f of metafieldFields) {
          if (!result.updated_fields.includes(f)) result.updated_fields.push(f);
        }
      }
    }
  }

  if (result.updated_fields.length === 0 && result.errors.length === 0) {
    result.errors.push("No editable fields had values — nothing to update.");
    result.ok = false;
  }
  return result;
}

// ---------- Jomashop push (uses single-product push semantics) ----------

type JomashopPushResult = {
  rowNumber: number;
  shopify_product_id: string;
  sku: string;
  ok: boolean;
  status?: number;
  error?: string;
  missingRequired?: string[];
  missingTopLevel?: string[];
};

async function refetchAndMap(
  productId: string,
): Promise<{ product: ShopifyProduct; mapped: MappedProduct; category: SupportedCategory } | null> {
  // Stream pages and stop as soon as we hit the matching product so we
  // never retain the full catalog in memory just to look up one product.
  let found: ShopifyProduct | null = null;
  const stream = await streamShopifyProducts((pageProducts) => {
    for (const p of pageProducts) {
      if (String(p.id) === String(productId)) {
        found = p;
        return false;
      }
    }
  }, { pageSize: 100 });
  if (!stream.ok && !found) return null;
  if (!found) return null;
  const tmp = mapShopifyToJomashop(found, []);
  const { schema } = await resolveCategorySchema(tmp.category);
  const props =
    (schema as { properties?: Array<any> } | undefined)?.properties ??
    FALLBACK_CATEGORY_SCHEMAS[tmp.category];
  const mapped = mapShopifyToJomashop(found, props);
  return { product: found, mapped, category: mapped.category };
}

async function pushRowToJomashop(row: ParsedRow): Promise<JomashopPushResult> {
  const out: JomashopPushResult = {
    rowNumber: row.rowNumber,
    shopify_product_id: row.shopify_product_id,
    sku: row.sku,
    ok: false,
  };
  if (!row.shopify_product_id) {
    out.error = "Missing shopify_product_id.";
    return out;
  }
  const remapped = await refetchAndMap(row.shopify_product_id);
  if (!remapped) {
    out.error = "Could not locate product on Shopify after metafield update.";
    return out;
  }
  if (isSampleProduct(remapped.product)) {
    out.error = "Sample/demo product — push refused.";
    return out;
  }
  const { payload, missingRequired, missingTopLevel, pushDebug } =
    buildJomashopProductPayload(remapped.mapped, row.sku || undefined);
  if (pushDebug.fallbackUnsafe) {
    out.error = `Live category schema for "${pushDebug.category}" unavailable; bundled fallback would emit lowercase labels Jomashop rejects.`;
    return out;
  }
  if (missingRequired.length > 0 || missingTopLevel.length > 0) {
    out.error = "Required fields are still missing after Shopify update.";
    out.missingRequired = missingRequired;
    out.missingTopLevel = missingTopLevel;
    return out;
  }
  const productResp = await jomashopRequest({
    method: "POST",
    path: "/v1/products",
    body: payload,
  });
  if (!productResp.ok) {
    out.status = productResp.status;
    const errBody = productResp.errorData as { error?: string } | undefined;
    out.error = errBody?.error ?? productResp.error;
    return out;
  }
  out.ok = true;
  out.status = productResp.status;
  return out;
}

// ---------- Route registration ----------

export function registerBulkRepairRoutes(app: Express): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB cap
  });

  // ---------- Export ----------
  app.get("/api/products/missing/export.xlsx", async (_req, res) => {
    try {
      const { rows, shopDomain, fetchedCount, pageCount } = await buildMissingExportRows();
      if (!shopDomain) {
        return res.status(503).json({
          ok: false,
          error: "No connected Shopify store with an access token. Complete OAuth install first.",
        });
      }
      const buf = await buildWorkbook(rows);
      const filename = `missing-fields-${shopDomain.replace(/\.myshopify\.com$/, "")}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Export-Rows", String(rows.length));
      res.setHeader("X-Export-Shop", shopDomain);
      res.setHeader("X-Export-Products-Fetched", String(fetchedCount));
      res.setHeader("X-Export-Pages", String(pageCount));
      storage.appendLog({
        level: "info",
        message: `Exported ${rows.length} missing-field row(s) from ${shopDomain}`,
        detailsJson: JSON.stringify({ fetchedCount, pageCount }),
        createdAt: Date.now(),
      });
      res.end(buf);
    } catch (err) {
      const msg = (err as Error).message;
      storage.appendLog({
        level: "error",
        message: `Missing-field XLSX export failed: ${msg}`,
        detailsJson: null,
        createdAt: Date.now(),
      });
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ---------- Import (dry run) ----------
  app.post(
    "/api/products/missing/import-preview",
    upload.single("file"),
    async (req, res) => {
      gcSessions();
      const file = req.file;
      if (!file) {
        return res.status(400).json({ ok: false, error: "Missing uploaded file." });
      }
      try {
        const { rows, headerErrors } = await parseUpload(file.buffer);
        if (rejectIfTooManyRows(res, rows.length, MAX_IMPORT_ROWS)) {
          return;
        }
        const validRows = rows.filter((r) => r.errors.length === 0 && r.has_changes);
        const errorRows = rows.filter((r) => r.errors.length > 0);
        const noChangeRows = rows.filter((r) => r.errors.length === 0 && !r.has_changes);
        const readyRows = validRows.filter(
          (r) => (r.row_status ?? "").trim().toLowerCase() === "ready",
        );

        const fieldUpdateCounts: Record<string, number> = {};
        for (const r of validRows) {
          for (const f of r.changed_fields) {
            fieldUpdateCounts[f] = (fieldUpdateCounts[f] ?? 0) + 1;
          }
        }

        const sessionId = newSessionId();
        SESSIONS.set(sessionId, {
          id: sessionId,
          createdAt: Date.now(),
          rows,
          shopifyApplied: false,
          shopifyResults: [],
        });

        storage.appendLog({
          level: "info",
          message: `Bulk repair import preview parsed ${rows.length} row(s)`,
          detailsJson: JSON.stringify({
            sessionId,
            valid: validRows.length,
            errors: errorRows.length,
            noChange: noChangeRows.length,
            ready: readyRows.length,
          }),
          createdAt: Date.now(),
        });

        res.json({
          ok: headerErrors.length === 0,
          sessionId,
          headerErrors,
          totals: {
            total: rows.length,
            valid: validRows.length,
            errors: errorRows.length,
            noChange: noChangeRows.length,
            readyForJomashop: readyRows.length,
          },
          fieldUpdateCounts,
          rows: rows.map((r) => ({
            rowNumber: r.rowNumber,
            shopify_product_id: r.shopify_product_id,
            shopify_variant_id: r.shopify_variant_id,
            sku: r.sku,
            product_title: r.product_title,
            current_brand: r.current_brand,
            missing_fields: r.missing_fields,
            changed_fields: r.changed_fields,
            row_status: r.row_status,
            notes: r.notes,
            errors: r.errors,
            has_changes: r.has_changes,
          })),
        });
      } catch (err) {
        const msg = (err as Error).message;
        res.status(400).json({ ok: false, error: `Could not parse XLSX: ${msg}` });
      }
    },
  );

  // ---------- Apply to Shopify ----------
  app.post("/api/products/missing/apply-shopify", async (req, res) => {
    gcSessions();
    const { sessionId, confirm } = (req.body ?? {}) as {
      sessionId?: string;
      confirm?: boolean;
    };
    if (!confirm) {
      return res.status(400).json({
        ok: false,
        error: "Missing confirmation. Set `confirm: true` to acknowledge this will update Shopify.",
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
    const conn = getActiveShopifyConnection();
    if (!conn) {
      return res.status(503).json({
        ok: false,
        error: "No connected Shopify store with an access token.",
      });
    }

    const startedAt = Date.now();
    const job = storage.createSyncJob({
      jobType: "bulk_repair_shopify",
      status: "running",
      startedAt,
      finishedAt: null,
      totalItems: session.rows.length,
      successItems: 0,
      errorItems: 0,
      summary: `Bulk repair ${session.rows.length} row(s) → Shopify`,
    });

    const results: ShopifyApplyResult[] = [];
    let okCount = 0;
    let errCount = 0;
    for (const row of session.rows) {
      if (row.errors.length > 0 || !row.has_changes) {
        results.push({
          rowNumber: row.rowNumber,
          shopify_product_id: row.shopify_product_id,
          sku: row.sku,
          ok: false,
          updated_fields: [],
          errors: row.errors.length > 0 ? row.errors : ["No changes — skipped."],
        });
        continue;
      }
      const r = await applyRowToShopify(conn, row);
      results.push(r);
      if (r.ok) okCount += 1;
      else errCount += 1;
    }

    session.shopifyApplied = true;
    session.shopifyResults = results;

    storage.updateSyncJob(job.id, {
      status: errCount === 0 ? "success" : "partial",
      finishedAt: Date.now(),
      successItems: okCount,
      errorItems: errCount,
      summary: `Shopify metafield update: ${okCount} ok / ${errCount} failed`,
    });
    storage.appendLog({
      jobId: job.id,
      level: errCount === 0 ? "info" : "warn",
      message: `Bulk repair Shopify apply: ${okCount} ok / ${errCount} failed`,
      detailsJson: JSON.stringify({ sessionId, total: session.rows.length }),
      createdAt: Date.now(),
    });

    res.json({
      ok: errCount === 0,
      jobId: job.id,
      totals: { total: session.rows.length, ok: okCount, failed: errCount },
      results,
    });
  });

  // ---------- Push corrected rows to Jomashop ----------
  app.post("/api/products/missing/push-jomashop", async (req, res) => {
    gcSessions();
    const { sessionId, confirm, productIds } = (req.body ?? {}) as {
      sessionId?: string;
      confirm?: boolean;
      productIds?: string[];
    };
    if (!confirm) {
      return res.status(400).json({
        ok: false,
        error: "Missing confirmation. Set `confirm: true` to acknowledge this will push to Jomashop.",
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
    if (!jomashopConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Jomashop credentials not configured. Set JOMASHOP_EMAIL and JOMASHOP_PASSWORD.",
      });
    }

    // Only push rows marked ready, no errors, and (if productIds supplied)
    // matching the explicit selection from the UI.
    const candidates = session.rows.filter((r) => {
      if (r.errors.length > 0) return false;
      const status = (r.row_status ?? "").trim().toLowerCase();
      if (status !== "ready") return false;
      if (productIds && productIds.length > 0) {
        return productIds.includes(r.shopify_product_id);
      }
      return true;
    });

    if (candidates.length === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "No rows marked `row_status=ready` were found. Mark rows ready in the XLSX, re-upload, and try again.",
      });
    }

    const job = storage.createSyncJob({
      jobType: "bulk_repair_jomashop",
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      totalItems: candidates.length,
      successItems: 0,
      errorItems: 0,
      summary: `Push ${candidates.length} corrected product(s) → Jomashop`,
    });

    const results: JomashopPushResult[] = [];
    let okCount = 0;
    let errCount = 0;
    // De-dupe by product id — variants of the same product map to one push.
    const seen = new Set<string>();
    for (const row of candidates) {
      if (seen.has(row.shopify_product_id)) continue;
      seen.add(row.shopify_product_id);
      const r = await pushRowToJomashop(row);
      results.push(r);
      if (r.ok) okCount += 1;
      else errCount += 1;
    }

    storage.updateSyncJob(job.id, {
      status: errCount === 0 ? "success" : "partial",
      finishedAt: Date.now(),
      successItems: okCount,
      errorItems: errCount,
      summary: `Jomashop bulk push: ${okCount} ok / ${errCount} failed`,
    });
    storage.appendLog({
      jobId: job.id,
      level: errCount === 0 ? "info" : "warn",
      message: `Bulk repair Jomashop push: ${okCount} ok / ${errCount} failed`,
      detailsJson: JSON.stringify({ sessionId, total: results.length }),
      createdAt: Date.now(),
    });

    res.json({
      ok: errCount === 0,
      jobId: job.id,
      totals: { total: results.length, ok: okCount, failed: errCount },
      results,
    });
  });
}
