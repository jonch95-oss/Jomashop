import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppShell } from "@/components/AppShell";
import Overview from "@/pages/Overview";
import Setup from "@/pages/Setup";
import Mapping from "@/pages/Mapping";
import Products from "@/pages/Products";
import Inventory from "@/pages/Inventory";
import Orders from "@/pages/Orders";
import Fulfillment from "@/pages/Fulfillment";
import Logs from "@/pages/Logs";

function AppRouter() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/setup" component={Setup} />
        <Route path="/mapping" component={Mapping} />
        <Route path="/products" component={Products} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/orders" component={Orders} />
        <Route path="/fulfillment" component={Fulfillment} />
        <Route path="/logs" component={Logs} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
