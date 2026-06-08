import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShoppingBag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, LoadingRows, EmptyState, ErrorBlock } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

type JomashopLineItem = {
  sku?: string;
  jomashop_sku?: string;
  quantity?: number | string;
  price?: number | string;
};

type JomashopOrder = {
  sales_order_number?: string;
  placed_at?: string;
  status?: string;
  gift_message?: string | null;
  ship_method?: string | null;
  shipping_address?: {
    name?: string;
    address1?: string;
    address2?: string | null;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  } | null;
  line_items?: JomashopLineItem[];
};

type LiveOrdersResponse = {
  configured?: boolean;
  data?: unknown;
  items?: JomashopOrder[];
  error?: string;
};

type ImportedOrder = {
  id: number;
  salesOrderNumber: string;
  status: string;
  payloadJson: string;
  shopifyOrderId: string | null;
  importedAt: number;
  updatedAt: number;
};

type ImportResult = {
  ok: boolean;
  jobId?: number;
  fetched?: number;
  created?: number;
  skipped?: number;
  failed?: number;
  error?: string;
  results?: Array<{
    sales_order_number: string;
    status: "created" | "skipped" | "failed";
    shopify_order_id?: string | null;
    message: string;
  }>;
};

function extractOrders(data: unknown): JomashopOrder[] {
  const d: any = data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.orders)) return d.orders;
  if (Array.isArray(d?.data?.orders)) return d.data.orders;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.data)) return d.data;
  if (d?.order && typeof d.order === "object") return [d.order];
  return [];
}

function orderTotal(order: JomashopOrder): number {
  return (order.line_items || []).reduce((sum, li) => {
    const price = Number(li.price ?? 0);
    const qty = Number(li.quantity ?? 0);
    return sum + (Number.isFinite(price) ? price : 0) * (Number.isFinite(qty) ? qty : 0);
  }, 0);
}

function shopifyOrderHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = String(raw).match(/(\d+)$/)?.[1];
  return id ? `https://admin.shopify.com/store/herbiemissry/orders/${id}` : null;
}

export default function Orders() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("new");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const liveQ = useQuery<LiveOrdersResponse>({
    queryKey: ["jomashop-orders", status],
    queryFn: async () => {
      const res = await fetch(`/api/jomashop/orders?status=${encodeURIComponent(status)}&per_page=50`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return res.json();
    },
  });

  const importedQ = useQuery<ImportedOrder[]>({ queryKey: ["/api/imported-orders"] });

  const importMutation = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      const res = await apiRequest("POST", "/api/jomashop/orders/import-to-shopify", {
        confirm: true,
        status,
        limit: 50,
      });
      return (await res.json()) as ImportResult;
    },
    onSuccess: (result) => {
      setImportResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/imported-orders"] });
      queryClient.invalidateQueries({ queryKey: ["jomashop-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sync-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (err: Error) => setImportResult({ ok: false, error: err.message }),
  });

  const orders = useMemo(() => extractOrders(liveQ.data?.data ?? liveQ.data?.items ?? []), [liveQ.data]);
  const importedBySo = useMemo(() => {
    const m = new Map<string, ImportedOrder>();
    for (const row of importedQ.data || []) m.set(row.salesOrderNumber, row);
    return m;
  }, [importedQ.data]);

  const importableCount = orders.filter((o) => {
    const so = String(o.sales_order_number || "");
    return so && !importedBySo.get(so)?.shopifyOrderId;
  }).length;

  return (
    <>
      <PageHeader
        title="Orders"
        description="Live Jomashop orders from GET /v1/orders. Import creates Shopify orders tagged jomashop and links them back here."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <select
              data-testid="select-order-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {['new', 'pending', 'partial', 'fulfilled', 'rejected', 'cancelled'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <Button
              data-testid="button-import-orders-to-shopify"
              size="sm"
              disabled={importMutation.isPending || importableCount === 0 || liveQ.data?.configured === false}
              onClick={() => {
                if (typeof window !== "undefined" && !window.confirm(`Create Shopify orders for ${importableCount} Jomashop order(s)?`)) return;
                importMutation.mutate();
              }}
            >
              <ShoppingBag className="mr-2 h-3.5 w-3.5" />
              {importMutation.isPending ? "Importing…" : `Import to Shopify (${importableCount})`}
            </Button>
            <Button data-testid="button-refresh-orders" size="sm" variant="outline" onClick={() => liveQ.refetch()}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        }
      />

      {liveQ.data?.configured === false && (
        <ErrorBlock message="Jomashop credentials are not configured. Set JOMASHOP_EMAIL and JOMASHOP_PASSWORD before importing orders." />
      )}

      {importResult && (
        <div
          data-testid="banner-order-import-result"
          className={`mb-4 rounded-md border px-4 py-2.5 text-xs ${
            importResult.ok
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          }`}
        >
          {importResult.error
            ? `Import failed: ${importResult.error}`
            : `Import result: ${importResult.created ?? 0} created, ${importResult.skipped ?? 0} skipped, ${importResult.failed ?? 0} failed.`}
          {importResult.results && importResult.results.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {importResult.results.slice(0, 8).map((r, i) => (
                <li key={`${r.sales_order_number}-${i}`}>{r.sales_order_number || "(missing SO#)"}: {r.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {liveQ.isLoading || importedQ.isLoading ? (
        <LoadingRows />
      ) : liveQ.isError ? (
        <ErrorBlock message={(liveQ.error as Error).message} />
      ) : orders.length === 0 ? (
        <EmptyState title={`No ${status} Jomashop orders found`} />
      ) : (
        <Card>
          <CardHeader className="border-b border-card-border">
            <CardTitle className="text-sm">Jomashop {status} orders ({orders.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-card-border bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Order</th>
                    <th className="px-4 py-2 text-left font-medium">Items</th>
                    <th className="px-4 py-2 text-left font-medium">Ship to</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 text-right font-medium">Shopify</th>
                    <th className="px-4 py-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o, idx) => {
                    const so = String(o.sales_order_number || `order-${idx}`);
                    const imported = importedBySo.get(so);
                    const href = shopifyOrderHref(imported?.shopifyOrderId);
                    return (
                      <tr key={so} className="border-b border-card-border last:border-0" data-testid={`row-order-${so}`}>
                        <td className="px-4 py-2.5">
                          <div className="font-mono text-xs">{so}</div>
                          <div className="text-[10px] text-muted-foreground tabular-nums">
                            {o.placed_at ? new Date(o.placed_at).toLocaleString() : "—"}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {(o.line_items || []).map((li, i) => (
                            <div key={`${li.sku || li.jomashop_sku || i}`} className="font-mono">
                              {li.quantity ?? 1}x {li.sku || li.jomashop_sku || "unknown SKU"}
                            </div>
                          ))}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {o.shipping_address?.name || "—"}
                          <div className="text-[10px]">
                            {[o.shipping_address?.city, o.shipping_address?.state, o.shipping_address?.zip].filter(Boolean).join(", ") || "—"}
                          </div>
                          {o.ship_method && <div className="text-[10px]">{o.ship_method}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">${orderTotal(o).toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right text-xs">
                          {href ? (
                            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
                              Open Shopify
                            </a>
                          ) : imported ? (
                            <span className="text-amber-500">Import attempted</span>
                          ) : (
                            <span className="text-muted-foreground">Not imported</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Badge variant="outline" className="text-[10px] uppercase">{o.status || status}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
