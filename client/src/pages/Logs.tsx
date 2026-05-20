import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, LoadingRows, EmptyState } from "@/components/AppShell";
import type { SyncJob, SyncLog } from "@/lib/types";

export default function Logs() {
  const jobs = useQuery<SyncJob[]>({ queryKey: ["/api/sync-jobs"] });
  const logs = useQuery<SyncLog[]>({ queryKey: ["/api/logs"] });

  return (
    <>
      <PageHeader
        title="Logs"
        description="Sync jobs and event log. Useful when debugging the Shopify OAuth handshake or Jomashop JWT lifecycle."
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b border-card-border">
            <CardTitle className="text-sm">Sync jobs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {jobs.isLoading ? (
              <div className="p-5">
                <LoadingRows />
              </div>
            ) : (jobs.data?.length ?? 0) === 0 ? (
              <EmptyState title="No jobs yet" description="Trigger a session test from Setup to record the first job." />
            ) : (
              <ul className="divide-y divide-card-border">
                {jobs.data!.map((j) => (
                  <li key={j.id} className="px-5 py-3" data-testid={`job-${j.id}`}>
                    <div className="flex items-center justify-between">
                      <code className="font-mono text-xs">{j.jobType}</code>
                      <Badge
                        variant={j.status === "success" ? "default" : j.status === "failed" ? "destructive" : "secondary"}
                        className="text-[10px] uppercase"
                      >
                        {j.status}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                      <span>{new Date(j.startedAt).toLocaleString()}</span>
                      <span>
                        {j.successItems}/{j.totalItems} ok
                      </span>
                    </div>
                    {j.summary && <div className="mt-1 text-xs text-muted-foreground">{j.summary}</div>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="border-b border-card-border">
            <CardTitle className="text-sm">Event log</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {logs.isLoading ? (
              <div className="p-5">
                <LoadingRows />
              </div>
            ) : (logs.data?.length ?? 0) === 0 ? (
              <EmptyState title="No events" description="OAuth and Jomashop events will appear here." />
            ) : (
              <ul className="divide-y divide-card-border">
                {logs.data!.map((l) => (
                  <li key={l.id} className="px-5 py-3" data-testid={`log-${l.id}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm">
                        <Badge
                          variant={l.level === "error" ? "destructive" : l.level === "warn" ? "secondary" : "outline"}
                          className="text-[10px] uppercase"
                        >
                          {l.level}
                        </Badge>
                        <span>{l.message}</span>
                      </div>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {new Date(l.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    {l.detailsJson && (
                      <pre className="mt-1 overflow-x-auto rounded border border-border bg-card/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                        {l.detailsJson}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
