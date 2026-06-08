import type { Express } from "express";
import { storage } from "./storage";

/**
 * Server-side bulk push: push many products to Jomashop in one request with
 * bounded concurrency and a consolidated per-product result.
 *
 * Rather than re-implement (and risk drifting from) the ~800-line single-push
 * handler — which performs live schema resolution, brand/category resolution,
 * a multi-stage preflight, the /i1→/v1 fallback, inventory sync, and push-
 * status bookkeeping — this endpoint fans out to the existing, battle-tested
 * `POST /api/jomashop/push-product` route over the loopback interface. Each
 * product therefore goes through the exact same code path as a single-row
 * push; we only add fan-out, a small concurrency pool (to respect the vendor
 * API), and aggregation.
 */

type BulkPushItem = {
  /** Stable id for correlating results back to a UI row. Falls back to the
   *  product id / sku when omitted. */
  key?: string;
  product: Record<string, unknown>;
  variantSku?: string;
  overrides?: Record<string, unknown>;
};

type BulkPushResult = {
  key: string;
  productId: string | null;
  sku: string | null;
  ok: boolean;
  status: number;
  stage: string | null;
  error: string | null;
};

function loopbackBaseUrl(): string {
  const port = parseInt(process.env.PORT || "5000", 10);
  return `http://127.0.0.1:${port}`;
}

function adminAuthHeader(): Record<string, string> {
  const token = process.env.ADMIN_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const pool = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(pool);
  return results;
}

export function registerBulkPushRoutes(app: Express): void {
  /**
   * POST /api/jomashop/push-products-bulk
   *
   * Body: {
   *   confirm: true,
   *   items: [{ key?, product, variantSku?, overrides? }],
   *   pushInventory?: boolean,   // default true (matches the row-level UI)
   *   concurrency?: number,      // default 3, clamped to 1..8
   *   stopOnError?: boolean,     // default false
   * }
   */
  app.post("/api/jomashop/push-products-bulk", async (req, res) => {
    const body = (req.body || {}) as {
      confirm?: boolean;
      items?: BulkPushItem[];
      pushInventory?: boolean;
      concurrency?: number;
      stopOnError?: boolean;
    };

    if (!body.confirm) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing confirmation. Set `confirm: true` to acknowledge this will create/update data in Jomashop.",
      });
    }
    const items = Array.isArray(body.items) ? body.items.filter((it) => it && it.product) : [];
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: "No products supplied in `items`." });
    }

    const pushInventory = body.pushInventory !== false;
    const concurrency = Math.min(8, Math.max(1, Number(body.concurrency) || 3));
    const stopOnError = body.stopOnError === true;

    const base = loopbackBaseUrl();
    const authHeader = adminAuthHeader();

    const job = storage.createSyncJob({
      jobType: "products_push_bulk",
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      totalItems: items.length,
      successItems: 0,
      errorItems: 0,
      summary: `Bulk push ${items.length} product(s)`,
    });

    let aborted = false;

    const results = await runWithConcurrency<BulkPushItem, BulkPushResult>(
      items,
      concurrency,
      async (item) => {
        const productId =
          item.product && (item.product as any).id !== undefined
            ? String((item.product as any).id)
            : null;
        const key = item.key || productId || item.variantSku || "unknown";
        const baseResult: BulkPushResult = {
          key,
          productId,
          sku: item.variantSku ?? null,
          ok: false,
          status: 0,
          stage: null,
          error: null,
        };

        if (aborted) {
          return { ...baseResult, error: "Skipped: a previous push failed and stopOnError was set." };
        }

        try {
          const resp = await fetch(`${base}/api/jomashop/push-product`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader },
            body: JSON.stringify({
              confirm: true,
              product: item.product,
              variantSku: item.variantSku,
              pushInventory,
              overrides: item.overrides,
            }),
          });
          let json: any = null;
          try {
            json = await resp.json();
          } catch {
            // ignore parse errors; status carries the signal
          }
          const ok = resp.ok && json?.ok !== false;
          const result: BulkPushResult = {
            key,
            productId,
            sku: json?.payloadPreview?.vendor_sku ?? item.variantSku ?? null,
            ok,
            status: resp.status,
            stage: json?.stage ?? null,
            error: ok
              ? null
              : json?.error ||
                (Array.isArray(json?.errors) ? json.errors.join("; ") : null) ||
                `HTTP ${resp.status}`,
          };
          if (!ok && stopOnError) aborted = true;
          return result;
        } catch (err) {
          if (stopOnError) aborted = true;
          return { ...baseResult, error: (err as Error).message };
        }
      },
    );

    const pushed = results.filter((r) => r.ok).length;
    const failed = results.length - pushed;

    storage.updateSyncJob(job.id, {
      status: failed === 0 ? "success" : "failed",
      finishedAt: Date.now(),
      successItems: pushed,
      errorItems: failed,
      summary: `Bulk push: ${pushed} ok, ${failed} failed of ${results.length}`,
    });

    return res.json({
      ok: failed === 0,
      jobId: job.id,
      total: results.length,
      pushed,
      failed,
      results,
    });
  });
}
