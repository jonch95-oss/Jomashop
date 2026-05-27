import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, LoadingRows, ErrorBlock } from "@/components/AppShell";
import type { CategorySchema } from "@/lib/types";
import { JomashopMappingExcelCard } from "@/components/JomashopMappingExcel";
import { JomashopProductFieldExcelCard } from "@/components/JomashopProductFieldExcel";

const CATEGORIES = ["Shoes", "Handbags", "Clothing"] as const;
type Cat = (typeof CATEGORIES)[number];

// Suggested Shopify source per Jomashop field (frontend display only).
const SUGGESTED_SOURCE: Record<string, string> = {
  brand: "product.vendor",
  model: "product.title",
  color: "variant.option(color)",
  size: "variant.option(size)",
  size_system: "metafield: luxe.size_system",
  gender: "metafield: luxe.gender",
  material: "metafield: luxe.material",
  style: "metafield: luxe.style",
  hardware: "metafield: luxe.hardware",
  interior_material: "metafield: luxe.interior_material",
  dimensions: "metafield: luxe.dimensions",
  country_of_origin: "metafield: luxe.country_of_origin",
  category_type: "metafield: luxe.category_type",
};

function CategoryMap({ category }: { category: Cat }) {
  const q = useQuery<CategorySchema>({
    queryKey: ["/api/jomashop/categories", category],
  });

  if (q.isLoading) return <LoadingRows />;
  if (q.isError) return <ErrorBlock message={(q.error as Error).message} />;
  if (!q.data) return null;

  const props = q.data.schema.properties || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border border-border bg-card/40 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <ArrowLeftRight className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium">{category}</span>
          <span className="text-muted-foreground">— {props.length} fields</span>
        </div>
        <Badge variant={q.data.source === "live" ? "default" : "secondary"} className="text-[10px] uppercase">
          {q.data.source === "live" ? "Live schema" : "Fallback schema"}
        </Badge>
      </div>

      <div className="overflow-hidden rounded-md border border-card-border">
        <table className="w-full text-sm">
          <thead className="border-b border-card-border bg-card/50 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Jomashop field</th>
              <th className="px-4 py-2 text-left font-medium">Type</th>
              <th className="px-4 py-2 text-left font-medium">Suggested Shopify source</th>
              <th className="px-4 py-2 text-right font-medium">Required</th>
            </tr>
          </thead>
          <tbody>
            {props.map((p) => (
              <tr key={p.field} className="border-b border-card-border last:border-0" data-testid={`mapping-row-${p.field}`}>
                <td className="px-4 py-2.5 font-mono text-xs">{p.field}</td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {p.type || "string"}
                  {p.options && p.options.length > 0 && (
                    <span className="ml-1 text-muted-foreground/70">({p.options.join(", ")})</span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                  {SUGGESTED_SOURCE[p.field] || "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {p.required ? (
                    <Badge variant="default" className="gap-1 text-[10px]">
                      <Check className="h-2.5 w-2.5" /> Required
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                      <X className="h-2.5 w-2.5" /> Optional
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Mapping() {
  const [active, setActive] = useState<Cat>("Shoes");
  return (
    <>
      <PageHeader
        title="Field mapping"
        description="Map Shopify product fields to Jomashop category properties. Schemas are fetched live from /v1/categories/:name when credentials are available."
      />
      <div className="mb-6 space-y-6">
        <JomashopProductFieldExcelCard />
        <JomashopMappingExcelCard />
      </div>
      <Card>
        <CardHeader className="border-b border-card-border">
          <CardTitle className="text-sm">Categories</CardTitle>
        </CardHeader>
        <CardContent className="p-5">
          <Tabs value={active} onValueChange={(v) => setActive(v as Cat)}>
            <TabsList>
              {CATEGORIES.map((c) => (
                <TabsTrigger key={c} value={c} data-testid={`tab-${c.toLowerCase()}`}>
                  {c}
                </TabsTrigger>
              ))}
            </TabsList>
            {CATEGORIES.map((c) => (
              <TabsContent key={c} value={c} className="mt-4">
                <CategoryMap category={c} />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </>
  );
}
