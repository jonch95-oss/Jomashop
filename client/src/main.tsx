import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initEmbedded } from "./lib/embedded";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Kick off embedded Shopify admin detection ASAP (no-op standalone). The
// first API call awaits the same promise, so booting App Bridge here removes
// it from the critical path of the first query.
void initEmbedded();

createRoot(document.getElementById("root")!).render(<App />);
