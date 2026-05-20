import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Activity, CheckCircle2, AlertTriangle, Circle, ArrowRight, Server, KeyRound, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, LoadingRows, ErrorBlock } from "@/components/AppShell";
import type { ConfigStatus, SyncJob } from "@/lib/types";

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
      aria-hidden
    />
  );
}

export default function Overview() {
  const cfg = useQuery<ConfigStatus>({ queryKey: ["/api/config/status"] });
  const jobs = useQuery<SyncJob[]>({ queryKey: ["/api/sync-jobs"] });

  const checklistItems = cfg.data
    ? [
        { label: "Shopify Client ID set", ok: cfg.data.shopify.clientIdConfigured, href: "/setup" },
        { label: "Shopify Client Secret set", ok: cfg.data.shopify.clientSecretConfigured, href: "/setup" },
        { label: "App URL configured", ok: cfg.data.shopify.appUrlConfigured, href: "/setup" },
        { label: "Jomashop email set", ok: cfg.data.jomashop.emailConfigured, href: "/setup" },
        { label: "Jomashop password set", ok: cfg.data.jomashop.passwordConfigured, href: "/setup" },
        { label: "Jomashop session active", ok: cfg.data.jomashop.sessionActive, href: "/setup" },
      ]
    : [];

  const readyCount = checklistItems.filter((i) => i.ok).length;
  const totalCount = checklistItems.length || 1;

  return (
    <>
      <PageHeader
        title="Operations overview"
        description="Sync state between LuxeSupply's Shopify catalog and the Jomashop Vendor API."
        actions={
          <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider" data-testid="badge-env">
            {cfg.data?.app.env || "—"}
          </Badge>
        }
      />

      {cfg.isLoading ? (
        <LoadingRows count={4} />
      ) : cfg.isError ? (
        <ErrorBlock message={(cfg.error as Error).message} />
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Card data-testid="card-kpi-readiness">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Readiness</span>
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 tabular-nums">
                  <span className="text-xl font-semibold">{readyCount}</span>
                  <span className="text-sm text-muted-foreground">/ {totalCount}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Configuration checks passing</p>
              </CardContent>
            </Card>
            <Card data-testid="card-kpi-shopify">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Shopify OAuth</span>
                  <StatusDot ok={cfg.data!.shopify.clientIdConfigured && cfg.data!.shopify.clientSecretConfigured} />
                </div>
                <div className="mt-2 text-xl font-semibold">
                  {cfg.data!.shopify.clientIdConfigured && cfg.data!.shopify.clientSecretConfigured
                    ? "Configured"
                    : "Not set"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{cfg.data!.shopify.scopes.length} scopes selected</p>
              </CardContent>
            </Card>
            <Card data-testid="card-kpi-jomashop">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Jomashop</span>
                  <StatusDot ok={cfg.data!.jomashop.sessionActive} />
                </div>
                <div className="mt-2 text-xl font-semibold">
                  {cfg.data!.jomashop.sessionActive
                    ? "Session active"
                    : cfg.data!.jomashop.emailConfigured
                      ? "Not signed in"
                      : "Not configured"}
                </div>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">{cfg.data!.jomashop.baseUrl}</p>
              </CardContent>
            </Card>
            <Card data-testid="card-kpi-jobs">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Recent jobs</span>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="mt-2 text-xl font-semibold tabular-nums">{jobs.data?.length ?? 0}</div>
                <p className="mt-1 text-xs text-muted-foreground">Across all sync types</p>
              </CardContent>
            </Card>
          </div>

          {/* Checklist + recent activity */}
          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="border-b border-card-border">
                <CardTitle className="text-sm">Setup checklist</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y divide-card-border">
                  {checklistItems.map((item) => (
                    <li
                      key={item.label}
                      className="flex items-center justify-between px-5 py-3"
                      data-testid={`checklist-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <div className="flex items-center gap-3">
                        {item.ok ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Circle className="h-4 w-4 text-muted-foreground/60" />
                        )}
                        <span className="text-sm">{item.label}</span>
                      </div>
                      <Link href={item.href}>
                        <Button size="sm" variant="ghost" className="h-7 text-xs">
                          {item.ok ? "Review" : "Configure"}
                          <ArrowRight className="ml-1 h-3 w-3" />
                        </Button>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="border-b border-card-border">
                <CardTitle className="text-sm">What this scaffold does</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-5 text-sm text-muted-foreground">
                <div className="flex items-start gap-3">
                  <Server className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p>Express backend with real Shopify OAuth + Jomashop JWT lifecycle.</p>
                </div>
                <div className="flex items-start gap-3">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p>Secrets read from environment variables only. No raw credentials in DB.</p>
                </div>
                <div className="flex items-start gap-3">
                  <Database className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p>SQLite stores connection state, SKU/category maps, jobs, and order snapshots.</p>
                </div>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <p>Frontend is read-only. Mutating sync actions are intentionally stubbed.</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Recent jobs */}
          <Card className="mt-6">
            <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
              <CardTitle className="text-sm">Recent sync jobs</CardTitle>
              <Link href="/logs">
                <Button size="sm" variant="ghost" className="h-7 text-xs">
                  View logs
                  <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {jobs.isLoading ? (
                <div className="p-5">
                  <LoadingRows count={3} />
                </div>
              ) : (jobs.data?.length ?? 0) === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                  No sync jobs yet. Run a Jomashop session test from Setup to record the first job.
                </div>
              ) : (
                <ul className="divide-y divide-card-border">
                  {jobs.data!.slice(0, 5).map((j) => (
                    <li key={j.id} className="flex items-center justify-between px-5 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="font-mono text-[10px] uppercase">{j.jobType}</Badge>
                        <span className="text-muted-foreground tabular-nums">
                          {new Date(j.startedAt).toLocaleString()}
                        </span>
                      </div>
                      <Badge
                        variant={j.status === "success" ? "default" : j.status === "failed" ? "destructive" : "secondary"}
                        className="text-[10px] uppercase"
                      >
                        {j.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
