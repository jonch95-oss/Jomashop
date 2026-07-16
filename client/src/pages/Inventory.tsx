import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Ban } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, LoadingRows, ErrorBlock } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";

type Row = { vendor_sku: string; price: number; status: string; quantity: number };
type Preview = { headers: string[]; rows: Row[]; note: string };
type SyncResult = {
  ok: boolean;
  attempted?: number;
  applied?: number;
  skipped?: number;
  rejected?: number;
  truncated?: boolean;
  results?: Array<{ sku: string; status: string; message: string }>;
  error?: string;
  note?: string;
};

export default function Inventory() {
  const q = useQuery<Preview>({ queryKey: ["/api/sync/inventory-preview"] });
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const sync = useMutation({
    mutationFn: async (args: { shopifySku?: string }): Promise<SyncResult> => {
      const res = await apiRequest("POST", "/api/jomashop/inventory-sync", args);
      return (await res.json()) as SyncResult;
    },
    onSuccess: (r) => setSyncResult(r),
    onError: (e: Error) => setSyncResult({ ok: false, error: e.message }),
  });

  const [zeroBrand, setZeroBrand] = useState("");
  const [zeroStyle, setZeroStyle] = useState("");
  const [zeroResult, setZeroResult] = useState<{ ok?: boolean; dryRun?: boolean; matched?: number; applied?: number; failed?: number; error?: string } | null>(null);
  const zero = useMutation({
    mutationFn: async (args: { brand?: string; styleTag?: string; dryRun?: boolean; confirm?: boolean }) => {
      const res = await apiRequest("POST", "/api/jomashop/bulk-zero-inventory", args);
      return (await res.json()) as { ok?: boolean; dryRun?: boolean; matched?: number; applied?: number; failed?: number; error?: string };
    },
    onSuccess: (r) => setZeroResult(r),
    onError: (e: Error) => setZeroResult({ ok: false, error: e.message }),
  });

  if (q.isLoading) return <LoadingRows />;
  if (q.isError) return <ErrorBlock message={(q.error as Error).message} />;
  if (!q.data) return null;

  const downloadCsv = () => {
    const lines = [q.data!.headers.join(",")].concat(
      q.data!.rows.map((r) =>
        [r.vendor_sku, r.price.toFixed(2), r.status, r.quantity].join(","),
      ),
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inventory-preview.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Pushed-SKU inventory reconciliation. Zero total Shopify quantity sends Jomashop out_of_stock and drafts the Shopify product; adding quantity back reactivates it."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="button-sync-inventory"
              onClick={() => sync.mutate({})}
              disabled={sync.isPending}
              variant="default"
              size="sm"
            >
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${sync.isPending ? "animate-spin" : ""}`} />{" "}
              {sync.isPending ? "Syncing…" : "Sync pushed SKUs to Jomashop"}
            </Button>
            <Button data-testid="button-download-csv" onClick={downloadCsv} variant="outline" size="sm">
              <Download className="mr-2 h-3.5 w-3.5" /> Export preview CSV
            </Button>
          </div>
        }
      />

      <div className="mb-4 rounded-md border border-border bg-card/40 px-4 py-2.5 text-xs text-muted-foreground">
        {q.data.note} Inventory updates use Jomashop's documented fields: quantity, price, map_price, and status. Shopify visibility follows stock automatically for pushed products.
      </div>

      <Card className="mb-4" data-testid="card-bulk-zero">
        <CardHeader className="border-b border-card-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Ban className="h-4 w-4 text-rose-500" /> Bulk zero-out inventory on Jomashop
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-5">
          <p className="text-xs text-muted-foreground">
            Set quantity 0 / out_of_stock on Jomashop for every pushed product matching a brand and/or
            style code. Preview first; the live run needs a second confirm. Does not touch Shopify stock.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Brand (contains)</label>
              <Input data-testid="input-zero-brand" value={zeroBrand} onChange={(e) => setZeroBrand(e.target.value)} placeholder="e.g. Palm Angels" className="text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Style code (tag)</label>
              <Input data-testid="input-zero-style" value={zeroStyle} onChange={(e) => setZeroStyle(e.target.value)} placeholder="e.g. LOAF, HOOD" className="text-sm" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="button-zero-preview"
              variant="outline"
              size="sm"
              disabled={zero.isPending || (!zeroBrand.trim() && !zeroStyle.trim())}
              onClick={() => zero.mutate({ brand: zeroBrand.trim(), styleTag: zeroStyle.trim(), dryRun: true })}
            >
              Preview matches
            </Button>
            {zeroResult && zeroResult.dryRun && (zeroResult.matched ?? 0) > 0 && (
              <Button
                data-testid="button-zero-apply"
                variant="destructive"
                size="sm"
                disabled={zero.isPending}
                onClick={() => {
                  if (window.confirm(`Zero out ${zeroResult.matched} product(s) on Jomashop? This sets them out_of_stock.`)) {
                    zero.mutate({ brand: zeroBrand.trim(), styleTag: zeroStyle.trim(), dryRun: false, confirm: true });
                  }
                }}
              >
                <Ban className="mr-1.5 h-3.5 w-3.5" /> Zero out {zeroResult.matched} now
              </Button>
            )}
          </div>
          {zeroResult && (
            <div className={`rounded-md border px-3 py-2 text-xs ${zeroResult.dryRun ? "border-border bg-card/40 text-muted-foreground" : zeroResult.ok ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-rose-500/50 bg-rose-500/10 text-rose-600"}`}>
              {zeroResult.dryRun
                ? `Preview: ${zeroResult.matched ?? 0} pushed product(s) match. ${zeroResult.matched ? "Click \u201cZero out\u201d to apply." : "Nothing to zero."}`
                : `Zeroed ${zeroResult.applied ?? 0} / ${zeroResult.matched ?? 0} on Jomashop${zeroResult.failed ? `, ${zeroResult.failed} failed` : ""}.`}
            </div>
          )}
        </CardContent>
      </Card>

      {syncResult && (
        <div
          data-testid="banner-sync-result"
          className={`mb-4 rounded-md border px-4 py-2.5 text-xs ${
            syncResult.ok
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-400"
          }`}
        >
          {syncResult.ok
            ? `Synced ${syncResult.attempted ?? 0} SKU(s): ${syncResult.applied ?? 0} applied, ${
                syncResult.skipped ?? 0
              } skipped, ${syncResult.rejected ?? 0} rejected${
                syncResult.truncated ? " (truncated to first 250)" : ""
              }${syncResult.note ? ` — ${syncResult.note}` : ""}`
            : `Sync failed: ${syncResult.error ?? "unknown error"}`}
        </div>
      )}

      <Card>
        <CardHeader className="border-b border-card-border">
          <CardTitle className="text-sm">Pushed SKU inventory preview</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-card-border bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  {q.data.headers.map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.vendor_sku} className="border-b border-card-border last:border-0" data-testid={`row-inventory-${r.vendor_sku}`}>
                    <td className="px-4 py-2.5 font-mono text-xs">{r.vendor_sku}</td>
                    <td className="px-4 py-2.5 tabular-nums">${r.price.toFixed(2)}</td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          r.status === "active"
                            ? "default"
                            : r.status === "out_of_stock"
                              ? "secondary"
                              : "outline"
                        }
                        className="text-[10px] uppercase"
                      >
                        {r.status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{r.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
