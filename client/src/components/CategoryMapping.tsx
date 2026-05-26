// Category mapping workflow UI. Pairs with server/category_mapping.ts.
//
// Flow:
//   1) Aggregate distinct Shopify category codes from the cached product
//      preview and download an XLSX listing them.
//   2) Operator fills in jomashop_category_to_use for each row and re-uploads.
//   3) Dry-run preview shows totals + unknown Jomashop categories.
//   4) Operator clicks Apply (explicit confirm); overrides are saved to
//      SQLite and the product cache is invalidated.
//   5) Operator clicks Refresh from Shopify on the Products page to see
//      "needs verification" rows flip to ready.

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

type AggregateRow = {
  shopify_category_code: string;
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

type AggregateResponse = {
  ok: boolean;
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  uniqueCodes: number;
  jomashopCategoriesAvailable: boolean;
  jomashopCategories: string[];
  rows: AggregateRow[];
};

type ImportPreview = {
  ok: boolean;
  sessionId: string;
  headerErrors: string[];
  jomashopCategoriesAvailable: boolean;
  jomashopCategories: string[];
  totals: {
    total: number;
    valid: number;
    errors: number;
    unknownCategory: number;
    clear: number;
    affectedProducts: number;
  };
  rows: Array<{
    rowNumber: number;
    shopify_category_code: string;
    shopify_category_code_normalized: string;
    jomashop_category_to_use: string;
    notes: string;
    errors: string[];
    unknown_jomashop_category: boolean;
    is_clear: boolean;
    product_count_estimate: number;
  }>;
};

type ApplyResponse = {
  ok: boolean;
  applied: number;
  cleared: number;
  shopDomain: string | null;
  cacheInvalidated: boolean;
  note: string;
  unknowns?: string[];
  error?: string;
};

type OverridesResponse = {
  ok: boolean;
  count: number;
  overrides: Array<{
    shopify_category_code: string;
    jomashop_category: string;
    notes: string | null;
    updated_at: number;
  }>;
};

export function CategoryMappingCard(props: { onAfterApply?: () => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [pendingApplyOpen, setPendingApplyOpen] = useState(false);
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);

  const aggregateQ = useQuery<AggregateResponse>({
    queryKey: ["/api/category-mapping/aggregate"],
  });
  const overridesQ = useQuery<OverridesResponse>({
    queryKey: ["/api/category-mapping/overrides"],
  });

  const exportMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/category-mapping/export.xlsx", {
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
      const rowCount = res.headers.get("X-Export-Rows") ?? "?";
      const shop = res.headers.get("X-Export-Shop") ?? "shop";
      const filename = `category-mapping-${shop.replace(/\.myshopify\.com$/, "")}-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return { rowCount, shop };
    },
    onSuccess: (r) => {
      setExportError(null);
      setExportInfo(`Exported ${r.rowCount} category code(s) from ${r.shop}.`);
    },
    onError: (e: Error) => {
      setExportError(e.message);
      setExportInfo(null);
    },
  });

  const previewMut = useMutation({
    mutationFn: async (file: File): Promise<ImportPreview> => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/category-mapping/import-preview", {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.error || `Upload failed (${res.status})`);
      }
      return body as ImportPreview;
    },
    onSuccess: (r) => {
      setPreview(r);
      setApplyResult(null);
      setAllowUnknown(false);
    },
  });

  const applyMut = useMutation({
    mutationFn: async (): Promise<ApplyResponse> => {
      if (!preview) throw new Error("No preview available.");
      const res = await apiRequest("POST", "/api/category-mapping/apply", {
        sessionId: preview.sessionId,
        confirm: true,
        allowUnknown,
      });
      return (await res.json()) as ApplyResponse;
    },
    onSuccess: (r) => {
      setApplyResult(r);
      setPendingApplyOpen(false);
      overridesQ.refetch();
      aggregateQ.refetch();
      props.onAfterApply?.();
    },
    onError: async (e: Error) => {
      setPendingApplyOpen(false);
      const msg = e.message || "Apply failed";
      // Try to surface server response shape
      try {
        const parsed = JSON.parse(msg.replace(/^\d+:\s*/, ""));
        if (parsed && typeof parsed === "object") {
          setApplyResult({
            ok: false,
            applied: 0,
            cleared: 0,
            shopDomain: null,
            cacheInvalidated: false,
            note: "",
            unknowns: parsed.unknowns,
            error: parsed.error || msg,
          });
          return;
        }
      } catch {
        // not JSON
      }
      setApplyResult({
        ok: false,
        applied: 0,
        cleared: 0,
        shopDomain: null,
        cacheInvalidated: false,
        note: "",
        error: msg,
      });
    },
  });

  const deleteOverrideMut = useMutation({
    mutationFn: async (code: string) => {
      const res = await apiRequest("DELETE", `/api/category-mapping/overrides/${encodeURIComponent(code)}`);
      return (await res.json()) as { ok: boolean; removed: string };
    },
    onSuccess: () => {
      overridesQ.refetch();
      aggregateQ.refetch();
      props.onAfterApply?.();
    },
  });

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    previewMut.mutate(f);
    e.target.value = "";
  }

  const agg = aggregateQ.data;
  const overrides = overridesQ.data?.overrides ?? [];
  const uniqueCount = agg?.uniqueCodes ?? 0;
  const hasUnknown = (preview?.totals.unknownCategory ?? 0) > 0;

  return (
    <Card data-testid="card-category-mapping">
      <CardHeader className="flex flex-row items-start justify-between gap-3 border-b border-card-border">
        <div className="min-w-0">
          <CardTitle className="text-sm">Category mapping (Shopify → Jomashop)</CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Map Shopify category codes (e.g. DRSH) to Jomashop categories. Download the
            list, fill <span className="font-mono">jomashop_category_to_use</span>, upload,
            then click Apply. Each mapping flips every product with that code in one go.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="button-export-category-mapping"
            disabled={exportMut.isPending || uniqueCount === 0}
            onClick={() => exportMut.mutate()}
          >
            {exportMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-2 h-3.5 w-3.5" />
            )}
            Export category mapping
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-upload-category-mapping"
            disabled={previewMut.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {previewMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-2 h-3.5 w-3.5" />
            )}
            Upload filled mapping
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            data-testid="input-upload-category-mapping"
            onChange={onFileChange}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 text-xs">
        {agg && (
          <div className="flex flex-wrap items-center gap-2" data-testid="block-aggregate-summary">
            <Badge variant="outline">
              {agg.uniqueCodes} unique Shopify code{agg.uniqueCodes === 1 ? "" : "s"}
            </Badge>
            <Badge variant="outline">{agg.totalProducts} product(s) cached</Badge>
            {agg.jomashopCategoriesAvailable ? (
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                Jomashop categories: {agg.jomashopCategories.length}
              </Badge>
            ) : (
              <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                Jomashop category list unavailable — free-text input
              </Badge>
            )}
            {!agg.fromCache && (
              <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                No cached preview — click Refresh from Shopify first.
              </Badge>
            )}
          </div>
        )}
        {exportError && (
          <div
            data-testid="text-category-export-error"
            className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500"
          >
            {exportError}
          </div>
        )}
        {exportInfo && (
          <div
            data-testid="text-category-export-info"
            className="rounded border border-emerald-500/40 bg-emerald-500/5 p-2 text-emerald-500"
          >
            {exportInfo}
          </div>
        )}
        {previewMut.isError && (
          <div
            data-testid="text-category-upload-error"
            className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500"
          >
            {(previewMut.error as Error)?.message}
          </div>
        )}

        {agg && agg.rows.length > 0 && !preview && (
          <div className="max-h-56 overflow-auto rounded border border-border">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-card/80 text-[10px] uppercase text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left">Shopify code</th>
                  <th className="px-2 py-1 text-left">Suggested</th>
                  <th className="px-2 py-1 text-left">Products</th>
                  <th className="px-2 py-1 text-left">Missing</th>
                  <th className="px-2 py-1 text-left">Current mapping</th>
                  <th className="px-2 py-1 text-left">Sample titles</th>
                </tr>
              </thead>
              <tbody>
                {agg.rows.map((r) => (
                  <tr
                    key={r.shopify_category_code_normalized}
                    className="border-t border-border"
                    data-testid={`row-aggregate-${r.shopify_category_code_normalized}`}
                  >
                    <td className="px-2 py-1 font-mono">{r.shopify_category_code || "—"}</td>
                    <td className="px-2 py-1">{r.suggested_category || "—"}</td>
                    <td className="px-2 py-1">{r.product_count}</td>
                    <td className="px-2 py-1">{r.missing_count}</td>
                    <td className="px-2 py-1">
                      {r.current_jomashop_category ? (
                        <Badge variant="outline" className="bg-blue-500/10 text-[10px] text-blue-700">
                          {r.current_jomashop_category}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">
                      {r.sample_titles.slice(0, 2).join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {preview && (
          <div className="space-y-3" data-testid="block-category-preview">
            {preview.headerErrors.length > 0 && (
              <div className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500">
                <div className="font-medium">Header errors</div>
                <ul className="ml-4 list-disc">
                  {preview.headerErrors.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" data-testid="badge-total-category">
                Total: {preview.totals.total}
              </Badge>
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                Valid: {preview.totals.valid}
              </Badge>
              {preview.totals.errors > 0 && (
                <Badge variant="outline" className="bg-red-500/10 text-red-700 dark:text-red-400">
                  Errors: {preview.totals.errors}
                </Badge>
              )}
              {preview.totals.unknownCategory > 0 && (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  Unknown Jomashop category: {preview.totals.unknownCategory}
                </Badge>
              )}
              {preview.totals.clear > 0 && (
                <Badge variant="outline">Clear: {preview.totals.clear}</Badge>
              )}
              <Badge variant="outline" className="bg-blue-500/10 text-blue-700 dark:text-blue-400">
                Products affected: {preview.totals.affectedProducts}
              </Badge>
            </div>

            <div className="max-h-60 overflow-auto rounded border border-border">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-card/80 text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Row</th>
                    <th className="px-2 py-1 text-left">Shopify code</th>
                    <th className="px-2 py-1 text-left">Jomashop category</th>
                    <th className="px-2 py-1 text-left">Products</th>
                    <th className="px-2 py-1 text-left">Notes / errors</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr
                      key={r.rowNumber}
                      className="border-t border-border"
                      data-testid={`row-category-preview-${r.rowNumber}`}
                    >
                      <td className="px-2 py-1 font-mono">{r.rowNumber}</td>
                      <td className="px-2 py-1 font-mono">{r.shopify_category_code || "—"}</td>
                      <td className="px-2 py-1">
                        {r.is_clear ? (
                          <span className="text-muted-foreground">— (clear)</span>
                        ) : (
                          <span
                            className={
                              r.unknown_jomashop_category ? "text-amber-600" : undefined
                            }
                          >
                            {r.jomashop_category_to_use || "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1">{r.product_count_estimate}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {r.errors.length > 0
                          ? r.errors.join("; ")
                          : r.unknown_jomashop_category
                            ? "Not in live Jomashop categories"
                            : r.notes || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="default"
                data-testid="button-open-apply-category"
                disabled={preview.totals.valid === 0 || applyMut.isPending}
                onClick={() => setPendingApplyOpen(true)}
              >
                {applyMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                )}
                Apply category mappings
              </Button>
              {hasUnknown && (
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={allowUnknown}
                    onChange={(e) => setAllowUnknown(e.target.checked)}
                    data-testid="checkbox-allow-unknown"
                  />
                  Allow unknown Jomashop categories
                </label>
              )}
            </div>
          </div>
        )}

        {applyResult && (
          <div
            data-testid="block-apply-result"
            className={`rounded border p-2 ${
              applyResult.ok
                ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                : "border-red-500/40 bg-red-500/5 text-red-500"
            }`}
          >
            {applyResult.ok ? (
              <div>
                Saved <strong>{applyResult.applied}</strong> mapping(s)
                {applyResult.cleared > 0 ? `, cleared ${applyResult.cleared}` : ""}.
                {applyResult.cacheInvalidated
                  ? " Product cache cleared — click Refresh from Shopify to see updated readiness."
                  : ""}
              </div>
            ) : (
              <div>
                <div className="font-medium">{applyResult.error || "Apply failed"}</div>
                {applyResult.unknowns && applyResult.unknowns.length > 0 && (
                  <ul className="ml-4 mt-1 list-disc">
                    {applyResult.unknowns.map((u, i) => (
                      <li key={i} className="font-mono text-[10px]">{u}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {overrides.length > 0 && (
          <div className="rounded border border-border bg-card/40 p-2" data-testid="block-current-overrides">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Current saved mappings
              </div>
              <Badge variant="outline">{overrides.length}</Badge>
            </div>
            <div className="max-h-40 overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Shopify code</th>
                    <th className="px-2 py-1 text-left">Jomashop category</th>
                    <th className="px-2 py-1 text-left">Notes</th>
                    <th className="px-2 py-1 text-right">&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr
                      key={o.shopify_category_code}
                      className="border-t border-border"
                      data-testid={`row-override-${o.shopify_category_code}`}
                    >
                      <td className="px-2 py-1 font-mono">{o.shopify_category_code}</td>
                      <td className="px-2 py-1">{o.jomashop_category}</td>
                      <td className="px-2 py-1 text-muted-foreground">{o.notes || "—"}</td>
                      <td className="px-2 py-1 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`button-remove-override-${o.shopify_category_code}`}
                          disabled={deleteOverrideMut.isPending}
                          onClick={() => deleteOverrideMut.mutate(o.shopify_category_code)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={pendingApplyOpen} onOpenChange={setPendingApplyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply category mappings?</DialogTitle>
            <DialogDescription>
              {preview ? (
                <>
                  This will save <strong>{preview.totals.valid}</strong> mapping(s) to the
                  local database and invalidate the product cache.{" "}
                  <strong>{preview.totals.affectedProducts}</strong> product(s) will be
                  re-classified on the next Refresh from Shopify.
                  {hasUnknown && allowUnknown && (
                    <>
                      <br />
                      <strong>
                        Warning: {preview.totals.unknownCategory} row(s) reference Jomashop
                        categories not in the live list and will be saved anyway.
                      </strong>
                    </>
                  )}
                </>
              ) : (
                "No preview loaded."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingApplyOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="button-confirm-apply-category"
              disabled={!preview || applyMut.isPending}
              onClick={() => applyMut.mutate()}
            >
              {applyMut.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
