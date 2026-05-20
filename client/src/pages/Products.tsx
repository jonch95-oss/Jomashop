import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, RefreshCcw, Loader2, Send, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader, EmptyState, LoadingRows } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";
import type { MappedProduct } from "@/lib/types";

type OverrideFields = {
  category: string;
  brand: string;
  sku: string;
  manufacturer_number: string;
};

const TOP_LEVEL_FIELDS = ["category", "brand", "sku", "manufacturer_number"] as const;

// The shape of the body POSTed to /api/jomashop/push-product. We use the
// SAMPLE_SHOPIFY_PRODUCTS payload (echoed back through /api/sync/preview-products)
// to drive a single test push without having to refetch raw Shopify objects.
type PushTarget = {
  productIndex: number;
  variantSku?: string;
  mapped: MappedProduct;
};

type PushResult = {
  ok: boolean;
  jobId?: number;
  schemaSource?: "live" | "fallback";
  payloadPreview?: Record<string, unknown>;
  payloadSent?: Record<string, unknown>;
  product?: { status: number; data: unknown };
  inventory?: { status: number; ok: boolean; data?: unknown; error?: string } | null;
  warnings?: string[];
  missingRequired?: string[];
  missingTopLevel?: string[];
  errors?: string[];
  invalidParams?: string[];
  error?: string;
  status?: number;
  stage?: string;
};

type PreviewData = {
  mapped: MappedProduct[];
  count: number;
  schemas: any;
  usingSamples?: boolean;
  shopifyConnected?: boolean;
  note?: string;
};

export default function Products() {
  const [data, setData] = useState<PreviewData | null>(null);
  const [pushTarget, setPushTarget] = useState<PushTarget | null>(null);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [overrides, setOverrides] = useState<OverrideFields>({
    category: "",
    brand: "",
    sku: "",
    manufacturer_number: "",
  });

  // Live Jomashop categories — used to populate a datalist for the category
  // override so the operator can pick a name Jomashop actually accepts
  // instead of shipping a raw Shopify code.
  const categoriesQ = useQuery<{
    source: "live" | "fallback";
    categories?: Array<{ name: string }>;
    data?: unknown;
  }>({
    queryKey: ["/api/jomashop/categories"],
  });

  const categoryOptions = useMemo<string[]>(() => {
    const raw = categoriesQ.data;
    if (!raw) return ["Shoes", "Handbags", "Clothing"];
    const liveList =
      (Array.isArray((raw as any).data) ? (raw as any).data : null) ||
      (Array.isArray((raw as any).data?.categories) ? (raw as any).data.categories : null) ||
      raw.categories ||
      [];
    const names = (liveList as Array<{ name?: string } | string>)
      .map((c) => (typeof c === "string" ? c : c?.name))
      .filter((s): s is string => Boolean(s));
    return names.length > 0 ? names : ["Shoes", "Handbags", "Clothing"];
  }, [categoriesQ.data]);

  const preview = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sync/preview-products", {});
      return res.json();
    },
    onSuccess: (d) => setData(d),
  });

  const push = useMutation({
    mutationFn: async (target: PushTarget): Promise<PushResult> => {
      const trimmedOverrides = Object.fromEntries(
        TOP_LEVEL_FIELDS.map((k) => [k, overrides[k].trim()]).filter(
          ([, v]) => v !== "",
        ),
      );
      const res = await apiRequest("POST", "/api/jomashop/push-product", {
        confirm: true,
        variantSku: target.variantSku,
        pushInventory: true,
        product: shopifyProductFromMapped(target.mapped),
        overrides: trimmedOverrides,
      });
      return res.json();
    },
    onSuccess: (r) => setPushResult(r),
    onError: (e: Error) => {
      try {
        const msg = e.message;
        const jsonStart = msg.indexOf("{");
        if (jsonStart >= 0) {
          setPushResult(JSON.parse(msg.slice(jsonStart)) as PushResult);
        } else {
          setPushResult({ ok: false, error: msg });
        }
      } catch {
        setPushResult({ ok: false, error: e.message });
      }
    },
  });

  // Auto-run on mount
  useEffect(() => {
    preview.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openPushModal(productIndex: number, mapped: MappedProduct, variantSku?: string) {
    setPushResult(null);
    setPushTarget({ productIndex, variantSku, mapped });
    setOverrides({
      category: mapped.suggested_category || mapped.category || "",
      brand: mapped.brand || "",
      sku: variantSku || mapped.sku || mapped.vendor_sku || "",
      manufacturer_number:
        mapped.manufacturer_number || variantSku || mapped.sku || mapped.vendor_sku || "",
    });
  }

  function closePushModal() {
    setPushTarget(null);
    setPushResult(null);
    setOverrides({ category: "", brand: "", sku: "", manufacturer_number: "" });
    push.reset();
  }

  const overrideBlanks = TOP_LEVEL_FIELDS.filter((k) => overrides[k].trim() === "");
  const targetIsSample = pushTarget?.mapped.is_sample === true;
  const canConfirm =
    pushTarget !== null &&
    overrideBlanks.length === 0 &&
    !push.isPending &&
    !targetIsSample;

  const categorySelected = overrides.category.trim();
  const categoryInLiveList =
    categorySelected !== "" &&
    categoryOptions.some(
      (c) => c.toLowerCase() === categorySelected.toLowerCase(),
    );
  const categoriesAreLive = (categoriesQ.data as any)?.source === "live";

  return (
    <>
      <PageHeader
        title="Products"
        description="Preview Shopify → Jomashop product mapping, then push a single test product when ready."
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
          {(data.usingSamples || !data.shopifyConnected) && (
            <div
              data-testid="banner-shopify-not-connected"
              className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400"
            >
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                Connect Shopify / load live products before pushing to Jomashop.
              </div>
              <div className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-300/80">
                {data.usingSamples
                  ? "The rows below are SAMPLE FIXTURE products built into the app — the push button is disabled for them."
                  : "No live Shopify products are loaded yet. Push will be disabled until at least one real product is fetched."}
              </div>
            </div>
          )}
          {data.mapped.map((p, idx) => (
            <Card
              key={`${p.vendor_sku}-${p.source.shopify_product_id}`}
              data-testid={`card-product-${p.vendor_sku}`}
              className={p.is_sample ? "border-amber-500/40" : undefined}
            >
              <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
                <div className="flex items-center gap-3">
                  <CardTitle className="text-sm">{p.name}</CardTitle>
                  <Badge variant="outline" className="text-[10px] uppercase">{p.category}</Badge>
                  {p.is_sample ? (
                    <Badge
                      data-testid={`badge-sample-${p.vendor_sku}`}
                      className="bg-amber-500/15 text-[10px] uppercase text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
                      variant="outline"
                    >
                      Sample data — push disabled
                    </Badge>
                  ) : (
                    <Badge
                      data-testid={`badge-live-${p.vendor_sku}`}
                      className="bg-emerald-500/15 text-[10px] uppercase text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
                      variant="outline"
                    >
                      Live Shopify product
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <code className="font-mono text-[11px] text-muted-foreground tabular-nums">{p.vendor_sku}</code>
                  <Button
                    data-testid={`button-push-product-${p.vendor_sku}`}
                    onClick={() => openPushModal(idx, p)}
                    size="sm"
                    variant="default"
                    disabled={p.is_sample}
                    title={p.is_sample ? "Sample/demo product — cannot be pushed" : undefined}
                  >
                    <Send className="mr-2 h-3.5 w-3.5" />
                    {p.is_sample ? "Push disabled (sample)" : "Push test product to Jomashop"}
                  </Button>
                </div>
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
                          <th className="px-3 py-1.5 text-right font-medium">Push</th>
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
                            <td className="px-3 py-1.5 text-right">
                              <Button
                                data-testid={`button-push-variant-${v.vendor_sku}`}
                                onClick={() => openPushModal(idx, p, v.vendor_sku)}
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px]"
                                disabled={p.is_sample}
                                title={p.is_sample ? "Sample/demo product — cannot be pushed" : undefined}
                              >
                                <Send className="mr-1 h-3 w-3" />
                                Push
                              </Button>
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

      <Dialog open={pushTarget !== null} onOpenChange={(o) => !o && closePushModal()}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Confirm push to Jomashop
            </DialogTitle>
            <DialogDescription>
              This will <strong>create or update data in Jomashop</strong>. It posts one product
              to <code className="rounded bg-muted px-1">POST /v1/products</code> and updates
              inventory at <code className="rounded bg-muted px-1">PUT /v1/inventory/:sku</code>.
              Only proceed if you have reviewed the mapping below.
            </DialogDescription>
          </DialogHeader>

          {pushTarget && !pushResult && (
            <div className="space-y-3 text-xs">
              <div
                data-testid="banner-push-source"
                className={`rounded border p-2 text-[11px] font-semibold uppercase tracking-wider ${
                  targetIsSample
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {targetIsSample
                  ? "Sample data — push disabled"
                  : "Live Shopify product"}
              </div>
              <div className="rounded border border-border bg-card/40 p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Product
                </div>
                <div className="font-medium">{pushTarget.mapped.name}</div>
                <div className="mt-1 text-muted-foreground">
                  Shopify product_type:{" "}
                  <code className="rounded bg-muted px-1 font-mono">
                    {pushTarget.mapped.raw_category || "—"}
                  </code>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Shopify price</div>
                    <div className="tabular-nums">
                      {pushTarget.mapped.price !== null ? `$${pushTarget.mapped.price.toFixed(2)}` : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Jomashop price (after discount)</div>
                    <div className="font-medium tabular-nums">
                      {(() => {
                        const v = pushTarget.variantSku
                          ? pushTarget.mapped.variants.find((x) => x.vendor_sku === pushTarget.variantSku)
                          : null;
                        const p = v?.jomashop_price ?? pushTarget.mapped.jomashop_price;
                        return p !== null && p !== undefined ? `$${p.toFixed(2)}` : "—";
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded border border-border bg-card/40 p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Required Jomashop fields (editable)
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div>
                    <Label htmlFor="ovr-category" className="text-[10px] uppercase">
                      Category {categoriesAreLive ? "(live)" : "(fallback)"}
                    </Label>
                    <select
                      id="ovr-category"
                      data-testid="select-override-category"
                      value={
                        categoryInLiveList || categorySelected === ""
                          ? categorySelected
                          : "__custom__"
                      }
                      onChange={(e) => {
                        if (e.target.value === "__custom__") return;
                        setOverrides((o) => ({ ...o, category: e.target.value }));
                      }}
                      className="flex h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs"
                    >
                      <option value="">— select category —</option>
                      {categoryOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                      {!categoryInLiveList && categorySelected !== "" && (
                        <option value="__custom__">{categorySelected} (custom)</option>
                      )}
                    </select>
                    <Input
                      data-testid="input-override-category"
                      value={overrides.category}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, category: e.target.value }))
                      }
                      placeholder="or type a category name"
                      className="mt-1 h-7 font-mono text-[11px]"
                    />
                    {categorySelected !== "" && !categoryInLiveList && (
                      <div
                        data-testid="warning-category-not-in-list"
                        className="mt-1 text-[10px] text-amber-500"
                      >
                        {categoriesAreLive
                          ? "Warning: this category is not in the live Jomashop category list."
                          : "Note: live categories not fetched — using fallback list."}
                      </div>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="ovr-brand" className="text-[10px] uppercase">
                      Brand
                    </Label>
                    <Input
                      id="ovr-brand"
                      data-testid="input-override-brand"
                      value={overrides.brand}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, brand: e.target.value }))
                      }
                      placeholder="e.g. Off-White"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label htmlFor="ovr-sku" className="text-[10px] uppercase">
                      SKU
                    </Label>
                    <Input
                      id="ovr-sku"
                      data-testid="input-override-sku"
                      value={overrides.sku}
                      onChange={(e) => setOverrides((o) => ({ ...o, sku: e.target.value }))}
                      placeholder="Shopify variant SKU"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label htmlFor="ovr-mfg" className="text-[10px] uppercase">
                      Manufacturer Number
                    </Label>
                    <Input
                      id="ovr-mfg"
                      data-testid="input-override-mfg"
                      value={overrides.manufacturer_number}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, manufacturer_number: e.target.value }))
                      }
                      placeholder="ff_designer_id"
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>

              <div className="rounded border border-border bg-card/40 p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Pre-flight checklist
                </div>
                <ul className="space-y-1">
                  {TOP_LEVEL_FIELDS.map((k) => {
                    const ok = overrides[k].trim() !== "";
                    return (
                      <li
                        key={k}
                        className={`flex items-center gap-2 ${ok ? "text-emerald-500" : "text-red-500"}`}
                        data-testid={`checklist-${k}`}
                      >
                        {ok ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5" />
                        )}
                        <span className="font-mono">{k}</span>
                        <span className="ml-auto truncate text-muted-foreground">
                          {ok ? overrides[k] : "blank — will be rejected"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {pushTarget.mapped.warnings.length > 0 && (
                <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-amber-500">
                  <div className="font-medium">Mapping warnings:</div>
                  <ul className="ml-4 list-disc">
                    {pushTarget.mapped.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {pushResult && (
            <div className="space-y-3 text-xs">
              <div
                className={`flex items-center gap-2 rounded border p-2 ${
                  pushResult.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-500"
                    : "border-red-500/40 bg-red-500/5 text-red-500"
                }`}
              >
                {pushResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                <span className="font-medium">
                  {pushResult.ok ? "Push succeeded" : pushResult.error || "Push failed"}
                </span>
                {pushResult.schemaSource && (
                  <Badge variant="outline" className="ml-auto text-[9px] uppercase">
                    schema: {pushResult.schemaSource}
                  </Badge>
                )}
              </div>

              {pushResult.missingRequired && pushResult.missingRequired.length > 0 && (
                <div className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500">
                  <div className="font-medium">Missing required fields:</div>
                  <ul className="ml-4 list-disc">
                    {pushResult.missingRequired.map((m, i) => (
                      <li key={i} className="font-mono">{m}</li>
                    ))}
                  </ul>
                </div>
              )}

              {pushResult.missingTopLevel && pushResult.missingTopLevel.length > 0 && (
                <div className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500">
                  <div className="font-medium">Missing top-level fields:</div>
                  <ul className="ml-4 list-disc">
                    {pushResult.missingTopLevel.map((m, i) => (
                      <li key={i} className="font-mono">{m}</li>
                    ))}
                  </ul>
                </div>
              )}

              {(pushResult.errors && pushResult.errors.length > 0) ||
              (pushResult.invalidParams && pushResult.invalidParams.length > 0) ? (
                <div className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500">
                  <div className="font-medium">Jomashop validation errors:</div>
                  {pushResult.errors && (
                    <ul className="ml-4 list-disc">
                      {pushResult.errors.map((m, i) => (
                        <li key={`e-${i}`}>{m}</li>
                      ))}
                    </ul>
                  )}
                  {pushResult.invalidParams && pushResult.invalidParams.length > 0 && (
                    <div className="mt-1 text-[10px] uppercase tracking-wider">
                      invalid_params:{" "}
                      <span className="font-mono">{pushResult.invalidParams.join(", ")}</span>
                    </div>
                  )}
                </div>
              ) : null}

              {pushResult.payloadSent && (
                <details className="rounded border border-border bg-card/40 p-2" open>
                  <summary className="cursor-pointer font-medium">Exact payload sent</summary>
                  <pre
                    className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[10px]"
                    data-testid="text-payload-sent"
                  >
                    {JSON.stringify(pushResult.payloadSent, null, 2)}
                  </pre>
                </details>
              )}

              {pushResult.product && (
                <details className="rounded border border-border bg-card/40 p-2">
                  <summary className="cursor-pointer font-medium">
                    POST /v1/products → {pushResult.product.status}
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[10px]">
                    {JSON.stringify(pushResult.product.data, null, 2)}
                  </pre>
                </details>
              )}

              {pushResult.inventory && (
                <details className="rounded border border-border bg-card/40 p-2">
                  <summary className="cursor-pointer font-medium">
                    PUT /v1/inventory → {pushResult.inventory.status} {pushResult.inventory.ok ? "ok" : "(failed)"}
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[10px]">
                    {JSON.stringify(pushResult.inventory.data ?? pushResult.inventory.error, null, 2)}
                  </pre>
                </details>
              )}

              {pushResult.payloadPreview && (
                <details className="rounded border border-border bg-card/40 p-2">
                  <summary className="cursor-pointer font-medium">Payload sent</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[10px]">
                    {JSON.stringify(pushResult.payloadPreview, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closePushModal} disabled={push.isPending}>
              {pushResult ? "Close" : "Cancel"}
            </Button>
            {!pushResult && pushTarget && (
              <Button
                onClick={() => push.mutate(pushTarget)}
                disabled={!canConfirm}
                data-testid="button-confirm-push"
              >
                {push.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-2 h-3.5 w-3.5" />
                )}
                Confirm — push to Jomashop
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Reconstruct a ShopifyProduct-shaped object from the mapped preview so the
 * push endpoint can re-run mapping with the live category schema. This is a
 * stand-in until real Shopify products are fetched via the OAuth flow.
 */
function shopifyProductFromMapped(m: MappedProduct): Record<string, unknown> {
  return {
    id: m.source.shopify_product_id,
    title: m.name,
    body_html: m.description,
    vendor: m.brand,
    product_type: m.category,
    images: m.images.map((src) => ({ src })),
    options: Object.keys(m.variants[0]?.options || {}).map((name) => ({ name, values: [] })),
    variants: m.variants.map((v, i) => ({
      id: m.source.shopify_variant_ids[i],
      sku: v.vendor_sku,
      price: v.price !== null ? String(v.price) : undefined,
      inventory_quantity: v.quantity,
      option1: Object.values(v.options)[0],
      option2: Object.values(v.options)[1],
      option3: Object.values(v.options)[2],
    })),
    metafields: [
      // Surface the commercial discount + properties so the backend mapping
      // produces the same Jomashop price and properties.
      { namespace: "custom", key: "commercial_discount", value: m.commercial_discount },
      ...Object.entries(m.properties)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => ({ namespace: "luxe", key: k, value: v as string | number })),
    ],
  };
}
