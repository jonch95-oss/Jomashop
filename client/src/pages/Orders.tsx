import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, LoadingRows, EmptyState } from "@/components/AppShell";

type Sample = {
  sales_order_number: string;
  status: string;
  customer: string;
  line_items: Array<{ sku: string; quantity: number; price: number }>;
  shipping: { method: string; address: { city: string; state: string } };
  placed_at: string;
};

type Preview = { samples: Sample[]; fulfillExample: any; note: string };

export default function Orders() {
  const q = useQuery<Preview>({ queryKey: ["/api/sync/orders-preview"] });

  return (
    <>
      <PageHeader
        title="Orders"
        description="New orders pulled from GET /v1/orders?status=new. Preview view until OAuth + Jomashop login complete."
      />

      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data ? (
        <EmptyState title="No order preview available" />
      ) : (
        <>
          <div className="mb-4 rounded-md border border-border bg-card/40 px-4 py-2.5 text-xs text-muted-foreground">
            {q.data.note}
          </div>
          <Card>
            <CardHeader className="border-b border-card-border">
              <CardTitle className="text-sm">New orders ({q.data.samples.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-card-border bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Order</th>
                    <th className="px-4 py-2 text-left font-medium">Items</th>
                    <th className="px-4 py-2 text-left font-medium">Ship to</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.samples.map((o) => {
                    const total = o.line_items.reduce((s, li) => s + li.price * li.quantity, 0);
                    return (
                      <tr key={o.sales_order_number} className="border-b border-card-border last:border-0" data-testid={`row-order-${o.sales_order_number}`}>
                        <td className="px-4 py-2.5">
                          <div className="font-mono text-xs">{o.sales_order_number}</div>
                          <div className="text-[10px] text-muted-foreground tabular-nums">{new Date(o.placed_at).toLocaleString()}</div>
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {o.line_items.map((li) => (
                            <div key={li.sku} className="font-mono">
                              {li.quantity}× {li.sku}
                            </div>
                          ))}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {o.shipping.address.city}, {o.shipping.address.state}
                          <div className="text-[10px]">{o.shipping.method}</div>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">${total.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Badge variant="outline" className="text-[10px] uppercase">{o.status}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
