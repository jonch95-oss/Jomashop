import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader, EmptyState, ErrorBlock, LoadingRows } from "@/components/AppShell";
import { InlineFieldRepair } from "@/components/InlineFieldRepair";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";
import type { MappedProduct } from "@/lib/types";

/**
 * Review Queue — a single triage surface that groups the cached catalog by
 * Jomashop push-readiness so the operator can see, at a glance, how many
 * products need mapping, have errors, are ready, were pushed, failed, or need
 * a Shopify write-back. Selecting a status (or a smart filter) narrows the
 * list. Each row exposes the inline field-repair panel and a non-destructive
 * "Validate (dry-run)" action that runs the full server preflight without
 * sending anything to Jomashop.
 */

type PreviewData = {
  mapped: MappedProduct[];
  count: number;
  totalCount?: number;
  cached?: boolean;
  lastRefreshedAt?: number | null;
  dataSource?: "live" | "sample";
};

type StatusKey =
  | "needs_mapping"
  | "has_errors"
  | "ready"
  | "pushed"
  | "push_failed"
  | "writeback_needed";

type DryRunState = {
  loading: boolean;
  passed?: boolean;
  message?: string;
  missing?: string[];
};

type DetailTab = "fields" | "variants" | "writeback";

function productId(p: MappedProduct): string {
  return String(p.source?.shopify_product_id ?? p.vendor_sku ?? "");
}

function missingFieldsFor(p: MappedProduct): string[] {
  const out = new Set<string>();
  for (const f of p.missing_top_level || []) if (f && f !== "undefined") out.add(f);
  for (const f of p.missing_required || []) if (f && f !== "undefined") out.add(f);
  for (const ie of p.invalid_enums || []) if (ie?.field) out.add(ie.field);
  return Array.from(out);
}

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

function hasVariantIssue(p: MappedProduct): boolean {
  return (p.variants || []).some(
    (v) => v.status === "inactive" || v.price === null || !v.vendor_sku,
  );
}

function hasErrors(p: MappedProduct): boolean {
  if (p.push_state === "rejected" || p.push_state === "failed") return true;
  if ((p.invalid_enums?.length ?? 0) > 0) return true;
  if ((p.unverified_required_options?.length ?? 0) > 0) return true;
  return false;
}

function needsMapping(p: MappedProduct): boolean {
  if (missingFieldsFor(p).length > 0) return true;
  if (brandUnresolved(p) || categoryUnresolved(p)) return true;
  return false;
}

function writebackNeeded(p: MappedProduct): boolean {
  // A product needs a Shopify write-back when it has missing top-level fields
  // (sku, brand, manufacturer_number, category) that live in Shopify and have
  // no internal override yet. We approximate with missing_top_level presence.
  return (p.missing_top_level || []).some((f) => f && f !== "undefined");
}

function statusOf(p: MappedProduct): StatusKey {
  if (p.push_state === "failed") return "push_failed";
  if (p.push_state === "rejected" || hasErrors(p)) return "has_errors";
  if (p.push_state === "pushed") return "pushed";
  if (needsMapping(p)) return "needs_mapping";
  if (writebackNeeded(p)) return "writeback_needed";
  return "ready";
}

const STATUS_META: Array<{ key: StatusKey; label: string; tone: string }> = [
  { key: "needs_mapping", label: "Needs Mapping", tone: "text-amber-600 dark:text-amber-400" },
  { key: "has_errors", label: "Has Errors", tone: "text-red-600 dark:text-red-400" },
  { key: "ready", label: "Ready to Push", tone: "text-emerald-600 dark:text-emerald-400" },
  { key: "pushed", label: "Pushed", tone: "text-sky-600 dark:text-sky-400" },
  { key: "push_failed", label: "Push Failed", tone: "text-red-600 dark:text-red-400" },
  { key: "writeback_needed", label: "Write-back Needed", tone: "text-violet-600 dark:text-violet-400" },
];

type SmartFilter =
  | "missing_category"
  | "missing_brand"
  | "variant_issue"
  | "ready"
  | "writeback_needed"
  | "push_failed";

const SMART_FILTERS: Array<{ key: SmartFilter; label: string; test: (p: MappedProduct) => boolean }> = [
  { key: "missing_category", label: "Missing category", test: (p) => categoryUnresolved(p) || (p.missing_top_level || []).includes("category") || !!p.ambiguous_category },
  { key: "missing_brand", label: "Missing brand", test: (p) => brandUnresolved(p) || (p.missing_top_level || []).includes("brand") },
  { key: "variant_issue", label: "Variant issue", test: hasVariantIssue },
  { key: "ready", label: "Ready to push", test: (p) => statusOf(p) === "ready" },
  { key: "writeback_needed", label: "Write-back needed", test: writebackNeeded },
  { key: "push_failed", label: "Push failed", test: (p) => p.push_state === "failed" },
];

export default function Queue() {
  const [activeStatus, setActiveStatus] = useState<StatusKey | "all">("all");
  const [activeSmart, setActiveSmart] = useState<SmartFilter | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detailTab, setDetailTab] = useState<Record<string, DetailTab>>({});
  const [dryRuns, setDryRuns] = useState<Record<string, DryRunState>>({});
  const [showBulk, setShowBulk] = useState(false);

  const cacheQ = useQuery<PreviewData>({
    queryKey: ["/api/products/cache", "queue"],
    queryFn: async () => {
      const res = await fetch("/api/products/cache?limit=all", {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Cache fetch failed (${res.status})`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const products = useMemo(() => {
    const all = Array.isArray(cacheQ.data?.mapped) ? cacheQ.data!.mapped : [];
    return all.filter((p) => !p.is_sample);
  }, [cacheQ.data]);

  const counts = useMemo(() => {
    const c: Record<StatusKey, number> = {
      needs_mapping: 0,
      has_errors: 0,
      ready: 0,
      pushed: 0,
      push_failed: 0,
      writeback_needed: 0,
    };
    for (const p of products) c[statusOf(p)] += 1;
    return c;
  }, [products]);

  const filtered = useMemo(() => {
    let rows = products;
    if (activeStatus !== "all") rows = rows.filter((p) => statusOf(p) === activeStatus);
    if (activeSmart) {
      const f = SMART_FILTERS.find((x) => x.key === activeSmart);
      if (f) rows = rows.filter(f.test);
    }
    return rows;
  }, [products, activeStatus, activeSmart]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(filtered.map(productId)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function runDryRun(p: MappedProduct) {
    const id = productId(p);
    setDryRuns((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const res = await apiRequest("POST", "/api/jomashop/push-product", {
        productId: id,
        variantSku: p.vendor_sku,
        dryRun: true,
      });
      const body = await res.json();
      if (body.ok && body.dryRun) {
        const v = body.validation || {};
        const missing = [
          ...(v.missingTopLevel || []),
          ...(v.missingRequired || []),
        ];
        setDryRuns((prev) => ({
          ...prev,
          [id]: {
            loading: false,
            passed: v.passed !== false && missing.length === 0,
            message: v.passed === false || missing.length > 0
              ? `Validation gaps: ${missing.join(", ") || "see preflight"}`
              : "Validation passed — payload is push-ready (nothing sent).",
            missing,
          },
        }));
      } else {
        setDryRuns((prev) => ({
          ...prev,
          [id]: {
            loading: false,
            passed: false,
            message: body.error || body.errors?.join("; ") || `Preflight blocked (${body.status ?? res.status}).`,
            missing: [...(body.missingTopLevel || []), ...(body.missingRequired || [])],
          },
        }));
      }
    } catch (err) {
      setDryRuns((prev) => ({
        ...prev,
        [id]: { loading: false, passed: false, message: (err as Error).message || "Dry-run failed." },
      }));
    }
  }

  async function runDryRunSelected() {
    const targets = filtered.filter((p) => selected.has(productId(p)));
    for (const p of targets) {
      // Sequential to avoid hammering the live preflight endpoint.
      // eslint-disable-next-line no-await-in-loop
      await runDryRun(p);
    }
  }

  if (cacheQ.isLoading) {
    return (
      <>
        <PageHeader title="Review Queue" description="Triage the catalog by Jomashop push-readiness." />
        <LoadingRows count={6} />
      </>
    );
  }
  if (cacheQ.isError) {
    return (
      <>
        <PageHeader title="Review Queue" description="Triage the catalog by Jomashop push-readiness." />
        <ErrorBlock message={(cacheQ.error as Error)?.message || "Failed to load product cache."} />
      </>
    );
  }
  if (products.length === 0) {
    return (
      <>
        <PageHeader title="Review Queue" description="Triage the catalog by Jomashop push-readiness." />
        <EmptyState
          title="No products in cache"
          description="Refresh products from Shopify on the Products page first, then return here to triage them."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Review Queue"
        description={`${products.length} products · grouped by push-readiness`}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => cacheQ.refetch()}
            data-testid="button-queue-refresh"
          >
            <RefreshCcw className="mr-2 h-3.5 w-3.5" />
            Reload
          </Button>
        }
      />

      {/* Status group cards */}
      <div className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <button
          type="button"
          onClick={() => setActiveStatus("all")}
          className={`rounded-md border px-3 py-2.5 text-left transition hover-elevate ${
            activeStatus === "all" ? "border-foreground bg-card" : "border-card-border bg-card/40"
          }`}
          data-testid="status-card-all"
        >
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">All</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">{products.length}</div>
        </button>
        {STATUS_META.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveStatus(activeStatus === s.key ? "all" : s.key)}
            className={`rounded-md border px-3 py-2.5 text-left transition hover-elevate ${
              activeStatus === s.key ? "border-foreground bg-card" : "border-card-border bg-card/40"
            }`}
            data-testid={`status-card-${s.key}`}
          >
            <div className={`text-[10px] uppercase tracking-wider ${s.tone}`}>{s.label}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{counts[s.key]}</div>
          </button>
        ))}
      </div>

      {/* Smart filters */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Smart filters</span>
        {SMART_FILTERS.map((f) => {
          const n = products.filter(f.test).length;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setActiveSmart(activeSmart === f.key ? null : f.key)}
              className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-wider transition ${
                activeSmart === f.key
                  ? "border-foreground bg-foreground text-background"
                  : "border-card-border bg-card/40 text-muted-foreground hover:bg-card"
              }`}
              data-testid={`smart-filter-${f.key}`}
            >
              {f.label} <span className="ml-1 tabular-nums">{n}</span>
            </button>
          );
        })}
        {(activeSmart || activeStatus !== "all") && (
          <button
            type="button"
            onClick={() => {
              setActiveSmart(null);
              setActiveStatus("all");
            }}
            className="text-[10px] uppercase tracking-wider text-muted-foreground underline"
            data-testid="button-clear-filters"
          >
            Clear
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-card-border bg-card/40 px-3 py-2">
        <span className="text-xs text-muted-foreground" data-testid="text-selected-count">
          {selected.size} selected · {filtered.length} shown
        </span>
        <Button size="sm" variant="outline" onClick={selectAllVisible} data-testid="button-select-all">
          Select all visible
        </Button>
        <Button size="sm" variant="outline" onClick={clearSelection} disabled={selected.size === 0} data-testid="button-clear-selection">
          Clear
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowBulk((v) => !v)}
          disabled={selected.size === 0}
          data-testid="button-toggle-bulk"
        >
          {showBulk ? "Hide bulk edit" : "Bulk edit fields"}
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={runDryRunSelected}
          disabled={selected.size === 0}
          data-testid="button-validate-selected"
        >
          <ShieldCheck className="mr-2 h-3.5 w-3.5" />
          Validate selected (dry-run)
        </Button>
      </div>

      {showBulk && selected.size > 0 && (
        <BulkEditPanel
          products={filtered.filter((p) => selected.has(productId(p)) && p.source?.shopify_product_id)}
          onApplied={() => cacheQ.refetch()}
        />
      )}

      {/* Rows */}
      <div className="space-y-2">
        {filtered.map((p) => {
          const id = productId(p);
          const status = statusOf(p);
          const meta = STATUS_META.find((s) => s.key === status);
          const missing = missingFieldsFor(p);
          const dr = dryRuns[id];
          const isOpen = expanded.has(id);
          return (
            <Card key={id} className="overflow-hidden" data-testid={`queue-row-${id}`}>
              <CardContent className="p-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={selected.has(id)}
                    onCheckedChange={() => toggleSelect(id)}
                    className="mt-1"
                    data-testid={`checkbox-${id}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{p.name || p.vendor_sku}</span>
                      <Badge variant="outline" className={`text-[9px] uppercase ${meta?.tone ?? ""}`}>
                        {meta?.label ?? status}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {p.brand || "—"} · {p.category}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <code className="font-mono">{p.vendor_sku}</code>
                      {missing.length > 0 && (
                        <span className="text-amber-700 dark:text-amber-400">
                          Missing: {missing.slice(0, 6).join(", ")}{missing.length > 6 ? "…" : ""}
                        </span>
                      )}
                      {p.last_push_error && (
                        <span className="text-red-600 dark:text-red-400">Last error: {p.last_push_error}</span>
                      )}
                    </div>
                    {dr && (
                      <div
                        className={`mt-2 flex items-center gap-1.5 text-[11px] ${
                          dr.loading
                            ? "text-muted-foreground"
                            : dr.passed
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-red-600 dark:text-red-400"
                        }`}
                        data-testid={`dryrun-result-${id}`}
                      >
                        {dr.loading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : dr.passed ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5" />
                        )}
                        {dr.loading ? "Validating…" : dr.message}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runDryRun(p)}
                      disabled={dr?.loading}
                      data-testid={`button-validate-${id}`}
                    >
                      {dr?.loading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Validate
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleExpand(id)}
                      data-testid={`button-expand-${id}`}
                    >
                      {isOpen ? "Hide fields" : "Fix fields"}
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-3 border-t border-card-border pt-3">
                    <div className="mb-3 flex items-center gap-1.5">
                      {(["fields", "variants", "writeback"] as DetailTab[]).map((t) => {
                        const activeTab = (detailTab[id] ?? "fields") === t;
                        const label = t === "fields" ? "Fix fields" : t === "variants" ? "Variants" : "Write-back preview";
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setDetailTab((prev) => ({ ...prev, [id]: t }))}
                            className={`rounded-md border px-2.5 py-1 text-[11px] transition ${
                              activeTab ? "border-foreground bg-card" : "border-card-border bg-card/40 text-muted-foreground"
                            }`}
                            data-testid={`detail-tab-${t}-${id}`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>

                    {(detailTab[id] ?? "fields") === "fields" && (
                      p.source?.shopify_product_id ? (
                        <InlineFieldRepair
                          productId={String(p.source.shopify_product_id)}
                          missingFields={missing}
                          onSaved={() => cacheQ.refetch()}
                          hidePushButton
                        />
                      ) : (
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          No Shopify product id on this cached row — refresh from Shopify to enable inline repair.
                        </div>
                      )
                    )}

                    {(detailTab[id] ?? "fields") === "variants" && <VariantMatrix product={p} />}

                    {(detailTab[id] ?? "fields") === "writeback" && (
                      p.source?.shopify_product_id ? (
                        <WritebackPreview productId={String(p.source.shopify_product_id)} pushed={p.push_state === "pushed"} />
                      ) : (
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          No Shopify product id — refresh from Shopify to preview write-back targets.
                        </div>
                      )
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
        {filtered.length === 0 && (
          <EmptyState title="Nothing matches" description="No products match the selected status / smart filter." />
        )}
      </div>
    </>
  );
}

// ---------- Bulk edit panel ----------
// Applies one or more (field, value) pairs to every selected product through
// the existing per-product safe write route (POST /api/jomashop/inline-field-repair),
// which validates each value against the live category schema before writing a
// Shopify metafield. A client-side preview shows which selected products
// actually have that field outstanding before anything is written.

type BulkRow = { field: string; value: string };
type BulkResult = { id: string; name: string; ok: boolean; message: string };

function BulkEditPanel({ products, onApplied }: { products: MappedProduct[]; onApplied: () => void }) {
  const [rows, setRows] = useState<BulkRow[]>([{ field: "", value: "" }]);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Union of outstanding field names across the selection — offered as quick
  // picks so the operator fills a real gap rather than guessing labels.
  const suggestedFields = useMemo(() => {
    const s = new Set<string>();
    for (const p of products) for (const f of missingFieldsFor(p)) s.add(f);
    return Array.from(s).sort();
  }, [products]);

  const activeRows = rows.filter((r) => r.field.trim() && r.value.trim());

  function affectedCountForField(field: string): number {
    const wanted = field.toLowerCase().trim();
    return products.filter((p) => missingFieldsFor(p).some((f) => f.toLowerCase().trim() === wanted)).length;
  }

  function setRow(i: number, patch: Partial<BulkRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { field: "", value: "" }]);
  }
  function removeRow(i: number) {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }

  async function apply() {
    if (activeRows.length === 0) return;
    setApplying(true);
    setResults(null);
    setProgress({ done: 0, total: products.length });
    const out: BulkResult[] = [];
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      const pid = String(p.source?.shopify_product_id ?? "");
      const name = p.name || p.vendor_sku;
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await apiRequest("POST", "/api/jomashop/inline-field-repair", {
          productId: pid,
          confirm: true,
          fields: activeRows.map((r) => ({ field: r.field.trim(), value: r.value.trim() })),
        });
        // eslint-disable-next-line no-await-in-loop
        const body = await res.json();
        if (body.ok) {
          const okCount = (body.results || []).filter((r: { ok: boolean }) => r.ok).length;
          out.push({ id: pid, name, ok: true, message: `Saved ${okCount} field(s)` });
        } else {
          const fieldErr = (body.results || [])
            .filter((r: { ok: boolean }) => !r.ok)
            .map((r: { field: string; validationError?: string; error?: string }) => `${r.field}: ${r.validationError || r.error}`)
            .join("; ");
          out.push({ id: pid, name, ok: false, message: fieldErr || body.error || "Failed" });
        }
      } catch (err) {
        out.push({ id: pid, name, ok: false, message: (err as Error).message || "Request failed" });
      }
      setProgress({ done: i + 1, total: products.length });
    }
    setResults(out);
    setApplying(false);
    onApplied();
  }

  const okCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <Card className="mb-3 border-foreground/30" data-testid="bulk-edit-panel">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Bulk edit {products.length} selected product(s)</h3>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Writes Shopify metafields via validated repair route
          </span>
        </div>

        {suggestedFields.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Outstanding fields</span>
            {suggestedFields.slice(0, 12).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  // Fill the first empty field row, else add a new one.
                  const emptyIdx = rows.findIndex((r) => !r.field.trim());
                  if (emptyIdx >= 0) setRow(emptyIdx, { field: f });
                  else setRows((prev) => [...prev, { field: f, value: "" }]);
                }}
                className="rounded-full border border-card-border bg-card/40 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-card"
                data-testid={`bulk-suggest-${f}`}
              >
                {f} <span className="tabular-nums">({affectedCountForField(f)})</span>
              </button>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r.field}
                onChange={(e) => setRow(i, { field: e.target.value })}
                placeholder="Field (e.g. Color, Gender, Shoe Size)"
                className="h-8 flex-1 text-xs"
                data-testid={`bulk-field-${i}`}
              />
              <Input
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="Value to apply to all selected"
                className="h-8 flex-1 text-xs"
                data-testid={`bulk-value-${i}`}
              />
              {r.field.trim() && (
                <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground" title="Selected products currently missing/invalid for this field">
                  {affectedCountForField(r.field)} affected
                </span>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                onClick={() => removeRow(i)}
                disabled={rows.length === 1}
                data-testid={`bulk-remove-${i}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={addRow} data-testid="bulk-add-row">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add field
          </Button>
        </div>

        <div className="flex items-center justify-between border-t border-card-border pt-3">
          <span className="text-[11px] text-muted-foreground">
            {activeRows.length === 0
              ? "Fill at least one field and value."
              : `Will apply ${activeRows.length} field(s) to each of ${products.length} product(s).`}
            {progress && applying && ` · ${progress.done}/${progress.total}`}
          </span>
          <Button
            size="sm"
            variant="default"
            onClick={apply}
            disabled={applying || activeRows.length === 0}
            data-testid="button-bulk-apply"
          >
            {applying ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-2 h-3.5 w-3.5" />}
            Apply to selected
          </Button>
        </div>

        {results && (
          <div className="space-y-1 border-t border-card-border pt-2" data-testid="bulk-results">
            <div className="text-[11px] font-medium">
              {okCount}/{results.length} updated{results.length - okCount > 0 ? ` · ${results.length - okCount} failed` : ""}
            </div>
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {results.map((r) => (
                <div
                  key={r.id}
                  className={`flex items-center gap-1.5 text-[11px] ${r.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                >
                  {r.ok ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <XCircle className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{r.name}: {r.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Variant matrix ----------
// Renders the cached variant rows for a product (size/color options, SKU,
// inventory, price, mapped Jomashop price) with per-row issue flags. All data
// comes from the cached MappedProduct.variants — no extra fetch.

function VariantMatrix({ product }: { product: MappedProduct }) {
  const variants = product.variants || [];
  if (variants.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        No variant rows in cache for this product. Refresh from Shopify if you expect variants.
      </div>
    );
  }
  // Collect the union of option keys (e.g. Size, Color) across variants.
  const optionKeys = Array.from(
    variants.reduce((set, v) => {
      for (const k of Object.keys(v.options || {})) set.add(k);
      return set;
    }, new Set<string>()),
  );
  return (
    <div className="overflow-x-auto rounded-md border border-card-border">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-card-border bg-card/40 text-left text-muted-foreground">
            <th className="px-2 py-1.5 font-medium">SKU</th>
            {optionKeys.map((k) => (
              <th key={k} className="px-2 py-1.5 font-medium">{k}</th>
            ))}
            <th className="px-2 py-1.5 font-medium">Qty</th>
            <th className="px-2 py-1.5 font-medium">Price</th>
            <th className="px-2 py-1.5 font-medium">Jomashop price</th>
            <th className="px-2 py-1.5 font-medium">Status</th>
            <th className="px-2 py-1.5 font-medium">Issues</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v, i) => {
            const issues: string[] = [];
            if (!v.vendor_sku) issues.push("no SKU");
            if (v.price === null) issues.push("no price");
            if (v.status === "inactive") issues.push("inactive");
            if (v.jomashop_price === null) issues.push("no Jomashop price");
            return (
              <tr key={v.vendor_sku || i} className="border-b border-card-border/60 last:border-0">
                <td className="px-2 py-1.5 font-mono">{v.vendor_sku || "—"}</td>
                {optionKeys.map((k) => (
                  <td key={k} className="px-2 py-1.5">{v.options?.[k] ?? "—"}</td>
                ))}
                <td className="px-2 py-1.5 tabular-nums">{v.quantity ?? "—"}</td>
                <td className="px-2 py-1.5 tabular-nums">{v.price ?? "—"}</td>
                <td className="px-2 py-1.5 tabular-nums">{v.jomashop_price ?? "—"}</td>
                <td className="px-2 py-1.5">
                  <Badge
                    variant="outline"
                    className={`text-[9px] uppercase ${
                      v.status === "active"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : v.status === "out_of_stock"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {v.status}
                  </Badge>
                </td>
                <td className="px-2 py-1.5 text-red-600 dark:text-red-400">{issues.join(", ") || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Shopify write-back preview ----------
// Read-only. Fetches GET /api/shopify/writeback-preview/:productId and splits
// outstanding fields into buckets: written back to Shopify, saved internally
// (override resolves it), pushed to Jomashop, and unchanged / not-ready.

type WritebackResponse = {
  ok: boolean;
  error?: string;
  jomashop_ready?: boolean;
  shopify_writeback?: Array<{ field: string; metafield_target: string; reason: string }>;
  internal_mapping?: Array<{ field: string; proposed: string | null; confidence: string }>;
  missing_required?: string[];
  missing_top_level?: string[];
};

function WritebackPreview({ productId, pushed }: { productId: string; pushed: boolean }) {
  const q = useQuery<WritebackResponse>({
    queryKey: ["/api/shopify/writeback-preview", productId],
    queryFn: async () => {
      const res = await fetch(`/api/shopify/writeback-preview/${encodeURIComponent(productId)}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading write-back preview…
      </div>
    );
  }
  if (q.isError || !q.data || !q.data.ok) {
    return <div className="text-[11px] text-red-600 dark:text-red-400">{q.data?.error || (q.error as Error)?.message || "Preview unavailable."}</div>;
  }
  const d = q.data;
  const shopify = d.shopify_writeback || [];
  const internal = d.internal_mapping || [];

  return (
    <div className="space-y-3" data-testid={`writeback-preview-${productId}`}>
      <div className="flex items-center gap-1.5 rounded-md border border-card-border bg-card/40 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Read-only preview — no data is written. Use Fix fields to perform the safe write-back.
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <WritebackBucket
          title="Needs Shopify write-back"
          tone="text-violet-700 dark:text-violet-400"
          items={shopify.map((s) => `${s.field} → ${s.metafield_target} (${s.reason})`)}
          empty="No fields require a Shopify metafield write."
        />
        <WritebackBucket
          title="Saved internally (override resolves)"
          tone="text-sky-700 dark:text-sky-400"
          items={internal.map((s) => `${s.field} → ${s.proposed ?? "?"} [${s.confidence}]`)}
          empty="No internal overrides apply."
        />
        <WritebackBucket
          title="Pushed to Jomashop"
          tone="text-emerald-700 dark:text-emerald-400"
          items={pushed ? ["This product has been pushed to Jomashop."] : []}
          empty="Not pushed to Jomashop yet."
        />
        <WritebackBucket
          title="Unchanged / ready"
          tone="text-muted-foreground"
          items={d.jomashop_ready ? ["Nothing outstanding — product is Jomashop-ready."] : []}
          empty={d.jomashop_ready ? "" : "Still has outstanding fields (see other buckets)."}
        />
      </div>
    </div>
  );
}

function WritebackBucket({ title, tone, items, empty }: { title: string; tone: string; items: string[]; empty: string }) {
  return (
    <div className="rounded-md border border-card-border bg-card/40 p-2.5">
      <div className={`mb-1.5 text-[10px] font-medium uppercase tracking-wider ${tone}`}>
        {title} {items.length > 0 && <span className="tabular-nums">({items.length})</span>}
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((it, i) => (
            <li key={i} className="text-[11px] font-mono">{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
