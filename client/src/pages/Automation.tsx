import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlayCircle, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, LoadingRows, ErrorBlock } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";

type InventoryItem = {
  vendor_sku: string;
  matched_shopify_sku: string | null;
  match_status: string | null;
  shopify_qty: number | null;
  portal_qty: number | null;
  delta: number | null;
  action: "update" | "skip";
  reason: string | null;
  flagged: boolean;
};

type InventoryRun = {
  ok: boolean;
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  counts: { total: number; planned: number; applied: number; rejected: number; skipped: number; flagged: number };
  items: InventoryItem[];
  errors: string[];
  note: string;
  cacheFetchedAt: number | null;
  liveBlockedByEnv?: boolean;
};

type OrderLine = {
  sales_order_number: string;
  sku: string;
  quantity: number | null;
  matched: boolean;
  match_source: string;
  match_status: string | null;
  matched_shopify_sku: string | null;
};

type OrderPull = {
  ok: boolean;
  dryRun: true;
  startedAt: number;
  finishedAt: number;
  counts: { orders: number; lines: number; matched: number; portal_confirmed: number; unmatched: number; already_imported: number };
  unmatchedLines: OrderLine[];
  errors: string[];
  note: string;
};

type Status = {
  ok: boolean;
  config: {
    enabled: boolean;
    dryRun: boolean;
    inventoryIntervalMinutes: number;
    orderIntervalMinutes: number;
    maxInventoryDelta: number;
    orderImportEnabled: boolean;
  };
  scheduler: {
    running: boolean;
    startedAt: number | null;
    nextInventoryRunAt: number | null;
    nextOrderRunAt: number | null;
  };
  lastInventoryRun: InventoryRun | null;
  lastOrderPull: OrderPull | null;
  recentJobs: Array<{
    id: number;
    jobType: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    totalItems: number;
    successItems: number;
    errorItems: number;
    summary: string | null;
  }>;
  safety: { liveInventoryWrites: boolean; liveOrderCreation: boolean; note: string };
};

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function OnOff({ on, onLabel = "Enabled", offLabel = "Disabled" }: { on: boolean; onLabel?: string; offLabel?: string }) {
  return (
    <Badge variant={on ? "default" : "outline"} className="text-[10px] uppercase">
      {on ? onLabel : offLabel}
    </Badge>
  );
}

export default function Automation() {
  const queryClient = useQueryClient();
  const q = useQuery<Status>({ queryKey: ["/api/automation/status"] });
  const [invRun, setInvRun] = useState<InventoryRun | null>(null);
  const [orderRun, setOrderRun] = useState<OrderPull | null>(null);

  const invSync = useMutation({
    mutationFn: async (): Promise<InventoryRun> => {
      const res = await apiRequest("POST", "/api/automation/inventory-sync-now", { dryRun: true });
      return (await res.json()) as InventoryRun;
    },
    onSuccess: (r) => {
      setInvRun(r);
      queryClient.invalidateQueries({ queryKey: ["/api/automation/status"] });
    },
    onError: (e: Error) =>
      setInvRun({
        ok: false,
        dryRun: true,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        counts: { total: 0, planned: 0, applied: 0, rejected: 0, skipped: 0, flagged: 0 },
        items: [],
        errors: [e.message],
        note: "Request failed.",
        cacheFetchedAt: null,
      }),
  });

  const orderPull = useMutation({
    mutationFn: async (): Promise<OrderPull> => {
      const res = await apiRequest("POST", "/api/automation/pull-orders-now", { status: "new" });
      return (await res.json()) as OrderPull;
    },
    onSuccess: (r) => {
      setOrderRun(r);
      queryClient.invalidateQueries({ queryKey: ["/api/automation/status"] });
    },
    onError: (e: Error) =>
      setOrderRun({
        ok: false,
        dryRun: true,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        counts: { orders: 0, lines: 0, matched: 0, portal_confirmed: 0, unmatched: 0, already_imported: 0 },
        unmatchedLines: [],
        errors: [e.message],
        note: "Request failed.",
      }),
  });

  if (q.isLoading) return <LoadingRows />;
  if (q.isError) return <ErrorBlock message={(q.error as Error).message} />;
  if (!q.data) return null;

  const { config, scheduler, safety } = q.data;
  const lastInv = invRun ?? q.data.lastInventoryRun;
  const lastOrd = orderRun ?? q.data.lastOrderPull;

  return (
    <>
      <PageHeader
        title="Automation"
        description="Scheduled inventory sync (Shopify → Jomashop) and order pull preview (Jomashop → Shopify). Everything defaults to disabled/dry-run; only portal-confirmed styles are eligible."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="button-inventory-sync-now"
              onClick={() => invSync.mutate()}
              disabled={invSync.isPending}
              size="sm"
            >
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${invSync.isPending ? "animate-spin" : ""}`} />
              {invSync.isPending ? "Planning…" : "Sync inventory now (dry run)"}
            </Button>
            <Button
              data-testid="button-pull-orders-now"
              onClick={() => orderPull.mutate()}
              disabled={orderPull.isPending}
              variant="outline"
              size="sm"
            >
              <PlayCircle className={`mr-2 h-3.5 w-3.5 ${orderPull.isPending ? "animate-spin" : ""}`} />
              {orderPull.isPending ? "Pulling…" : "Pull orders now (preview)"}
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <Card data-testid="card-automation-config">
          <CardHeader className="border-b border-card-border">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Zap className="h-4 w-4 text-primary" /> Scheduler
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Auto sync</span>
              <OnOff on={config.enabled} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Mode</span>
              <OnOff on={config.dryRun} onLabel="Dry run" offLabel="LIVE" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Inventory interval</span>
              <span className="tabular-nums">{config.inventoryIntervalMinutes} min</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Order pull interval</span>
              <span className="tabular-nums">{config.orderIntervalMinutes} min</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Max inventory delta</span>
              <span className="tabular-nums">{config.maxInventoryDelta}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Next inventory run</span>
              <span>{scheduler.running ? fmtTime(scheduler.nextInventoryRunAt) : "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Next order pull</span>
              <span>{scheduler.running ? fmtTime(scheduler.nextOrderRunAt) : "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-automation-safety">
          <CardHeader className="border-b border-card-border">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-primary" /> Safety
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Live inventory writes</span>
              <OnOff on={safety.liveInventoryWrites} onLabel="ON" offLabel="Off" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Automatic order creation</span>
              <OnOff on={safety.liveOrderCreation} onLabel="ON" offLabel="Never" />
            </div>
            <p className="pt-1 text-muted-foreground">{safety.note}</p>
            <p className="text-muted-foreground">
              Enable live inventory writes with <code className="font-mono">AUTO_SYNC_ENABLED=true</code> +{" "}
              <code className="font-mono">AUTO_SYNC_DRY_RUN=false</code>. Only styles the Portal Styles
              reconciliation marks Confirmed Live / Active in Portal are ever pushed.
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-automation-lastruns">
          <CardHeader className="border-b border-card-border">
            <CardTitle className="text-sm">Last runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Inventory sync</span>
              <span>{lastInv ? fmtTime(lastInv.finishedAt) : "never"}</span>
            </div>
            {lastInv && (
              <div className="text-muted-foreground">
                {lastInv.dryRun ? "Dry run: " : "Live: "}
                {lastInv.counts.planned} planned / {lastInv.counts.applied} applied /{" "}
                {lastInv.counts.skipped} skipped / {lastInv.counts.flagged} flagged
              </div>
            )}
            <div className="flex items-center justify-between pt-2">
              <span className="text-muted-foreground">Order pull</span>
              <span>{lastOrd ? fmtTime(lastOrd.finishedAt) : "never"}</span>
            </div>
            {lastOrd && (
              <div className="text-muted-foreground">
                {lastOrd.counts.orders} orders / {lastOrd.counts.lines} lines / {lastOrd.counts.matched}{" "}
                matched / {lastOrd.counts.unmatched} unmatched
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {lastInv && (
        <Card className="mb-4" data-testid="card-inventory-run">
          <CardHeader className="border-b border-card-border">
            <CardTitle className="text-sm">
              Inventory sync result{" "}
              <Badge variant={lastInv.dryRun ? "secondary" : "default"} className="ml-2 text-[10px] uppercase">
                {lastInv.dryRun ? "Dry run" : "Live"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="border-b border-card-border px-4 py-2.5 text-xs text-muted-foreground">
              {lastInv.note}
              {lastInv.errors.length > 0 && (
                <span className="text-rose-500"> Errors: {lastInv.errors.join("; ")}</span>
              )}
            </div>
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-card-border bg-card text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Vendor SKU</th>
                    <th className="px-4 py-2 text-left font-medium">Portal status</th>
                    <th className="px-4 py-2 text-right font-medium">Shopify qty</th>
                    <th className="px-4 py-2 text-right font-medium">Portal qty</th>
                    <th className="px-4 py-2 text-right font-medium">Delta</th>
                    <th className="px-4 py-2 text-left font-medium">Action</th>
                    <th className="px-4 py-2 text-left font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {lastInv.items.map((it, i) => (
                    <tr
                      key={`${it.vendor_sku}-${i}`}
                      className={`border-b border-card-border last:border-0 ${it.flagged ? "bg-amber-500/5" : ""}`}
                    >
                      <td className="px-4 py-2 font-mono text-xs">{it.vendor_sku}</td>
                      <td className="px-4 py-2 text-xs">{it.match_status ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{it.shopify_qty ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{it.portal_qty ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{it.delta ?? "—"}</td>
                      <td className="px-4 py-2">
                        <Badge
                          variant={it.action === "update" ? "default" : "outline"}
                          className="text-[10px] uppercase"
                        >
                          {it.action}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{it.reason ?? "Ready to update"}</td>
                    </tr>
                  ))}
                  {lastInv.items.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-xs text-muted-foreground">
                        No portal styles to evaluate. Import a Vendor Portal export on the Portal Styles page first.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {lastOrd && (
        <Card className="mb-4" data-testid="card-order-pull">
          <CardHeader className="border-b border-card-border">
            <CardTitle className="text-sm">
              Order pull preview{" "}
              <Badge variant="secondary" className="ml-2 text-[10px] uppercase">
                Preview only
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="border-b border-card-border px-4 py-2.5 text-xs text-muted-foreground">
              {lastOrd.note}
              {lastOrd.errors.length > 0 && (
                <span className="text-rose-500"> Errors: {lastOrd.errors.join("; ")}</span>
              )}
            </div>
            {lastOrd.unmatchedLines.length > 0 ? (
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 border-b border-card-border bg-card text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Order</th>
                      <th className="px-4 py-2 text-left font-medium">SKU</th>
                      <th className="px-4 py-2 text-right font-medium">Qty</th>
                      <th className="px-4 py-2 text-left font-medium">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lastOrd.unmatchedLines.map((l, i) => (
                      <tr key={`${l.sales_order_number}-${l.sku}-${i}`} className="border-b border-card-border bg-rose-500/5 last:border-0">
                        <td className="px-4 py-2 font-mono text-xs">{l.sales_order_number}</td>
                        <td className="px-4 py-2 font-mono text-xs">{l.sku}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{l.quantity ?? "—"}</td>
                        <td className="px-4 py-2">
                          <Badge variant="destructive" className="text-[10px] uppercase">
                            Unmatched
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                {lastOrd.counts.lines > 0
                  ? "All order lines matched a Shopify variant."
                  : "No order lines pulled."}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-automation-jobs">
        <CardHeader className="border-b border-card-border">
          <CardTitle className="text-sm">Recent automation jobs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-card-border bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Job</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Started</th>
                  <th className="px-4 py-2 text-left font-medium">Summary</th>
                </tr>
              </thead>
              <tbody>
                {q.data.recentJobs.map((j) => (
                  <tr key={j.id} className="border-b border-card-border last:border-0">
                    <td className="px-4 py-2 text-xs">
                      {j.jobType === "auto_inventory_sync" ? "Inventory sync" : "Order pull"}
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        variant={j.status === "success" ? "default" : j.status === "running" ? "secondary" : "destructive"}
                        className="text-[10px] uppercase"
                      >
                        {j.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-xs">{fmtTime(j.startedAt)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{j.summary ?? "—"}</td>
                  </tr>
                ))}
                {q.data.recentJobs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-xs text-muted-foreground">
                      No automation runs yet. Use the buttons above to run a dry-run now.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
