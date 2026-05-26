// Brand mapping workflow: store operator-supplied Shopify brand → exact
// Jomashop brand translations so the push payload always uses the spelling
// the Jomashop catalog recognizes. Mirrors category_mapping.ts but kept
// minimal — brands are pure key/value, no aggregate-from-cache needed.

import type { Express } from "express";
import { storage } from "./storage";

/**
 * Canonical lookup key for a Shopify brand string. Lowercases and strips
 * non-alphanumerics so "Tod's", "Tods", and "TODS" collapse to the same row.
 */
export function normalizeBrandKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

/**
 * Built-in Shopify brand → exact Jomashop brand seed mappings.
 *
 * Intentionally empty by default: the live Jomashop brand catalog isn't
 * exposed via API so the operator must populate this table by attempting a
 * push, copying the exact brand string from the Jomashop portal, and saving
 * it here. Listed here as the extension point — adding entries does not
 * require a code change beyond this file, but most overrides should be
 * stored in the operator-managed `brand_overrides` SQLite table.
 *
 * Keys are normalized via normalizeBrandKey.
 */
export const BUILT_IN_BRAND_OVERRIDES: Record<string, string> = {};

/**
 * Resolve a Shopify brand string to the exact Jomashop brand to send at push
 * time. Precedence: operator override → built-in seed → null (caller falls
 * back to the raw Shopify brand value).
 */
export function lookupBrandOverride(
  shopifyBrand: string | null | undefined,
): { jomashopBrand: string; source: "operator" | "built-in" } | null {
  const norm = normalizeBrandKey(shopifyBrand);
  if (!norm) return null;
  const row = storage.getBrandOverride(norm);
  if (row) {
    return { jomashopBrand: row.jomashopBrand, source: "operator" };
  }
  const builtIn = BUILT_IN_BRAND_OVERRIDES[norm];
  if (builtIn) return { jomashopBrand: builtIn, source: "built-in" };
  return null;
}

export function registerBrandMappingRoutes(app: Express): void {
  // GET: current saved brand overrides.
  app.get("/api/brand-mapping/overrides", (_req, res) => {
    const overrides = storage.listBrandOverrides();
    res.json({
      ok: true,
      count: overrides.length,
      overrides: overrides.map((o) => ({
        shopify_brand: o.shopifyBrand,
        jomashop_brand: o.jomashopBrand,
        notes: o.notes,
        updated_at: o.updatedAt,
      })),
    });
  });

  // POST: upsert a single brand override.
  // body: { shopify_brand, jomashop_brand, notes? }
  app.post("/api/brand-mapping/overrides", (req, res) => {
    const { shopify_brand, jomashop_brand, notes } = (req.body ?? {}) as {
      shopify_brand?: string;
      jomashop_brand?: string;
      notes?: string;
    };
    if (!shopify_brand || !shopify_brand.trim()) {
      return res.status(400).json({ ok: false, error: "Missing shopify_brand." });
    }
    if (!jomashop_brand || !jomashop_brand.trim()) {
      return res.status(400).json({ ok: false, error: "Missing jomashop_brand." });
    }
    const norm = normalizeBrandKey(shopify_brand);
    if (!norm) {
      return res.status(400).json({ ok: false, error: "shopify_brand normalizes to empty string." });
    }
    storage.upsertBrandOverride({
      shopifyBrand: norm,
      jomashopBrand: jomashop_brand.trim(),
      notes: notes?.trim() || null,
      updatedAt: Date.now(),
    });
    storage.appendLog({
      level: "info",
      message: `Saved brand override ${shopify_brand} → ${jomashop_brand}`,
      detailsJson: JSON.stringify({ norm, jomashop_brand }),
      createdAt: Date.now(),
    });
    res.json({ ok: true, shopify_brand: norm, jomashop_brand: jomashop_brand.trim() });
  });

  // DELETE: remove a single brand override.
  app.delete("/api/brand-mapping/overrides/:brand", (req, res) => {
    const norm = normalizeBrandKey(req.params.brand);
    if (!norm) return res.status(400).json({ ok: false, error: "Missing brand" });
    storage.deleteBrandOverride(norm);
    res.json({ ok: true, removed: norm });
  });
}
