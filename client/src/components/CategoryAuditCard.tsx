// Embedded category mapping audit. Lists every distinct Shopify category code
// seen in the cached preview, the resolved Jomashop category (after alias
// rewrites like Clothing → Apparel), a status badge (Mapped / Alias /
// Unmapped / Invalid), a dropdown to pick a new mapping, and a Save button
// that persists to SQLite and invalidates the product cache.
//
// Filter: Needs mapping (unmapped+invalid) / All / Mapped. Bulk save sends
// every dirty row at once.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";

type AuditStatus = "mapped" | "alias" | "unmapped" | "invalid";

type AuditRow = {
  shopify_category_code: string;
  shopify_category_code_normalized: string;
  product_count: number;
  missing_count: number;
  sample_titles: string[];
  sample_skus: string[];
  current_jomashop_category: string | null;
  resolved_jomashop_category: string | null;
  has_alias: boolean;
  alias_target: string | null;
  source: "operator" | "built-in" | "none";
  status: AuditStatus;
  status_reason: string;
  suggested_category: string;
  ambiguous: boolean;
  jomashop_schema_loaded: boolean;
};

type AuditResponse = {
  ok: boolean;
  shopDomain: string | null;
  fromCache: boolean;
  cachedAt: number | null;
  totalProducts: number;
  uniqueCodes: number;
  jomashopCategoriesAvailable: boolean;
  jomashopCategories: string[];
  pickerCategories: string[];
  totals: {
    mapped: number;
    alias: number;
    unmapped: number;
    invalid: number;
    needsMapping: number;
    productsAffectedNeedsMapping: number;
  };
  rows: AuditRow[];
};

type SaveResponse = {
  ok: boolean;
  applied: number;
  cleared: number;
  unknown?: Array<{ code: string; category: string }>;
  errors?: Array<{ code: string; error: string }>;
  shopDomain: string | null;
  cacheInvalidated: boolean;
  note?: string;
  error?: string;
};

type FilterMode = "needs" | "all" | "mapped";

function statusBadge(status: AuditStatus) {
  if (status === "mapped") {
    return (
      <Badge variant="outline" className="bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400">
        Mapped
      </Badge>
    );
  }
  if (status === "alias") {
    return (
      <Badge variant="outline" className="bg-blue-500/10 text-[10px] text-blue-700 dark:text-blue-400">
        Alias
      </Badge>
    );
  }
  if (status === "invalid") {
    return (
      <Badge variant="outline" className="bg-red-500/10 text-[10px] text-red-700 dark:text-red-400">
        Invalid
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
      Unmapped
    </Badge>
  );
}

export function CategoryAuditCard(props: { onAfterSave?: () => void }) {
  const qc = useQueryClient();
  const auditQ = useQuery<AuditResponse>({
    queryKey: ["/api/category-mapping/audit"],
  });
  const [filter, setFilter] = useState<FilterMode>("needs");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResponse | null>(null);

  const saveMut = useMutation({
    mutationFn: async (
      mappings: Array<{ shopify_category_code: string; jomashop_category: string }>,
    ): Promise<SaveResponse> => {
      const res = await apiRequest("POST", "/api/category-mapping/save", {
        mappings,
        allowUnknown,
      });
      return (await res.json()) as SaveResponse;
    },
    onSuccess: (r) => {
      setSaveResult(r);
      if (r.ok || (r.applied ?? 0) > 0 || (r.cleared ?? 0) > 0) {
        setDrafts({});
        auditQ.refetch();
        qc.invalidateQueries({ queryKey: ["/api/category-mapping/overrides"] });
        qc.invalidateQueries({ queryKey: ["/api/category-mapping/aggregate"] });
        props.onAfterSave?.();
      }
    },
    onError: (e: Error) => {
      setSaveResult({
        ok: false,
        applied: 0,
        cleared: 0,
        shopDomain: null,
        cacheInvalidated: false,
        error: e.message,
      });
    },
  });

  const data = auditQ.data;
  const rows = useMemo<AuditRow[]>(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (filter === "needs" && !(r.status === "unmapped" || r.status === "invalid")) return false;
      if (filter === "mapped" && !(r.status === "mapped" || r.status === "alias")) return false;
      if (q && !`${r.shopify_category_code} ${r.suggested_category} ${(r.sample_titles || []).join(" ")}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [data, filter, search]);

  const dirtyRows = useMemo(() => {
    if (!data) return [] as Array<{ shopify_category_code: string; jomashop_category: string }>;
    const out: Array<{ shopify_category_code: string; jomashop_category: string }> = [];
    for (const r of data.rows) {
      const draft = drafts[r.shopify_category_code_normalized];
      if (draft === undefined) continue;
      const current = r.current_jomashop_category ?? "";
      if (draft === current) continue;
      out.push({
        shopify_category_code: r.shopify_category_code_normalized,
        jomashop_category: draft,
      });
    }
    return out;
  }, [data, drafts]);

  function setDraft(code: string, value: string) {
    setDrafts((prev) => ({ ...prev, [code]: value }));
  }

  function saveRow(r: AuditRow) {
    const draft = drafts[r.shopify_category_code_normalized] ?? r.current_jomashop_category ?? "";
    saveMut.mutate([
      {
        shopify_category_code: r.shopify_category_code_normalized,
        jomashop_category: draft,
      },
    ]);
  }

  const totals = data?.totals;

  return (
    <Card data-testid="card-category-audit">
      <CardHeader className="border-b border-card-border">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm">Category mapping audit</CardTitle>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Every Shopify category code in the cached preview with its current Jomashop
              mapping. Pick a category and click Save to apply — the product cache is
              invalidated automatically so the Products page refreshes its readiness.
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant={filter === "needs" ? "default" : "outline"}
              data-testid="filter-needs"
              onClick={() => setFilter("needs")}
            >
              Needs mapping
              {totals && totals.needsMapping > 0 && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  {totals.needsMapping}
                </Badge>
              )}
            </Button>
            <Button
              size="sm"
              variant={filter === "all" ? "default" : "outline"}
              data-testid="filter-all"
              onClick={() => setFilter("all")}
            >
              All
              {totals && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  {data?.uniqueCodes ?? 0}
                </Badge>
              )}
            </Button>
            <Button
              size="sm"
              variant={filter === "mapped" ? "default" : "outline"}
              data-testid="filter-mapped"
              onClick={() => setFilter("mapped")}
            >
              Mapped
              {totals && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  {totals.mapped + totals.alias}
                </Badge>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 text-xs">
        {auditQ.isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading audit…
          </div>
        )}
        {auditQ.isError && (
          <div className="rounded border border-red-500/40 bg-red-500/5 p-2 text-red-500">
            {(auditQ.error as Error)?.message || "Failed to load audit"}
          </div>
        )}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="block-audit-summary">
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                Mapped: {totals?.mapped ?? 0}
              </Badge>
              <Badge variant="outline" className="bg-blue-500/10 text-blue-700 dark:text-blue-400">
                Alias: {totals?.alias ?? 0}
              </Badge>
              <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                Unmapped: {totals?.unmapped ?? 0}
              </Badge>
              <Badge variant="outline" className="bg-red-500/10 text-red-700 dark:text-red-400">
                Invalid: {totals?.invalid ?? 0}
              </Badge>
              {totals && totals.productsAffectedNeedsMapping > 0 && (
                <Badge variant="outline">
                  {totals.productsAffectedNeedsMapping} product(s) blocked by needs-mapping
                </Badge>
              )}
              {data.jomashopCategoriesAvailable ? (
                <Badge variant="outline" className="bg-blue-500/10 text-blue-700 dark:text-blue-400">
                  Live Jomashop categories: {data.jomashopCategories.length}
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  Live category list unavailable — falling back to supported list
                </Badge>
              )}
              {!data.fromCache && (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  No cached preview — click Refresh from Shopify on Products first.
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by code, suggested, sample title…"
                className="h-7 max-w-xs text-[11px]"
                data-testid="input-audit-search"
              />
              <Button
                size="sm"
                variant="default"
                data-testid="button-save-all-dirty"
                disabled={dirtyRows.length === 0 || saveMut.isPending}
                onClick={() => saveMut.mutate(dirtyRows)}
              >
                {saveMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-2 h-3.5 w-3.5" />
                )}
                Save {dirtyRows.length > 0 ? `${dirtyRows.length} change(s)` : "all"}
              </Button>
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allowUnknown}
                  onChange={(e) => setAllowUnknown(e.target.checked)}
                  data-testid="checkbox-audit-allow-unknown"
                />
                Allow non-live categories
              </label>
            </div>

            {saveResult && (
              <div
                data-testid="block-audit-save-result"
                className={`rounded border p-2 ${
                  saveResult.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-red-500/40 bg-red-500/5 text-red-500"
                }`}
              >
                {saveResult.ok ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Saved {saveResult.applied} mapping(s)
                    {saveResult.cleared > 0 ? `, cleared ${saveResult.cleared}` : ""}.
                    {saveResult.cacheInvalidated
                      ? " Cache cleared — refresh Products to see updated readiness."
                      : ""}
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {saveResult.error || "Save failed"}
                    </div>
                    {saveResult.unknown && saveResult.unknown.length > 0 && (
                      <ul className="ml-4 mt-1 list-disc">
                        {saveResult.unknown.map((u, i) => (
                          <li key={i} className="font-mono text-[10px]">
                            {u.code} → {u.category} (not in live list)
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="max-h-96 overflow-auto rounded border border-border">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-card/80 text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Status</th>
                    <th className="px-2 py-1 text-left">Shopify code</th>
                    <th className="px-2 py-1 text-left">Products</th>
                    <th className="px-2 py-1 text-left">Current → Resolved</th>
                    <th className="px-2 py-1 text-left">Pick Jomashop category</th>
                    <th className="px-2 py-1 text-left">Sample titles</th>
                    <th className="px-2 py-1 text-right">&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-2 py-3 text-center text-muted-foreground">
                        {filter === "needs"
                          ? "Nothing needs mapping right now. Switch to All to view mapped rows."
                          : "No rows match the current filter."}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => {
                    const draftKey = r.shopify_category_code_normalized;
                    const draft = drafts[draftKey] ?? r.current_jomashop_category ?? "";
                    const isDirty = draft !== (r.current_jomashop_category ?? "");
                    return (
                      <tr
                        key={draftKey}
                        className="border-t border-border align-top"
                        data-testid={`row-audit-${draftKey}`}
                      >
                        <td className="px-2 py-1">{statusBadge(r.status)}</td>
                        <td className="px-2 py-1">
                          <div className="font-mono">{r.shopify_category_code || "—"}</div>
                          {r.ambiguous && (
                            <Badge
                              variant="outline"
                              className="mt-1 bg-amber-500/10 text-[9px] text-amber-700"
                            >
                              ambiguous
                            </Badge>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <div>{r.product_count}</div>
                          {r.missing_count > 0 && (
                            <div className="text-[9px] text-muted-foreground">
                              {r.missing_count} missing field(s)
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          {r.current_jomashop_category ? (
                            <div className="flex flex-col gap-1">
                              <span>{r.current_jomashop_category}</span>
                              {r.has_alias && r.alias_target && (
                                <span className="text-[10px] text-blue-600">
                                  → {r.alias_target}
                                </span>
                              )}
                              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                                {r.source}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">— ({r.suggested_category})</span>
                          )}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            className="w-full rounded border border-border bg-background px-1 py-0.5 text-[11px]"
                            value={draft}
                            onChange={(e) => setDraft(draftKey, e.target.value)}
                            data-testid={`select-audit-${draftKey}`}
                          >
                            <option value="">— Clear / Unmapped —</option>
                            {(data.pickerCategories || []).map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          {r.status_reason && (
                            <div className="mt-1 text-[9px] text-muted-foreground">
                              {r.status_reason}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {r.sample_titles.slice(0, 2).join(" · ") || "—"}
                          {r.sample_skus.length > 0 && (
                            <div className="mt-0.5 font-mono text-[9px]">
                              {r.sample_skus.slice(0, 2).join(", ")}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <Button
                            size="sm"
                            variant={isDirty ? "default" : "outline"}
                            disabled={!isDirty || saveMut.isPending}
                            onClick={() => saveRow(r)}
                            data-testid={`button-save-audit-${draftKey}`}
                          >
                            Save
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
