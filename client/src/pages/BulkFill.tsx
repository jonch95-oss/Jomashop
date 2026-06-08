import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  Send,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, LoadingRows, ErrorBlock, EmptyState } from "@/components/AppShell";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

type FieldKind = "field" | "topLevel" | "brand" | "category";

type FieldDescriptor = {
  field: string;
  kind: FieldKind;
  required: boolean;
  type: string;
  options: string[];
  options_unverified: boolean;
  multiple: boolean;
  isVariantTargeted: boolean;
  metafieldTarget: string;
  suggestion: string;
  isTopLevel: boolean;
};

type Cell = {
  field: string;
  status: "missing" | "invalid" | "ok";
  currentValue: string;
  invalidValue: string;
};

type Row = {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  brand: string;
  category: string;
  readiness: string;
  image: string | null;
  needsRepair: string[];
  cells: Record<string, Cell>;
};

type CategoryGroup = {
  category: string;
  schemaSource: string;
  fields: FieldDescriptor[];
  rows: Row[];
};

type GridResponse = {
  ok: boolean;
  shopDomain: string | null;
  shopifyConnected: boolean;
  fromCache: boolean;
  totalProducts: number;
  unreadyProducts: number;
  categories: CategoryGroup[];
  note?: string;
};

type ApplyFieldResult = {
  field: string;
  ok: boolean;
  metafieldTarget: string | null;
  error: string | null;
  validationError: string | null;
};
type ApplyProductResult = {
  productId: string;
  sku: string;
  written: number;
  failed: number;
  fields: ApplyFieldResult[];
  readiness: string | null;
  push_ready: boolean;
};
type ApplyResponse = {
  ok: boolean;
  totalWritten: number;
  totalFailed: number;
  totalMappingsSaved: number;
  needsRefresh: boolean;
  nowReady: number;
  products: ApplyProductResult[];
};

// editsByProduct[productId][field] = value
type Edits = Record<string, Record<string, string>>;

export default function BulkFill() {
  const { toast } = useToast();
  const [edits, setEdits] = useState<Edits>({});
  const [saveAsMapping, setSaveAsMapping] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState<{ pushed: number; failed: number; total: number } | null>(
    null,
  );
  // Per-product readiness overrides applied after a successful save so the UI
  // reflects "ready" rows without a full grid reload.
  const [readyOverride, setReadyOverride] = useState<Record<string, boolean>>({});

  const gridQ = useQuery<GridResponse>({
    queryKey: ["/api/jomashop/bulk-fill/grid"],
    queryFn: async () => {
      const res = await fetch("/api/jomashop/bulk-fill/grid", {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return res.json();
    },
  });

  const data = gridQ.data;

  const fieldKindByName = useMemo(() => {
    const map: Record<string, FieldKind> = {};
    if (data) {
      for (const g of data.categories) {
        for (const f of g.fields) map[f.field] = f.kind;
      }
    }
    return map;
  }, [data]);

  function setCell(productId: string, field: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [productId]: { ...(prev[productId] || {}), [field]: value },
    }));
  }

  function cellValue(row: Row, field: string): string {
    const edited = edits[row.productId]?.[field];
    if (edited !== undefined) return edited;
    return row.cells[field]?.currentValue ?? "";
  }

  function fillDown(group: CategoryGroup, field: string, value: string) {
    if (value.trim() === "") return;
    setEdits((prev) => {
      const next = { ...prev };
      for (const row of group.rows) {
        // Only fill cells that still need a value/fix, so we never clobber a
        // cell that is already OK.
        const status = row.cells[field]?.status;
        if (status === "ok") continue;
        next[row.productId] = { ...(next[row.productId] || {}), [field]: value };
      }
      return next;
    });
    toast({ title: "Filled down", description: `Set "${field}" = "${value}" on rows that need it.` });
  }

  const editedCount = useMemo(() => {
    let n = 0;
    for (const fields of Object.values(edits)) {
      for (const v of Object.values(fields)) {
        if (String(v).trim() !== "") n += 1;
      }
    }
    return n;
  }, [edits]);

  async function saveAll() {
    if (saving) return;
    const payload: Array<{
      productId: string;
      fields: Array<{ field: string; value: string; kind: FieldKind }>;
    }> = [];
    for (const [productId, fields] of Object.entries(edits)) {
      const filled = Object.entries(fields)
        .filter(([, v]) => String(v).trim() !== "")
        .map(([field, value]) => ({
          field,
          value: String(value).trim(),
          kind: fieldKindByName[field] ?? ("field" as FieldKind),
        }));
      if (filled.length > 0) payload.push({ productId, fields: filled });
    }
    if (payload.length === 0) {
      toast({ title: "Nothing to save", description: "Fill in at least one field first." });
      return;
    }
    setSaving(true);
    try {
      const res = await apiRequest("POST", "/api/jomashop/bulk-fill/apply", {
        confirm: true,
        saveAsMapping,
        edits: payload,
      });
      const body = (await res.json()) as ApplyResponse;
      const newlyReady: Record<string, boolean> = {};
      let validationFails = 0;
      for (const p of body.products) {
        if (p.push_ready) newlyReady[p.productId] = true;
        validationFails += p.fields.filter((f) => f.validationError).length;
      }
      setReadyOverride((prev) => ({ ...prev, ...newlyReady }));
      toast({
        title: `Saved ${body.totalWritten} value(s)${
          body.totalMappingsSaved > 0 ? ` · ${body.totalMappingsSaved} reusable mapping(s)` : ""
        }`,
        description: body.needsRefresh
          ? `${body.nowReady} ready · brand/category mappings saved — Refresh from Shopify on Products to re-verify, then push.`
          : `${body.nowReady} product(s) now ready to push${
              body.totalFailed > 0 ? ` · ${body.totalFailed} failed (${validationFails} validation)` : ""
            }.`,
        variant: body.totalFailed > 0 ? "destructive" : "default",
      });
      // Clear edits that were successfully written; keep failed ones so the
      // operator can correct them.
      setEdits((prev) => {
        const next = { ...prev };
        for (const p of body.products) {
          const okFields = new Set(p.fields.filter((f) => f.ok).map((f) => f.field));
          if (next[p.productId]) {
            const remaining: Record<string, string> = {};
            for (const [field, value] of Object.entries(next[p.productId])) {
              if (!okFields.has(field)) remaining[field] = value;
            }
            if (Object.keys(remaining).length === 0) delete next[p.productId];
            else next[p.productId] = remaining;
          }
        }
        return next;
      });
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const readyProductIds = useMemo(() => {
    const ids: string[] = [];
    if (!data) return ids;
    for (const g of data.categories) {
      for (const r of g.rows) {
        if (readyOverride[r.productId]) ids.push(r.productId);
      }
    }
    return ids;
  }, [data, readyOverride]);

  async function pushReady() {
    if (pushing || readyProductIds.length === 0) return;
    setPushing(true);
    setPushProgress(null);
    try {
      const res = await apiRequest("POST", "/api/jomashop/push-products-bulk", {
        confirm: true,
        productIds: readyProductIds,
        pushInventory: true,
      });
      const body = (await res.json()) as { pushed: number; failed: number; total: number };
      setPushProgress({ pushed: body.pushed, failed: body.failed, total: body.total });
      toast({
        title: `Pushed ${body.pushed}/${body.total}`,
        description: body.failed > 0 ? `${body.failed} failed — check Logs for details.` : "All ready rows pushed.",
        variant: body.failed > 0 ? "destructive" : "default",
      });
      // Refresh the grid so pushed rows drop out.
      gridQ.refetch();
      setReadyOverride({});
    } catch (err) {
      toast({ title: "Bulk push failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setPushing(false);
    }
  }

  if (gridQ.isLoading) return <LoadingRows count={6} />;
  if (gridQ.isError) return <ErrorBlock message={(gridQ.error as Error).message} />;
  if (!data) return null;

  const hasRows = data.categories.some((g) => g.rows.length > 0);

  return (
    <>
      <PageHeader
        title="Bulk fill"
        description="Fill every product-level required Jomashop field in one grid, then push the rows that become ready — the fast path to go live."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => gridQ.refetch()}
              disabled={gridQ.isFetching}
              data-testid="button-bulkfill-reload"
            >
              {gridQ.isFetching ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
              )}
              Reload
            </Button>
            <Button onClick={saveAll} disabled={saving || editedCount === 0} data-testid="button-bulkfill-save">
              {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
              Save {editedCount > 0 ? `(${editedCount})` : "all"}
            </Button>
            <Button
              variant="default"
              onClick={pushReady}
              disabled={pushing || readyProductIds.length === 0}
              data-testid="button-bulkfill-push"
              title="Push every row that became ready after saving."
            >
              {pushing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-2 h-3.5 w-3.5" />}
              Push ready ({readyProductIds.length})
            </Button>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3 text-xs">
        <Badge variant="outline" className="gap-1">
          {data.unreadyProducts} not ready
        </Badge>
        <Badge variant="outline" className="gap-1">
          {data.totalProducts} total in cache
        </Badge>
        <label className="flex items-center gap-1.5" title="Save each fix as a reusable enum/brand/category mapping so the same issue auto-resolves on future products.">
          <input
            type="checkbox"
            checked={saveAsMapping}
            onChange={(e) => setSaveAsMapping(e.target.checked)}
            data-testid="checkbox-save-as-mapping"
          />
          Save fixes as reusable mappings
        </label>
        {!data.shopifyConnected && (
          <span className="text-amber-500">
            No connected Shopify store — saving requires an OAuth-installed store.
          </span>
        )}
        {pushProgress && (
          <span data-testid="text-bulkfill-push-result" className="text-muted-foreground">
            Last push: {pushProgress.pushed} ok, {pushProgress.failed} failed of {pushProgress.total}.
          </span>
        )}
      </div>

      {!hasRows ? (
        <EmptyState
          title="Nothing to fill"
          description={
            data.note ||
            "Every cached product already has its required Jomashop fields. Refresh from Shopify on the Products page if you expect more."
          }
          icon={CheckCircle2}
        />
      ) : (
        <div className="space-y-8">
          {data.categories.map((group) => (
            <CategoryGridCard
              key={group.category}
              group={group}
              edits={edits}
              readyOverride={readyOverride}
              cellValue={cellValue}
              setCell={setCell}
              fillDown={fillDown}
            />
          ))}
        </div>
      )}
    </>
  );
}

function CategoryGridCard({
  group,
  edits,
  readyOverride,
  cellValue,
  setCell,
  fillDown,
}: {
  group: CategoryGroup;
  edits: Edits;
  readyOverride: Record<string, boolean>;
  cellValue: (row: Row, field: string) => string;
  setCell: (productId: string, field: string, value: string) => void;
  fillDown: (group: CategoryGroup, field: string, value: string) => void;
}) {
  const [fillValues, setFillValues] = useState<Record<string, string>>({});

  return (
    <Card data-testid={`bulkfill-category-${group.category}`}>
      <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
        <CardTitle className="text-sm">
          {group.category} <span className="text-muted-foreground">· {group.rows.length} product(s)</span>
        </CardTitle>
        <Badge variant="outline" className="text-[10px] uppercase">
          schema: {group.schemaSource}
        </Badge>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-card-border bg-card/40 text-left align-top">
              <th className="sticky left-0 z-10 bg-card/40 px-3 py-2 font-medium">Product</th>
              {group.fields.map((f) => (
                <th key={f.field} className="min-w-[180px] px-3 py-2 font-medium">
                  <div className="flex items-center gap-1">
                    {f.field}
                    {f.required && <span className="text-destructive">*</span>}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                    {f.metafieldTarget}
                  </div>
                  {/* Fill-down control */}
                  <div className="mt-1.5 flex items-center gap-1">
                    {f.type === "enum" && f.options.length > 0 && !f.options_unverified && !f.multiple ? (
                      <Select
                        value={fillValues[f.field] ?? ""}
                        onValueChange={(v) => setFillValues((p) => ({ ...p, [f.field]: v }))}
                      >
                        <SelectTrigger className="h-7 w-full text-[11px]">
                          <SelectValue placeholder="fill all…" />
                        </SelectTrigger>
                        <SelectContent>
                          {f.options.map((opt) => (
                            <SelectItem key={opt} value={opt} className="text-[11px]">
                              {opt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={fillValues[f.field] ?? ""}
                        onChange={(e) => setFillValues((p) => ({ ...p, [f.field]: e.target.value }))}
                        placeholder="fill all…"
                        className="h-7 text-[11px]"
                      />
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      title={`Apply "${fillValues[f.field] ?? ""}" to every row needing ${f.field}`}
                      onClick={() => fillDown(group, f.field, fillValues[f.field] ?? "")}
                      data-testid={`button-filldown-${group.category}-${f.field}`}
                    >
                      <ArrowDownToLine className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => {
              const isReady = readyOverride[row.productId];
              return (
                <tr
                  key={row.productId}
                  className="border-b border-card-border last:border-0"
                  data-testid={`bulkfill-row-${row.productId}`}
                >
                  <td className="sticky left-0 z-10 max-w-[240px] bg-background px-3 py-2 align-top">
                    <div className="flex items-start gap-2">
                      {row.image && (
                        <img
                          src={row.image}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded border border-border object-cover"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="truncate font-medium" title={row.name}>
                          {row.name || "(untitled)"}
                        </div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground">{row.sku}</div>
                        {isReady && (
                          <Badge variant="default" className="mt-1 gap-1 text-[10px]">
                            <CheckCircle2 className="h-3 w-3" /> ready
                          </Badge>
                        )}
                      </div>
                    </div>
                  </td>
                  {group.fields.map((f) => {
                    const cell = row.cells[f.field];
                    const value = cellValue(row, f.field);
                    const edited = edits[row.productId]?.[f.field] !== undefined;
                    const needs = cell && cell.status !== "ok";
                    // Cells where this column isn't part of the row's repair set
                    // (the product already has this field) are read-only context.
                    const applicable = Boolean(cell);
                    const tone = !applicable
                      ? ""
                      : edited
                        ? "ring-1 ring-primary/50"
                        : cell.status === "invalid"
                          ? "ring-1 ring-destructive/50"
                          : cell.status === "missing"
                            ? "ring-1 ring-amber-500/40"
                            : "";
                    if (!applicable) {
                      return (
                        <td key={f.field} className="px-3 py-2 align-top text-muted-foreground/60">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={f.field} className="px-3 py-2 align-top">
                        {f.type === "enum" && f.options.length > 0 && !f.options_unverified && !f.multiple ? (
                          <Select value={value} onValueChange={(v) => setCell(row.productId, f.field, v)}>
                            <SelectTrigger className={`h-8 text-xs ${tone}`} data-testid={`cell-${row.productId}-${f.field}`}>
                              <SelectValue placeholder={needs ? "select…" : ""} />
                            </SelectTrigger>
                            <SelectContent>
                              {f.options.map((opt) => (
                                <SelectItem key={opt} value={opt} className="text-xs">
                                  {opt}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            value={value}
                            onChange={(e) => setCell(row.productId, f.field, e.target.value)}
                            placeholder={
                              cell.status === "invalid"
                                ? `invalid: ${cell.invalidValue}`
                                : needs
                                  ? "enter…"
                                  : ""
                            }
                            type={f.type === "number" || f.type === "integer" ? "number" : "text"}
                            className={`h-8 text-xs ${tone}`}
                            data-testid={`cell-${row.productId}-${f.field}`}
                          />
                        )}
                        {(f.kind === "brand" || f.kind === "category") && cell.invalidValue && (
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={cell.invalidValue}>
                            Shopify: {cell.invalidValue} → saved as mapping
                          </div>
                        )}
                        {f.kind !== "brand" && f.kind !== "category" && cell.status === "invalid" && !edited && (
                          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-destructive">
                            <XCircle className="h-3 w-3" /> not in accepted list
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
