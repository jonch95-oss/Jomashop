// Bulk repair workflow UI. Pairs with server/bulk_repair.ts.
//
// Flow:
//   1) Download XLSX of all live Shopify products that are missing required
//      metafields.
//   2) Operator edits the XLSX off-line, sets row_status=ready for rows they
//      want pushed to Jomashop, and re-uploads.
//   3) Dry-run preview shows totals and per-row diagnostics — no mutations.
//   4) Operator clicks Apply to Shopify (explicit confirm), which writes
//      metafields via the Admin GraphQL metafieldsSet mutation.
//   5) After Shopify writes succeed, operator can re-run preview to refetch
//      live data, then push the ready rows to Jomashop with another explicit
//      confirm.

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Send,
  Upload,
  XCircle,
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

type ImportPreview = {
  ok: boolean;
  sessionId: string;
  headerErrors: string[];
  totals: {
    total: number;
    valid: number;
    errors: number;
    noChange: number;
    readyForJomashop: number;
  };
  fieldUpdateCounts: Record<string, number>;
  rows: Array<{
    rowNumber: number;
    shopify_product_id: string;
    shopify_variant_id: string;
    sku: string;
    product_title: string;
    current_brand: string;
    missing_fields: string;
    changed_fields: string[];
    row_status: string;
    notes: string;
    errors: string[];
    has_changes: boolean;
  }>;
};

type ShopifyApplyResponse = {
  ok: boolean;
  jobId: number;
  totals: { total: number; ok: number; failed: number };
  results: Array<{
    rowNumber: number;
    shopify_product_id: string;
    sku: string;
    ok: boolean;
    updated_fields: string[];
    errors: string[];
  }>;
};

type JomashopPushResponse = {
  ok: boolean;
  jobId: number;
  totals: { total: number; ok: number; failed: number };
  results: Array<{
    rowNumber: number;
    shopify_product_id: string;
    sku: string;
    ok: boolean;
    status?: number;
    error?: string;
    missingRequired?: string[];
    missingTopLevel?: string[];
  }>;
};

export function BulkRepairCard(props: { onAfterApply?: () => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [applyResult, setApplyResult] = useState<ShopifyApplyResponse | null>(null);
  const [pushResult, setPushResult] = useState<JomashopPushResponse | null>(null);
  const [pendingApplyOpen, setPendingApplyOpen] = useState(false);
  const [pendingPushOpen, setPendingPushOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);

  const exportMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/products/missing/export.xlsx", {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Export failed (${res.status}): ${text || res.statusText}`);
      }
      const blob = await res.blob();
      const rowCount = res.headers.get("X-Export-Rows") ?? "?";
      const shop = res.headers.get("X-Export-Shop") ?? "shop";
      const filename = `missing-fields-${shop.replace(/\.myshopify\.com$/, "")}-${new Date()
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
      setExportInfo(`Exported ${r.rowCount} row(s) from ${r.shop}.`);
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
      const res = await fetch("/api/products/missing/import-preview", {
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
      setPushResult(null);
    },
  });

  const applyMut = useMutation({
    mutationFn: async (): Promise<ShopifyApplyResponse> => {
      if (!preview) throw new Error("No preview available.");
      const res = await apiRequest("POST", "/api/products/missing/apply-shopify", {
        sessionId: preview.sessionId,
        confirm: true,
      });
      return (await res.json()) as ShopifyApplyResponse;
    },
    onSuccess: (r) => {
      setApplyResult(r);
      setPendingApplyOpen(false);
      props.onAfterApply?.();
    },
    onError: (e: Error) => {
      setApplyResult({
        ok: false,
        jobId: 0,
        totals: { total: 0, ok: 0, failed: 0 },
        results: [],
      });
      setPendingApplyOpen(false);
      // Surface in the dialog via errors below
      console.error(e);
    },
  });

  const pushMut = useMutation({
    mutationFn: async (): Promise<JomashopPushResponse> => {
      if (!preview) throw new Error("No preview available.");
      const res = await apiRequest("POST", "/api/products/missing/push-jomashop", {
        sessionId: preview.sessionId,
        confirm: true,
      });
      return (await res.json()) as JomashopPushResponse;
    },
    onSuccess: (r) => {
      setPushResult(r);
      setPendingPushOpen(false);
    },
    onError: (e: Error) => {
      setPushResult({
        ok: false,
        jobId: 0,
        totals: { total: 0, ok: 0, failed: 0 },
        results: [{ rowNumber: 0, shopify_product_id: "", sku: "", ok: false, error: e.message }],
      });
      setPendingPushOpen(false);
    },
  });

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    previewMut.mutate(f);
    e.target.value = "";
  }

  const readyForJomashop = preview?.totals.readyForJomashop ?? 0;
  const hasErrors = (preview?.totals.errors ?? 0) > 0;

  return (
    <Card data-testid="card-bulk-repair">
      <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
        <div>
          <CardTitle className="text-sm">Bulk repair via Excel</CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Export products missing required metafields, edit off-line, then upload to
            apply Shopify updates and push corrected items to Jomashop.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="button-export-xlsx"
            disabled={exportMut.isPending}
            onClick={() => exportMut.mutate()}
          >
            {exportMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-2 h-3.5 w-3.5" />
            )}
            Export missing fields Excel
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-upload-xlsx"
            disabled={previewMut.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {previewMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-2 h-3.5 w-3.5" />
            )}
            Upload edited XLSX
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            data-testid="input-upload-xlsx"
            onChange={onFileChange}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 text-xs">
        {exportError && (
          <div
            data-testid="text-export-error"
            className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500"
          >
            {exportError}
          </div>
        )}
        {exportInfo && (
          <div
            data-testid="text-export-info"
            className="rounded border border-emerald-500/40 bg-emerald-500/5 p-2 text-emerald-500"
          >
            {exportInfo}
          </div>
        )}
        {previewMut.isError && (
          <div
            data-testid="text-upload-error"
            className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500"
          >
            {(previewMut.error as Error)?.message}
          </div>
        )}

        {preview && (
          <div className="space-y-3" data-testid="block-preview">
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
              <Badge variant="outline" data-testid="badge-total">
                Total: {preview.totals.total}
              </Badge>
              <Badge
                variant="outline"
                className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                data-testid="badge-valid"
              >
                Valid: {preview.totals.valid}
              </Badge>
              <Badge
                variant="outline"
                className="bg-red-500/10 text-red-700 dark:text-red-400"
                data-testid="badge-errors"
              >
                Errors: {preview.totals.errors}
              </Badge>
              <Badge variant="outline" data-testid="badge-no-change">
                No change: {preview.totals.noChange}
              </Badge>
              <Badge
                variant="outline"
                className="bg-blue-500/10 text-blue-700 dark:text-blue-400"
                data-testid="badge-ready"
              >
                Ready for Jomashop: {preview.totals.readyForJomashop}
              </Badge>
            </div>

            {Object.keys(preview.fieldUpdateCounts).length > 0 && (
              <div className="rounded border border-border bg-card/40 p-2">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Fields to update in Shopify metafields
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(preview.fieldUpdateCounts).map(([f, n]) => (
                    <Badge
                      key={f}
                      variant="outline"
                      className="font-mono text-[10px]"
                      data-testid={`badge-field-${f}`}
                    >
                      {f}: {n}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="max-h-60 overflow-auto rounded border border-border">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-card/80 text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Row</th>
                    <th className="px-2 py-1 text-left">Product</th>
                    <th className="px-2 py-1 text-left">SKU</th>
                    <th className="px-2 py-1 text-left">Changed</th>
                    <th className="px-2 py-1 text-left">Status</th>
                    <th className="px-2 py-1 text-left">Notes / errors</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr
                      key={r.rowNumber}
                      className="border-t border-border"
                      data-testid={`row-preview-${r.rowNumber}`}
                    >
                      <td className="px-2 py-1 font-mono">{r.rowNumber}</td>
                      <td className="px-2 py-1">{r.product_title || "—"}</td>
                      <td className="px-2 py-1 font-mono">{r.sku || "—"}</td>
                      <td className="px-2 py-1">
                        {r.changed_fields.length === 0
                          ? "—"
                          : r.changed_fields.join(", ")}
                      </td>
                      <td className="px-2 py-1">
                        <Badge
                          variant="outline"
                          className={
                            (r.row_status ?? "").toLowerCase() === "ready"
                              ? "bg-blue-500/10 text-[10px] text-blue-700"
                              : "text-[10px]"
                          }
                        >
                          {r.row_status || "—"}
                        </Badge>
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {r.errors.length > 0
                          ? r.errors.join("; ")
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
                data-testid="button-open-apply-shopify"
                disabled={preview.totals.valid === 0 || applyMut.isPending}
                onClick={() => setPendingApplyOpen(true)}
              >
                {applyMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-2 h-3.5 w-3.5" />
                )}
                Apply updates to Shopify
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="button-open-push-jomashop"
                disabled={readyForJomashop === 0 || pushMut.isPending}
                onClick={() => setPendingPushOpen(true)}
              >
                <Send className="mr-2 h-3.5 w-3.5" />
                Push ready rows to Jomashop ({readyForJomashop})
              </Button>
              {hasErrors && (
                <span className="text-[10px] text-amber-500">
                  Some rows have errors — they will be skipped.
                </span>
              )}
            </div>
          </div>
        )}

        {applyResult && (
          <div
            className={`rounded border p-2 ${
              applyResult.ok
                ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-500"
                : "border-red-500/40 bg-red-500/5 text-red-500"
            }`}
            data-testid="block-apply-result"
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              {applyResult.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              Shopify update: {applyResult.totals.ok} ok / {applyResult.totals.failed} failed
            </div>
            {applyResult.results.some((r) => !r.ok) && (
              <details className="text-[10px]">
                <summary className="cursor-pointer">Per-row results</summary>
                <ul className="ml-4 mt-1 list-disc">
                  {applyResult.results.map((r) => (
                    <li key={r.rowNumber}>
                      Row {r.rowNumber} ({r.sku || r.shopify_product_id}):{" "}
                      {r.ok
                        ? `updated ${r.updated_fields.join(", ")}`
                        : `failed — ${r.errors.join("; ")}`}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {pushResult && (
          <div
            className={`rounded border p-2 ${
              pushResult.ok
                ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-500"
                : "border-red-500/40 bg-red-500/5 text-red-500"
            }`}
            data-testid="block-push-result"
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              {pushResult.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              Jomashop push: {pushResult.totals.ok} ok / {pushResult.totals.failed} failed
            </div>
            <details className="text-[10px]" open={!pushResult.ok}>
              <summary className="cursor-pointer">Per-row results</summary>
              <ul className="ml-4 mt-1 list-disc">
                {pushResult.results.map((r) => (
                  <li key={`${r.rowNumber}-${r.shopify_product_id}`}>
                    Row {r.rowNumber} ({r.sku || r.shopify_product_id}):{" "}
                    {r.ok
                      ? `pushed (HTTP ${r.status ?? "?"})`
                      : `failed — ${r.error ?? "unknown"}`}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </CardContent>

      {/* Confirm Apply to Shopify */}
      <Dialog open={pendingApplyOpen} onOpenChange={setPendingApplyOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Apply Shopify updates?
            </DialogTitle>
            <DialogDescription>
              This will write metafields to the connected Shopify store via
              <code className="mx-1 rounded bg-muted px-1">metafieldsSet</code> for
              every valid row in the uploaded XLSX. Identifier columns are never
              overwritten.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <ul className="space-y-1 text-xs">
              <li>
                Rows to update:{" "}
                <span className="font-mono">{preview.totals.valid}</span>
              </li>
              <li>
                Rows skipped (errors):{" "}
                <span className="font-mono">{preview.totals.errors}</span>
              </li>
              <li>
                Rows skipped (no change):{" "}
                <span className="font-mono">{preview.totals.noChange}</span>
              </li>
            </ul>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingApplyOpen(false)}
              disabled={applyMut.isPending}
            >
              Cancel
            </Button>
            <Button
              data-testid="button-confirm-apply-shopify"
              onClick={() => applyMut.mutate()}
              disabled={applyMut.isPending}
            >
              {applyMut.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="mr-2 h-3.5 w-3.5" />
              )}
              Confirm — apply to Shopify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Jomashop push */}
      <Dialog open={pendingPushOpen} onOpenChange={setPendingPushOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Push corrected
              products to Jomashop?
            </DialogTitle>
            <DialogDescription>
              This will POST every row with{" "}
              <code className="rounded bg-muted px-1">row_status=ready</code> to
              Jomashop's <code className="rounded bg-muted px-1">/v1/products</code>{" "}
              endpoint. Sample/demo fixtures are blocked at the server.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <ul className="space-y-1 text-xs">
              <li>
                Ready rows to push:{" "}
                <span className="font-mono">{preview.totals.readyForJomashop}</span>
              </li>
              <li className="text-muted-foreground">
                Rows without row_status=ready will be left alone.
              </li>
            </ul>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingPushOpen(false)}
              disabled={pushMut.isPending}
            >
              Cancel
            </Button>
            <Button
              data-testid="button-confirm-push-jomashop"
              onClick={() => pushMut.mutate()}
              disabled={pushMut.isPending}
            >
              {pushMut.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="mr-2 h-3.5 w-3.5" />
              )}
              Confirm — push to Jomashop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
