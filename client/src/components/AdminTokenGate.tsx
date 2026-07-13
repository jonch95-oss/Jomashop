import { useEffect, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import {
  clearAdminToken,
  getAdminToken,
  onAdminTokenChanged,
  onAdminTokenRequired,
  setAdminToken,
} from "@/lib/adminToken";
import { isEmbeddedCandidate } from "@/lib/embedded";

export function AdminTokenGate() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [hasToken, setHasToken] = useState(() => Boolean(getAdminToken()));
  // Inside the Shopify admin iframe, auth is handled by App Bridge session
  // tokens - the manual token modal/buttons are bypassed entirely.
  const embedded = isEmbeddedCandidate();

  useEffect(() => {
    const off1 = onAdminTokenRequired(() => {
      setValue(getAdminToken());
      setOpen(true);
    });
    const off2 = onAdminTokenChanged(() => {
      setHasToken(Boolean(getAdminToken()));
    });
    return () => {
      off1();
      off2();
    };
  }, []);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setAdminToken(trimmed);
    setOpen(false);
    queryClient.invalidateQueries();
  }

  function handleSignOut() {
    clearAdminToken();
    queryClient.clear();
  }

  if (embedded) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="sm:max-w-md"
          onInteractOutside={(e) => {
            if (!getAdminToken()) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (!getAdminToken()) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              Admin token required
            </DialogTitle>
            <DialogDescription>
              The API requires an admin bearer token. Paste your{" "}
              <code className="font-mono text-xs">ADMIN_TOKEN</code> to access
              the dashboard. It is stored only in this browser tab's
              sessionStorage and is sent as{" "}
              <code className="font-mono text-xs">Authorization: Bearer …</code>{" "}
              on each request.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="admin-token">Admin token</Label>
              <Input
                id="admin-token"
                type="password"
                autoComplete="off"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Paste ADMIN_TOKEN"
                data-testid="input-admin-token"
              />
              <p className="text-xs text-muted-foreground">
                Cleared when this browser tab closes. Use the Sign out button to
                clear it sooner.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={!value.trim()}
                data-testid="button-admin-token-save"
              >
                Save & continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {hasToken && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={handleSignOut}
          data-testid="button-admin-token-signout"
          title="Clear admin token from this browser tab"
        >
          <LogOut className="mr-1 h-3 w-3" />
          Sign out
        </Button>
      )}
      {!hasToken && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => {
            setValue("");
            setOpen(true);
          }}
          data-testid="button-admin-token-enter"
        >
          <KeyRound className="mr-1 h-3 w-3" />
          Enter token
        </Button>
      )}
    </>
  );
}
