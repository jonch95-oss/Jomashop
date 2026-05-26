// Enum mapping workflow: operator-supplied source value → exact Jomashop
// enum option per category + schema field.
//
// Sits in front of the schema-driven mapper: when a property has a known
// option list (live or fallback) AND/OR is tagged `options_unverified: true`,
// the override map is consulted with the canonical source value the mapper
// extracted. If a Jomashop-accepted option is returned, the mapper emits it
// verbatim — bypassing the unverified-options block. This is the missing
// resolution layer that lets the operator unblock pushes when Jomashop's
// accepted enum list is private (e.g. Apparel "Article") or when the
// Shopify-side value doesn't naturally map (e.g. OUTW → "Outerwear" might
// need to land on "Down Parka" for a specific tenant).
//
// Operator precedence: operator override (enum_overrides table) →
// built-in seed (BUILT_IN_ENUM_OVERRIDES) → null (caller decides whether to
// fall back to the raw value or surface a preflight block).

import type { Express } from "express";
import { storage } from "./storage";
import {
  SUPPORTED_CATEGORIES,
  type SupportedCategory,
  type EnumOverride,
} from "@shared/schema";

/**
 * Canonical lookup key for a Jomashop category name. Collapses casing /
 * non-alphanumerics so "Apparel", "apparel", and "APPAREL " resolve to the
 * same bucket. Matches the canonicalization used everywhere else in this
 * codebase (category_mapping / brand_mapping).
 */
export function normalizeEnumCategoryKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

/**
 * Canonical lookup key for a schema field label (e.g. "Article",
 * "Apparel Type", "Country of Origin"). Same shape as the category key so
 * the operator can spell "article", "Article", or "ARTICLE" interchangeably
 * without producing duplicate rows.
 */
export function normalizeEnumFieldKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

/**
 * Canonical lookup key for a source value. Used to dedupe variant
 * casings/spacings of the same input (e.g. "OUTW" / "outw" / "Outw"
 * collapse). Empty input returns "" — the caller is expected to skip the
 * lookup when this happens.
 */
export function normalizeEnumSourceValue(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Built-in seed mappings. Keyed by `${categoryKey}|${fieldKey}|${sourceKey}`,
 * value is the exact Jomashop-accepted option string. Apparel "Article" is
 * the high-value seed — the live Jomashop accepted list isn't published, so
 * we map every Shopify apparel-code variant to a single placeholder
 * sub-type that is known to round-trip on common tenants. Operators can
 * overwrite any of these via /api/enum-mapping/overrides.
 *
 * The keys live in this normalized shape so a missing-row lookup never
 * accidentally trips on whitespace/casing.
 */
export const BUILT_IN_ENUM_OVERRIDES: Record<string, string> = {
  // ---- Apparel · Article ----
  // Maps Shopify product_type codes / common Article values to the Jomashop
  // top-level Apparel sub-type. Once the live /i1/categories/Apparel
  // schema response is loaded the override is no longer needed because the
  // verified option list overrides everything in this file.
  "apparel|article|outw": "Outerwear",
  "apparel|article|outerwear": "Outerwear",
  "apparel|article|scoat": "Outerwear",
  "apparel|article|coat": "Outerwear",
  "apparel|article|coats": "Outerwear",
  "apparel|article|blzr": "Blazers",
  "apparel|article|blazer": "Blazers",
  "apparel|article|blazers": "Blazers",
  "apparel|article|jack": "Jackets",
  "apparel|article|jacket": "Jackets",
  "apparel|article|jackets": "Jackets",
  "apparel|article|vest": "Vests",
  "apparel|article|vests": "Vests",
  "apparel|article|pant": "Pants",
  "apparel|article|pants": "Pants",
  "apparel|article|trou": "Pants",
  "apparel|article|trouser": "Pants",
  "apparel|article|trousers": "Pants",
  "apparel|article|jean": "Jeans",
  "apparel|article|jeans": "Jeans",
  "apparel|article|swpa": "Sweatpants",
  "apparel|article|sweatpants": "Sweatpants",
  "apparel|article|jogg": "Joggers",
  "apparel|article|joggers": "Joggers",
  "apparel|article|shor": "Shorts",
  "apparel|article|shorts": "Shorts",
  "apparel|article|shir": "Shirts",
  "apparel|article|shirt": "Shirts",
  "apparel|article|shirts": "Shirts",
  "apparel|article|drsh": "Dress Shirts",
  "apparel|article|dressshirt": "Dress Shirts",
  "apparel|article|dressshirts": "Dress Shirts",
  "apparel|article|polo": "Polo Shirts",
  "apparel|article|poloshirts": "Polo Shirts",
  "apparel|article|tshr": "T-Shirts",
  "apparel|article|tshirt": "T-Shirts",
  "apparel|article|tshirts": "T-Shirts",
  "apparel|article|tank": "Tank Tops",
  "apparel|article|tanktop": "Tank Tops",
  "apparel|article|tanktops": "Tank Tops",
  "apparel|article|tops": "Tops",
  "apparel|article|blou": "Blouses",
  "apparel|article|blouse": "Blouses",
  "apparel|article|blouses": "Blouses",
  "apparel|article|swtr": "Sweaters",
  "apparel|article|sweater": "Sweaters",
  "apparel|article|sweaters": "Sweaters",
  "apparel|article|hood": "Hoodies",
  "apparel|article|hoodie": "Hoodies",
  "apparel|article|hoodies": "Hoodies",
  "apparel|article|crew": "Sweatshirts",
  "apparel|article|swsh": "Sweatshirts",
  "apparel|article|sweatshirt": "Sweatshirts",
  "apparel|article|sweatshirts": "Sweatshirts",
  "apparel|article|pull": "Pullovers",
  "apparel|article|pullover": "Pullovers",
  "apparel|article|pullovers": "Pullovers",
  "apparel|article|dres": "Dresses",
  "apparel|article|dress": "Dresses",
  "apparel|article|dresses": "Dresses",
  "apparel|article|skrt": "Skirts",
  "apparel|article|skirt": "Skirts",
  "apparel|article|skirts": "Skirts",
  "apparel|article|suit": "Suits",
  "apparel|article|suits": "Suits",
  "apparel|article|tuxe": "Tuxedos",
  "apparel|article|tuxedo": "Tuxedos",
  "apparel|article|tuxedos": "Tuxedos",
  "apparel|article|swim": "Swimwear",
  "apparel|article|swimwear": "Swimwear",
  "apparel|article|legg": "Leggings",
  "apparel|article|leggings": "Leggings",
  "apparel|article|sock": "Socks",
  "apparel|article|socks": "Socks",
  "apparel|article|undw": "Underwear",
  "apparel|article|underwear": "Underwear",
  "apparel|article|paja": "Pajamas",
  "apparel|article|pajamas": "Pajamas",
  "apparel|article|robe": "Robes",
  "apparel|article|robes": "Robes",
  "apparel|article|body": "Bodysuits",
  "apparel|article|bodysuit": "Bodysuits",
  "apparel|article|bodysuits": "Bodysuits",
  "apparel|article|jump": "Jumpsuits",
  "apparel|article|jumpsuit": "Jumpsuits",
  "apparel|article|jumpsuits": "Jumpsuits",
  "apparel|article|actv": "Activewear",
  "apparel|article|activewear": "Activewear",
  "apparel|article|bras": "Bras",
  "apparel|article|bra": "Bras",
  "apparel|article|cape": "Capes",
  "apparel|article|capes": "Capes",
  "apparel|article|scrf": "Scarves",
  "apparel|article|scarf": "Scarves",
  "apparel|article|scarves": "Scarves",

  // Clothing (legacy alias of Apparel) — same seeds.
  "clothing|article|outw": "Outerwear",
  "clothing|article|outerwear": "Outerwear",
  "clothing|article|coat": "Outerwear",
  "clothing|article|jack": "Jackets",
  "clothing|article|pant": "Pants",
  "clothing|article|shir": "Shirts",
  "clothing|article|drsh": "Dress Shirts",
  "clothing|article|polo": "Polo Shirts",
  "clothing|article|tshr": "T-Shirts",
  "clothing|article|dres": "Dresses",
  "clothing|article|skrt": "Skirts",
  "clothing|article|suit": "Suits",
  "clothing|article|swim": "Swimwear",
};

/**
 * Resolve a source value to a Jomashop-accepted enum option for a given
 * category + field. Returns the override hit (operator → built-in) or null
 * when nothing matches. Callers should fall back to the raw value when null.
 *
 * `sourceValue` should be the canonical source (Shopify product_type,
 * category code, metafield value — whatever the mapper extracted). The
 * helper handles normalization internally.
 *
 * Optionally accepts the accepted option list (from the live or fallback
 * schema). When supplied, the returned override is only honored when its
 * value matches one of the accepted options (case-insensitive). This guards
 * against stale built-in seeds that don't match a particular tenant's
 * accepted list — a wrong override is never sent.
 */
export function lookupEnumOverride(
  jomashopCategory: string | null | undefined,
  jomashopField: string | null | undefined,
  sourceValue: string | null | undefined,
  acceptedOptions?: string[] | null,
): { jomashopOption: string; source: "operator" | "built-in" } | null {
  const cat = normalizeEnumCategoryKey(jomashopCategory);
  const field = normalizeEnumFieldKey(jomashopField);
  const value = normalizeEnumSourceValue(sourceValue);
  if (!cat || !field || !value) return null;

  // Build the candidate raw category strings we try in order. We always check
  // the storage table for both the exact passed-in category string AND the
  // normalized form so operator-saved rows with either casing resolve.
  const rawCategoryCandidates = [String(jomashopCategory ?? "")].filter(Boolean);

  let row: EnumOverride | undefined;
  for (const rawCat of rawCategoryCandidates) {
    row = storage.getEnumOverride(rawCat, String(jomashopField ?? ""), value);
    if (row) break;
    // Try storing-key form too in case the writer stored normalized values
    // and the caller passed the raw schema label.
    row = storage.getEnumOverride(rawCat.toLowerCase(), String(jomashopField ?? "").toLowerCase(), value);
    if (row) break;
  }
  if (!row) {
    // Final attempt with fully normalized category + field — covers rows
    // inserted via the normalized form directly.
    row = storage.getEnumOverride(cat, field, value);
  }

  const candidate: { jomashopOption: string; source: "operator" | "built-in" } | null = row
    ? { jomashopOption: row.jomashopOption, source: "operator" }
    : BUILT_IN_ENUM_OVERRIDES[`${cat}|${field}|${value}`]
      ? { jomashopOption: BUILT_IN_ENUM_OVERRIDES[`${cat}|${field}|${value}`], source: "built-in" }
      : null;

  if (!candidate) return null;
  if (acceptedOptions && acceptedOptions.length > 0) {
    // Verify against the live/fallback option list (case-insensitive). A
    // built-in seed that doesn't match the live accepted set is treated as a
    // miss — better to surface "Fix mapping for Article" than to send a
    // value Jomashop will reject.
    const accepted = acceptedOptions.map((o) => o.toLowerCase().trim());
    if (!accepted.includes(candidate.jomashopOption.toLowerCase().trim())) {
      return null;
    }
  }
  return candidate;
}

/**
 * Express routes for managing the enum_overrides table from the dashboard.
 * Mirror of brand_mapping / category_mapping shapes so the same UI patterns
 * (list/upsert/delete) drop in.
 */
export function registerEnumMappingRoutes(app: Express): void {
  // GET: all saved overrides.
  app.get("/api/enum-mapping/overrides", (_req, res) => {
    const overrides = storage.listEnumOverrides();
    res.json({
      ok: true,
      count: overrides.length,
      overrides: overrides.map((o) => ({
        jomashop_category: o.jomashopCategory,
        jomashop_field: o.jomashopField,
        source_value: o.sourceValue,
        jomashop_option: o.jomashopOption,
        notes: o.notes,
        updated_at: o.updatedAt,
      })),
    });
  });

  // POST: upsert. Required: jomashop_category, jomashop_field, source_value, jomashop_option.
  app.post("/api/enum-mapping/overrides", (req, res) => {
    const body = (req.body ?? {}) as {
      jomashop_category?: string;
      jomashop_field?: string;
      source_value?: string;
      jomashop_option?: string;
      notes?: string;
    };
    const category = (body.jomashop_category || "").trim();
    const field = (body.jomashop_field || "").trim();
    const sourceValue = (body.source_value || "").trim();
    const option = (body.jomashop_option || "").trim();
    if (!category) return res.status(400).json({ ok: false, error: "Missing jomashop_category." });
    if (!field) return res.status(400).json({ ok: false, error: "Missing jomashop_field." });
    if (!sourceValue) return res.status(400).json({ ok: false, error: "Missing source_value." });
    if (!option) return res.status(400).json({ ok: false, error: "Missing jomashop_option." });
    const normValue = normalizeEnumSourceValue(sourceValue);
    if (!normValue) {
      return res
        .status(400)
        .json({ ok: false, error: "source_value normalizes to empty string." });
    }
    // Reject categories that aren't part of the supported set so operators
    // can't accidentally seed mappings for a category the mapper will
    // never resolve to.
    if (!SUPPORTED_CATEGORIES.includes(category as SupportedCategory)) {
      const close = SUPPORTED_CATEGORIES.find(
        (c) => normalizeEnumCategoryKey(c) === normalizeEnumCategoryKey(category),
      );
      if (close) {
        // Forgive casing.
      } else {
        return res.status(400).json({
          ok: false,
          error: `Unsupported jomashop_category. Use one of: ${SUPPORTED_CATEGORIES.join(", ")}`,
        });
      }
    }
    storage.upsertEnumOverride({
      jomashopCategory: category,
      jomashopField: field,
      sourceValue: normValue,
      jomashopOption: option,
      notes: body.notes?.trim() || null,
      updatedAt: Date.now(),
    });
    storage.appendLog({
      level: "info",
      message: `Saved enum override ${category}/${field}: ${sourceValue} → ${option}`,
      detailsJson: JSON.stringify({ category, field, sourceValue, option }),
      createdAt: Date.now(),
    });
    res.json({
      ok: true,
      jomashop_category: category,
      jomashop_field: field,
      source_value: normValue,
      jomashop_option: option,
    });
  });

  // DELETE: remove a single override.
  app.delete("/api/enum-mapping/overrides", (req, res) => {
    const category = String(req.query.category || "").trim();
    const field = String(req.query.field || "").trim();
    const sourceValue = String(req.query.source_value || "").trim();
    if (!category || !field || !sourceValue) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing category, field, or source_value query param." });
    }
    const normValue = normalizeEnumSourceValue(sourceValue);
    storage.deleteEnumOverride(category, field, normValue);
    res.json({ ok: true, removed: { category, field, source_value: normValue } });
  });
}
