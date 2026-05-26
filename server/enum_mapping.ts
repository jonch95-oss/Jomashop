// Enum mapping workflow: operator-supplied source value → exact Jomashop
// enum option per category + schema field.
//
// Sits in front of the schema-driven mapper: when a property has a known
// option list (live or fallback) AND/OR is tagged `options_unverified: true`,
// the override map is consulted with the canonical source value the mapper
// extracted. If a VERIFIED Jomashop-accepted option is returned, the mapper
// emits it verbatim — bypassing the unverified-options block. This is the
// missing resolution layer that lets the operator unblock pushes when
// Jomashop's accepted enum list is private (e.g. Apparel "Article") or when
// the Shopify-side value doesn't naturally map.
//
// Resolution precedence: operator override (enum_overrides table, MUST be
// verified=1 OR cleared by the live accepted-options check) → built-in seed
// (only entries marked verified=true here) → null (caller surfaces a
// preflight block).
//
// History: prior builds shipped a large BUILT_IN_ENUM_OVERRIDES map that
// guessed Apparel "Article" → "Outerwear" for Canada Goose OUTW Kids — a
// mapping the live Jomashop /i1 Apparel schema rejected ("Article is not
// included in the list"). Those built-in guesses are now opt-in: each entry
// is tagged `{verified, requiresAcceptedOption}` and is honored ONLY when
// either (a) verified is true AND we can confirm it against the live
// accepted option list, or (b) the entry was manually flagged verified by
// the operator. Apparel/Article seeds in particular are removed — the live
// Jomashop list isn't published, so an operator-confirmed mapping is the
// only way to unblock that field.

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
 * Built-in seed mappings. Keyed by `${categoryKey}|${fieldKey}|${sourceKey}`.
 *
 * Each entry carries a `verified` flag. The lookup helper only honors an
 * entry when the live accepted option list contains `jomashopOption`
 * (case-insensitive) — otherwise the seed is treated as a miss and the
 * caller surfaces a preflight block. This guards against the
 * "Article=Outerwear" class of bug: a guess that happens to look reasonable
 * but isn't actually accepted by the live Jomashop schema.
 *
 * Apparel / Clothing "Article" has NO seed at all: the live accepted list
 * isn't published and the bundled guess ("Outerwear", "Pants", …) was
 * rejected by Jomashop on real catalog data. The operator MUST create a
 * verified mapping (per source value) before any Apparel Article push will
 * be allowed.
 */
export type BuiltInEnumSeed = {
  jomashopOption: string;
  verified: boolean;
};

export const BUILT_IN_ENUM_OVERRIDES: Record<string, BuiltInEnumSeed> = {
  // (Intentionally empty for Apparel / Clothing "Article" — Jomashop has not
  // published the accepted list and every prior guess was rejected on live
  // pushes. Operators must add a verified mapping via /api/enum-mapping/overrides
  // before Apparel/Article can be sent.)
};

/**
 * Read-only snapshot of all built-in seeds, exposed for debug endpoints and
 * tests. Returns the count of seeds and their `verified` flags so the
 * dashboard can warn if any unverified entry is ever introduced.
 */
export function listBuiltInSeeds(): Array<{
  key: string;
  jomashopOption: string;
  verified: boolean;
}> {
  return Object.entries(BUILT_IN_ENUM_OVERRIDES).map(([key, seed]) => ({
    key,
    jomashopOption: seed.jomashopOption,
    verified: seed.verified,
  }));
}

export type EnumOverrideHit = {
  jomashopOption: string;
  source: "operator" | "built-in";
  verified: boolean;
};

/**
 * Resolve a source value to a Jomashop-accepted enum option for a given
 * category + field. Returns the override hit (operator → built-in) or null
 * when nothing matches AT THE REQUIRED TRUST LEVEL. Callers should fall back
 * to surfacing a preflight block when null.
 *
 * Trust model:
 *  - Operator row: honored only when `row.verified` is true. An unverified
 *    operator row exists in the table for audit but is treated as a miss.
 *  - Built-in seed: honored only when its `verified` flag is true.
 *  - When `acceptedOptions` is supplied, the candidate value must appear in
 *    the list (case-insensitive). Otherwise the candidate is rejected.
 *  - When `acceptedOptions` is NOT supplied (live list unavailable), an
 *    operator row is honored only if `row.operatorVerified` is true (i.e.
 *    the operator explicitly accepted that no live list could validate it).
 *    Built-in seeds without a live list are NEVER honored.
 *
 * This is intentionally strict: a wrong override is the bug we're trying to
 * stop shipping. "Fix mapping for X" in the UI is the safe failure mode.
 */
export function lookupEnumOverride(
  jomashopCategory: string | null | undefined,
  jomashopField: string | null | undefined,
  sourceValue: string | null | undefined,
  acceptedOptions?: string[] | null,
): EnumOverrideHit | null {
  const cat = normalizeEnumCategoryKey(jomashopCategory);
  const field = normalizeEnumFieldKey(jomashopField);
  const value = normalizeEnumSourceValue(sourceValue);
  if (!cat || !field || !value) return null;

  const hasLiveAccepted = Array.isArray(acceptedOptions) && acceptedOptions.length > 0;
  const acceptedLower = hasLiveAccepted
    ? (acceptedOptions as string[]).map((o) => String(o).toLowerCase().trim())
    : null;

  const rawCategoryCandidates = [String(jomashopCategory ?? "")].filter(Boolean);

  let row: EnumOverride | undefined;
  for (const rawCat of rawCategoryCandidates) {
    row = storage.getEnumOverride(rawCat, String(jomashopField ?? ""), value);
    if (row) break;
    row = storage.getEnumOverride(rawCat.toLowerCase(), String(jomashopField ?? "").toLowerCase(), value);
    if (row) break;
  }
  if (!row) {
    row = storage.getEnumOverride(cat, field, value);
  }

  if (row) {
    const target = row.jomashopOption;
    const trusted = isOperatorRowTrusted(row, acceptedLower);
    if (trusted) {
      return { jomashopOption: target, source: "operator", verified: true };
    }
    // An untrusted operator row is treated as a miss — but we still prefer
    // null over falling through to the built-in seed, since the operator's
    // explicit row is a strong signal that "the seed is not what we want
    // here." (Otherwise an operator could enter an unverified override and
    // accidentally re-enable a built-in seed they were trying to block.)
    return null;
  }

  const seedKey = `${cat}|${field}|${value}`;
  const seed = BUILT_IN_ENUM_OVERRIDES[seedKey];
  if (!seed) return null;
  if (!seed.verified) return null;
  // Built-in seeds require an explicit live-options check to be honored.
  if (!acceptedLower) return null;
  if (!acceptedLower.includes(seed.jomashopOption.toLowerCase().trim())) return null;
  return { jomashopOption: seed.jomashopOption, source: "built-in", verified: true };
}

function isOperatorRowTrusted(row: EnumOverride, acceptedLower: string[] | null): boolean {
  if (!row.verified) return false;
  const targetLower = row.jomashopOption.toLowerCase().trim();
  if (acceptedLower) {
    return acceptedLower.includes(targetLower);
  }
  // No live list available: the operator must have explicitly flagged the
  // override as operator-verified (a "trust me, the live list is private"
  // confirmation). This is the escape hatch for Apparel Article when
  // Jomashop refuses to publish accepted values.
  return Boolean(row.operatorVerified);
}

/**
 * Express routes for managing the enum_overrides table from the dashboard.
 * Mirror of brand_mapping / category_mapping shapes so the same UI patterns
 * (list/upsert/delete) drop in. The POST endpoint now requires a verification
 * decision so an operator can't silently re-introduce the "Article=Outerwear"
 * class of bug.
 */
export function registerEnumMappingRoutes(app: Express): void {
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
        verified: Boolean(o.verified),
        operator_verified: Boolean(o.operatorVerified),
        accepted_options: parseAcceptedOptions(o.acceptedOptionsJson),
        updated_at: o.updatedAt,
      })),
      builtInSeeds: listBuiltInSeeds(),
    });
  });

  // POST: upsert. Required: jomashop_category, jomashop_field, source_value,
  // jomashop_option. Optional verification context:
  //   - accepted_options: string[] — when present the target must be in it
  //     (case-insensitive) for the row to be saved as verified.
  //   - operator_verified: boolean — set true when the operator confirms
  //     the mapping despite NO live accepted list being available (e.g.
  //     Apparel Article on a tenant Jomashop has not published).
  //   - notes: free-text audit trail.
  // A row that meets neither condition is saved as unverified for audit, but
  // will NOT satisfy any preflight check — the push will continue to block.
  app.post("/api/enum-mapping/overrides", (req, res) => {
    const body = (req.body ?? {}) as {
      jomashop_category?: string;
      jomashop_field?: string;
      source_value?: string;
      jomashop_option?: string;
      notes?: string;
      accepted_options?: unknown;
      operator_verified?: unknown;
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
    if (!SUPPORTED_CATEGORIES.includes(category as SupportedCategory)) {
      const close = SUPPORTED_CATEGORIES.find(
        (c) => normalizeEnumCategoryKey(c) === normalizeEnumCategoryKey(category),
      );
      if (!close) {
        return res.status(400).json({
          ok: false,
          error: `Unsupported jomashop_category. Use one of: ${SUPPORTED_CATEGORIES.join(", ")}`,
        });
      }
    }

    const acceptedOptions = normalizeAcceptedOptionsInput(body.accepted_options);
    const operatorVerified = body.operator_verified === true || body.operator_verified === "true";

    let verified = false;
    let verificationReason: string;
    if (acceptedOptions && acceptedOptions.length > 0) {
      const targetLower = option.toLowerCase().trim();
      const accepted = acceptedOptions.some(
        (o) => o.toLowerCase().trim() === targetLower,
      );
      if (!accepted) {
        return res.status(400).json({
          ok: false,
          error: `jomashop_option "${option}" is not in the supplied accepted_options list. Pick one of: ${acceptedOptions.join(", ")}`,
          accepted_options: acceptedOptions,
        });
      }
      verified = true;
      verificationReason = "live_accepted_options";
    } else if (operatorVerified) {
      verified = true;
      verificationReason = "operator_verified_no_live_options";
    } else {
      verified = false;
      verificationReason = "unverified";
    }

    storage.upsertEnumOverride({
      jomashopCategory: category,
      jomashopField: field,
      sourceValue: normValue,
      jomashopOption: option,
      notes: body.notes?.trim() || null,
      verified,
      operatorVerified,
      acceptedOptionsJson: acceptedOptions && acceptedOptions.length > 0
        ? JSON.stringify(acceptedOptions)
        : null,
      updatedAt: Date.now(),
    });
    storage.appendLog({
      level: verified ? "info" : "warn",
      message: `Saved enum override ${category}/${field}: ${sourceValue} → ${option} (${verificationReason})`,
      detailsJson: JSON.stringify({
        category,
        field,
        sourceValue,
        option,
        verified,
        operatorVerified,
        verificationReason,
        acceptedOptionsCount: acceptedOptions?.length ?? 0,
      }),
      createdAt: Date.now(),
    });
    res.json({
      ok: true,
      jomashop_category: category,
      jomashop_field: field,
      source_value: normValue,
      jomashop_option: option,
      verified,
      operator_verified: operatorVerified,
      verification_reason: verificationReason,
    });
  });

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

function normalizeAcceptedOptionsInput(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v === "string") {
        const trimmed = v.trim();
        if (trimmed) out.push(trimmed);
      }
    }
    return out;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normalizeAcceptedOptionsInput(parsed);
    } catch {
      // fall through — treat as comma-separated
    }
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return null;
}

function parseAcceptedOptions(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // ignore
  }
  return null;
}
