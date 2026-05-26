// Brand & Category Audit card.
//
// Pairs with server/resolution_audit.ts. Walks every distinct Shopify brand
// and Shopify category code in the cached product preview, resolves each
// against the live Jomashop /i1 lists, and exposes:
//   - Run audit (refresh the resolution status).
//   - Export audit XLSX (Brand Mapping + Category Mapping + reference sheets).
//   - Upload completed audit (dry-run preview).
//   - Apply (writes brand_overrides + category_overrides; invalidates cache).

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  ListChecks,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

type AuditRowBase = {
  shopify_brand?: string;
  shopify_category_code?: string;
  product_count: number;
  sample_titles: string[];
  sample_skus?: string[];
  current_override: string | null;
  current_override_source: "operator" | "built-in" | null;
  exact_match: { id: number | string; name: string } | null;
  suggestion: { id: number | string; name: string } | null;
  status: "exact" | "override" | "fuzzy" | "unresolved";
};
type BrandRow = AuditRowBase & {
  shopify_brand: string;
  shopify_brand_normalized: string;
  outbound_brand: string;
};
type CategoryRow = AuditRowBase & {
  shopify_category_code: string;
  shopify_category_code_normalized: string;
  suggested_category: string;
  outbound_category: string;
};

type AuditSummary = {
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

type AuditResponse = {
  ok: boolean;
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  i1Available: boolean;
  jomashopManufacturers: Array<{ id: number | string; name: string }>;
  jomashopCategories: Array<{ id: number | string; name: string }>;
  brandRows: BrandRow[];
  categoryRows: CategoryRow[];
  summary: AuditSummary;
  warnings: string[];
};

type ImportPreviewResponse = {
  ok: boolean;
  sessionId: string;
  headerErrors: string[];
  totals: {
    brandRows: number;
    categoryRows: number;
    validBrand: number;
    validCategory: number;
    unknownBrand: number;
    unknownCategory: number;
    errorRows: number;
    clearRows: number;
  };
  brandRows: Array<{
    rowNumber: number;
    shopify_brand: string;
    brand_to_use: string;
    errors: string[];
    unknown_jomashop_brand: boolean;
    is_clear: boolean;
  }>;
  categoryRows: Array<{
    rowNumber: number;
    shopify_category_code: string;
    category_to_use: string;
    errors: string[];
    unknown_jomashop_category: boolean;
    is_clear: boolean;
  }>;
};

type ApplyResponse = {
  ok: boolean;
  appliedBrands: number;
  appliedCategories: number;
  clearedBrands: number;
  clearedCategories: number;
  shopDomain: string | null;
  cacheInvalidated: boolean;
  note: string;
  unknownBrands?: string[];
  unknownCategories?: string[];
  error?: string;
};

function StatusBadge({ status }: { status: BrandRow["status"] }) {
  const klass =
    status === "exact"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : status === "override"
      ? "bg-blue-500/10 text-blue-700 dark:text-blue-400"
      : status === "fuzzy"
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : "bg-red-500/10 text-red-700 dark:text-red-400";
  return (
    <Badge variant="outline" className={klass} data-testid={`badge-audit-status-${status}`}>
      {status}
    </Badge>
  );
}

export function ResolutionAuditCard(props: { onAfterApply?: () => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const auditQ = useQuery<AuditResponse>({
    queryKey: ["/api/jomashop/resolution-audit"],
  });

  const runMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/jomashop/resolution-audit", {});
      return (await res.json()) as AuditResponse;
    },
    onSuccess: () => {
      auditQ.refetch();
    },
  });

  const exportMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/jomashop/resolution-audit/export.xlsx", {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = text || res.statusText;
        try {
          const j = JSON.parse(text);
          if (j?.error) msg = j.error;
        } catch {
          // not JSON
        }
        throw new Error(`Export failed (${res.status}): ${msg}`);
      }
      const blob = await res.blob();
      const brandRows = res.headers.get("X-Audit-Brand-Rows") ?? "?";
      const catRows = res.headers.get("X-Audit-Category-Rows") ?? "?";
      const shop = res.headers.get("X-Audit-Shop") ?? "shop";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `resolution-audit-${shop.replace(/\.myshopify\.com$/, "")}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return { brandRows, catRows, shop };
    },
    onSuccess: () => setExportError(null),
    onError: (e: Error) => setExportError(e.message),
  });

  const previewMut = useMutation({
    mutationFn: async (file: File): Promise<ImportPreviewResponse> => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/jomashop/resolution-audit/import-preview", {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Upload failed (${res.status})`);
      return body as ImportPreviewResponse;
    },
    onSuccess: (r) => {
      setPreview(r);
      setApplyResult(null);
      setAllowUnknown(false);
    },
    onError: (e: Error) => {
      setPreview(null);
      setApplyResult({
        ok: false,
        appliedBrands: 0,
        appliedCategories: 0,
        clearedBrands: 0,
        clearedCategories: 0,
        shopDomain: null,
        cacheInvalidated: false,
        note: "",
        error: e.message,
      });
    },
  });

  const applyMut = useMutation({
    mutationFn: async (): Promise<ApplyResponse> => {
      if (!preview) throw new Error("No preview available.");
      const res = await apiRequest("POST", "/api/jomashop/resolution-audit/apply", {
        sessionId: preview.sessionId,
        confirm: true,
        allowUnknown,
      });
      return (await res.json()) as ApplyResponse;
    },
    onSuccess: (r) => {
      setApplyResult(r);
      auditQ.refetch();
      props.onAfterApply?.();
    },
    onError: (e: Error) => {
      const msg = e.message || "Apply failed";
      try {
        const jsonStart = msg.indexOf("{");
        if (jsonStart >= 0) {
          const parsed = JSON.parse(msg.slice(jsonStart));
          setApplyResult({
            ok: false,
            appliedBrands: 0,
            appliedCategories: 0,
            clearedBrands: 0,
            clearedCategories: 0,
            shopDomain: null,
            cacheInvalidated: false,
            note: "",
            unknownBrands: parsed.unknownBrands,
            unknownCategories: parsed.unknownCategories,
            error: parsed.error || msg,
          });
          return;
        }
      } catch {
        // not JSON
      }
      setApplyResult({
        ok: false,
        appliedBrands: 0,
        appliedCategories: 0,
        clearedBrands: 0,
        clearedCategories: 0,
        shopDomain: null,
        cacheInvalidated: false,
        note: "",
        error: msg,
      });
    },
  });

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    previewMut.mutate(f);
    e.target.value = "";
  }

  const audit = auditQ.data;
  const summary = audit?.summary;
  const unresolvedBrands = audit
    ? audit.brandRows.filter((r) => r.status === "unresolved")
    : [];
  const fuzzyBrands = audit ? audit.brandRows.filter((r) => r.status === "fuzzy") : [];
  const unresolvedCats = audit
    ? audit.categoryRows.filter((r) => r.status === "unresolved")
    : [];
  const fuzzyCats = audit ? audit.categoryRows.filter((r) => r.status === "fuzzy") : [];

  return (
    <Card data-testid="card-resolution-audit">
      <CardHeader className="flex flex-row items-start justify-between gap-3 border-b border-card-border">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ListChecks className="h-4 w-4" />
            Brand & Category Audit
          </CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Audit every distinct Shopify brand and category code against the live Jomashop{" "}
            <code>/i1/manufacturers</code> and <code>/i1/categories</code> lists. Export the audit
            to XLSX, fill in <span className="font-mono">brand_to_use</span> /{" "}
            <span className="font-mono">category_to_use</span>, upload, and apply — overrides save
            in bulk so every product with the same brand/code flips at once.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="button-run-audit"
            disabled={runMut.isPending}
            onClick={() => runMut.mutate()}
          >
            {runMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ListChecks className="mr-2 h-3.5 w-3.5" />
            )}
            Run audit
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-export-audit"
            disabled={
              exportMut.isPending ||
              !audit ||
              (audit.brandRows.length === 0 && audit.categoryRows.length === 0)
            }
            onClick={() => exportMut.mutate()}
          >
            {exportMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-2 h-3.5 w-3.5" />
            )}
            Export audit Excel
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-upload-audit"
            disabled={previewMut.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {previewMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-2 h-3.5 w-3.5" />
            )}
            Upload completed audit
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            data-testid="input-upload-audit"
            onChange={onFileChange}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-3 p-4 text-xs">
        {auditQ.isLoading && !audit && (
          <div className="text-muted-foreground">Loading audit…</div>
        )}

        {audit && (
          <div className="flex flex-wrap items-center gap-2" data-testid="block-audit-summary">
            <Badge variant="outline">
              {audit.totalProducts} product{audit.totalProducts === 1 ? "" : "s"} cached
            </Badge>
            <Badge
              variant="outline"
              className={
                audit.i1Available
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
              }
            >
              Jomashop /i1 {audit.i1Available ? "reachable" : "unavailable"}
              {audit.i1Available
                ? ` · ${audit.jomashopManufacturers.length} brand(s), ${audit.jomashopCategories.length} category(ies)`
                : ""}
            </Badge>
            {summary && (
              <>
                <Badge variant="outline" data-testid="badge-summary-brands">
                  Brands: {summary.distinctBrands} distinct · {summary.exactBrands} exact ·{" "}
                  {summary.overrideBrands} override ·{" "}
                  <span className="text-amber-600 dark:text-amber-400">
                    {summary.fuzzyBrands} fuzzy
                  </span>{" "}
                  ·{" "}
                  <span className="text-red-600 dark:text-red-400">
                    {summary.unresolvedBrands} unresolved
                  </span>
                </Badge>
                <Badge variant="outline" data-testid="badge-summary-categories">
                  Categories: {summary.distinctCategories} distinct · {summary.exactCategories}{" "}
                  exact · {summary.overrideCategories} override ·{" "}
                  <span className="text-amber-600 dark:text-amber-400">
                    {summary.fuzzyCategories} fuzzy
                  </span>{" "}
                  ·{" "}
                  <span className="text-red-600 dark:text-red-400">
                    {summary.unresolvedCategories} unresolved
                  </span>
                </Badge>
                <Badge
                  variant="outline"
                  className={
                    summary.notReadyProducts === 0
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "bg-red-500/10 text-red-700 dark:text-red-400"
                  }
                  data-testid="badge-summary-not-ready"
                >
                  {summary.notReadyProducts} product(s) not ready
                </Badge>
              </>
            )}
            {!audit.fromCache && (
              <Badge
                variant="outline"
                className="bg-amber-500/10 text-amber-700 dark:text-amber-400"
              >
                No cached preview — click Refresh from Shopify first.
              </Badge>
            )}
            {audit.warnings.length > 0 && (
              <Badge
                variant="outline"
                className="bg-red-500/10 text-red-700 dark:text-red-400"
                title={audit.warnings.join("\n")}
                data-testid="badge-audit-warnings"
              >
                {audit.warnings.length} warning(s)
              </Badge>
            )}
          </div>
        )}

        {exportError && (
          <div
            data-testid="text-audit-export-error"
            className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500"
          >
            {exportError}
          </div>
        )}

        {audit && (unresolvedBrands.length > 0 || fuzzyBrands.length > 0) && (
          <div
            className="rounded border border-amber-500/40 bg-amber-500/5 p-2"
            data-testid="block-unresolved-brands"
          >
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              Brands needing attention ({unresolvedBrands.length + fuzzyBrands.length})
            </div>
            <div className="max-h-40 overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Shopify brand</th>
                    <th className="px-2 py-1 text-right">Products</th>
                    <th className="px-2 py-1 text-left">Suggestion</th>
                    <th className="px-2 py-1 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...unresolvedBrands, ...fuzzyBrands].slice(0, 50).map((r) => (
                    <tr
                      key={r.shopify_brand_normalized || r.shopify_brand}
                      className="border-t border-border"
                      data-testid={`row-unresolved-brand-${r.shopify_brand_normalized}`}
                    >
                      <td className="px-2 py-1 font-mono">{r.shopify_brand}</td>
                      <td className="px-2 py-1 text-right">{r.product_count}</td>
                      <td className="px-2 py-1">
                        {r.suggestion ? `${r.suggestion.name} (#${r.suggestion.id})` : "—"}
                      </td>
                      <td className="px-2 py-1">
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {audit && (unresolvedCats.length > 0 || fuzzyCats.length > 0) && (
          <div
            className="rounded border border-amber-500/40 bg-amber-500/5 p-2"
            data-testid="block-unresolved-categories"
          >
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              Categories needing attention ({unresolvedCats.length + fuzzyCats.length})
            </div>
            <div className="max-h-40 overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Shopify code</th>
                    <th className="px-2 py-1 text-left">Suggested</th>
                    <th className="px-2 py-1 text-right">Products</th>
                    <th className="px-2 py-1 text-left">Suggestion</th>
                    <th className="px-2 py-1 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...unresolvedCats, ...fuzzyCats].slice(0, 50).map((r) => (
                    <tr
                      key={r.shopify_category_code_normalized || r.shopify_category_code}
                      className="border-t border-border"
                      data-testid={`row-unresolved-category-${r.shopify_category_code_normalized}`}
                    >
                      <td className="px-2 py-1 font-mono">{r.shopify_category_code}</td>
                      <td className="px-2 py-1">{r.suggested_category}</td>
                      <td className="px-2 py-1 text-right">{r.product_count}</td>
                      <td className="px-2 py-1">
                        {r.suggestion ? `${r.suggestion.name} (#${r.suggestion.id})` : "—"}
                      </td>
                      <td className="px-2 py-1">
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {preview && (
          <div
            className="rounded border border-border bg-card/40 p-2"
            data-testid="block-audit-preview"
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-medium">
              <span>Upload dry-run:</span>
              <Badge variant="outline">
                Brand rows: {preview.totals.brandRows} (valid: {preview.totals.validBrand})
              </Badge>
              <Badge variant="outline">
                Category rows: {preview.totals.categoryRows} (valid: {preview.totals.validCategory})
              </Badge>
              {preview.totals.unknownBrand + preview.totals.unknownCategory > 0 && (
                <Badge
                  variant="outline"
                  className="bg-amber-500/10 text-amber-700 dark:text-amber-400"
                >
                  Unknown live values:{" "}
                  {preview.totals.unknownBrand + preview.totals.unknownCategory}
                </Badge>
              )}
              {preview.totals.errorRows > 0 && (
                <Badge variant="outline" className="bg-red-500/10 text-red-700 dark:text-red-400">
                  Row errors: {preview.totals.errorRows}
                </Badge>
              )}
            </div>
            {preview.headerErrors.length > 0 && (
              <div className="mb-1 text-[11px] text-red-500">
                {preview.headerErrors.join(" · ")}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-[11px]">
                <input
                  type="checkbox"
                  data-testid="checkbox-audit-allow-unknown"
                  checked={allowUnknown}
                  onChange={(e) => setAllowUnknown(e.target.checked)}
                />
                Allow values not in live Jomashop lists
              </label>
              <Button
                size="sm"
                data-testid="button-apply-audit"
                disabled={
                  applyMut.isPending ||
                  preview.headerErrors.length > 0 ||
                  preview.totals.validBrand + preview.totals.validCategory === 0
                }
                onClick={() => applyMut.mutate()}
              >
                {applyMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                )}
                Apply mappings
              </Button>
            </div>
          </div>
        )}

        {applyResult && (
          <div
            data-testid="block-audit-apply-result"
            className={
              applyResult.ok
                ? "rounded border border-emerald-500/40 bg-emerald-500/5 p-2 text-emerald-700 dark:text-emerald-400"
                : "rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500"
            }
          >
            {applyResult.ok ? (
              <>
                Saved {applyResult.appliedBrands} brand override(s) and{" "}
                {applyResult.appliedCategories} category override(s).
                {applyResult.clearedBrands + applyResult.clearedCategories > 0 &&
                  ` Cleared ${applyResult.clearedBrands} brand(s), ${applyResult.clearedCategories} category(ies).`}{" "}
                {applyResult.note}
              </>
            ) : (
              <>
                {applyResult.error}
                {applyResult.unknownBrands && applyResult.unknownBrands.length > 0 && (
                  <div className="mt-1">
                    <span className="font-mono">Unknown brands:</span>{" "}
                    {applyResult.unknownBrands.join(", ")}
                  </div>
                )}
                {applyResult.unknownCategories && applyResult.unknownCategories.length > 0 && (
                  <div className="mt-1">
                    <span className="font-mono">Unknown categories:</span>{" "}
                    {applyResult.unknownCategories.join(", ")}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
