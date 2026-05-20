import { useState, useMemo } from "react";
import { useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Copy, ExternalLink, Loader2, Check, X, Info, ShieldAlert, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader, LoadingRows, ErrorBlock } from "@/components/AppShell";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ConfigStatus, SessionTestResult, Store } from "@/lib/types";

function CopyableUrl({ value, label }: { value: string; label: string }) {
  const { toast } = useToast();
  return (
    <div className="rounded-md border border-border bg-card/60 p-3" data-testid={`copyable-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-start justify-between gap-2">
        <code className="break-all font-mono text-xs text-foreground">{value}</code>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              toast({ title: "Copied", description: label });
            } catch {
              toast({ title: "Copy failed", description: "Use long-press or right-click instead." });
            }
          }}
          aria-label={`Copy ${label}`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function StatusPill({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge variant="default" className="gap-1 text-[10px] uppercase">
      <Check className="h-3 w-3" /> Configured
    </Badge>
  ) : (
    <Badge variant="secondary" className="gap-1 text-[10px] uppercase">
      <X className="h-3 w-3" /> Missing
    </Badge>
  );
}

export default function Setup() {
  const cfg = useQuery<ConfigStatus>({ queryKey: ["/api/config/status"] });
  const stores = useQuery<Store[]>({ queryKey: ["/api/stores"] });
  const { toast } = useToast();
  const search = useSearch();
  const installedShop = useMemo(() => {
    const v = new URLSearchParams(search).get("installed");
    return v ? v.trim() : "";
  }, [search]);
  const connectedStore = useMemo(() => {
    const list = stores.data || [];
    if (installedShop) {
      const match = list.find((s) => s.shopDomain === installedShop);
      if (match) return match;
    }
    return list.find((s) => s.oauthStatus === "connected") || null;
  }, [stores.data, installedShop]);
  const [shop, setShop] = useState(installedShop || "luxesupply.myshopify.com");

  const test = useMutation<SessionTestResult>({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/jomashop/session/test");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.ok ? "Jomashop session OK" : "Jomashop session failed",
        description: data.message,
        variant: data.ok ? "default" : "destructive",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/config/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sync-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
  });

  if (cfg.isLoading) return <LoadingRows />;
  if (cfg.isError) return <ErrorBlock message={(cfg.error as Error).message} />;
  if (!cfg.data) return null;

  const baseUrl = cfg.data.app.baseUrl;

  return (
    <>
      <PageHeader
        title="Setup"
        description="Connect Shopify and Jomashop credentials, then verify the integration is live."
      />

      {installedShop && (
        <Alert
          variant="default"
          className="mb-4 border-emerald-500/40 bg-emerald-500/5"
          data-testid="alert-installed"
        >
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <AlertTitle className="text-sm">Shopify install complete</AlertTitle>
          <AlertDescription className="text-xs">
            Connected to <code className="font-mono">{installedShop}</code>
            {connectedStore?.scopes ? (
              <> with scopes <code className="font-mono">{connectedStore.scopes}</code>.</>
            ) : (
              <>.</>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Alert variant="default" className="mb-6 border-amber-500/40 bg-amber-500/5">
        <ShieldAlert className="h-4 w-4 text-amber-500" />
        <AlertTitle className="text-sm">Security first</AlertTitle>
        <AlertDescription className="text-xs">
          Never paste credentials into chat. Set Shopify and Jomashop secrets in your <code className="font-mono">.env</code> file
          (or your platform's secret manager) before running. If a Client Secret was exposed in a screenshot, rotate it from the
          Shopify Dev Dashboard immediately.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Shopify */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
            <CardTitle className="text-sm">Shopify OAuth</CardTitle>
            <Badge variant="outline" className="text-[10px] uppercase">Dev dashboard app</Badge>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center justify-between rounded-md border border-border p-2.5">
                <span className="text-muted-foreground">Client ID</span>
                <StatusPill ok={cfg.data.shopify.clientIdConfigured} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border p-2.5">
                <span className="text-muted-foreground">Client Secret</span>
                <StatusPill ok={cfg.data.shopify.clientSecretConfigured} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border p-2.5">
                <span className="text-muted-foreground">App URL</span>
                <StatusPill ok={cfg.data.shopify.appUrlConfigured} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border p-2.5">
                <span className="text-muted-foreground">Scopes</span>
                <span className="font-mono text-xs tabular-nums" data-testid="text-scope-count">{cfg.data.shopify.scopes.length}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Paste these into Shopify Dev Dashboard
              </Label>
              <CopyableUrl label="App URL" value={baseUrl} />
              <CopyableUrl label="Allowed redirection URL" value={cfg.data.shopify.callbackUrl} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="shop-domain" className="text-xs">Shop domain</Label>
              <Input
                id="shop-domain"
                data-testid="input-shop-domain"
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                placeholder="luxesupply.myshopify.com"
                className="font-mono text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="button-install-shopify"
                  disabled={!cfg.data.shopify.clientIdConfigured}
                  onClick={() => {
                    window.location.href = `${baseUrl}/auth/shopify/start?shop=${encodeURIComponent(shop)}`;
                  }}
                >
                  <ExternalLink className="mr-2 h-3.5 w-3.5" /> Begin install
                </Button>
                {!cfg.data.shopify.clientIdConfigured && (
                  <p className="text-xs text-muted-foreground">Set <code className="font-mono">SHOPIFY_CLIENT_ID</code> and restart to enable.</p>
                )}
              </div>
            </div>

            <div className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
              <div className="mb-1 flex items-center gap-1.5 text-foreground">
                <Info className="h-3 w-3" />
                <span className="font-medium">Selected scopes</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {cfg.data.shopify.scopes.map((s) => (
                  <code key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]" data-testid={`scope-${s}`}>
                    {s}
                  </code>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Jomashop */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between border-b border-card-border">
            <CardTitle className="text-sm">Jomashop Vendor API</CardTitle>
            <Badge variant="outline" className="text-[10px] uppercase">JWT, 5-day TTL</Badge>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center justify-between rounded-md border border-border p-2.5">
                <span className="text-muted-foreground">Email</span>
                <StatusPill ok={cfg.data.jomashop.emailConfigured} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border p-2.5">
                <span className="text-muted-foreground">Password</span>
                <StatusPill ok={cfg.data.jomashop.passwordConfigured} />
              </div>
              <div className="col-span-2 flex items-center justify-between rounded-md border border-border p-2.5">
                <span className="text-muted-foreground">Session</span>
                <Badge variant={cfg.data.jomashop.sessionActive ? "default" : "secondary"} className="text-[10px] uppercase">
                  {cfg.data.jomashop.sessionActive ? "Active" : "Not signed in"}
                </Badge>
              </div>
            </div>

            <CopyableUrl label="API base" value={cfg.data.jomashop.baseUrl} />

            <Button
              data-testid="button-test-session"
              onClick={() => test.mutate()}
              disabled={!cfg.data.jomashop.emailConfigured || !cfg.data.jomashop.passwordConfigured || test.isPending}
              className="w-full sm:w-auto"
            >
              {test.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Test login + categories fetch
            </Button>

            {test.data && (
              <div
                className={`rounded-md border p-3 text-xs ${
                  test.data.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-500"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }`}
              >
                {test.data.message}
              </div>
            )}

            <div className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
              The scaffold sends credentials over HTTPS only at login time. JWT is held in memory and rotated automatically — never
              written to disk or the database.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Env reference */}
      <Card className="mt-6">
        <CardHeader className="border-b border-card-border">
          <CardTitle className="text-sm">Environment variables</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-2 text-left font-medium">Key</th>
                <th className="px-5 py-2 text-left font-medium">Source</th>
                <th className="px-5 py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {cfg.data.credentialStatuses.map((c) => (
                <tr key={c.key} className="border-b border-card-border last:border-0" data-testid={`env-row-${c.key}`}>
                  <td className="px-5 py-2.5 font-mono text-xs">{c.key.toUpperCase()}</td>
                  <td className="px-5 py-2.5 text-xs text-muted-foreground">{c.source}</td>
                  <td className="px-5 py-2.5 text-right">
                    <StatusPill ok={c.configured} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
