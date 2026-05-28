import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { logMemory, rssMb, heapMb } from "./memlog";
import {
  installProcessHandlers,
  handleMulterError,
  snapshotLocks,
  memoryPressure,
} from "./stability";

installProcessHandlers();
const PROCESS_STARTED_AT = Date.now();

const app = express();
const httpServer = createServer(app);

// Render (and any other PaaS) probes /api/health to decide whether the
// container is healthy. Register the health route BEFORE any body parsers,
// auth middleware, or async route setup so the probe always succeeds even
// during startup or while heavy registrations are still pending. The
// handler MUST stay synchronous and allocation-light: no storage calls,
// no JSON.stringify of large payloads, no awaits. If the worker is so
// loaded it can't satisfy this, the OOM-killer is one allocation away
// and we want Render to see "unhealthy" and recycle the container.
app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, time: new Date().toISOString() });
});
app.head("/api/health", (_req, res) => res.status(200).end());

// Diagnostics endpoint — read-only summary of process state. Useful both
// for the operator UI ("is the server hot right now?") and for Render's
// post-incident debugging. Like /api/health it must NEVER throw and must
// stay lightweight (no DB calls, just process.memoryUsage + the in-memory
// lock map). Mounted before the admin-token gate intentionally so we can
// curl it during an outage even without a valid token.
app.get("/api/diagnostics/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let pressure;
  try {
    pressure = memoryPressure();
  } catch {
    pressure = { rssMb: -1, heapMb: -1, softRssMb: -1, softHeapMb: -1, exceeded: false };
  }
  let locks: Array<{ name: string; ageMs: number }> = [];
  try {
    locks = snapshotLocks();
  } catch {
    // best-effort
  }
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
    pid: process.pid,
    nodeVersion: process.version,
    env: process.env.NODE_ENV ?? "development",
    memory: {
      rssMb: rssMb(),
      heapMb: heapMb(),
      softRssMb: pressure.softRssMb,
      softHeapMb: pressure.softHeapMb,
      pressureExceeded: pressure.exceeded,
    },
    locks,
    time: new Date().toISOString(),
  });
});

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

function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  // Express strips the mount path when this is attached via app.use("/api", ...),
  // so req.path is e.g. "/health" not "/api/health". Match both for safety
  // (this middleware is also called from /api/health directly above as a
  // belt-and-braces guard). Diagnostics is also unauthenticated so the
  // operator can inspect the worker during an outage.
  if (
    req.path === "/api/health" ||
    req.path === "/health" ||
    req.path === "/api/diagnostics/status" ||
    req.path === "/diagnostics/status"
  ) {
    return next();
  }

  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({
        error: "Admin API disabled",
        message: "Set ADMIN_TOKEN to enable dashboard API routes in production.",
      });
    }
    return next();
  }

  if (req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
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

    const status = err?.status || err?.statusCode || 500;
    const message = err?.message || "Internal Server Error";

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
