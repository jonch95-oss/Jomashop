import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Plug,
  ArrowLeftRight,
  Boxes,
  PackageSearch,
  ScrollText,
  Truck,
  ClipboardList,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AdminTokenGate } from "./AdminTokenGate";

const NAV: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }>; group?: string }> = [
  { href: "/", label: "Overview", icon: LayoutDashboard, group: "Operate" },
  { href: "/setup", label: "Setup", icon: Plug, group: "Operate" },
  { href: "/mapping", label: "Field Mapping", icon: ArrowLeftRight, group: "Operate" },
  { href: "/products", label: "Products", icon: PackageSearch, group: "Catalog" },
  { href: "/inventory", label: "Inventory", icon: Boxes, group: "Catalog" },
  { href: "/orders", label: "Orders", icon: ClipboardList, group: "Fulfill" },
  { href: "/fulfillment", label: "Fulfillment", icon: Truck, group: "Fulfill" },
  { href: "/logs", label: "Logs", icon: ScrollText, group: "Diagnose" },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-label="LuxeSupply" className="text-primary">
        <rect x="2" y="2" width="20" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 7 L17 17 M17 7 L7 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        <circle cx="12" cy="12" r="3" fill="currentColor" />
      </svg>
      <div className="leading-tight">
        <div className="font-serif text-[15px] font-semibold tracking-tight">LuxeSupply</div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Jomashop Bridge</div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const grouped = NAV.reduce<Record<string, typeof NAV>>((acc, item) => {
    const g = item.group || "Other";
    acc[g] = acc[g] || [];
    acc[g].push(item);
    return acc;
  }, {});

  return (
    <div
      className="grid h-dvh text-foreground"
      style={{ gridTemplateColumns: "auto 1fr", gridTemplateRows: "1fr" }}
    >
      <aside
        className="row-span-full hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex"
        style={{ overscrollBehavior: "contain" }}
      >
        <div className="flex h-14 items-center border-b border-sidebar-border px-5">
          <Logo />
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4" style={{ overscrollBehavior: "contain" }}>
          {Object.entries(grouped).map(([group, items]) => (
            <div key={group} className="mb-5">
              <div className="px-2 pb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {group}
              </div>
              <div className="flex flex-col gap-0.5">
                {items.map((item) => {
                  const active = location === item.href;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      data-testid={`link-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                      className={cn(
                        "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors hover-elevate",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                      {active && (
                        <span className="absolute right-2 h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-4">
          <div className="rounded-md border border-sidebar-border bg-card/40 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-primary" />
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Scaffold mode
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Configure env vars, then complete Shopify OAuth + Jomashop session in Setup.
            </p>
          </div>
        </div>
      </aside>

      <main
        className="row-span-full overflow-y-auto"
        style={{ overscrollBehavior: "contain" }}
      >
        {/* Mobile header (compact) */}
        <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur md:hidden">
          <Logo />
          <AdminTokenGate />
        </header>
        {/* Desktop top bar */}
        <div className="sticky top-0 z-10 hidden h-12 items-center justify-end border-b border-border bg-background/95 px-8 backdrop-blur md:flex">
          <AdminTokenGate />
        </div>
        <div className="mx-auto w-full max-w-[1400px] px-5 py-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col items-start justify-between gap-3 border-b border-border pb-5 md:flex-row md:items-end">
      <div>
        <h1 className="font-serif text-xl font-semibold tracking-tight text-foreground md:text-[1.4rem]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = PackageSearch,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border bg-card/40 px-6 py-14 text-center">
      <div className="mb-3 rounded-full border border-border bg-background p-3 text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBlock({ title, message }: { title?: string; message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <div className="font-medium">{title || "Something went wrong"}</div>
      <div className="mt-1 text-destructive/80">{message}</div>
    </div>
  );
}

export function LoadingRows({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-muted/40" />
      ))}
    </div>
  );
}
