import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

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

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
