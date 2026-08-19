import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Ban, History, Upload, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, LoadingRows, ErrorBlock } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

type Row = { vendor_sku: string; price: number; status: string; quantity: number };
type Preview = {
  headers: string[];
  rows: Row[];
  note: string;
  pushed_sku_count?: number;
  unresolved_in_cache?: number;
};
type PriceImportResult = {
  ok?: boolean;
  dryRun?: boolean;
  parsed_from?: string | null;
  parsed_rows?: number;
  matched?: number;
  will_change?: number;
  will_stamp?: number;
  stamped?: number;
  unchanged?: number;
  unmatched?: number;
  not_pushed?: number;
  no_price_or_msrp?: number;
  metafieldWrites?: number;
  preview?: Array<{
    vendor_sku: string;
    shopify_sku: string;
    price: number | null;
    msrp: number | null;
    current_price: number | null;
    current_msrp: number | null;
  }>;
  not_pushed_skus?: Array<{
    vendor_sku: string;
    shopify_sku: string;
    state: string;
    last_status: number | null;
    last_error: string | null;
  }>;
  not_pushed_truncated?: boolean;
  unmatched_skus?: Array<{ vendor_sku: string; jomashop_sku: string | null }>;
  unmatched_truncated?: boolean;
  note?: string;
  error?: string;
};
type PriceProgress = {
  active: boolean;
  total: number;
  done: number;
  applied: number;
  skipped: number;
  rejected: number;
  errors: string[];
  stopped?: boolean;
};
type ReconcileResult = {
  ok?: boolean;
  source?: string;
  dryRun?: boolean;
  live_rows?: number;
  adopted?: number;
  already_known?: number;
  unmatched?: number;
  unmatched_skus?: Array<{ vendor_sku: string; jomashop_sku: string | null }>;
  unmatched_truncated?: boolean;
  note?: string;
  error?: string;
};
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

  // ---- Price / MSRP import from a Jomashop bulk-update workbook ----
  const priceFileRef = useRef<HTMLInputElement>(null);
  const [priceFile, setPriceFile] = useState<File | null>(null);
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceResult, setPriceResult] = useState<PriceImportResult | null>(null);
  const [priceProgress, setPriceProgress] = useState<PriceProgress | null>(null);

  function downloadRowsCsv(filename: string, header: string[], rows: Array<Array<string | number | null>>) {
    const esc = (v: string | number | null) => {
      const t = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const body = [header.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function runPriceImport(dryRun: boolean) {
    if (!priceFile) return;
    setPriceBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", priceFile);
      fd.append("dryRun", String(dryRun));
      const res = await fetch("/api/jomashop/price-import", {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: fd,
      });
      const body = (await res.json()) as PriceImportResult;
      if (!res.ok && !body.error) body.error = `Import failed (${res.status})`;
      setPriceResult(body);
      if (!dryRun && body.ok) setPriceProgress({ active: true, total: body.will_change ?? 0, done: 0, applied: 0, skipped: 0, rejected: 0, errors: [], stopped: false });
    } catch (e) {
      setPriceResult({ ok: false, error: (e as Error).message });
    } finally {
      setPriceBusy(false);
    }
  }

  // Poll the background push while it runs.
  useEffect(() => {
    if (!priceProgress?.active) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/jomashop/price-import-progress", { credentials: "include", headers: authHeaders() });
        const j = await r.json();
        if (j?.progress) setPriceProgress(j.progress);
        if (j?.progress && !j.progress.active) q.refetch();
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [priceProgress?.active]);

  const [reconcileSource, setReconcileSource] = useState<"jomashop" | "portal">("jomashop");
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);
  const reconcile = useMutation({
    mutationFn: async (args: { source: "jomashop" | "portal"; dryRun: boolean }) => {
      const res = await apiRequest("POST", "/api/jomashop/reconcile-push-state", args);
      return (await res.json()) as ReconcileResult;
    },
    onSuccess: (r) => {
      setReconcileResult(r);
      if (r.ok && !r.dryRun) q.refetch();
    },
    onError: (e: Error) => setReconcileResult({ ok: false, error: e.message }),
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

      <Card className="mb-4" data-testid="card-price-import">
        <CardHeader className="border-b border-card-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Upload className="h-4 w-4 text-violet-500" /> Import prices &amp; MSRP from a Jomashop workbook
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-5">
          <p className="text-xs text-muted-foreground">
            Upload the same bulk-update workbook you send to Jomashop. The bridge adopts its Price and MSRP
            columns, writes MSRP back to Shopify, and pushes the new values to Jomashop over the same channel
            inventory updates use. This is what stops your uploads being reverted: stock webhooks replay the
            price the bridge has stored, so once it stores yours, they replay yours. Stock is never touched.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={priceFileRef}
              type="file"
              accept=".csv,.xlsx,.xlsm,.xltx,.xltm,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { setPriceFile(f); setPriceResult(null); setPriceProgress(null); }
              }}
            />
            <Button data-testid="button-price-file" variant="outline" size="sm" onClick={() => priceFileRef.current?.click()} disabled={priceBusy}>
              <Upload className="mr-1.5 h-3.5 w-3.5" /> Choose file
            </Button>
            {priceFile && <span className="text-xs text-muted-foreground">{priceFile.name}</span>}
            <Button data-testid="button-price-preview" variant="outline" size="sm" disabled={!priceFile || priceBusy} onClick={() => runPriceImport(true)}>
              {priceBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null} Preview changes
            </Button>
            {priceResult?.ok && priceResult.dryRun && (priceResult.will_change ?? 0) > 0 && (
              <Button
                data-testid="button-price-apply"
                size="sm"
                disabled={priceBusy}
                onClick={() => {
                  if (window.confirm(`Push new price/MSRP for ${priceResult.will_change} SKU(s) to Jomashop?`)) runPriceImport(false);
                }}
              >
                Apply {priceResult.will_change} to Jomashop
              </Button>
            )}
          </div>

          {priceResult && (
            <div className={`rounded-md border px-3 py-2 text-xs ${priceResult.ok ? "border-border bg-card/40 text-muted-foreground" : "border-rose-500/50 bg-rose-500/10 text-rose-600"}`}>
              {priceResult.ok ? (
                <>
                  Read {priceResult.parsed_rows ?? 0} row(s){priceResult.parsed_from ? ` from ${priceResult.parsed_from}` : ""} — {priceResult.matched ?? 0} matched a pushed SKU,{" "}
                  <strong>{priceResult.will_change ?? 0} would change</strong>, {priceResult.unchanged ?? 0} already match.{" "}
                  {(priceResult.will_stamp ?? 0) > 0 &&
                    `${priceResult.will_stamp} already correct but not yet marked as yours — applying will claim them so they can't be recomputed. `}
                  {(priceResult.stamped ?? 0) > 0 && `Marked ${priceResult.stamped} as operator-priced. `}
                  {(priceResult.unmatched ?? 0) > 0 && `${priceResult.unmatched} had no Shopify match. `}
                  {(priceResult.not_pushed ?? 0) > 0 && `${priceResult.not_pushed} are not pushed yet. `}
                  {priceResult.note}
                </>
              ) : (
                `Price import failed: ${priceResult.error ?? "unknown error"}`
              )}
            </div>
          )}

          {priceResult?.ok && priceResult.dryRun && (priceResult.preview?.length ?? 0) > 0 && (
            <div className="max-h-56 overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">SKU</th>
                    <th className="px-3 py-1.5 text-right font-medium">Price now → new</th>
                    <th className="px-3 py-1.5 text-right font-medium">MSRP now → new</th>
                  </tr>
                </thead>
                <tbody>
                  {priceResult.preview!.map((r) => (
                    <tr key={r.shopify_sku} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono">{r.shopify_sku}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {r.current_price ?? "—"} <span className="text-muted-foreground">→</span> <strong>{r.price ?? "—"}</strong>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {r.current_msrp ?? "—"} <span className="text-muted-foreground">→</span> <strong>{r.msrp ?? "—"}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {priceResult?.ok && (priceResult.not_pushed_skus?.length ?? 0) > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-medium text-amber-700 dark:text-amber-400">
                  In your file but not priced ({priceResult.not_pushed ?? 0})
                </span>
                <Button
                  data-testid="button-export-not-pushed"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    downloadRowsCsv(
                      "not-priced-skus.csv",
                      ["vendor_sku", "shopify_sku", "state", "last_status", "last_error"],
                      priceResult.not_pushed_skus!.map((r) => [r.vendor_sku, r.shopify_sku, r.state, r.last_status, r.last_error]),
                    )
                  }
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
                </Button>
              </div>
              <p className="mb-2 text-muted-foreground">
                These matched a Shopify product but the bridge does not consider them pushed, so they were skipped.
                A state of &ldquo;failed&rdquo; with a 429/503 means Jomashop was busy, not that anything is wrong with
                the product — use &ldquo;Rebuild push state&rdquo; below to recover them, then re-run this import.
              </p>
              <div className="max-h-40 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                {priceResult.not_pushed_skus!.map((r) => (
                  <div key={r.shopify_sku}>
                    {r.vendor_sku} — {r.state}
                    {r.last_status ? ` (${r.last_status})` : ""}
                  </div>
                ))}
              </div>
              {priceResult.not_pushed_truncated && <div className="mt-1">Showing the first 500.</div>}
            </div>
          )}

          {priceResult?.ok && (priceResult.unmatched_skus?.length ?? 0) > 0 && (
            <div className="rounded-md border border-border bg-card/40 px-3 py-2 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-medium">No Shopify match ({priceResult.unmatched ?? 0})</span>
                <Button
                  data-testid="button-export-unmatched"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    downloadRowsCsv(
                      "no-shopify-match.csv",
                      ["vendor_sku", "jomashop_sku"],
                      priceResult.unmatched_skus!.map((r) => [r.vendor_sku, r.jomashop_sku]),
                    )
                  }
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
                </Button>
              </div>
              <p className="mb-2 text-muted-foreground">
                In your Jomashop file with nothing corresponding in the Shopify catalog, so the bridge cannot price them.
              </p>
              <div className="max-h-32 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                {priceResult.unmatched_skus!.map((r) => (
                  <div key={r.vendor_sku}>
                    {r.vendor_sku}
                    {r.jomashop_sku ? ` — ${r.jomashop_sku}` : ""}
                  </div>
                ))}
              </div>
            </div>
          )}

          {priceProgress && (
            <div className="rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
              {priceProgress.active ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Pushing {priceProgress.done} / {priceProgress.total} —{" "}
                    {priceProgress.applied} applied, {priceProgress.rejected} rejected
                  </span>
                  <Button
                    data-testid="button-price-stop"
                    variant="destructive"
                    size="sm"
                    onClick={async () => {
                      try {
                        await apiRequest("POST", "/api/jomashop/price-import/stop", {});
                      } catch {
                        /* the poll will reflect it either way */
                      }
                    }}
                  >
                    Stop
                  </Button>
                </div>
              ) : (
                <>
                  {priceProgress.stopped ? "Stopped early" : "Done"}: {priceProgress.applied} applied,{" "}
                  {priceProgress.skipped} skipped, {priceProgress.rejected} rejected of {priceProgress.total}.
                  {priceProgress.rejected > 0 && " Re-run the same file to retry just the failures — anything already applied is skipped."}
                </>
              )}
              {priceProgress.errors?.length > 0 && (
                <div className="mt-1 max-h-24 overflow-y-auto font-mono text-[11px] text-rose-600 dark:text-rose-400">
                  {priceProgress.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4" data-testid="card-reconcile-push-state">
        <CardHeader className="border-b border-card-border">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-sky-500" /> Rebuild push state from what is actually live
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-5">
          <p className="text-xs text-muted-foreground">
            &ldquo;Pushed&rdquo; is tracked in this app&apos;s own database. If that database was reset — a redeploy
            without a persistent disk wipes it — products stay live on Jomashop while this app forgets it ever
            pushed them, so they vanish from the Inventory list and reappear as &ldquo;needs pushing&rdquo;. This
            reads what is really there and re-creates the missing records. Preview first; nothing is written
            until you apply. It never pushes anything to Jomashop.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              data-testid="select-reconcile-source"
              value={reconcileSource}
              onChange={(e) => setReconcileSource(e.target.value as "jomashop" | "portal")}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="jomashop">Live Jomashop inventory (GET /v1/inventory)</option>
              <option value="portal">Imported Vendor Portal export (Portal Styles)</option>
            </select>
            <Button
              data-testid="button-reconcile-preview"
              variant="outline"
              size="sm"
              disabled={reconcile.isPending}
              onClick={() => reconcile.mutate({ source: reconcileSource, dryRun: true })}
            >
              Preview
            </Button>
            {reconcileResult?.ok && reconcileResult.dryRun && (reconcileResult.adopted ?? 0) > 0 && (
              <Button
                data-testid="button-reconcile-apply"
                size="sm"
                disabled={reconcile.isPending}
                onClick={() => reconcile.mutate({ source: reconcileSource, dryRun: false })}
              >
                Adopt {reconcileResult.adopted} SKU(s)
              </Button>
            )}
          </div>
          {reconcileResult && (
            <div
              data-testid="banner-reconcile-result"
              className={`rounded-md border px-3 py-2 text-xs ${
                reconcileResult.ok
                  ? "border-border bg-card/40 text-muted-foreground"
                  : "border-rose-500/50 bg-rose-500/10 text-rose-600"
              }`}
            >
              {reconcileResult.ok
                ? `${reconcileResult.live_rows ?? 0} live row(s) read — ${reconcileResult.adopted ?? 0} missing from push state, ${reconcileResult.already_known ?? 0} already tracked, ${reconcileResult.unmatched ?? 0} with no Shopify match. ${reconcileResult.note ?? ""}`
                : `Reconcile failed: ${reconcileResult.error ?? "unknown error"}`}
            </div>
          )}
          {reconcileResult?.ok && (reconcileResult.unmatched_skus?.length ?? 0) > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">
                On Jomashop but not in your Shopify catalog ({reconcileResult.unmatched ?? 0})
              </div>
              <p className="mb-2 text-muted-foreground">
                These exist on Jomashop with no matching Shopify product, so they can never appear on the
                Products page. Usually a SKU that drifted, or an item sold on Jomashop only.
              </p>
              <div className="max-h-40 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                {reconcileResult.unmatched_skus!.map((u) => (
                  <div key={u.vendor_sku}>
                    {u.vendor_sku}
                    {u.jomashop_sku ? ` — ${u.jomashop_sku}` : ""}
                  </div>
                ))}
              </div>
              {reconcileResult.unmatched_truncated && (
                <div className="mt-1 text-[11px] text-muted-foreground">Showing the first 500.</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

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
          <CardTitle className="text-sm">
            Pushed SKU inventory preview
            {typeof q.data.pushed_sku_count === "number" && (
              <span className="ml-2 font-normal text-muted-foreground">
                {q.data.pushed_sku_count} SKU(s)
              </span>
            )}
          </CardTitle>
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
                {q.data.rows.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-center text-xs text-muted-foreground" colSpan={q.data.headers.length}>
                      No pushed SKUs recorded for this store. If products are live on Jomashop, use
                      &ldquo;Rebuild push state&rdquo; above.
                    </td>
                  </tr>
                )}
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
