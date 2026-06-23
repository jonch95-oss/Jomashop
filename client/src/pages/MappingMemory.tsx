import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCcw, Save, Sparkles, Database } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader, EmptyState, ErrorBlock, LoadingRows } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

/**
 * Mapping Memory — surfaces the app's internal brand/category/enum overrides
 * (the persistent "memory") and the auto-fill suggestions mined from the
 * cached catalog. The operator can review saved mappings and apply a
 * suggestion (which writes the override through the existing mapping routes)
 * with a confidence label so high-trust fills can be applied in bulk.
 */

type Confidence = "Exact Match" | "Previously Used" | "Suggested" | "Needs Review";

type AllResponse = {
  ok: boolean;
  counts: { brand: number; category: number; enum: number; builtInBrand: number; builtInCategory: number };
  brand: Array<{ shopify_brand: string; jomashop_brand: string; notes?: string | null; updated_at?: number }>;
  category: Array<{ shopify_category_code: string; jomashop_category: string; notes?: string | null; updated_at?: number }>;
  enum: Array<{ jomashop_category: string; jomashop_field: string; source_value: string; jomashop_option: string; verified?: boolean; operator_verified?: boolean }>;
};

type BrandSuggestion = { type: "brand"; source_value: string; proposed: string | null; confidence: Confidence; affected_count: number; sample_sku: string };
type CategorySuggestion = { type: "category"; source_value: string; proposed: string | null; confidence: Confidence; affected_count: number; sample_sku: string };
type EnumSuggestion = { type: "enum"; category: string; field: string; source_value: string; options: string[]; proposed: string | null; confidence: Confidence; affected_count: number; sample_sku: string };

type SuggestionsResponse = {
  ok: boolean;
  scanned: number;
  counts: { brand: number; category: number; enum: number };
  brand: BrandSuggestion[];
  category: CategorySuggestion[];
  enum: EnumSuggestion[];
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  "Exact Match": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "Previously Used": "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  Suggested: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "Needs Review": "bg-muted/30 text-muted-foreground",
};

type Tab = "suggestions" | "saved";

export default function MappingMemory() {
  const [tab, setTab] = useState<Tab>("suggestions");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [applied, setApplied] = useState<Record<string, string>>({});

  const allQ = useQuery<AllResponse>({
    queryKey: ["/api/mapping-memory/all"],
    queryFn: async () => {
      const res = await fetch("/api/mapping-memory/all", { credentials: "include", headers: authHeaders() });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const sugQ = useQuery<SuggestionsResponse>({
    queryKey: ["/api/mapping-memory/suggestions"],
    queryFn: async () => {
      const res = await fetch("/api/mapping-memory/suggestions", { credentials: "include", headers: authHeaders() });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  function draftKey(type: string, k: string): string {
    return `${type}::${k}`;
  }

  async function applyBrand(s: BrandSuggestion) {
    const key = draftKey("brand", s.source_value);
    const value = (drafts[key] ?? s.proposed ?? "").trim();
    if (!value) return;
    setApplying((p) => ({ ...p, [key]: true }));
    try {
      await apiRequest("POST", "/api/brand-mapping/overrides", { shopify_brand: s.source_value, jomashop_brand: value });
      setApplied((p) => ({ ...p, [key]: value }));
      sugQ.refetch();
      allQ.refetch();
    } finally {
      setApplying((p) => ({ ...p, [key]: false }));
    }
  }

  async function applyCategory(s: CategorySuggestion) {
    const key = draftKey("category", s.source_value);
    const value = (drafts[key] ?? s.proposed ?? "").trim();
    if (!value) return;
    setApplying((p) => ({ ...p, [key]: true }));
    try {
      await apiRequest("POST", "/api/category-mapping/save", {
        mappings: [{ shopify_category_code: s.source_value, jomashop_category: value }],
        allowUnknown: true,
      });
      setApplied((p) => ({ ...p, [key]: value }));
      sugQ.refetch();
      allQ.refetch();
    } finally {
      setApplying((p) => ({ ...p, [key]: false }));
    }
  }

  async function applyEnum(s: EnumSuggestion) {
    const key = draftKey("enum", `${s.category}|${s.field}|${s.source_value}`);
    const value = (drafts[key] ?? s.proposed ?? "").trim();
    if (!value) return;
    setApplying((p) => ({ ...p, [key]: true }));
    try {
      await apiRequest("POST", "/api/enum-mapping/overrides", {
        jomashop_category: s.category,
        jomashop_field: s.field,
        source_value: s.source_value,
        jomashop_option: value,
        accepted_options: s.options,
        operator_verified: s.options.length === 0,
      });
      setApplied((p) => ({ ...p, [key]: value }));
      sugQ.refetch();
      allQ.refetch();
    } finally {
      setApplying((p) => ({ ...p, [key]: false }));
    }
  }

  // Bulk apply all suggestions whose confidence is in `levels` and that carry a
  // server-proposed value (so we never auto-save a "Needs Review" with no
  // target). Runs sequentially to stay gentle on the mapping routes.
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);

  async function bulkApply(levels: Confidence[]) {
    if (!sugQ.data) return;
    const set = new Set(levels);
    setBulkRunning(true);
    setBulkSummary(null);
    let applied = 0;
    let failed = 0;
    try {
      for (const s of sugQ.data.brand) {
        if (set.has(s.confidence) && s.proposed) {
          // eslint-disable-next-line no-await-in-loop
          await applyBrand(s).then(() => { applied += 1; }).catch(() => { failed += 1; });
        }
      }
      for (const s of sugQ.data.category) {
        if (set.has(s.confidence) && s.proposed) {
          // eslint-disable-next-line no-await-in-loop
          await applyCategory(s).then(() => { applied += 1; }).catch(() => { failed += 1; });
        }
      }
      for (const s of sugQ.data.enum) {
        if (set.has(s.confidence) && s.proposed) {
          // eslint-disable-next-line no-await-in-loop
          await applyEnum(s).then(() => { applied += 1; }).catch(() => { failed += 1; });
        }
      }
      setBulkSummary(`Applied ${applied} suggestion(s)${failed ? `, ${failed} failed` : ""}.`);
    } finally {
      setBulkRunning(false);
    }
  }

  function bulkCount(levels: Confidence[]): number {
    if (!sugQ.data) return 0;
    const set = new Set(levels);
    const all = [...sugQ.data.brand, ...sugQ.data.category, ...sugQ.data.enum];
    return all.filter((s) => set.has(s.confidence) && s.proposed).length;
  }

  const loading = allQ.isLoading || sugQ.isLoading;

  return (
    <>
      <PageHeader
        title="Mapping Memory"
        description="Internal brand / category / attribute overrides and auto-fill suggestions mined from the catalog."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              allQ.refetch();
              sugQ.refetch();
            }}
            data-testid="button-memory-refresh"
          >
            <RefreshCcw className="mr-2 h-3.5 w-3.5" />
            Reload
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setTab("suggestions")}
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition ${
            tab === "suggestions" ? "border-foreground bg-card" : "border-card-border bg-card/40 text-muted-foreground"
          }`}
          data-testid="tab-suggestions"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Suggestions
          {sugQ.data && (
            <span className="ml-1 tabular-nums">
              {sugQ.data.counts.brand + sugQ.data.counts.category + sugQ.data.counts.enum}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("saved")}
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition ${
            tab === "saved" ? "border-foreground bg-card" : "border-card-border bg-card/40 text-muted-foreground"
          }`}
          data-testid="tab-saved"
        >
          <Database className="h-3.5 w-3.5" />
          Saved mappings
          {allQ.data && (
            <span className="ml-1 tabular-nums">
              {allQ.data.counts.brand + allQ.data.counts.category + allQ.data.counts.enum}
            </span>
          )}
        </button>
      </div>

      {loading && <LoadingRows count={6} />}

      {tab === "suggestions" && !sugQ.isLoading && (
        sugQ.isError ? (
          <ErrorBlock message={(sugQ.error as Error)?.message || "Failed to load suggestions."} />
        ) : !sugQ.data || (sugQ.data.counts.brand + sugQ.data.counts.category + sugQ.data.counts.enum === 0) ? (
          <EmptyState
            title="No suggestions"
            description={`Scanned ${sugQ.data?.scanned ?? 0} cached products — nothing unresolved to suggest. Refresh products from Shopify to mine more.`}
            icon={Sparkles}
          />
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-card-border bg-card/40 px-3 py-2">
              <span className="text-[11px] text-muted-foreground">Bulk apply high-confidence suggestions:</span>
              <Button
                size="sm"
                variant="default"
                onClick={() => bulkApply(["Exact Match"])}
                disabled={bulkRunning || bulkCount(["Exact Match"]) === 0}
                data-testid="button-bulk-exact"
              >
                {bulkRunning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                Apply all Exact Match ({bulkCount(["Exact Match"])})
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => bulkApply(["Exact Match", "Previously Used"])}
                disabled={bulkRunning || bulkCount(["Exact Match", "Previously Used"]) === 0}
                data-testid="button-bulk-trusted"
              >
                Apply Exact + Previously Used ({bulkCount(["Exact Match", "Previously Used"])})
              </Button>
              {bulkSummary && <span className="text-[11px] text-emerald-700 dark:text-emerald-400">{bulkSummary}</span>}
              <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
                Suggested / Needs Review excluded — apply those individually
              </span>
            </div>

            <SuggestionGroup title="Brand" subtitle="Vendor → Jomashop manufacturer">
              {sugQ.data.brand.map((s) => {
                const key = draftKey("brand", s.source_value);
                return (
                  <SuggestionRow
                    key={key}
                    label={s.source_value}
                    meta={`${s.affected_count} product(s) · e.g. ${s.sample_sku}`}
                    confidence={s.confidence}
                    value={applied[key] ?? drafts[key] ?? s.proposed ?? ""}
                    onChange={(v) => setDrafts((p) => ({ ...p, [key]: v }))}
                    applying={!!applying[key]}
                    appliedValue={applied[key]}
                    onApply={() => applyBrand(s)}
                  />
                );
              })}
            </SuggestionGroup>

            <SuggestionGroup title="Category" subtitle="Shopify category code → Jomashop category">
              {sugQ.data.category.map((s) => {
                const key = draftKey("category", s.source_value);
                return (
                  <SuggestionRow
                    key={key}
                    label={s.source_value}
                    meta={`${s.affected_count} product(s) · e.g. ${s.sample_sku}`}
                    confidence={s.confidence}
                    value={applied[key] ?? drafts[key] ?? s.proposed ?? ""}
                    onChange={(v) => setDrafts((p) => ({ ...p, [key]: v }))}
                    applying={!!applying[key]}
                    appliedValue={applied[key]}
                    onApply={() => applyCategory(s)}
                  />
                );
              })}
            </SuggestionGroup>

            <SuggestionGroup title="Attributes" subtitle="Category field value → accepted Jomashop option">
              {sugQ.data.enum.map((s) => {
                const key = draftKey("enum", `${s.category}|${s.field}|${s.source_value}`);
                return (
                  <SuggestionRow
                    key={key}
                    label={`${s.field}: ${s.source_value || "—"}`}
                    meta={`${s.category} · ${s.affected_count} product(s)${s.options.length ? ` · options: ${s.options.slice(0, 5).join(", ")}` : ""}`}
                    confidence={s.confidence}
                    value={applied[key] ?? drafts[key] ?? s.proposed ?? ""}
                    onChange={(v) => setDrafts((p) => ({ ...p, [key]: v }))}
                    applying={!!applying[key]}
                    appliedValue={applied[key]}
                    onApply={() => applyEnum(s)}
                  />
                );
              })}
            </SuggestionGroup>
          </div>
        )
      )}

      {tab === "saved" && !allQ.isLoading && (
        allQ.isError ? (
          <ErrorBlock message={(allQ.error as Error)?.message || "Failed to load saved mappings."} />
        ) : (
          <SavedMappings data={allQ.data} />
        )
      )}
    </>
  );
}

function SuggestionGroup({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const arr = Array.isArray(children) ? children : [children];
  if (arr.filter(Boolean).length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-[11px] text-muted-foreground">{subtitle}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function SuggestionRow({
  label,
  meta,
  confidence,
  value,
  onChange,
  onApply,
  applying,
  appliedValue,
}: {
  label: string;
  meta: string;
  confidence: Confidence;
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
  applying: boolean;
  appliedValue?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <Badge variant="outline" className={`text-[9px] uppercase ${CONFIDENCE_TONE[confidence]}`}>
              {confidence}
            </Badge>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{meta}</div>
        </div>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Jomashop value…"
          className="h-8 w-56 text-xs"
          disabled={!!appliedValue}
        />
        <Button
          size="sm"
          variant={appliedValue ? "outline" : "default"}
          onClick={onApply}
          disabled={applying || !!appliedValue || !value.trim()}
        >
          {applying ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-3.5 w-3.5" />
          )}
          {appliedValue ? "Saved" : "Apply"}
        </Button>
      </CardContent>
    </Card>
  );
}

function SavedMappings({ data }: { data?: AllResponse }) {
  const [q, setQ] = useState("");
  const filter = q.trim().toLowerCase();

  const brand = useMemo(
    () => (data?.brand || []).filter((r) => !filter || `${r.shopify_brand} ${r.jomashop_brand}`.toLowerCase().includes(filter)),
    [data, filter],
  );
  const category = useMemo(
    () => (data?.category || []).filter((r) => !filter || `${r.shopify_category_code} ${r.jomashop_category}`.toLowerCase().includes(filter)),
    [data, filter],
  );
  const enums = useMemo(
    () => (data?.enum || []).filter((r) => !filter || `${r.jomashop_category} ${r.jomashop_field} ${r.source_value} ${r.jomashop_option}`.toLowerCase().includes(filter)),
    [data, filter],
  );

  if (!data) return null;
  if (data.counts.brand + data.counts.category + data.counts.enum === 0) {
    return <EmptyState title="No saved mappings yet" description="Apply a suggestion or use the Mapping & Excel tools to build internal memory." icon={Database} />;
  }

  return (
    <div className="space-y-6">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter saved mappings…"
        className="h-8 max-w-sm text-xs"
        data-testid="input-filter-saved"
      />
      <SavedTable
        title={`Brand (${brand.length})`}
        head={["Shopify brand", "Jomashop brand"]}
        rows={brand.map((r) => [r.shopify_brand, r.jomashop_brand])}
      />
      <SavedTable
        title={`Category (${category.length})`}
        head={["Shopify code", "Jomashop category"]}
        rows={category.map((r) => [r.shopify_category_code, r.jomashop_category])}
      />
      <SavedTable
        title={`Attributes (${enums.length})`}
        head={["Category", "Field", "Source value", "Jomashop option", "Verified"]}
        rows={enums.map((r) => [r.jomashop_category, r.jomashop_field, r.source_value, r.jomashop_option, r.verified ? "yes" : "no"])}
      />
    </div>
  );
}

function SavedTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No rows.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-card-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-card-border bg-card/40 text-left text-muted-foreground">
                {head.map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, i) => (
                <tr key={i} className="border-b border-card-border/60 last:border-0">
                  {r.map((cell, j) => (
                    <td key={j} className="px-3 py-1.5 font-mono">{cell || "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
