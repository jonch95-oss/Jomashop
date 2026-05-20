import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, LoadingRows, ErrorBlock } from "@/components/AppShell";

type Row = { vendor_sku: string; price: number; status: string; quantity: number };
type Preview = { headers: string[]; rows: Row[]; note: string };

export default function Inventory() {
  const q = useQuery<Preview>({ queryKey: ["/api/sync/inventory-preview"] });

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
        description="Bulk inventory update preview. Maps to PUT /v1/inventory/update-statuses or POST /v1/inventory/upload-updates."
        actions={
          <Button data-testid="button-download-csv" onClick={downloadCsv} variant="outline" size="sm">
            <Download className="mr-2 h-3.5 w-3.5" /> Export preview CSV
          </Button>
        }
      />

      <div className="mb-4 rounded-md border border-border bg-card/40 px-4 py-2.5 text-xs text-muted-foreground">
        {q.data.note}
      </div>

      <Card>
        <CardHeader className="border-b border-card-border">
          <CardTitle className="text-sm">Bulk payload preview</CardTitle>
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
