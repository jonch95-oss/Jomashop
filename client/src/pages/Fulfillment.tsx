import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, LoadingRows } from "@/components/AppShell";

type Preview = { samples: any[]; fulfillExample: { url: string; method: string; body: any } };

export default function Fulfillment() {
  const q = useQuery<Preview>({ queryKey: ["/api/sync/orders-preview"] });

  return (
    <>
      <PageHeader
        title="Fulfillment"
        description="Mark Jomashop orders fulfilled. Payload preview below; live PUT call wired in /api/jomashop/orders proxy."
      />

      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data ? null : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader className="border-b border-card-border">
              <CardTitle className="text-sm">Fulfill request</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-5 text-sm">
              <div className="flex items-center gap-2">
                <Badge className="font-mono text-[10px]">{q.data.fulfillExample.method}</Badge>
                <code className="font-mono text-xs">{q.data.fulfillExample.url}</code>
              </div>
              <pre className="overflow-x-auto rounded-md border border-border bg-card/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {JSON.stringify(q.data.fulfillExample.body, null, 2)}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b border-card-border">
              <CardTitle className="text-sm">Required fields</CardTitle>
            </CardHeader>
            <CardContent className="p-5">
              <ul className="space-y-2 text-sm">
                {[
                  ["fulfilled", "Array of { sku, quantity } pairs"],
                  ["invoice_number", "LuxeSupply invoice reference"],
                  ["tracking_number", "Carrier tracking number"],
                  ["used_supplied_shipping_label", "true if Jomashop label was used"],
                  ["shipped_at", "ISO timestamp of ship date"],
                ].map(([k, v]) => (
                  <li key={k} className="flex items-start justify-between gap-3 border-b border-card-border pb-2 last:border-0">
                    <code className="font-mono text-xs">{k}</code>
                    <span className="text-right text-xs text-muted-foreground">{v}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4 rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
                Reject path uses <code className="font-mono">PUT /v1/orders/:sales_order_number/reject</code>.
                Bulk path uses <code className="font-mono">POST /v1/orders/upload</code>.
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
