import { useMutation } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { AlertTriangle, RefreshCcw, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, EmptyState, LoadingRows } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";
import type { MappedProduct } from "@/lib/types";

export default function Products() {
  const [data, setData] = useState<{ mapped: MappedProduct[]; count: number; schemas: any } | null>(null);

  const preview = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sync/preview-products", {});
      return res.json();
    },
    onSuccess: (d) => setData(d),
  });

  // Auto-run on mount
  useEffect(() => {
    preview.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHeader
        title="Products"
        description="Preview Shopify → Jomashop product mapping. Uses sample data until OAuth is complete."
        actions={
          <Button
            data-testid="button-rerun-preview"
            onClick={() => preview.mutate()}
            disabled={preview.isPending}
            variant="outline"
            size="sm"
          >
            {preview.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="mr-2 h-3.5 w-3.5" />}
            Re-run preview
          </Button>
        }
      />

      {preview.isPending && !data ? (
        <LoadingRows count={3} />
      ) : !data ? (
        <EmptyState
          title="No mapping preview yet"
          description="Run a preview to see how Shopify product fields translate to Jomashop payloads."
        />
      ) : (
        <div className="space-y-4">
          {data.mapped.map((p) => (
            <Card key={`${p.vendor_sku}-${p.source.shopify_product_id}`} data-testid={`card-product-${p.vendor_sku}`}>
              <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-sm">{p.name}</CardTitle>
                  <Badge variant="outline" className="text-[10px] uppercase">{p.category}</Badge>
                </div>
                <code className="font-mono text-[11px] text-muted-foreground tabular-nums">{p.vendor_sku}</code>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 p-5 md:grid-cols-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Brand</div>
                  <div className="mt-1 text-sm">{p.brand}</div>
                  <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Shopify price</div>
                  <div className="mt-1 text-sm tabular-nums">
                    {p.price !== null ? `$${p.price.toFixed(2)}` : "—"}
                    {p.msrp && (
                      <span className="ml-2 text-xs text-muted-foreground line-through">${p.msrp.toFixed(2)}</span>
                    )}
                  </div>
                  <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Commercial discount</div>
                  <div className="mt-1 text-sm tabular-nums" data-testid={`text-discount-${p.vendor_sku}`}>
                    {p.commercial_discount > 0
                      ? `${(p.commercial_discount * 100).toFixed(p.commercial_discount * 100 % 1 === 0 ? 0 : 2)}%`
                      : "—"}
                  </div>
                  <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Jomashop price</div>
                  <div className="mt-1 text-sm font-medium tabular-nums" data-testid={`text-jomashop-price-${p.vendor_sku}`}>
                    {p.jomashop_price !== null ? `$${p.jomashop_price.toFixed(2)}` : "—"}
                  </div>
                  <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Variants</div>
                  <div className="mt-1 text-sm tabular-nums">{p.variants.length}</div>
                </div>

                <div className="md:col-span-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Category properties</div>
                  <div className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-2">
                    {Object.entries(p.properties).map(([k, v]) => (
                      <div
                        key={k}
                        className="flex items-center justify-between rounded border border-border bg-card/40 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-mono text-muted-foreground">{k}</span>
                        <span className={`ml-2 truncate font-mono ${v === null ? "text-amber-500/80" : ""}`}>
                          {v === null ? "missing" : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {p.warnings.length > 0 && (
                  <div className="md:col-span-3">
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-500">
                      <div className="mb-1 flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="h-3 w-3" /> {p.warnings.length} warning(s)
                      </div>
                      <ul className="ml-4 list-disc space-y-0.5">
                        {p.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                <div className="md:col-span-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Variants</div>
                  <div className="mt-2 overflow-hidden rounded border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-card/60 text-[10px] uppercase text-muted-foreground">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium">Vendor SKU</th>
                          <th className="px-3 py-1.5 text-left font-medium">Options</th>
                          <th className="px-3 py-1.5 text-right font-medium">Shopify price</th>
                          <th className="px-3 py-1.5 text-right font-medium">Jomashop price</th>
                          <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                          <th className="px-3 py-1.5 text-right font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.variants.map((v) => (
                          <tr key={v.vendor_sku} className="border-t border-border" data-testid={`variant-${v.vendor_sku}`}>
                            <td className="px-3 py-1.5 font-mono">{v.vendor_sku}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(" • ") || "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {v.price !== null ? `$${v.price.toFixed(2)}` : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right font-medium tabular-nums" data-testid={`variant-jomashop-price-${v.vendor_sku}`}>
                              {v.jomashop_price !== null ? `$${v.jomashop_price.toFixed(2)}` : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{v.quantity}</td>
                            <td className="px-3 py-1.5 text-right">
                              <Badge
                                variant={
                                  v.status === "active"
                                    ? "default"
                                    : v.status === "out_of_stock"
                                      ? "secondary"
                                      : "outline"
                                }
                                className="text-[9px] uppercase"
                              >
                                {v.status.replace("_", " ")}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
