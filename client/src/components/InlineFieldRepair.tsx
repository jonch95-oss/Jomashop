import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Save, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

/**
 * Per-product inline field repair: lets the operator fill in missing or
 * invalid Jomashop schema fields directly from the Products page without
 * leaving for the bulk Excel workflow. Wires to:
 *
 *   GET  /api/jomashop/inline-field-repair/:productId
 *   POST /api/jomashop/inline-field-repair
 *
 * Inputs are schema-driven: enum fields render as `<Select>` populated from
 * the live `data.values`; numeric / string fields render as `<Input>` with
 * the schema's bounds and validation hints. On Save the metafield target is
 * displayed so the operator can verify where the value landed. After a
 * successful save the parent product list is refetched and the Push button
 * is automatically un-blocked when the row becomes push-ready.
 */

export type InlineFieldRepairProps = {
  productId: string | number;
  /** When non-empty, only these fields are surfaced in the repair UI. */
  missingFields?: string[];
  /** Called after a successful save so the parent list can refresh. */
  onSaved?: (result: SaveResult) => void;
  /** Called when the operator clicks "Save & Push" after a successful save. */
  onSaveAndPush?: () => void;
  /** Hide the Save & Push button. */
  hidePushButton?: boolean;
};

type RepairFieldDescriptor = {
  field: string;
  required: boolean;
  type: string;
  options: string[];
  options_unverified: boolean;
  multiple: boolean;
  min_value?: number;
  max_value?: number;
  only_integer?: boolean;
  min_length?: number;
  max_length?: number;
  isVariantTargeted: boolean;
  metafieldTarget: string;
  currentValue: string;
  /** When status === "invalid", the offending value the mapper saw. The UI
   *  pre-populates the input with this so the operator can correct it. */
  invalidValue?: string;
  /** "ok"   — current value satisfies the schema.
   *  "missing" — no value present (or "undefined" placeholder).
   *  "invalid" — value present but failed enum coercion / schema validation. */
  status?: "ok" | "missing" | "invalid";
  /** True when this field MUST be repaired before push (required+missing or
   *  invalid). The UI uses this as the default focus list when the parent
   *  doesn't pass an explicit `missingFields`. */
  needsRepair?: boolean;
};

type SchemaResponse = {
  ok: boolean;
  error?: string;
  productId?: string;
  shopDomain?: string | null;
  fromCache?: boolean;
  category?: string;
  /** The raw Shopify category code/string before canonical aliasing. The UI
   *  uses this together with `categoryAliased` to display
   *  "Apparel (was: Clothing)" instead of "not found in /i1/categories" when
   *  the alias resolves cleanly. */
  sourceCategory?: string;
  categoryAliased?: boolean;
  schemaSource?: "live-v1" | "live-i1" | "fallback" | "unknown";
  fields?: RepairFieldDescriptor[];
};

type SaveResult = {
  ok: boolean;
  error?: string;
  productId?: string;
  category?: string;
  results?: Array<{
    field: string;
    ok: boolean;
    ownerType: "product" | "variant";
    namespace: string;
    key: string;
    metafieldTarget: string;
    error: string | null;
    validationError: string | null;
  }>;
  postRepair?: {
    missing_required: string[];
    missing_top_level: string[];
    invalid_enums: Array<{ field: string; value: string; options: string[] }>;
    push_ready: boolean;
    /** Full remapped compact product for the parent to splice into the
     *  visible list — keeps the card in sync with the backend without
     *  waiting for a full /api/products/refresh. */
    product?: any;
  } | null;
};

type RepairFilter = "required" | "optional" | "invalid" | "all";

export function InlineFieldRepair({
  productId,
  missingFields,
  onSaved,
  onSaveAndPush,
  hidePushButton,
}: InlineFieldRepairProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [lastResult, setLastResult] = useState<SaveResult | null>(null);

  const schemaQ = useQuery<SchemaResponse>({
    queryKey: ["/api/jomashop/inline-field-repair", String(productId)],
    queryFn: async () => {
      const res = await fetch(`/api/jomashop/inline-field-repair/${encodeURIComponent(String(productId))}`, {
        credentials: "include",
        headers: authHeaders(),
      });
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const missingSet = useMemo(() => {
    const s = new Set<string>();
    for (const f of missingFields || []) {
      if (typeof f === "string" && f.trim() !== "") s.add(f.toLowerCase().trim());
    }
    return s;
  }, [missingFields]);

  const allFields: RepairFieldDescriptor[] = useMemo(() => {
    return Array.isArray(schemaQ.data?.fields) ? schemaQ.data!.fields! : [];
  }, [schemaQ.data]);

  // Active filter — defaults to Required + Invalid so the operator focuses
  // on push-blocking fields first. They can expand to Optional or All any
  // time without leaving the page.
  const [filter, setFilter] = useState<RepairFilter>("required");

  // Apply the selected filter to allFields. "required" surfaces required+
  // missing AND invalid (anything that blocks push), "optional" surfaces
  // recommended/optional fields that have no current value (editable but
  // never blocking), "invalid" narrows to enum-coercion failures only,
  // "all" shows every schema field so the operator can edit a populated
  // value in place.
  const focusFields = useMemo(() => {
    const out = new Map<string, RepairFieldDescriptor>();
    const isRequiredMissing = (f: RepairFieldDescriptor) =>
      f.required === true && f.status === "missing";
    const isInvalid = (f: RepairFieldDescriptor) => f.status === "invalid";
    const isOptionalMissing = (f: RepairFieldDescriptor) =>
      f.required !== true && f.status === "missing";
    for (const f of allFields) {
      if (filter === "all") {
        out.set(f.field, f);
        continue;
      }
      if (filter === "required" && (isRequiredMissing(f) || isInvalid(f))) {
        out.set(f.field, f);
        continue;
      }
      if (filter === "optional" && isOptionalMissing(f)) {
        out.set(f.field, f);
        continue;
      }
      if (filter === "invalid" && isInvalid(f)) {
        out.set(f.field, f);
        continue;
      }
    }
    // Parent-supplied missing fields (case-insensitive label match) get
    // pulled in regardless of the filter — keeps the inline panel and the
    // per-row "Missing: …" badge consistent.
    if (missingSet.size > 0 && filter !== "invalid") {
      for (const f of allFields) {
        if (missingSet.has(f.field.toLowerCase().trim())) {
          out.set(f.field, f);
        }
      }
    }
    return Array.from(out.values());
  }, [allFields, missingSet, filter]);

  // Tallies for the filter chips so the operator can see at a glance how
  // many fields fall into each bucket.
  const filterCounts = useMemo(() => {
    let requiredMissing = 0;
    let invalid = 0;
    let optionalMissing = 0;
    for (const f of allFields) {
      if (f.required === true && f.status === "missing") requiredMissing += 1;
      if (f.status === "invalid") invalid += 1;
      if (f.required !== true && f.status === "missing") optionalMissing += 1;
    }
    return {
      required: requiredMissing + invalid,
      optional: optionalMissing,
      invalid,
      all: allFields.length,
    };
  }, [allFields]);

  const visibleFields = focusFields;

  // Reset working values whenever the schema changes (e.g. after a save +
  // refetch). Pre-populate with current values so editing-in-place works.
  // For invalid-enum fields the mapper drops the source value (it failed
  // coercion) — but the server echoes the offending value back as
  // `invalidValue` so the input/select can render it for the operator to
  // correct without having to re-enter the original.
  useEffect(() => {
    if (!Array.isArray(allFields) || allFields.length === 0) return;
    const next: Record<string, string> = {};
    for (const f of allFields) {
      const cur = f.currentValue ?? "";
      next[f.field] = cur || (f.status === "invalid" ? (f.invalidValue ?? "") : "");
    }
    setValues((prev) => {
      // Preserve any in-progress edits the operator hasn't saved yet.
      const merged = { ...next };
      for (const [k, v] of Object.entries(prev)) {
        if (v !== "" && v !== undefined && v !== null) merged[k] = v;
      }
      return merged;
    });
  }, [allFields]);

  function setVal(field: string, v: string) {
    setValues((prev) => ({ ...prev, [field]: v }));
  }

  function clientValidate(f: RepairFieldDescriptor, raw: string): string | null {
    const val = String(raw ?? "").trim();
    if (val === "") {
      return f.required ? "Required." : null;
    }
    if (f.type === "enum" && Array.isArray(f.options) && f.options.length > 0) {
      const set = new Set(f.options.map((o) => o.toLowerCase().trim()));
      const tokens = f.multiple
        ? val.split(",").map((t) => t.trim()).filter((t) => t !== "")
        : [val.trim()];
      const bad = tokens.filter((t) => !set.has(t.toLowerCase().trim()));
      if (bad.length > 0) return `"${bad.join(", ")}" not in accepted options.`;
    }
    if (f.type === "number" || f.type === "integer" || f.only_integer) {
      const n = Number(val);
      if (!Number.isFinite(n)) return "Must be a number.";
      if ((f.only_integer || f.type === "integer") && !Number.isInteger(n)) return "Must be an integer.";
      if (typeof f.min_value === "number" && n < f.min_value) return `Must be ≥ ${f.min_value}.`;
      if (typeof f.max_value === "number" && n > f.max_value) return `Must be ≤ ${f.max_value}.`;
    }
    if (f.type === "string" || (!f.type && !(Array.isArray(f.options) && f.options.length > 0))) {
      if (typeof f.min_length === "number" && val.length < f.min_length) return `Length ≥ ${f.min_length}.`;
      if (typeof f.max_length === "number" && val.length > f.max_length) return `Length ≤ ${f.max_length}.`;
    }
    if (val.length > 1000) return "Exceeds 1000 character cap.";
    return null;
  }

  async function save(opts: { pushAfter?: boolean } = {}) {
    setSaving(true);
    setLastResult(null);
    try {
      // Only submit fields the operator actually filled (non-blank). The
      // backend re-validates everything sent.
      const fields = visibleFields
        .map((f) => ({ field: f.field, value: String(values[f.field] ?? "").trim() }))
        .filter((entry) => entry.value !== "");
      if (fields.length === 0) {
        setLastResult({ ok: false, error: "Nothing to save — fill at least one field." });
        return;
      }
      const res = await apiRequest("POST", "/api/jomashop/inline-field-repair", {
        productId: String(productId),
        confirm: true,
        fields,
      });
      const body = (await res.json()) as SaveResult;
      setLastResult(body);
      if (body.ok) {
        // Refetch the per-product schema so currentValue updates reflect the
        // values we just wrote, then notify parent. The parent uses the
        // postRepair.product on the response to splice the remapped row
        // into the visible list immediately — no waiting for a cache
        // refresh round-trip.
        schemaQ.refetch();
        onSaved?.(body);
        if (opts.pushAfter && body.postRepair && body.postRepair.push_ready) {
          onSaveAndPush?.();
        } else if (opts.pushAfter) {
          // Save succeeded but the product is still not push-ready (a
          // required field elsewhere is still blank). Don't push.
        }
      }
    } catch (err) {
      setLastResult({ ok: false, error: (err as Error).message || "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  if (schemaQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading Jomashop schema…
      </div>
    );
  }
  if (schemaQ.isError) {
    return (
      <div className="text-xs text-red-600 dark:text-red-400">
        Failed to load schema: {(schemaQ.error as Error)?.message || "unknown error"}
      </div>
    );
  }
  const schema = schemaQ.data;
  if (!schema || !schema.ok) {
    return (
      <div className="text-xs text-red-600 dark:text-red-400">
        {schema?.error || "Schema unavailable."}
      </div>
    );
  }
  const pushReadyAfterSave = lastResult?.ok && lastResult?.postRepair?.push_ready === true;

  // Filter chip definitions — order matters: Required first because it is
  // the default and the most actionable bucket.
  const filterChips: Array<{ id: RepairFilter; label: string; count: number; title: string }> = [
    {
      id: "required",
      label: "Required missing",
      count: filterCounts.required,
      title: "Required category attributes that are missing OR invalid — must be repaired before push.",
    },
    {
      id: "optional",
      label: "Optional missing",
      count: filterCounts.optional,
      title: "Recommended attributes with no current value — editable but never blocking.",
    },
    {
      id: "invalid",
      label: "Invalid",
      count: filterCounts.invalid,
      title: "Existing values that failed enum coercion against Jomashop's accepted-options list.",
    },
    {
      id: "all",
      label: "All fields",
      count: filterCounts.all,
      title: "Every schema attribute — use to edit an already-populated value.",
    },
  ];

  if (visibleFields.length === 0) {
    return (
      <div
        className="space-y-2"
        data-testid={`inline-repair-${productId}`}
      >
        <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {filter === "required"
            ? "No required or invalid fields remain — product is push-ready."
            : "No fields in the selected filter."}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {filterChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              title={chip.title}
              data-testid={`button-filter-${chip.id}-${productId}`}
              className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-wider transition ${
                filter === chip.id
                  ? "border-foreground bg-foreground text-background"
                  : "border-card-border bg-card/40 text-muted-foreground hover:bg-card"
              }`}
            >
              {chip.label} {chip.count > 0 && <span className="ml-1 tabular-nums">{chip.count}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid={`inline-repair-${productId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>
            Category: <span className="text-foreground">{schema.category}</span>
            {schema.categoryAliased && schema.sourceCategory && (
              <span
                className="ml-1 text-[10px] text-muted-foreground"
                title={`Shopify code "${schema.sourceCategory}" is mapped to the canonical Jomashop category "${schema.category}".`}
                data-testid={`text-category-aliased-${productId}`}
              >
                (alias of {schema.sourceCategory})
              </span>
            )}
          </span>
          <span>·</span>
          <span>
            Schema: <span className="text-foreground">{schema.schemaSource}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {filterChips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={() => setFilter(chip.id)}
            title={chip.title}
            data-testid={`button-filter-${chip.id}-${productId}`}
            className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-wider transition ${
              filter === chip.id
                ? "border-foreground bg-foreground text-background"
                : "border-card-border bg-card/40 text-muted-foreground hover:bg-card"
            }`}
          >
            {chip.label} {chip.count > 0 && <span className="ml-1 tabular-nums">{chip.count}</span>}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {visibleFields.map((f) => {
          const v = values[f.field] ?? "";
          const validationErr = clientValidate(f, v);
          const resultForField = lastResult?.results?.find((r) => r.field === f.field);
          return (
            <div
              key={f.field}
              className="space-y-1 rounded-md border border-card-border bg-card/40 p-2"
              data-testid={`field-row-${productId}-${f.field}`}
            >
              <div className="flex flex-wrap items-center gap-1">
                <Label className="text-[11px] uppercase tracking-wider">
                  {f.field}
                </Label>
                {f.required ? (
                  <Badge
                    variant="outline"
                    className="bg-red-500/10 text-[9px] uppercase text-red-600 dark:text-red-400"
                    title="Required by the Jomashop category schema — must be set before push."
                    data-testid={`badge-required-${productId}-${f.field}`}
                  >
                    required
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="bg-muted/20 text-[9px] uppercase text-muted-foreground"
                    title="Optional / recommended — editable but does not block push."
                    data-testid={`badge-optional-${productId}-${f.field}`}
                  >
                    optional
                  </Badge>
                )}
                {f.status === "invalid" && (
                  <Badge
                    variant="outline"
                    className="bg-amber-500/15 text-[9px] uppercase text-amber-700 dark:text-amber-400"
                    title={
                      f.invalidValue
                        ? `Current Shopify value "${f.invalidValue}" failed schema validation.`
                        : "Current value failed schema validation."
                    }
                    data-testid={`badge-invalid-${productId}-${f.field}`}
                  >
                    invalid
                  </Badge>
                )}
                {f.status === "missing" && !f.required && (
                  <Badge
                    variant="outline"
                    className="text-[9px] uppercase text-muted-foreground"
                    data-testid={`badge-missing-${productId}-${f.field}`}
                  >
                    missing
                  </Badge>
                )}
                {f.isVariantTargeted && (
                  <Badge variant="outline" className="text-[9px] uppercase">
                    variant
                  </Badge>
                )}
                {f.options_unverified && (
                  <Badge variant="outline" className="bg-amber-500/10 text-[9px] uppercase text-amber-700 dark:text-amber-400">
                    options unverified
                  </Badge>
                )}
              </div>

              {f.type === "enum" && Array.isArray(f.options) && f.options.length > 0 ? (
                <Select
                  value={v}
                  onValueChange={(nv) => setVal(f.field, nv)}
                >
                  <SelectTrigger
                    className="h-8 text-xs"
                    data-testid={`select-${productId}-${f.field}`}
                  >
                    <SelectValue placeholder={`Choose ${f.field.toLowerCase()}…`} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {f.options.map((opt) => (
                      <SelectItem key={opt} value={opt} className="text-xs">
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : f.type === "number" || f.type === "integer" || f.only_integer ? (
                <Input
                  type="number"
                  inputMode={f.only_integer || f.type === "integer" ? "numeric" : "decimal"}
                  step={f.only_integer || f.type === "integer" ? 1 : "any"}
                  min={typeof f.min_value === "number" ? f.min_value : undefined}
                  max={typeof f.max_value === "number" ? f.max_value : undefined}
                  value={v}
                  onChange={(e) => setVal(f.field, e.target.value)}
                  placeholder={`Enter ${f.field.toLowerCase()}…`}
                  className="h-8 text-xs"
                  data-testid={`input-${productId}-${f.field}`}
                />
              ) : (
                <Input
                  type="text"
                  value={v}
                  onChange={(e) => setVal(f.field, e.target.value)}
                  placeholder={`Enter ${f.field.toLowerCase()}…`}
                  maxLength={typeof f.max_length === "number" ? f.max_length : 1000}
                  className="h-8 text-xs"
                  data-testid={`input-${productId}-${f.field}`}
                />
              )}

              <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-muted-foreground">
                <div>
                  Target:{" "}
                  <code className="font-mono text-[10px]">{f.metafieldTarget}</code>
                  {f.isVariantTargeted && " (variant)"}
                </div>
                {validationErr ? (
                  <span className="text-red-600 dark:text-red-400">{validationErr}</span>
                ) : null}
              </div>
              {resultForField && (
                <div
                  className={`text-[10px] ${resultForField.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                  data-testid={`field-result-${productId}-${f.field}`}
                >
                  {resultForField.ok ? (
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Wrote to{" "}
                      <code className="font-mono">{resultForField.metafieldTarget}</code>{" "}
                      ({resultForField.ownerType})
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <XCircle className="h-3 w-3" />
                      {resultForField.validationError || resultForField.error}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => save({ pushAfter: false })}
          disabled={saving}
          data-testid={`button-save-fields-${productId}`}
        >
          {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-2 h-3.5 w-3.5" />}
          Save
        </Button>
        {!hidePushButton && (
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => save({ pushAfter: true })}
            disabled={saving}
            data-testid={`button-save-and-push-${productId}`}
          >
            {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-2 h-3.5 w-3.5" />}
            Save &amp; Push
          </Button>
        )}
      </div>

      {lastResult && !lastResult.ok && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-700 dark:text-red-300">
          <div className="flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            <strong>Save failed.</strong>
          </div>
          {lastResult.error && <div className="mt-1">{lastResult.error}</div>}
        </div>
      )}
      {lastResult && lastResult.ok && (
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px] text-emerald-700 dark:text-emerald-300"
          data-testid={`inline-repair-success-${productId}`}
        >
          <div className="flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <strong>
              Saved {lastResult.results?.filter((r) => r.ok).length ?? 0} field(s)
              {lastResult.postRepair
                ? pushReadyAfterSave
                  ? " — product is now push-ready"
                  : ` — ${lastResult.postRepair.missing_required.length + lastResult.postRepair.missing_top_level.length} required field(s) still missing`
                : ""}
              .
            </strong>
          </div>
          {lastResult.postRepair && !pushReadyAfterSave && (
            <div className="mt-1">
              Still missing:{" "}
              {[
                ...lastResult.postRepair.missing_top_level,
                ...lastResult.postRepair.missing_required,
              ].join(", ") || "—"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
