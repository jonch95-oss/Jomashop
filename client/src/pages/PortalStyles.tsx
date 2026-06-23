import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCcw, Upload, ClipboardPaste, AlertTriangle, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, EmptyState, ErrorBlock, LoadingRows } from "@/components/AppShell";
import { apiRequest } from "@/lib/queryClient";
import { authHeaders } from "@/lib/adminToken";

/**
 * Portal Styles — reconciles a Vendor Portal inventory export (CSV/XLSX/paste)
 * against the cached Shopify catalog so the operator can see what is actually
 * live in Jomashop before pushing inventory or fulfilling orders. Import is
 * file/export based on purpose: the portal has no API yet and we never scrape.
 */

type MatchStatus =
  | "Confirmed Live"
  | "Active in Portal"
  | "Inactive in Portal"
  | "Portal Missing"
  | "Needs Review"
  | "Unmatched Portal Row";

type ReconciledStyle = {
  vendor_sku: string;
  jomashop_sku: string | null;
  name: string | null;
  brand: string | null;
  category: string | null;
  status: string | null;
  joma_status: string | null;
  qty: number | null;
  price: number | null;
  msrp: number | null;
  match_status: MatchStatus;
  match_confidence: string;
  matched_shopify_product_id: string | null;
  matched_shopify_variant_id: string | null;
  matched_shopify_sku: string | null;
  inventory_eligible: boolean;
};

type PortalMissing = { vendor_sku: string; brand: string; name: string; push_state: string };

type StylesResponse = {
  ok: boolean;
  count: number;
  summary: Record<string, number> & { portal_missing: number; total: number };
  styles: ReconciledStyle[];
  portal_missing: PortalMissing[];
};

const STATUS_TONE: Record<MatchStatus, string> = {
  "Confirmed Live": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "Active in Portal": "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  "Inactive in Portal": "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400",
  "Portal Missing": "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  "Needs Review": "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "Unmatched Portal Row": "bg-red-500/10 text-red-700 dark:text-red-400",
};

function money(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(2)}`;
}

export default function PortalStyles() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MatchStatus | "All">("All");

  const stylesQ = useQuery<StylesResponse>({
    queryKey: ["/api/portal/styles"],
    queryFn: async () => {
      const res = await fetch("/api/portal/styles", { credentials: "include", headers: authHeaders() });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  async function uploadFile(file: File) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/portal/import", {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: fd,
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `Import failed (${res.status})`);
      setNotice(`Imported ${body.imported} style(s)${body.skipped ? `, ${body.skipped} skipped` : ""}.`);
      stylesQ.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function importPaste() {
    if (!paste.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest("POST", "/api/portal/import", { csv: paste });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || "Import failed");
      setNotice(`Imported ${body.imported} style(s)${body.skipped ? `, ${body.skipped} skipped` : ""}.`);
      setPaste("");
      stylesQ.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const data = stylesQ.data;
  const styles = data?.styles ?? [];
  const summary = data?.summary;

  const visible = useMemo(
    () => (filter === "All" ? styles : styles.filter((s) => s.match_status === filter)),
    [styles, filter],
  );

  const statusCounts: Array<[MatchStatus, number]> = useMemo(() => {
    const order: MatchStatus[] = [
      "Confirmed Live",
      "Active in Portal",
      "Inactive in Portal",
      "Needs Review",
      "Unmatched Portal Row",
    ];
    return order.map((s) => [s, summary?.[s] ?? 0]);
  }, [summary]);

  return (
    <div>
      <PageHeader
        title="Portal Styles"
        description="Reconcile a Vendor Portal inventory export against the Shopify catalog. Import CSV/XLSX or paste rows — no portal API or scraping required."
        actions={
          <Button variant="outline" size="sm" onClick={() => stylesQ.refetch()} disabled={stylesQ.isFetching}>
            <RefreshCcw className={stylesQ.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
              }}
            />
            <Button onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload CSV / XLSX
            </Button>
            <span className="text-sm text-muted-foreground">
              Expected columns: Status / Joma Status, SKU, Jomashop SKU, Name, Category, Qty, Price, MSRP, Date Created, Date Updated.
            </span>
          </div>

          <div className="mt-4">
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="Or paste CSV rows here (first line = headers)…"
              className="w-full h-28 rounded-md border bg-background p-2 font-mono text-xs"
            />
            <div className="mt-2 flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={importPaste} disabled={busy || !paste.trim()}>
                <ClipboardPaste className="h-4 w-4" />
                Import pasted rows
              </Button>
              {notice && <span className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</span>}
              {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      {summary && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setFilter("All")}
            className={filter === "All" ? "rounded-md border px-3 py-1.5 text-sm bg-muted" : "rounded-md border px-3 py-1.5 text-sm"}
          >
            All <span className="ml-1 text-muted-foreground">{summary.total}</span>
          </button>
          {statusCounts.map(([s, n]) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={filter === s ? "rounded-md border px-3 py-1.5 text-sm bg-muted" : "rounded-md border px-3 py-1.5 text-sm"}
            >
              <Badge className={STATUS_TONE[s]}>{s}</Badge>
              <span className="ml-2 text-muted-foreground">{n}</span>
            </button>
          ))}
          {summary.portal_missing > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md border border-orange-500/30 px-3 py-1.5 text-sm text-orange-700 dark:text-orange-400">
              <AlertTriangle className="h-4 w-4" />
              {summary.portal_missing} pushed product(s) missing from portal
            </span>
          )}
        </div>
      )}

      {stylesQ.isLoading ? (
        <LoadingRows count={6} />
      ) : stylesQ.error ? (
        <ErrorBlock message={(stylesQ.error as Error).message} />
      ) : styles.length === 0 ? (
        <EmptyState
          title="No portal styles imported yet"
          description="Upload your Vendor Portal inventory export (CSV/XLSX) or paste the rows above to reconcile against the Shopify catalog."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Vendor SKU</th>
                    <th className="px-3 py-2">Jomashop SKU</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2">Matched Shopify</th>
                    <th className="px-3 py-2">Confidence</th>
                    <th className="px-3 py-2">Inventory push</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => (
                    <tr key={s.vendor_sku} className="border-b hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <Badge className={STATUS_TONE[s.match_status]}>{s.match_status}</Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{s.vendor_sku}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.jomashop_sku || "—"}</td>
                      <td className="px-3 py-2 max-w-[22rem] truncate" title={s.name || ""}>
                        {s.name || "—"}
                        {s.brand ? <span className="ml-1 text-muted-foreground">· {s.brand}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right">{s.qty ?? "—"}</td>
                      <td className="px-3 py-2 text-right">{money(s.price)}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {s.matched_shopify_sku || s.matched_shopify_product_id || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{s.match_confidence}</td>
                      <td className="px-3 py-2">
                        {s.inventory_eligible ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck className="h-4 w-4" /> Eligible
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <AlertTriangle className="h-4 w-4" /> Blocked
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
