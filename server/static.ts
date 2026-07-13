import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";
import { injectAppBridgeScript } from "./embedded_auth";

export function serveStatic(app: Express) {
  // Try a couple of likely locations so the bundled cjs and a tsx run from
  // the repo root both work without a separate code path. Render's build
  // step produces dist/public; dev runs out of the working tree.
  const candidates = [
    path.resolve(__dirname, "public"),
    path.resolve(process.cwd(), "dist/public"),
    path.resolve(process.cwd(), "public"),
  ];
  const distPath = candidates.find((p) => fs.existsSync(p));

  if (!distPath) {
    // Don't throw — that would abort startup and prevent the server from
    // listening on PORT, which is how the operator gets visibility via
    // /api/health. Instead, log loudly and register a tiny fallback so the
    // root URL returns a useful diagnostic instead of an HTML 500.
    // eslint-disable-next-line no-console
    console.error(
      "[serveStatic] No client build found in",
      candidates.join(", "),
      "— /api/health still works; rebuild and redeploy to restore the UI.",
    );
    app.use("/{*path}", (_req, res) => {
      res.status(503).json({
        ok: false,
        error: "Client build is missing. Re-run `npm run build` and redeploy.",
      });
    });
    return;
  }

  // index:false so "/" falls through to the handler below — the embedded
  // Shopify admin needs App Bridge spliced into index.html per-request.
  app.use(express.static(distPath, { index: false }));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (req, res) => {
    // Deep links: the SPA is hash-routed, but the embedded Shopify admin
    // addresses sub-pages by PATH (App URL + /setup, /products, ...). Bounce
    // any non-asset path to the hash route, preserving the query string so
    // App Bridge params survive.
    if (req.path !== "/" && !req.path.includes(".")) {
      const qIdx = req.originalUrl.indexOf("?");
      const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx).split("#")[0] : "";
      return res.redirect(302, `/${qs}#${req.path}`);
    }
    const indexPath = path.resolve(distPath, "index.html");
    fs.readFile(indexPath, "utf-8", (err, html) => {
      if (err) {
        return res.status(500).json({ ok: false, error: "index.html missing from build." });
      }
      res
        .status(200)
        .set({ "Content-Type": "text/html" })
        .end(injectAppBridgeScript(html, req.query as Record<string, unknown>));
    });
  });
}
