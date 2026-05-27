// Operator UI for the bulk Jomashop mapping XLSX workflow.
//
// Pairs with server/jomashop_mapping_excel.ts. Allows operators to:
//   1) Export every unresolved Jomashop required-enum mapping to one XLSX.
//   2) Upload the completed XLSX (validated against live v1 options).
//   3) Apply mappings to create verified enum_overrides + bulk-invalidate
//      the cached product preview + optionally write Shopify metafields.

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
  rowId: string;
  jomashop_category: string;
  shopify_category_code: string;
  jomashop_property: string;
  required: boolean;
  current_source_value: string;
  user_value: string;
  write_back: boolean;
  metafield_namespace: string;
  metafield_key: string;
  notes: string;
  accepted_options_source: string;
  is_valid: boolean;
  errors: string[];
};

type PreviewResponse = {
  ok: boolean;
  sessionId: string;
  headerErrors: string[];
  totals: { total: number; valid: number; errors: number; writeback: number };
  rows: PreviewRow[];
};

type ApplyResponse = {
  ok: boolean;
  appliedOverrides: number;
  cacheInvalidatedFor: string | null;
  shopifyConnected: boolean;
  shopifyWritebackPerformed: boolean;
  metafieldWriteSummary: { attempted: number; succeeded: number; failed: number };
  metafieldWrites: Array<{
    rowId: string;
    productId: string;
    namespace: string;
    key: string;
    ok: boolean;
    error: string | null;
  }>;
  note: string;
};

export function JomashopMappingExcelCard() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [performWriteback, setPerformWriteback] = useState(false);

  const exportMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/jomashop-mapping/export.xlsx", {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Export failed (${res.status}): ${text || res.statusText}`);
      }
      const blob = await res.blob();
      const rowCount = res.headers.get("X-Export-Rows") ?? "?";
      const shop = res.headers.get("X-Export-Shop") ?? "shop";
      const filename = `jomashop-mapping-${shop.replace(/\.myshopify\.com$/, "")}-${new Date()
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
      setExportInfo(`Exported ${r.rowCount} unresolved mapping row(s) from ${r.shop}.`);
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
      const res = await fetch("/api/jomashop-mapping/import-preview", {
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
      const res = await apiRequest("POST", "/api/jomashop-mapping/apply", {
        sessionId: preview.sessionId,
        confirm: true,
        performShopifyWriteback: performWriteback,
      });
      return (await res.json()) as ApplyResponse;
    },
    onSuccess: (r) => setApplyResult(r),
  });

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    previewMut.mutate(f);
    // Allow re-upload of the same file later.
    e.target.value = "";
  }

  const errorRows = preview?.rows.filter((r) => !r.is_valid) ?? [];
  const validRows = preview?.rows.filter((r) => r.is_valid) ?? [];

  return (
    <Card data-testid="jomashop-mapping-excel">
      <CardHeader className="border-b border-card-border">
        <CardTitle className="text-sm">Bulk Jomashop mapping (XLSX)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <p className="text-xs text-muted-foreground">
          Export every unresolved Jomashop required-enum mapping to one XLSX,
          fill in the accepted Jomashop value per row (one row per mapping
          NEED, not one per product), and upload the completed file. Mappings
          are saved as verified overrides and applied to every cached product
          in bulk. Optionally write the accepted value back to the Shopify
          product metafield.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => exportMut.mutate()}
            disabled={exportMut.isPending}
            data-testid="button-jomashop-mapping-export"
          >
            {exportMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export Jomashop Mapping Excel
          </Button>
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={previewMut.isPending}
            data-testid="button-jomashop-mapping-upload"
          >
            {previewMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Upload Completed Mapping Excel
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
                {preview.totals.writeback} marked for Shopify writeback
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

            {errorRows.length > 0 && (
              <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                <div className="font-medium">Row errors</div>
                {errorRows.slice(0, 10).map((r) => (
                  <div key={r.rowNumber} className="font-mono text-[11px]">
                    Row {r.rowNumber} ({r.jomashop_category}/{r.jomashop_property}):{" "}
                    {r.errors.join("; ")}
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
                    <div key={r.rowNumber} className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {r.jomashop_category}/{r.jomashop_property}
                      </span>
                      <span>
                        {r.current_source_value} →{" "}
                        <span className="text-green-700">{r.user_value}</span>
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
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={performWriteback}
                  onChange={(e) => setPerformWriteback(e.target.checked)}
                  data-testid="checkbox-shopify-writeback"
                />
                Also write to Shopify metafields for rows marked Yes
              </label>
              <Button
                onClick={() => applyMut.mutate()}
                disabled={applyMut.isPending || validRows.length === 0}
                data-testid="button-jomashop-mapping-apply"
              >
                {applyMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                Apply {validRows.length} mapping(s)
              </Button>
            </div>
          </div>
        )}

        {applyResult && (
          <div
            className="space-y-2 rounded-md border border-green-500/30 bg-green-500/5 p-3 text-xs"
            data-testid="jomashop-mapping-apply-result"
          >
            <div className="font-medium text-green-700">
              Applied {applyResult.appliedOverrides} verified override(s).
            </div>
            <div>
              Cache invalidated for:{" "}
              <span className="font-mono">{applyResult.cacheInvalidatedFor ?? "(none)"}</span>
            </div>
            {applyResult.shopifyWritebackPerformed && (
              <div>
                Shopify metafield writes:{" "}
                <span className="font-medium">
                  {applyResult.metafieldWriteSummary.succeeded}/
                  {applyResult.metafieldWriteSummary.attempted}
                </span>{" "}
                succeeded
                {applyResult.metafieldWriteSummary.failed > 0 &&
                  ` (${applyResult.metafieldWriteSummary.failed} failed)`}
              </div>
            )}
            {applyResult.metafieldWrites.filter((w) => !w.ok).slice(0, 5).map((w, i) => (
              <div
                key={i}
                className="font-mono text-[11px] text-destructive"
              >
                {w.productId} {w.namespace}.{w.key}: {w.error}
              </div>
            ))}
            <div className="text-muted-foreground">{applyResult.note}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
