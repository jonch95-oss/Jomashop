import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, RefreshCcw, Loader2, Send, CheckCircle2, XCircle, Search } from "lucide-react";
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
import { authHeaders } from "@/lib/adminToken";
import { BulkRepairCard } from "@/components/BulkRepair";
import { CategoryMappingCard } from "@/components/CategoryMapping";
import { BrandMappingCard } from "@/components/BrandMapping";
import { ResolutionAuditCard } from "@/components/ResolutionAudit";
import { InlineFieldRepair } from "@/components/InlineFieldRepair";
import { canonicalJomashopCategory } from "@shared/schema";
import type { MappedProduct } from "@/lib/types";

type OverrideFields = {
  category: string;
  brand: string;
  sku: string;
  manufacturer_number: string;
};

const TOP_LEVEL_FIELDS = ["category", "brand", "sku", "manufacturer_number"] as const;
const PAGE_SIZE = 50;

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
  /**
   * Total number of products in the server-side cache. The `mapped` array
   * may only contain the page-sized slice currently in view; `totalCount` is
   * always the full cached catalog size so the UI can show
   * "200 shown of 3103 total" instead of "200 of 200".
   */
  totalCount?: number;
  page?: { offset: number; limit: number; hasMore: boolean };
  schemas: any;
  usingSamples?: boolean;
  shopifyConnected?: boolean;
  dataSource?: "live" | "sample";
  shopDomain?: string | null;
  fetchedCount?: number;
  pageCount?: number;
  hasMore?: boolean;
  fallbackReason?: string | null;
  fetchError?: string | null;
  liveCategoryNames?: string[] | null;
  note?: string;
  fromCache?: boolean;
  lastRefreshedAt?: number | null;
  cached?: boolean;
};

type ProductFilter =
  | "all"
  | "ready"
  | "missing"
  | "pushed"
  | "not_pushed"
  | "rejected"
  | "unresolved_brand"
  | "unresolved_category"
  | "sample";

function brandUnresolved(p: MappedProduct): boolean {
  const r = p.jomashop_resolution;
  if (!r || !r.i1_available) return false;
  return !r.manufacturer;
}

function categoryUnresolved(p: MappedProduct): boolean {
  const r = p.jomashop_resolution;
  if (!r || !r.i1_available) return false;
  return !r.category_record;
}

function missingFieldsFor(p: MappedProduct): string[] {
  const out = new Set<string>();
  for (const f of p.missing_top_level || []) {
    if (f && f !== "undefined") out.add(f);
  }
  for (const f of p.missing_required || []) {
    if (f && f !== "undefined") out.add(f);
  }
  return Array.from(out);
}

function pushStateOf(p: MappedProduct): "pushed" | "rejected" | "failed" | "not_pushed" {
  return (p.push_state as any) || "not_pushed";
}

/** Final Jomashop category as resolved (or suggested) for filtering/grouping. */
function finalJomashopCategoryOf(p: MappedProduct): string {
  const resolved = p.jomashop_resolution?.category_record?.name;
  if (resolved && resolved.trim() !== "") return resolved;
  if (p.suggested_category && p.suggested_category.trim() !== "") return p.suggested_category;
  return p.category || "";
}

function brandOf(p: MappedProduct): string {
  return (p.brand || "").trim();
}

function isReady(p: MappedProduct): boolean {
  // Server-side readiness is the single source of truth. UI just reflects it.
  return p.readiness === "ready";
}

/**
 * Compact summary of required enum fields that are blocked because Jomashop's
 * accepted option list isn't known AND no enum mapping resolves the source
 * value. Surfaced to the row button as the reason "Fix mapping for X" is
 * shown instead of "Push to Jomashop".
 */
function unresolvedRequiredEnumSummary(p: MappedProduct): string | null {
  const u = p.unverified_required_options;
  if (!Array.isArray(u) || u.length === 0) return null;
  const fields = u
    .map((entry) => entry?.field)
    .filter((f): f is string => typeof f === "string" && f.length > 0);
  if (fields.length === 0) return null;
  return fields.join(", ");
}

/**
 * True when the product should NOT be pushable from the row-level button.
 * Sample fixtures, products with missing fields, and products whose
 * Jomashop category needs verification all block the row-level push so the
 * operator must open the modal and supply overrides explicitly.
 */
function isPushBlocked(p: MappedProduct): boolean {
  if (p.is_sample) return true;
  if (p.readiness === "ready") return false;
  // "rejected" rows can still be retried via the modal; we surface them
  // through the modal flow rather than the row button so the operator has
  // to acknowledge the prior failure first.
  return true;
}

/** Human label for a property whose schema field name was missing. */
function displayPropertyKey(k: string | null | undefined): string {
  if (!k || k === "undefined" || k.trim() === "") return "needs category verification";
  return k;
}

/** Human label for a property value (avoids ever showing "undefined missing"). */
function displayPropertyValue(v: unknown): { label: string; tone: "ok" | "missing" } {
  if (v === null || v === undefined) return { label: "missing", tone: "missing" };
  if (typeof v === "string" && v.trim().toLowerCase() === "undefined") {
    return { label: "missing", tone: "missing" };
  }
  if (typeof v === "string" && v.trim() === "") return { label: "missing", tone: "missing" };
  return { label: String(v), tone: "ok" };
}

function formatTime(ts?: number | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function Products() {
  const queryClient = useQueryClient();
  const [data, setData] = useState<PreviewData | null>(null);
  const [pushTarget, setPushTarget] = useState<PushTarget | null>(null);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [brandFilter, setBrandFilter] = useState<string>("");
  const [jomashopCategoryFilter, setJomashopCategoryFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [overrides, setOverrides] = useState<OverrideFields>({
    category: "",
    brand: "",
    sku: "",
    manufacturer_number: "",
  });
  const [bulkPushing, setBulkPushing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; ok: number; failed: number } | null>(null);

  // On mount: try to render from cache (instant). Only refresh from Shopify
  // when the user clicks "Refresh from Shopify". We pass ?limit=all so the
  // UI receives the entire compact catalog and can render correct totals,
  // filter counts, and pagination over the full dataset — not just the
  // server-default 200-row slice.
  const cacheQ = useQuery<PreviewData & { cached?: boolean }>({
    queryKey: ["/api/products/cache", "all"],
    queryFn: async () => {
      // Must include the admin token header — in production the
      // requireAdminToken middleware returns 503/401 for unauthenticated
      // /api/* hits, which previously blanked out the Products page.
      const res = await fetch("/api/products/cache?limit=all", {
        credentials: "include",
        headers: authHeaders(),
      });
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (cacheQ.data && (cacheQ.data.cached === true || Array.isArray((cacheQ.data as any).mapped))) {
      setData(cacheQ.data);
    }
  }, [cacheQ.data]);

  const categoriesQ = useQuery<{
    source: "live" | "fallback";
    categories?: Array<{ name: string }>;
    data?: unknown;
  }>({
    queryKey: ["/api/jomashop/categories"],
    refetchOnWindowFocus: false,
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

  const refresh = useMutation({
    mutationFn: async () => {
      // Ask the server to return the full mapped catalog in the response so
      // the page renders the complete product list immediately after a
      // refresh, not just the first 200 rows.
      const res = await apiRequest("POST", "/api/products/refresh", {
        responseLimit: "all",
      });
      return res.json();
    },
    onSuccess: (d: PreviewData) => {
      setData(d);
      queryClient.invalidateQueries({ queryKey: ["/api/products/cache"] });
      queryClient.invalidateQueries({ queryKey: ["/api/push-statuses"] });
    },
  });

  const saveBrandOverride = useMutation({
    mutationFn: async (args: { shopify_brand: string; jomashop_brand: string }) => {
      const res = await apiRequest("POST", "/api/brand-mapping/overrides", {
        shopify_brand: args.shopify_brand,
        jomashop_brand: args.jomashop_brand,
      });
      return (await res.json()) as { ok: boolean; error?: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand-mapping/overrides"] });
    },
  });

  const createManufacturer = useMutation({
    mutationFn: async (args: { name: string }) => {
      const res = await apiRequest("POST", "/api/jomashop/manufacturers", {
        name: args.name,
        confirm: true,
      });
      return (await res.json()) as { ok: boolean; error?: string; data?: unknown };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jomashop/manufacturers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/products/cache"] });
    },
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
    onSuccess: (r, target) => {
      setPushResult(r);
      // Optimistically flip the row to "pushed" so the product immediately
      // moves out of the "Not pushed" filter without waiting for the cache
      // refetch round-trip. The cache endpoint will then overlay the
      // persisted push_status on its next fetch and confirm the state.
      if (r && r.ok) {
        const vendorSku = target.variantSku || target.mapped.vendor_sku || target.mapped.sku || "";
        const jomashopSku = (r as any)?.payloadPreview?.vendor_sku ?? (r as any)?.payloadPreview?.sku ?? vendorSku;
        setData((prev) => {
          if (!prev || !Array.isArray((prev as any).mapped)) return prev;
          const nextMapped = (prev as any).mapped.map((row: any) => {
            if (String(row.vendor_sku) !== String(vendorSku)) return row;
            return {
              ...row,
              push_state: "pushed",
              jomashop_sku: jomashopSku,
              last_push_error: null,
              last_pushed_at: Date.now(),
              last_invalid_params: null,
              last_rejected_category: null,
              last_rejected_brand: null,
            };
          });
          return { ...(prev as any), mapped: nextMapped };
        });
      }
      // Refetch cache so the overlay (push_statuses joined onto cached
      // payload) takes effect, and refresh the dedicated push-statuses
      // endpoint used by other panels.
      queryClient.invalidateQueries({ queryKey: ["/api/products/cache"] });
      queryClient.refetchQueries({ queryKey: ["/api/products/cache"] });
      queryClient.invalidateQueries({ queryKey: ["/api/push-statuses"] });
    },
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

  // Bulk push the currently-filtered products. Scope is exactly what's
  // visible after brand/category/status/search filters — so operators can
  // narrow with the filter chips, eyeball the list, then push the whole
  // visible set. Walks the existing single-push endpoint sequentially so
  // we don't introduce a new server route and the per-product behaviour
  // (overrides defaulted from mapping, schema verification, inventory
  // sync) stays identical to a row-level push.
  async function runBulkPush() {
    if (bulkPushing) return;
    const targets = filteredProducts.filter((p) => !isPushBlocked(p));
    if (targets.length === 0) return;
    if (typeof window !== "undefined") {
      const scopeParts: string[] = [];
      if (brandFilter) scopeParts.push(`brand="${brandFilter}"`);
      if (jomashopCategoryFilter) scopeParts.push(`Jomashop category="${jomashopCategoryFilter}"`);
      const scopeLabel = scopeParts.length > 0 ? ` (${scopeParts.join(", ")})` : "";
      if (!window.confirm(`Push ${targets.length} product(s) to Jomashop${scopeLabel}?`)) return;
    }
    setBulkPushing(true);
    setBulkProgress({ done: 0, total: targets.length, ok: 0, failed: 0 });
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const p = targets[i];
      try {
        const res = await apiRequest("POST", "/api/jomashop/push-product", {
          confirm: true,
          pushInventory: true,
          product: shopifyProductFromMapped(p),
          overrides: {
            category: (p.suggested_category || p.category || "").trim(),
            brand: (p.brand || "").trim(),
            sku: (p.sku || p.vendor_sku || "").trim(),
            manufacturer_number: (p.manufacturer_number || p.sku || p.vendor_sku || "").trim(),
          },
        });
        const body = await res.json().catch(() => ({ ok: false }));
        if (body && body.ok) ok += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
      setBulkProgress({ done: i + 1, total: targets.length, ok, failed });
    }
    setBulkPushing(false);
    queryClient.invalidateQueries({ queryKey: ["/api/products/cache"] });
    queryClient.refetchQueries({ queryKey: ["/api/products/cache"] });
    queryClient.invalidateQueries({ queryKey: ["/api/push-statuses"] });
  }

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

  // Unique brand + final Jomashop category lists derived from the loaded
  // catalog. Used to populate the new filter dropdowns.
  const brandOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of data?.mapped ?? []) {
      const b = brandOf(p);
      if (b) set.add(b);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data]);

  const jomashopCategoryOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of data?.mapped ?? []) {
      const c = finalJomashopCategoryOf(p);
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data]);

  // Apply only the brand + final Jomashop category scope. The status-filter
  // counts are then derived from this scoped subset so they stay consistent
  // with what the user actually sees.
  const scopedProducts = useMemo<MappedProduct[]>(() => {
    const mapped = data?.mapped ?? [];
    const b = brandFilter.trim().toLowerCase();
    const c = jomashopCategoryFilter.trim().toLowerCase();
    if (b === "" && c === "") return mapped;
    return mapped.filter((p) => {
      if (b !== "" && brandOf(p).toLowerCase() !== b) return false;
      if (c !== "" && finalJomashopCategoryOf(p).toLowerCase() !== c) return false;
      return true;
    });
  }, [data, brandFilter, jomashopCategoryFilter]);

  const filterCounts = useMemo(() => {
    const mapped = scopedProducts;
    const counts = {
      all: mapped.length,
      ready: 0,
      missing: 0,
      pushed: 0,
      not_pushed: 0,
      rejected: 0,
      unresolved_brand: 0,
      unresolved_category: 0,
      sample: 0,
    };
    for (const p of mapped) {
      if (p.is_sample) counts.sample += 1;
      const miss = missingFieldsFor(p);
      const state = pushStateOf(p);
      if (state === "pushed") counts.pushed += 1;
      else if (state === "rejected" || state === "failed") counts.rejected += 1;
      else if (!p.is_sample) counts.not_pushed += 1;
      if (isReady(p)) counts.ready += 1;
      else if (miss.length > 0 && !p.is_sample) counts.missing += 1;
      if (!p.is_sample && brandUnresolved(p)) counts.unresolved_brand += 1;
      if (!p.is_sample && categoryUnresolved(p)) counts.unresolved_category += 1;
    }
    return counts;
  }, [scopedProducts]);

  // Memoize the filter+search results so each keystroke doesn't re-walk the
  // whole list when there are thousands of products.
  const filteredProducts = useMemo<MappedProduct[]>(() => {
    const mapped = scopedProducts;
    const q = query.trim().toLowerCase();
    return mapped.filter((p) => {
      if (q !== "") {
        const haystack = [
          p.name,
          p.brand,
          p.vendor_sku,
          p.sku,
          p.manufacturer_number,
          ...(p.variants?.map((v) => v.vendor_sku) ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      const miss = missingFieldsFor(p);
      const state = pushStateOf(p);
      if (filter === "all") return true;
      if (filter === "ready") return isReady(p);
      if (filter === "missing") return miss.length > 0 && !p.is_sample;
      if (filter === "pushed") return state === "pushed";
      if (filter === "not_pushed") return state === "not_pushed" && !p.is_sample;
      if (filter === "rejected") return state === "rejected" || state === "failed";
      if (filter === "unresolved_brand") return !p.is_sample && brandUnresolved(p);
      if (filter === "unresolved_category") return !p.is_sample && categoryUnresolved(p);
      if (filter === "sample") return p.is_sample === true;
      return true;
    });
  }, [scopedProducts, filter, query]);

  // Reset to page 0 whenever filter or search changes.
  useEffect(() => {
    setPage(0);
  }, [filter, query, data, brandFilter, jomashopCategoryFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));
  const pageProducts = useMemo(
    () => filteredProducts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filteredProducts, page],
  );

  const categorySelected = overrides.category.trim();
  const categoryInLiveList =
    categorySelected !== "" &&
    categoryOptions.some(
      (c) => c.toLowerCase() === categorySelected.toLowerCase(),
    );
  const categoriesAreLive = (categoriesQ.data as any)?.source === "live";

  const banner = data && (
    <div
      data-testid="banner-data-source"
      className={`rounded-md border p-3 text-xs ${
        data.dataSource === "live"
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 font-medium">
        {data.dataSource === "live" ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5" />
        )}
        <span data-testid="text-data-source">
          Data source: {data.dataSource === "live" ? "LIVE SHOPIFY" : "SAMPLE FALLBACK"}
        </span>
        {data.shopDomain && (
          <span data-testid="text-shop-domain" className="font-mono text-[11px] opacity-80">
            · {data.shopDomain}
          </span>
        )}
        {typeof data.fetchedCount === "number" && data.fetchedCount > 0 && (
          <span className="text-[11px] opacity-80" data-testid="text-fetched-count">
            · {data.fetchedCount} product{data.fetchedCount === 1 ? "" : "s"}
            {typeof data.pageCount === "number" && data.pageCount > 0
              ? ` across ${data.pageCount} page${data.pageCount === 1 ? "" : "s"}`
              : ""}
            {typeof data.totalCount === "number" &&
            typeof data.mapped?.length === "number" &&
            data.totalCount > data.mapped.length
              ? ` · ${data.mapped.length} of ${data.totalCount} shown`
              : ""}
            {data.hasMore ? " · more available" : data.dataSource === "live" ? " · complete" : ""}
          </span>
        )}
        <span className="text-[11px] opacity-80" data-testid="text-last-refreshed">
          · Last refreshed {formatTime(data.lastRefreshedAt)}
          {data.fromCache ? " (cached)" : ""}
        </span>
        <span className="ml-auto text-[11px] opacity-70">
          Shopify {data.shopifyConnected ? "connected" : "not connected"}
        </span>
      </div>
      {data.fetchError && (
        <div data-testid="text-fetch-error" className="mt-1 text-[11px] text-red-500">
          Fetch error: {data.fetchError}
        </div>
      )}
      {data.fallbackReason && data.dataSource === "sample" && (
        <div className="mt-1 text-[11px] opacity-80">{data.fallbackReason}</div>
      )}
    </div>
  );

  const filters: Array<{ key: ProductFilter; label: string; count: number }> = [
    { key: "all", label: "All", count: filterCounts.all },
    { key: "ready", label: "Ready to push", count: filterCounts.ready },
    { key: "missing", label: "Missing required", count: filterCounts.missing },
    { key: "pushed", label: "Pushed", count: filterCounts.pushed },
    { key: "not_pushed", label: "Not pushed", count: filterCounts.not_pushed },
    { key: "rejected", label: "Rejected / Needs fix", count: filterCounts.rejected },
    { key: "unresolved_brand", label: "Unresolved brand", count: filterCounts.unresolved_brand },
    {
      key: "unresolved_category",
      label: "Unresolved category",
      count: filterCounts.unresolved_category,
    },
  ];
  if (filterCounts.sample > 0) {
    filters.push({ key: "sample", label: "Sample only", count: filterCounts.sample });
  }

  return (
    <>
      <PageHeader
        title="Products"
        description="Preview Shopify → Jomashop product mapping, then push one when ready. Initial load uses the cached preview — click Refresh from Shopify to re-paginate."
        actions={
          <Button
            data-testid="button-refresh-from-shopify"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            variant="outline"
            size="sm"
          >
            {refresh.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="mr-2 h-3.5 w-3.5" />}
            Refresh from Shopify
          </Button>
        }
      />

      {cacheQ.isLoading && !data ? (
        <LoadingRows count={3} />
      ) : !data ? (
        <EmptyState
          title="No cached preview yet"
          description="Click Refresh from Shopify to paginate all products and cache the result for fast page loads."
        />
      ) : (
        <div className="space-y-4">
          {banner}

          <ResolutionAuditCard onAfterApply={() => refresh.mutate()} />

          <CategoryMappingCard onAfterApply={() => refresh.mutate()} />

          <BrandMappingCard onAfterApply={() => refresh.mutate()} />

          <BulkRepairCard onAfterApply={() => refresh.mutate()} />

          <div className="rounded-md border border-border bg-card/40 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Search title, SKU, brand
                </Label>
                <div className="relative mt-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    data-testid="input-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search…"
                    className="h-8 pl-7 text-xs"
                  />
                </div>
              </div>
              <div className="min-w-[180px]">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Brand
                </Label>
                <select
                  data-testid="select-filter-brand"
                  value={brandFilter}
                  onChange={(e) => setBrandFilter(e.target.value)}
                  className="mt-1 flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">All brands</option>
                  {brandOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-[180px]">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Final Jomashop category
                </Label>
                <select
                  data-testid="select-filter-jomashop-category"
                  value={jomashopCategoryFilter}
                  onChange={(e) => setJomashopCategoryFilter(e.target.value)}
                  className="mt-1 flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="">All categories</option>
                  {jomashopCategoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              {(brandFilter || jomashopCategoryFilter) && (
                <Button
                  data-testid="button-clear-brand-category-filters"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-[11px]"
                  onClick={() => {
                    setBrandFilter("");
                    setJomashopCategoryFilter("");
                  }}
                >
                  Clear
                </Button>
              )}
              <div className="text-[11px] text-muted-foreground" data-testid="text-filtered-count">
                {(() => {
                  // `filterCounts.all` reflects what's loaded in the
                  // browser; `totalCount` reflects the full cached catalog
                  // on the server. When they differ (e.g. the server clipped
                  // a slice), surface both so operators don't misread a
                  // 200-row page as "only 200 products exist".
                  const shown = filteredProducts.length;
                  const loaded = filterCounts.all;
                  const total = typeof data?.totalCount === "number" ? data.totalCount : loaded;
                  if (total > loaded) {
                    return `${shown} match${shown === 1 ? "" : "es"} of ${loaded} loaded · ${total} total in cache`;
                  }
                  return `${shown} match${shown === 1 ? "" : "es"} of ${loaded} total`;
                })()}
              </div>
            </div>

            <div
              data-testid="bulk-push-controls"
              className="mt-2 flex flex-wrap items-center gap-2 rounded border border-dashed border-border bg-card/30 p-2 text-xs"
            >
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Bulk push
              </span>
              {(() => {
                const eligible = filteredProducts.filter((p) => !isPushBlocked(p)).length;
                return (
                  <span className="text-[11px] text-muted-foreground" data-testid="text-bulk-push-scope">
                    {eligible} of {filteredProducts.length} filtered product(s) ready to push
                  </span>
                );
              })()}
              <Button
                data-testid="button-bulk-push-filtered"
                size="sm"
                variant="default"
                className="ml-auto h-7 text-[11px]"
                onClick={() => runBulkPush()}
                disabled={
                  bulkPushing ||
                  filteredProducts.filter((p) => !isPushBlocked(p)).length === 0
                }
                title="Push every ready product matching the current brand, category, status, and search filters."
              >
                {bulkPushing ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-2 h-3.5 w-3.5" />
                )}
                {bulkPushing && bulkProgress
                  ? `Pushing ${bulkProgress.done}/${bulkProgress.total}…`
                  : `Push filtered (${filteredProducts.filter((p) => !isPushBlocked(p)).length})`}
              </Button>
              {bulkProgress && !bulkPushing && (
                <span
                  data-testid="text-bulk-push-result"
                  className={`text-[11px] ${
                    bulkProgress.failed === 0 ? "text-emerald-500" : "text-amber-500"
                  }`}
                >
                  Bulk push: {bulkProgress.ok} ok / {bulkProgress.failed} failed
                </span>
              )}
            </div>

            <div
              data-testid="product-filter-controls"
              className="mt-2 flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Filter
              </span>
              {filters.map((f) => (
                <Button
                  key={f.key}
                  data-testid={`button-filter-${f.key}`}
                  size="sm"
                  variant={filter === f.key ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  <Badge variant="outline" className="ml-2 h-4 px-1 font-mono text-[9px] tabular-nums">
                    {f.count}
                  </Badge>
                </Button>
              ))}
            </div>
          </div>

          {filteredProducts.length === 0 ? (
            <EmptyState
              title="No products match this filter"
              description="Try the All filter or clear the search."
            />
          ) : (
            <>
              {pageProducts.map((p) => {
                const idx = data.mapped.indexOf(p);
                const missing = missingFieldsFor(p);
                const state = pushStateOf(p);
                return (
                  <Card
                    key={`${p.vendor_sku}-${p.source.shopify_product_id}`}
                    data-testid={`card-product-${p.vendor_sku}`}
                    className={p.is_sample ? "border-amber-500/40" : undefined}
                  >
                    <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-sm">{p.name}</CardTitle>
                        <Badge variant="outline" className="text-[10px] uppercase">{p.category}</Badge>
                        {state === "pushed" && (
                          <Badge
                            data-testid={`badge-pushed-${p.vendor_sku}`}
                            variant="outline"
                            className="bg-emerald-500/15 text-[10px] uppercase text-emerald-700 dark:text-emerald-400"
                            title={p.last_pushed_at ? `Pushed ${formatTime(p.last_pushed_at)}` : undefined}
                          >
                            Pushed
                          </Badge>
                        )}
                        {state === "rejected" && (
                          <Badge
                            data-testid={`badge-rejected-${p.vendor_sku}`}
                            variant="outline"
                            className="bg-red-500/15 text-[10px] uppercase text-red-700 dark:text-red-400"
                            title={p.last_push_error || "Last push was rejected"}
                          >
                            Rejected / Needs fix
                          </Badge>
                        )}
                        {state === "failed" && (
                          <Badge
                            variant="outline"
                            className="bg-red-500/15 text-[10px] uppercase text-red-700 dark:text-red-400"
                            title={p.last_push_error || "Last push failed"}
                          >
                            Push failed
                          </Badge>
                        )}
                        {state === "not_pushed" && !p.is_sample && (
                          <Badge
                            data-testid={`badge-not-pushed-${p.vendor_sku}`}
                            variant="outline"
                            className="text-[10px] uppercase"
                          >
                            Not pushed
                          </Badge>
                        )}
                        {p.readiness === "needs-category-verification" && (
                          <Badge
                            variant="outline"
                            className="bg-amber-500/15 text-[10px] uppercase text-amber-700 dark:text-amber-400"
                            title="Live Jomashop category list unavailable — verify before pushing"
                          >
                            Needs category verification
                          </Badge>
                        )}
                        {missing.length > 0 && (
                          <Badge
                            data-testid={`badge-missing-${p.vendor_sku}`}
                            variant="outline"
                            className="bg-red-500/10 text-[10px] uppercase text-red-600 dark:text-red-400"
                            title={`Missing: ${missing.join(", ")}`}
                          >
                            Missing: {missing.join(", ")}
                          </Badge>
                        )}
                        {p.is_sample && (
                          <Badge
                            data-testid={`badge-sample-${p.vendor_sku}`}
                            className="bg-amber-500/15 text-[10px] uppercase text-amber-700 dark:text-amber-400"
                            variant="outline"
                          >
                            Sample — push disabled
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
                          disabled={isPushBlocked(p)}
                          title={
                            p.is_sample
                              ? "Sample/demo product — cannot be pushed"
                              : p.readiness === "ready"
                                ? undefined
                                : unresolvedRequiredEnumSummary(p)
                                  ? `Fix mapping for ${unresolvedRequiredEnumSummary(p)} — Jomashop accepted option list unknown. Open the product to add a mapping.`
                                  : "Fix mapping first — required fields, category, or schema missing"
                          }
                        >
                          <Send className="mr-2 h-3.5 w-3.5" />
                          {p.is_sample
                            ? "Push disabled (sample)"
                            : p.readiness !== "ready"
                              ? unresolvedRequiredEnumSummary(p)
                                ? `Fix mapping for ${unresolvedRequiredEnumSummary(p)}`
                                : "Fix mapping first"
                              : state === "pushed"
                                ? "Update on Jomashop"
                                : "Push to Jomashop"}
                        </Button>
                      </div>
                    </CardHeader>
                    {!p.is_sample &&
                      p.source.shopify_product_id !== undefined &&
                      p.source.shopify_product_id !== null &&
                      (missing.length > 0 ||
                        (Array.isArray(p.unverified_required_options) &&
                          p.unverified_required_options.length > 0) ||
                        (Array.isArray(p.invalid_enums) && p.invalid_enums.length > 0) ||
                        // Also surface the inline repair panel when there are
                        // recommended/optional category attributes that are
                        // currently missing — operators can fill them inline
                        // without having to leave the page or run the bulk
                        // Excel workflow.
                        Object.entries(p.properties).some(([k, v]) => {
                          if (!k || k === "undefined") return false;
                          if (v === null || v === undefined) return true;
                          if (typeof v === "string") {
                            const s = v.trim().toLowerCase();
                            if (s === "" || s === "undefined") return true;
                          }
                          return false;
                        })) && (
                        <details
                          className="border-b border-card-border bg-amber-500/[0.04] p-4"
                          data-testid={`details-inline-repair-${p.vendor_sku}`}
                        >
                          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                            Repair missing Jomashop fields ({missing.length})
                            <span className="text-[11px] font-normal text-muted-foreground">
                              — fill the required fields below and save without leaving the page
                            </span>
                          </summary>
                          <div className="mt-3">
                            <InlineFieldRepair
                              productId={String(p.source.shopify_product_id)}
                              missingFields={missing}
                              onSaved={(result) => {
                                // The backend returns the remapped product on
                                // postRepair.product. Splice it directly into
                                // the visible list so the card re-renders with
                                // the freshly-derived properties, warnings,
                                // missing_required, readiness, etc. — without
                                // waiting for a full /api/products/refresh.
                                const remapped = result?.postRepair?.product as
                                  | MappedProduct
                                  | undefined;
                                if (remapped) {
                                  setData((prev) => {
                                    if (!prev || !Array.isArray(prev.mapped)) return prev;
                                    const targetPid = String(
                                      p.source.shopify_product_id,
                                    );
                                    const nextMapped = prev.mapped.map((row) => {
                                      const pid = String(
                                        row?.source?.shopify_product_id ?? "",
                                      );
                                      return pid === targetPid ? remapped : row;
                                    });
                                    return { ...prev, mapped: nextMapped };
                                  });
                                }
                                // Invalidate cache + push-status queries so a
                                // subsequent page refresh re-derives readiness
                                // with the new metafield values.
                                queryClient.invalidateQueries({
                                  queryKey: ["/api/products/cache"],
                                });
                                queryClient.invalidateQueries({
                                  queryKey: ["/api/push-statuses"],
                                });
                              }}
                              onSaveAndPush={() => {
                                openPushModal(idx, p);
                              }}
                            />
                          </div>
                        </details>
                      )}
                    <CardContent className="grid grid-cols-1 gap-4 p-5 md:grid-cols-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Brand / Designer</div>
                        <div className="mt-1 text-sm" data-testid={`text-brand-${p.vendor_sku}`}>
                          {p.brand || "—"}
                        </div>
                        {p.manufacturer_number && (
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            Designer Id: <code className="font-mono text-[11px]">{p.manufacturer_number}</code>
                          </div>
                        )}
                        <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">Category mapping</div>
                        <div className="mt-1 space-y-0.5 text-[11px]">
                          <div>
                            <span className="text-muted-foreground">Shopify code: </span>
                            <code className="font-mono">{p.raw_category || "—"}</code>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Suggested: </span>
                            <code className="font-mono">{p.suggested_category || p.category}</code>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Jomashop category: </span>
                            {p.jomashop_resolution?.category_record ? (
                              <code
                                className="font-mono text-emerald-600 dark:text-emerald-400"
                                data-testid={`text-jomashop-category-${p.vendor_sku}`}
                              >
                                {p.jomashop_resolution.category_record.name} (id:{" "}
                                {String(p.jomashop_resolution.category_record.id)})
                              </code>
                            ) : p.readiness === "ready" ? (
                              <code
                                className="font-mono text-emerald-600 dark:text-emerald-400"
                                data-testid={`text-jomashop-category-${p.vendor_sku}`}
                              >
                                {p.suggested_category || p.category}
                              </code>
                            ) : (() => {
                              // When the live category schema loaded under a
                              // canonical alias (e.g. "Clothing" → "Apparel"
                              // resolves the live Apparel schema), don't show
                              // the confusing "not found in /i1/categories:
                              // Clothing" message — display the canonical
                              // name instead so the operator can see the
                              // alias is doing its job.
                              const canonical = canonicalJomashopCategory(p.category) as string;
                              const aliased = canonical !== p.category;
                              const schemaIsLive =
                                p.schema_source === "live-i1" || p.schema_source === "live-v1";
                              if (aliased && schemaIsLive) {
                                return (
                                  <code
                                    className="font-mono text-emerald-600 dark:text-emerald-400"
                                    data-testid={`text-jomashop-category-alias-${p.vendor_sku}`}
                                    title={`Shopify code "${p.category}" maps to canonical Jomashop category "${canonical}" — live schema loaded.`}
                                  >
                                    {canonical}{" "}
                                    <span className="text-[10px] text-muted-foreground">
                                      (alias of {p.category})
                                    </span>
                                  </code>
                                );
                              }
                              return (
                                <span
                                  className="font-mono text-amber-600 dark:text-amber-400"
                                  data-testid={`text-jomashop-category-needs-verify-${p.vendor_sku}`}
                                >
                                  {p.ambiguous_category
                                    ? "needs verification (ambiguous code)"
                                    : p.jomashop_resolution?.i1_available
                                      ? `not found in /i1/categories: ${p.jomashop_resolution.outbound_category || p.category}`
                                      : p.readiness === "needs-category-verification"
                                        ? "needs verification (no schema loaded)"
                                        : "needs verification"}
                                </span>
                              );
                            })()}
                          </div>
                          {p.jomashop_resolution && p.jomashop_resolution.i1_available && (
                            <div>
                              <span className="text-muted-foreground">Jomashop brand: </span>
                              {p.jomashop_resolution.manufacturer ? (
                                <code
                                  className="font-mono text-emerald-600 dark:text-emerald-400"
                                  data-testid={`text-jomashop-brand-${p.vendor_sku}`}
                                >
                                  {p.jomashop_resolution.manufacturer.name} (id:{" "}
                                  {String(p.jomashop_resolution.manufacturer.id)})
                                </code>
                              ) : (
                                <span
                                  className="font-mono text-amber-600 dark:text-amber-400"
                                  data-testid={`text-jomashop-brand-missing-${p.vendor_sku}`}
                                >
                                  Brand "{p.jomashop_resolution.outbound_brand || p.brand}" not found in Jomashop manufacturers
                                  {p.jomashop_resolution.manufacturer_suggestion && (
                                    <>
                                      {" "}— did you mean "
                                      {p.jomashop_resolution.manufacturer_suggestion.name}"?
                                    </>
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Shopify price</div>
                        <div className="mt-1 text-sm tabular-nums">
                          {p.price !== null ? `$${p.price.toFixed(2)}` : "—"}
                          {p.msrp && (
                            <span className="ml-2 text-xs text-muted-foreground line-through">${p.msrp.toFixed(2)}</span>
                          )}
                        </div>
                        <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">MSRP (list price)</div>
                        <div
                          className="mt-1 text-sm tabular-nums"
                          data-testid={`text-msrp-${p.vendor_sku}`}
                        >
                          {p.msrp !== null && p.msrp !== undefined ? `$${p.msrp.toFixed(2)}` : "—"}
                          {p.msrp_source && p.msrp_source !== "none" && (
                            <span
                              className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                              data-testid={`text-msrp-source-${p.vendor_sku}`}
                            >
                              source:{" "}
                              {p.msrp_source === "variant_compare_at_price"
                                ? "compare_at_price"
                                : p.msrp_source === "metafield"
                                  ? `metafield (${p.msrp_metafield_key ?? "?"})`
                                  : p.msrp_source === "shopify_price_fallback"
                                    ? "shopify price (no MSRP set)"
                                    : p.msrp_source}
                            </span>
                          )}
                        </div>
                        <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Jomashop price</div>
                        <div className="mt-1 text-sm font-medium tabular-nums">
                          {p.jomashop_price !== null ? `$${p.jomashop_price.toFixed(2)}` : "—"}
                        </div>
                        {p.last_push_error && (
                          <div className="mt-3 text-[10px] uppercase tracking-wider text-red-500">
                            Last push error
                          </div>
                        )}
                        {p.last_push_error && (
                          <div
                            className="mt-1 break-words text-[11px] text-red-500"
                            data-testid={`text-last-push-error-${p.vendor_sku}`}
                          >
                            {p.last_push_error}
                          </div>
                        )}
                        {(state === "rejected" || state === "failed") &&
                          (p.last_rejected_category ||
                            p.last_rejected_brand ||
                            (p.last_invalid_params && p.last_invalid_params.length > 0)) && (
                          <div
                            data-testid={`block-rejected-details-${p.vendor_sku}`}
                            className="mt-2 rounded border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-600 dark:text-red-400"
                          >
                            <div className="font-medium">Jomashop rejected this push.</div>
                            {p.last_rejected_category && (
                              <div className="mt-0.5">
                                Category sent:{" "}
                                <code className="font-mono">{p.last_rejected_category}</code>
                                {p.last_invalid_params?.includes("category") && (
                                  <span className="ml-1 text-[10px] uppercase">(invalid)</span>
                                )}
                              </div>
                            )}
                            {p.last_rejected_brand && (
                              <div className="mt-0.5">
                                Brand sent:{" "}
                                <code className="font-mono">{p.last_rejected_brand}</code>
                                {p.last_invalid_params?.includes("brand") && (
                                  <span className="ml-1 text-[10px] uppercase">(invalid)</span>
                                )}
                              </div>
                            )}
                            <div className="mt-1 text-[10px] opacity-80">
                              Open the push modal and supply an exact category and/or brand
                              override. Save the brand in the Brand mapping card above to apply
                              it to all matching products.
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="md:col-span-2">
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Category properties</div>
                          {p.schema_source && p.schema_source !== "none" && (
                            <div
                              className={`text-[10px] uppercase tracking-wider ${
                                p.schema_source === "fallback"
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-emerald-600 dark:text-emerald-400"
                              }`}
                              data-testid={`text-schema-source-${p.vendor_sku}`}
                              title={
                                p.schema_source === "fallback"
                                  ? "Live Jomashop category schema unavailable — using bundled exact-label fallback schema."
                                  : "Using the live Jomashop category schema."
                              }
                            >
                              Schema: {p.schema_source === "fallback" ? "fallback (bundled)" : "live"}
                            </div>
                          )}
                        </div>
                        {(() => {
                          const propEntries = Object.entries(p.properties).filter(
                            ([k]) => k && k !== "undefined",
                          );
                          const schemaFields = (p.schema_fields ?? []).filter(
                            (f) => f && f.field && f.field !== "undefined",
                          );
                          if (propEntries.length === 0 && schemaFields.length === 0) {
                            return (
                              <div
                                className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400"
                                data-testid={`text-no-schema-${p.vendor_sku}`}
                              >
                                No Jomashop schema loaded for this category — needs category verification.
                              </div>
                            );
                          }
                          // Build a union of schema-declared fields and any
                          // values present in p.properties so the panel always
                          // renders the expected category shape — even when
                          // the Shopify product is missing values.
                          const seen = new Set<string>();
                          const rows: Array<{ field: string; value: unknown; required: boolean }> = [];
                          for (const f of schemaFields) {
                            seen.add(f.field);
                            rows.push({
                              field: f.field,
                              value: (p.properties as Record<string, unknown>)[f.field],
                              required: f.required,
                            });
                          }
                          for (const [k, v] of propEntries) {
                            if (seen.has(k)) continue;
                            rows.push({ field: k, value: v, required: false });
                          }
                          return (
                            <div className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-2">
                              {rows.map(({ field, value, required }) => {
                                const display = displayPropertyValue(value);
                                const isMissing = display.tone === "missing";
                                return (
                                  <div
                                    key={field}
                                    className="flex items-center justify-between rounded border border-border bg-card/40 px-2.5 py-1.5 text-xs"
                                  >
                                    <span className="font-mono text-muted-foreground">
                                      {displayPropertyKey(field)}
                                      {required && (
                                        <span
                                          className="ml-1 text-[10px] uppercase text-amber-500/80"
                                          title="Required by the Jomashop category schema"
                                        >
                                          *
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      className={`ml-2 truncate font-mono ${isMissing ? "text-amber-500/80" : ""}`}
                                    >
                                      {display.label}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
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
                                <tr key={v.vendor_sku} className="border-t border-border">
                                  <td className="px-3 py-1.5 font-mono">{v.vendor_sku}</td>
                                  <td className="px-3 py-1.5 text-muted-foreground">
                                    {Object.entries(v.options ?? {}).map(([k, val]) => `${k}: ${val}`).join(" • ") || "—"}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">
                                    {v.price !== null ? `$${v.price.toFixed(2)}` : "—"}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-medium tabular-nums">
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
                                      onClick={() => openPushModal(idx, p, v.vendor_sku)}
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 px-2 text-[10px]"
                                      disabled={isPushBlocked(p)}
                                      title={
                                        p.is_sample
                                          ? "Sample/demo — cannot be pushed"
                                          : p.readiness === "ready"
                                            ? undefined
                                            : "Parent not ready — fix mapping first"
                                      }
                                    >
                                      <Send className="mr-1 h-3 w-3" />
                                      {p.is_sample
                                        ? "Disabled"
                                        : p.readiness !== "ready"
                                          ? "Fix first"
                                          : state === "pushed"
                                            ? "Update"
                                            : "Push"}
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {p.debug_raw && (
                        <div className="md:col-span-3">
                          <details className="rounded border border-border bg-card/30 text-[11px]">
                            <summary
                              className="cursor-pointer select-none px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                              data-testid={`toggle-debug-${p.vendor_sku}`}
                            >
                              Raw Shopify data (metafields, options, variants)
                            </summary>
                            <div className="space-y-3 px-3 pb-3 pt-1">
                              <div>
                                <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                                  Metafields ({p.debug_raw.metafields.length})
                                </div>
                                {p.debug_raw.metafields.length === 0 ? (
                                  <div className="mt-1 text-muted-foreground">
                                    No metafields returned by Shopify.
                                  </div>
                                ) : (
                                  <div className="mt-1 overflow-hidden rounded border border-border">
                                    <table className="w-full font-mono text-[10px]">
                                      <thead className="bg-card/60 text-[9px] uppercase text-muted-foreground">
                                        <tr>
                                          <th className="px-2 py-1 text-left">namespace.key</th>
                                          <th className="px-2 py-1 text-left">name/label</th>
                                          <th className="px-2 py-1 text-left">value</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {p.debug_raw.metafields.map((m, i) => (
                                          <tr key={i} className="border-t border-border">
                                            <td className="px-2 py-1">
                                              {(m.namespace ?? "")}
                                              {m.namespace ? "." : ""}
                                              {m.key ?? ""}
                                            </td>
                                            <td className="px-2 py-1 text-muted-foreground">
                                              {m.name || m.label || "—"}
                                            </td>
                                            <td className="px-2 py-1 break-all">
                                              {m.value || "—"}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                              <div>
                                <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                                  Product options
                                </div>
                                {p.debug_raw.options.length === 0 ? (
                                  <div className="mt-1 text-muted-foreground">No options.</div>
                                ) : (
                                  <ul className="mt-1 space-y-0.5 font-mono">
                                    {p.debug_raw.options.map((o, i) => (
                                      <li key={i}>
                                        <span className="text-muted-foreground">{o.name}:</span>{" "}
                                        {o.values.join(" / ")}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              <div>
                                <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                                  Variant selected options
                                </div>
                                {p.debug_raw.variants.length === 0 ? (
                                  <div className="mt-1 text-muted-foreground">No variants.</div>
                                ) : (
                                  <ul className="mt-1 space-y-0.5 font-mono">
                                    {p.debug_raw.variants.map((v, i) => (
                                      <li key={i}>
                                        <span className="text-muted-foreground">
                                          {v.sku || `variant-${i + 1}`}:
                                        </span>{" "}
                                        {Object.keys(v.options).length === 0
                                          ? "—"
                                          : Object.entries(v.options)
                                              .map(([k, val]) => `${k}=${val}`)
                                              .join(" • ")}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </details>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              {pageCount > 1 && (
                <div className="flex items-center justify-between rounded-md border border-border bg-card/40 p-2 text-xs">
                  <span className="text-muted-foreground">
                    Page {page + 1} of {pageCount} · showing {pageProducts.length} of {filteredProducts.length}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      data-testid="button-prev-page"
                      size="sm"
                      variant="outline"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                    >
                      Previous
                    </Button>
                    <Button
                      data-testid="button-next-page"
                      size="sm"
                      variant="outline"
                      onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                      disabled={page >= pageCount - 1}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
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
                className={`rounded border p-2 text-[11px] font-semibold uppercase tracking-wider ${
                  targetIsSample
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {targetIsSample
                  ? "Sample data — push disabled"
                  : pushTarget.mapped.push_state === "pushed"
                    ? "Live Shopify product — already pushed (this will update Jomashop)"
                    : "Live Shopify product"}
              </div>
              {(pushTarget.mapped.push_state === "rejected" ||
                pushTarget.mapped.push_state === "failed") &&
                (pushTarget.mapped.last_rejected_category ||
                  pushTarget.mapped.last_rejected_brand) && (
                <div
                  data-testid="block-modal-prior-rejection"
                  className="rounded border border-red-500/40 bg-red-500/5 p-2 text-[11px] text-red-600 dark:text-red-400"
                >
                  <div className="font-medium">
                    Jomashop rejected the previous push.
                  </div>
                  {pushTarget.mapped.last_rejected_category && (
                    <div>
                      Category sent:{" "}
                      <code className="font-mono">
                        {pushTarget.mapped.last_rejected_category}
                      </code>
                      {pushTarget.mapped.last_invalid_params?.includes("category") &&
                        " — Jomashop says this category does not exist; pick another exact name or confirm in the portal."}
                    </div>
                  )}
                  {pushTarget.mapped.last_rejected_brand && (
                    <div>
                      Brand sent:{" "}
                      <code className="font-mono">
                        {pushTarget.mapped.last_rejected_brand}
                      </code>
                      {pushTarget.mapped.last_invalid_params?.includes("brand") &&
                        " — Jomashop says this brand does not exist; try the exact spelling shown in the Jomashop portal."}
                    </div>
                  )}
                </div>
              )}
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
                          ? "Warning: this category is not in the live Jomashop category list. Push will likely fail."
                          : "Note: live categories not fetched — using fallback list. Push may be rejected."}
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
                    {pushTarget?.mapped.jomashop_resolution?.i1_available ? (
                      pushTarget.mapped.jomashop_resolution.manufacturer ? (
                        <div className="mt-1 text-[10px] text-emerald-500">
                          Matched Jomashop manufacturer:{" "}
                          <code className="font-mono">
                            {pushTarget.mapped.jomashop_resolution.manufacturer.name} (id:{" "}
                            {String(pushTarget.mapped.jomashop_resolution.manufacturer.id)})
                          </code>
                        </div>
                      ) : (
                        <div className="mt-1 space-y-1 text-[10px] text-amber-500">
                          <div>
                            Brand "{pushTarget.mapped.jomashop_resolution.outbound_brand || pushTarget.mapped.brand}" not found in Jomashop manufacturers.
                            {pushTarget.mapped.jomashop_resolution.manufacturer_suggestion && (
                              <>
                                {" "}Did you mean{" "}
                                <button
                                  type="button"
                                  data-testid="button-apply-brand-suggestion"
                                  className="underline"
                                  onClick={() =>
                                    setOverrides((o) => ({
                                      ...o,
                                      brand:
                                        pushTarget.mapped.jomashop_resolution!
                                          .manufacturer_suggestion!.name,
                                    }))
                                  }
                                >
                                  "{pushTarget.mapped.jomashop_resolution.manufacturer_suggestion.name}"
                                </button>
                                ?
                              </>
                            )}
                          </div>
                          {overrides.brand.trim() !== "" && (
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid="button-create-jomashop-manufacturer"
                                disabled={createManufacturer.isPending}
                                onClick={() => {
                                  if (
                                    typeof window !== "undefined" &&
                                    !window.confirm(
                                      `Create new Jomashop brand "${overrides.brand.trim()}"? This adds it to Jomashop's global catalog.`,
                                    )
                                  ) {
                                    return;
                                  }
                                  createManufacturer.mutate({ name: overrides.brand.trim() });
                                }}
                              >
                                {createManufacturer.isPending ? (
                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                ) : null}
                                Create Jomashop brand "{overrides.brand.trim()}"
                              </Button>
                              {createManufacturer.data?.ok && (
                                <span className="text-[10px] text-emerald-500">created</span>
                              )}
                              {createManufacturer.data?.ok === false && (
                                <span className="text-[10px] text-red-500">
                                  {createManufacturer.data.error || "create failed"}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      <div className="mt-1 text-[10px] text-amber-500">
                        Warning: Brand must match Jomashop exactly. /i1/manufacturers lookup not available — value cannot be verified before push.
                      </div>
                    )}
                    {overrides.brand.trim() !== "" &&
                      pushTarget &&
                      overrides.brand.trim() !==
                        (pushTarget.mapped.brand || "").trim() && (
                      <div className="mt-1 flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="button-save-brand-override-from-modal"
                          disabled={saveBrandOverride.isPending}
                          onClick={() =>
                            saveBrandOverride.mutate({
                              shopify_brand: pushTarget.mapped.brand,
                              jomashop_brand: overrides.brand.trim(),
                            })
                          }
                        >
                          {saveBrandOverride.isPending ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : null}
                          Save as brand override
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          {pushTarget.mapped.brand} → {overrides.brand.trim()} (applies to all matching products)
                        </span>
                        {saveBrandOverride.data?.ok && (
                          <span className="text-[10px] text-emerald-500">saved</span>
                        )}
                      </div>
                    )}
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
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[10px]">
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
                {pushTarget.mapped.push_state === "pushed"
                  ? "Confirm — update on Jomashop"
                  : "Confirm — push to Jomashop"}
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
 * push endpoint can re-run mapping with the live category schema.
 */
function shopifyProductFromMapped(m: MappedProduct): Record<string, unknown> {
  const images = Array.isArray(m.images) ? m.images : [];
  return {
    id: m.source.shopify_product_id,
    title: m.name,
    body_html: m.description ?? "",
    vendor: m.brand,
    product_type: m.category,
    images: images.map((src) => ({ src })),
    options: Object.keys(m.variants[0]?.options ?? {}).map((name) => ({ name, values: [] })),
    variants: m.variants.map((v, i) => {
      const opts = v.options ?? {};
      return {
        id: m.source.shopify_variant_ids[i],
        sku: v.vendor_sku,
        price: v.price !== null ? String(v.price) : undefined,
        inventory_quantity: v.quantity,
        option1: Object.values(opts)[0],
        option2: Object.values(opts)[1],
        option3: Object.values(opts)[2],
      };
    }),
    metafields: [
      { namespace: "custom", key: "commercial_discount", value: m.commercial_discount },
      ...Object.entries(m.properties)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => ({ namespace: "luxe", key: k, value: v as string | number })),
    ],
  };
}
