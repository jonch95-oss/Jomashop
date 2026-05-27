// Operator UI for the per-product Jomashop field XLSX workflow.
//
// Sister component to JomashopMappingExcel. Allows the operator to:
//   1) Export every cached Shopify product (or only unready ones) into one
//      XLSX with one sheet per Jomashop category. Each sheet has identity
//      columns + the category's live schema fields as editable columns.
//   2) Upload the completed XLSX. Each filled cell is validated against the
//      live accepted-options list (for enum fields) and basic type/length
//      sanity (for string/number).
//   3) Apply — valid cells are written to Shopify metafields (namespace
//      "jomashop", key derived from the property name). Variant-targeted
//      fields like Size route to variant metafields; product-level fields
//      route to product metafields. The cached preview is invalidated so
//      the next refresh re-derives properties from the new metafields.

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

type PreviewRow = {
  rowNumber: number;
  sheetName: string;
  rowId: string;
  jomashop_category: string;
  shopify_product_id: string;
  shopify_variant_id: string;
  vendor_sku: string;
  field_count: number;
  field_values: Record<string, string>;
  write_back: boolean;
  notes: string;
  is_valid: boolean;
  errors: string[];
};

type PreviewResponse = {
  ok: boolean;
  sessionId: string;
  headerErrors: string[];
  perCategoryWarnings: string[];
  totals: {
    total: number;
    valid: number;
    errors: number;
    writeback: number;
    metafieldsFillable: number;
  };
  rows: PreviewRow[];
};

type ApplyResponse = {
  ok: boolean;
  rowsProcessed: number;
  validRowsApplied: number;
  skippedInvalidRows: number;
  cacheInvalidatedFor: string | null;
  shopifyConnected: boolean;
  metafieldWriteSummary: { attempted: number; succeeded: number; failed: number };
  metafieldWrites: Array<{
    rowId: string;
    ownerId: string;
    ownerType: "product" | "variant";
    field: string;
    namespace: string;
    key: string;
    ok: boolean;
    error: string | null;
  }>;
  warnings: string[];
  note: string;
};

export function JomashopProductFieldExcelCard() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [includeAll, setIncludeAll] = useState(false);

  const exportMut = useMutation({
    mutationFn: async () => {
      const url = `/api/jomashop-product-fields/export.xlsx${includeAll ? "?all=1" : ""}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Export failed (${res.status}): ${text || res.statusText}`);
      }
      const blob = await res.blob();
      const rowCount = res.headers.get("X-Export-Rows") ?? "?";
      const sheetCount = res.headers.get("X-Export-Sheets") ?? "?";
      const shop = res.headers.get("X-Export-Shop") ?? "shop";
      const filename = `jomashop-product-fields-${shop.replace(/\.myshopify\.com$/, "")}-${
        includeAll ? "all" : "unready"
      }-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      return { rowCount, sheetCount, shop };
    },
    onSuccess: (r) => {
      setExportError(null);
      setExportInfo(
        `Exported ${r.rowCount} row(s) across ${r.sheetCount} category sheet(s) for ${r.shop}.`,
      );
    },
    onError: (e: Error) => {
      setExportError(e.message);
      setExportInfo(null);
    },
  });

  const previewMut = useMutation({
    mutationFn: async (file: File): Promise<PreviewResponse> => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/jomashop-product-fields/import-preview", {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.error || `Upload failed (${res.status})`);
      }
      return body as PreviewResponse;
    },
    onSuccess: (r) => {
      setPreview(r);
      setApplyResult(null);
    },
  });

  const applyMut = useMutation({
    mutationFn: async (): Promise<ApplyResponse> => {
      if (!preview) throw new Error("No preview available.");
      const res = await apiRequest("POST", "/api/jomashop-product-fields/apply", {
        sessionId: preview.sessionId,
        confirm: true,
      });
      return (await res.json()) as ApplyResponse;
    },
    onSuccess: (r) => setApplyResult(r),
  });

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    previewMut.mutate(f);
    e.target.value = "";
  }

  const errorRows = preview?.rows.filter((r) => !r.is_valid) ?? [];
  const validRows = preview?.rows.filter((r) => r.is_valid) ?? [];

  return (
    <Card data-testid="jomashop-product-field-excel">
      <CardHeader className="border-b border-card-border">
        <CardTitle className="text-sm">Per-product Jomashop fields (XLSX)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <p className="text-xs text-muted-foreground">
          Export a workbook with one row per Shopify product (or per variant)
          and one sheet per Jomashop category, with that category's live
          schema fields as editable columns. Fill the cells in Excel, mark
          Write Back? = Yes for rows whose values should be pushed back to
          Shopify metafields (namespace <code className="font-mono">jomashop</code>,
          key derived from the property name), and upload the file. Variant-
          specific fields like Size route to variant metafields; product-
          level fields route to product metafields. This is complementary to
          the grouped enum-mapping workflow above.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeAll}
              onChange={(e) => setIncludeAll(e.target.checked)}
              data-testid="checkbox-product-field-include-all"
            />
            Include push-ready products too
          </label>
          <Button
            onClick={() => exportMut.mutate()}
            disabled={exportMut.isPending}
            data-testid="button-product-field-export"
          >
            {exportMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export Product Field Excel
          </Button>
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={previewMut.isPending}
            data-testid="button-product-field-upload"
          >
            {previewMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Upload Product Field Excel
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={onFileChange}
          />
        </div>

        {exportInfo && (
          <div className="rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-green-700">
            {exportInfo}
          </div>
        )}
        {exportError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {exportError}
          </div>
        )}
        {previewMut.isError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {(previewMut.error as Error).message}
          </div>
        )}

        {preview && (
          <div className="space-y-3 rounded-md border border-card-border bg-card/40 p-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> {preview.totals.valid} valid
              </Badge>
              <Badge variant="destructive" className="gap-1">
                <XCircle className="h-3 w-3" /> {preview.totals.errors} error
                {preview.totals.errors === 1 ? "" : "s"}
              </Badge>
              <Badge variant="outline" className="gap-1">
                {preview.totals.writeback} writeback row(s)
              </Badge>
              <Badge variant="outline" className="gap-1">
                {preview.totals.metafieldsFillable} cell(s) to write
              </Badge>
              <span className="text-muted-foreground">
                ({preview.totals.total} total)
              </span>
            </div>

            {preview.headerErrors.length > 0 && (
              <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {preview.headerErrors.map((e, i) => (
                  <div key={i} className="flex items-start gap-1">
                    <AlertTriangle className="mt-0.5 h-3 w-3" />
                    {e}
                  </div>
                ))}
              </div>
            )}

            {preview.perCategoryWarnings.length > 0 && (
              <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700">
                {preview.perCategoryWarnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1">
                    <AlertTriangle className="mt-0.5 h-3 w-3" />
                    {w}
                  </div>
                ))}
              </div>
            )}

            {errorRows.length > 0 && (
              <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                <div className="font-medium">Row errors</div>
                {errorRows.slice(0, 10).map((r) => (
                  <div key={`${r.sheetName}-${r.rowNumber}`} className="font-mono text-[11px]">
                    {r.sheetName} row {r.rowNumber} ({r.vendor_sku}): {r.errors.join("; ")}
                  </div>
                ))}
                {errorRows.length > 10 && (
                  <div className="text-[11px] italic">
                    …and {errorRows.length - 10} more
                  </div>
                )}
              </div>
            )}

            {validRows.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium">Valid rows (preview)</div>
                <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-card-border bg-background/60 p-2 text-[11px] font-mono">
                  {validRows.slice(0, 25).map((r) => (
                    <div
                      key={`${r.sheetName}-${r.rowNumber}`}
                      className="flex items-center gap-2"
                    >
                      <span className="text-muted-foreground">
                        {r.jomashop_category}/{r.vendor_sku}
                      </span>
                      <span>
                        {Object.entries(r.field_values).slice(0, 3).map(([k, v]) => (
                          <span key={k} className="mr-2">
                            {k}=<span className="text-green-700">{v}</span>
                          </span>
                        ))}
                        {Object.keys(r.field_values).length > 3 && (
                          <span className="italic text-muted-foreground">
                            +{Object.keys(r.field_values).length - 3} more
                          </span>
                        )}
                      </span>
                      {r.write_back && (
                        <Badge variant="outline" className="text-[10px]">
                          writeback
                        </Badge>
                      )}
                    </div>
                  ))}
                  {validRows.length > 25 && (
                    <div className="italic text-muted-foreground">
                      …and {validRows.length - 25} more
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-card-border pt-3">
              <Button
                onClick={() => applyMut.mutate()}
                disabled={applyMut.isPending || validRows.length === 0}
                data-testid="button-product-field-apply"
              >
                {applyMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                Apply {validRows.length} row(s) → write metafields
              </Button>
            </div>
          </div>
        )}

        {applyResult && (
          <div
            className="space-y-2 rounded-md border border-green-500/30 bg-green-500/5 p-3 text-xs"
            data-testid="product-field-apply-result"
          >
            <div className="font-medium text-green-700">
              Processed {applyResult.rowsProcessed} row(s);{" "}
              {applyResult.validRowsApplied} applied,{" "}
              {applyResult.skippedInvalidRows} skipped.
            </div>
            <div>
              Cache invalidated for:{" "}
              <span className="font-mono">{applyResult.cacheInvalidatedFor ?? "(none)"}</span>
            </div>
            <div>
              Metafield writes:{" "}
              <span className="font-medium">
                {applyResult.metafieldWriteSummary.succeeded}/
                {applyResult.metafieldWriteSummary.attempted}
              </span>{" "}
              succeeded
              {applyResult.metafieldWriteSummary.failed > 0 &&
                ` (${applyResult.metafieldWriteSummary.failed} failed)`}
            </div>
            {applyResult.metafieldWrites
              .filter((w) => !w.ok)
              .slice(0, 5)
              .map((w, i) => (
                <div key={i} className="font-mono text-[11px] text-destructive">
                  {w.ownerType} {w.ownerId} {w.namespace}.{w.key}: {w.error}
                </div>
              ))}
            {applyResult.warnings.length > 0 && (
              <div className="space-y-0.5 text-amber-700">
                {applyResult.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
            <div className="text-muted-foreground">{applyResult.note}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
