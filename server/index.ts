import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { logMemory } from "./memlog";
import { installProcessHandlers, handleMulterError } from "./stability";

installProcessHandlers();

const app = express();
const httpServer = createServer(app);

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
  if (req.path === "/api/health") return next();

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
  await registerRoutes(httpServer, app);

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
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      logMemory("server.listen", { port });
    },
  );

  // Periodic memory snapshot so Render's logs show RSS/heap drift even when
  // no Shopify endpoints are being hit. Cheap (one process.memoryUsage call
  // every 5 minutes) and disabled in NODE_ENV=test if anyone adds tests.
  if (process.env.NODE_ENV !== "test") {
    setInterval(() => {
      logMemory("server.heartbeat");
    }, 5 * 60 * 1000).unref();
  }
})();
