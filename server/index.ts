import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { logMemory } from "./memlog";
import { installProcessHandlers, handleMulterError } from "./stability";
import {
  bearerFromAuthorization,
  embeddedAuthConfigured,
  looksLikeJwt,
  verifyShopifySessionToken,
} from "./embedded_auth";

installProcessHandlers();

const app = express();
const httpServer = createServer(app);

// Render (and any other PaaS) probes /api/health to decide whether the
// container is healthy. Register the health route BEFORE any body parsers,
// auth middleware, or async route setup so the probe always succeeds even
// during startup or while heavy registrations are still pending. This is
// what fixes the "dial tcp ...:5000: connect: connection refused" alerts —
// the previous build returned a 503 here because the admin-token gate ran
// first and Express's app.use("/api", mw) had stripped the "/api" prefix,
// causing the `req.path === "/api/health"` exemption to never match.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
app.head("/api/health", (_req, res) => res.status(200).end());

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Capture the raw request body for HMAC verification (Shopify webhooks) and
// for any other route that needs to inspect bytes the JSON parser already
// consumed.
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ---------- Embedded Shopify admin support ----------
//
// When the app is loaded inside the Shopify admin iframe, Shopify appends
// ?embedded=1&host=...&shop=... to the App URL. Shopify REQUIRES a
// Content-Security-Policy frame-ancestors header on those responses that
// allows the specific shop + admin.shopify.com. Standalone (Render)
// requests carry none of those params and get no CSP header, so existing
// behavior is unchanged.
app.use((req, res, next) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const hasEmbedHint =
    typeof req.query.host === "string" ||
    typeof req.query.embedded === "string" ||
    Boolean(shop);
  if (hasEmbedHint) {
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors https://${shop} https://admin.shopify.com;`,
      );
    } else {
      res.setHeader(
        "Content-Security-Policy",
        "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
      );
    }
    res.removeHeader("X-Frame-Options");
  }
  next();
});

// The Shopify admin exposes the app under /apps/{handle}[/...]. Our SPA is
// hash-routed from "/", so bounce any such path back to the root while
// preserving the query string (host/shop/embedded params must survive the
// redirect for App Bridge to boot).
app.get(/^\/apps\/[^/]+(?:\/.*)?$/, (req, res) => {
  const qIdx = req.originalUrl.indexOf("?");
  const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : "";
  res.redirect(302, `/${qs}`);
});

function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  // Express strips the mount path when this is attached via app.use("/api", ...),
  // so req.path is e.g. "/health" not "/api/health". Match both for safety
  // (this middleware is also called from /api/health directly above as a
  // belt-and-braces guard).
  if (req.path === "/api/health" || req.path === "/health") return next();
  // Public, non-sensitive config (e.g. the App Bridge api key) needed BEFORE
  // the client can authenticate.
  if (req.path.startsWith("/api/public/") || req.path.startsWith("/public/")) return next();

  const token = process.env.ADMIN_TOKEN?.trim();
  const bearer = bearerFromAuthorization(req.headers.authorization);

  // 1) Standalone mode: exact ADMIN_TOKEN match (existing behavior).
  if (token && bearer === token) return next();

  // 2) Embedded mode: a valid Shopify App Bridge session token (JWT signed
  //    with SHOPIFY_CLIENT_SECRET) is accepted in place of ADMIN_TOKEN.
  if (embeddedAuthConfigured() && looksLikeJwt(bearer)) {
    const check = verifyShopifySessionToken(bearer);
    if (check.ok) return next();
    // Deliberately logged (reason only, never the token) so embedded-auth
    // misconfigurations (secret mismatch, clock skew, wrong aud) are
    // diagnosable from platform logs.
    console.warn(`[embedded-auth] session token rejected: ${check.reason} (path=${req.path})`);
  } else if (!bearer) {
    console.warn(`[embedded-auth] no Authorization bearer on ${req.path}`);
  }

  if (!token) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({
        error: "Admin API disabled",
        message:
          "Set ADMIN_TOKEN to enable dashboard API routes in production (or load the app inside the Shopify admin with embedded session auth configured).",
      });
    }
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}

app.use("/api", requireAdminToken);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // Avoid materializing megabyte-sized response payloads into the log
        // line on product/cache endpoints — that would defeat the memory
        // savings of paginating those responses. Truncate aggressively.
        try {
          const stringified = JSON.stringify(capturedJsonResponse);
          logLine += ` :: ${stringified.length > 400 ? stringified.slice(0, 400) + "…" : stringified}`;
        } catch {
          // body wasn't JSON-serializable — skip
        }
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Wrap registration so a single bad route can't take the entire server
  // down before it starts listening — the health endpoint is already wired
  // above the body parser, so even if routes never finish registering,
  // Render's health probe will still pass and the operator can fix forward.
  try {
    await registerRoutes(httpServer, app);
  } catch (err) {
    console.error("[startup] registerRoutes failed:", err);
    logMemory("startup.registerRoutes.failed", {
      message: (err as Error)?.message,
    });
  }

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    // Normalize multer / upload errors to a clean 413 JSON instead of a
    // generic 500. Anything else falls through to the existing branch.
    if (handleMulterError(err, res)) {
      return;
    }

    const isBodyTooLarge =
      err?.type === "entity.too.large" ||
      err?.status === 413 ||
      err?.statusCode === 413;
    const status = isBodyTooLarge ? 413 : err?.status || err?.statusCode || 500;
    const message = isBodyTooLarge
      ? "Request body exceeds the server limit. Reduce the payload size and retry."
      : err?.message || "Internal Server Error";

    // Always respond with JSON for API paths so frontend code doesn't
    // accidentally render an HTML error page into its JSON state.
    if (req.path && req.path.startsWith("/api")) {
      return res.status(status).json({ ok: false, error: message });
    }
    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // Note: we do NOT pass reusePort. SO_REUSEPORT is a Linux-specific socket
  // option that some PaaS runtimes (and recent Node builds on certain
  // kernels) reject with EADDRINUSE or EINVAL, leaving the process running
  // but unable to accept connections — that's how Render ends up reporting
  // "dial tcp 10.x.x.x:5000: connect: connection refused".
  httpServer.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
    logMemory("server.listen", { port });
  });

  // Periodic memory snapshot so Render's logs show RSS/heap drift even when
  // no Shopify endpoints are being hit. Cheap (one process.memoryUsage call
  // every 5 minutes) and disabled in NODE_ENV=test if anyone adds tests.
  if (process.env.NODE_ENV !== "test") {
    setInterval(() => {
      logMemory("server.heartbeat");
    }, 5 * 60 * 1000).unref();
  }
})();
