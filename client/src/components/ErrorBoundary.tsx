import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = { children: ReactNode };
type State = { error: Error | null; info: ErrorInfo | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    if (typeof console !== "undefined") {
      console.error("[ErrorBoundary]", error, info?.componentStack);
    }
  }

  reset = () => {
    this.setState({ error: null, info: null });
  };

  reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error?.message || String(this.state.error);
    const stack = this.state.info?.componentStack || this.state.error?.stack || "";
    return (
      <div
        data-testid="error-boundary-fallback"
        className="m-6 max-w-3xl rounded-md border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300"
      >
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4" />
          Something went wrong rendering this page.
        </div>
        <div className="mt-2 break-words font-mono text-xs">{msg}</div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="outline" onClick={this.reset}>
            Try again
          </Button>
          <Button size="sm" onClick={this.reload}>
            <RefreshCcw className="mr-2 h-3.5 w-3.5" />
            Reload page
          </Button>
        </div>
        {stack && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs opacity-80">Stack trace</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-background p-2 font-mono text-[10px] text-foreground">
              {stack}
            </pre>
          </details>
        )}
      </div>
    );
  }
}
