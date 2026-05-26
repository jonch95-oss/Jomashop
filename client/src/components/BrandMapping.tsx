// Brand mapping workflow UI. Mirrors CategoryMapping but is a simple
// key/value editor: there is no live Jomashop brand catalog to download, so
// the operator types in the exact spelling Jomashop expects after a push is
// rejected with "Brand must exist".

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";

type BrandOverride = {
  shopify_brand: string;
  jomashop_brand: string;
  notes: string | null;
  updated_at: number;
};

type OverridesResponse = {
  ok: boolean;
  count: number;
  overrides: BrandOverride[];
};

export function BrandMappingCard(props: { onAfterApply?: () => void }) {
  const [shopifyBrand, setShopifyBrand] = useState("");
  const [jomashopBrand, setJomashopBrand] = useState("");
  const [notes, setNotes] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveInfo, setSaveInfo] = useState<string | null>(null);

  const overridesQ = useQuery<OverridesResponse>({
    queryKey: ["/api/brand-mapping/overrides"],
  });

  const saveMut = useMutation({
    mutationFn: async (): Promise<{ ok: boolean; shopify_brand?: string; jomashop_brand?: string; error?: string }> => {
      const res = await apiRequest("POST", "/api/brand-mapping/overrides", {
        shopify_brand: shopifyBrand,
        jomashop_brand: jomashopBrand,
        notes,
      });
      return (await res.json()) as { ok: boolean; shopify_brand?: string; jomashop_brand?: string; error?: string };
    },
    onSuccess: (r) => {
      if (r.ok) {
        setSaveInfo(`Saved ${r.shopify_brand} → ${r.jomashop_brand}.`);
        setSaveError(null);
        setShopifyBrand("");
        setJomashopBrand("");
        setNotes("");
        overridesQ.refetch();
        props.onAfterApply?.();
      } else {
        setSaveError(r.error || "Save failed");
        setSaveInfo(null);
      }
    },
    onError: (e: Error) => {
      setSaveError(e.message);
      setSaveInfo(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (key: string) => {
      const res = await apiRequest("DELETE", `/api/brand-mapping/overrides/${encodeURIComponent(key)}`);
      return (await res.json()) as { ok: boolean; removed: string };
    },
    onSuccess: () => {
      overridesQ.refetch();
      props.onAfterApply?.();
    },
  });

  const overrides = overridesQ.data?.overrides ?? [];

  return (
    <Card data-testid="card-brand-mapping">
      <CardHeader className="border-b border-card-border">
        <CardTitle className="text-sm">Brand mapping (Shopify → Jomashop)</CardTitle>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Map a Shopify brand/designer to the exact spelling Jomashop expects.
          Used when Jomashop rejects a push with <code>Brand must exist</code>.
          Lookup ignores case and punctuation, so "Tods", "TODS", and "Tod's"
          all resolve to the same row.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 p-4 text-xs">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <div>
            <Label htmlFor="brand-shopify" className="text-[10px] uppercase">
              Shopify brand (vendor / designer)
            </Label>
            <Input
              id="brand-shopify"
              data-testid="input-brand-shopify"
              value={shopifyBrand}
              onChange={(e) => setShopifyBrand(e.target.value)}
              placeholder="e.g. Tods"
              className="h-8 font-mono text-xs"
            />
          </div>
          <div>
            <Label htmlFor="brand-jomashop" className="text-[10px] uppercase">
              Exact Jomashop brand
            </Label>
            <Input
              id="brand-jomashop"
              data-testid="input-brand-jomashop"
              value={jomashopBrand}
              onChange={(e) => setJomashopBrand(e.target.value)}
              placeholder="e.g. Tod's"
              className="h-8 font-mono text-xs"
            />
          </div>
          <div>
            <Label htmlFor="brand-notes" className="text-[10px] uppercase">
              Notes
            </Label>
            <Input
              id="brand-notes"
              data-testid="input-brand-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="optional"
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            data-testid="button-save-brand-override"
            disabled={
              saveMut.isPending ||
              shopifyBrand.trim() === "" ||
              jomashopBrand.trim() === ""
            }
            onClick={() => saveMut.mutate()}
          >
            {saveMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
            )}
            Save brand override
          </Button>
          {saveError && (
            <span data-testid="text-brand-save-error" className="text-red-500">
              {saveError}
            </span>
          )}
          {saveInfo && (
            <span data-testid="text-brand-save-info" className="text-emerald-500">
              {saveInfo}
            </span>
          )}
        </div>

        {overrides.length > 0 && (
          <div className="rounded border border-border bg-card/40 p-2" data-testid="block-current-brand-overrides">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Current saved brand overrides
              </div>
              <Badge variant="outline">{overrides.length}</Badge>
            </div>
            <div className="max-h-40 overflow-auto">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Shopify key</th>
                    <th className="px-2 py-1 text-left">Jomashop brand</th>
                    <th className="px-2 py-1 text-left">Notes</th>
                    <th className="px-2 py-1 text-right">&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr
                      key={o.shopify_brand}
                      className="border-t border-border"
                      data-testid={`row-brand-override-${o.shopify_brand}`}
                    >
                      <td className="px-2 py-1 font-mono">{o.shopify_brand}</td>
                      <td className="px-2 py-1">{o.jomashop_brand}</td>
                      <td className="px-2 py-1 text-muted-foreground">{o.notes || "—"}</td>
                      <td className="px-2 py-1 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`button-remove-brand-override-${o.shopify_brand}`}
                          disabled={deleteMut.isPending}
                          onClick={() => deleteMut.mutate(o.shopify_brand)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
