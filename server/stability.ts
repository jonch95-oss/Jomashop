// Shared stability primitives used across the heavy endpoints (XLSX
// import/export, product refresh/cache, live schema loading). Each helper
// here is intentionally tiny and dependency-free so the hardening surface is
// easy to audit and so importing it is cheap.

import type { Response } from "express";
import { logMemory } from "./memlog";

// ---------- Process-level handlers ----------

let processHandlersInstalled = false;

/**
 * Install once-per-process handlers so an uncaught exception or unhandled
 * promise rejection inside a route handler is logged with full context
 * instead of silently killing the worker (Render shows "service exited with
 * status 134" when the V8 abort fires from an uncaught throw). We do NOT
 * exit the process — Render's process manager would restart us anyway, and
 * staying up lets the operator see the error on /api/health and in logs.
 */
export function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on("uncaughtException", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[uncaughtException]", err?.stack || err);
    try {
      logMemory("uncaughtException", { message: err?.message });
    } catch {
      // logMemory is best-effort
    }
  });

  process.on("unhandledRejection", (reason: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[unhandledRejection]", reason);
    try {
      logMemory("unhandledRejection", {
        message: (reason as Error)?.message ?? String(reason),
      });
    } catch {
      // best-effort
    }
  });

  // Node emits 'warning' for things like ExperimentalWarning, MaxListeners,
  // etc. Worth logging so an exhausted listener pool shows up before it
  // becomes an OOM.
  process.on("warning", (warning: Error) => {
    // eslint-disable-next-line no-console
    console.warn("[node.warning]", warning?.name, warning?.message);
  });
}

// ---------- In-process locks for heavy operations ----------

const LOCKS = new Map<string, { acquiredAt: number; label: string }>();

/**
 * Attempt to acquire a named in-process lock. Returns true when acquired,
 * false when the lock is already held. Use this to gate operations that
 * would crush the process if run concurrently (full product cache
 * recompute, large XLSX import). The caller MUST release the lock in a
 * finally block.
 *
 * Stale-lock protection: if a lock has been held for longer than
 * `maxAgeMs`, we forcibly take it. This guards against a previous request
 * that crashed before reaching its finally block (the worker came back up
 * but the lock object survives because it lives in module memory).
 */
export function tryAcquireLock(
  name: string,
  opts: { maxAgeMs?: number } = {},
): boolean {
  const maxAgeMs = opts.maxAgeMs ?? 15 * 60 * 1000;
  const existing = LOCKS.get(name);
  if (existing && Date.now() - existing.acquiredAt < maxAgeMs) {
    return false;
  }
  LOCKS.set(name, { acquiredAt: Date.now(), label: name });
  return true;
}

export function releaseLock(name: string): void {
  LOCKS.delete(name);
}

export function lockStatus(name: string): { held: boolean; ageMs: number } {
  const existing = LOCKS.get(name);
  if (!existing) return { held: false, ageMs: 0 };
  return { held: true, ageMs: Date.now() - existing.acquiredAt };
}

/**
 * Convenience wrapper that returns a 409 JSON response when the named lock
 * is held. The intent is one-liner gating at the top of a route handler:
 *
 *     if (!withLockOr409(res, "products.refresh")) return;
 *     try { ... } finally { releaseLock("products.refresh"); }
 */
export function withLockOr409(res: Response, name: string): boolean {
  if (!tryAcquireLock(name)) {
    const status = lockStatus(name);
    res.status(409).json({
      ok: false,
      error:
        `Operation "${name}" is already running (held for ${Math.round(status.ageMs / 1000)}s). ` +
        `Retry once it completes.`,
    });
    return false;
  }
  return true;
}

// ---------- Bounded session map ----------

/**
 * Map-like store for parsed XLSX import sessions. Caps the total number of
 * concurrently-held sessions (the oldest are evicted) and the per-session
 * row count, so a misbehaving client cannot pin hundreds of megabytes of
 * parsed rows in the worker. TTL eviction is still the responsibility of
 * the caller (it's already wired into every import-preview route).
 */
export type BoundedSession<T> = {
  id: string;
  createdAt: number;
  payload: T;
};

export class BoundedSessionStore<T> {
  private readonly store = new Map<string, BoundedSession<T>>();

  constructor(
    private readonly opts: {
      maxSessions: number;
      ttlMs: number;
      /** Label used in log lines when we evict. */
      label: string;
    },
  ) {}

  set(id: string, payload: T): void {
    this.gc();
    if (this.store.size >= this.opts.maxSessions) {
      // Evict the oldest entry (LRU-by-creation). Map iteration order is
      // insertion order so the first key is the oldest.
      const oldest = this.store.keys().next();
      if (!oldest.done) {
        this.store.delete(oldest.value);
      }
    }
    this.store.set(id, { id, createdAt: Date.now(), payload });
  }

  get(id: string): T | undefined {
    this.gc();
    const entry = this.store.get(id);
    return entry?.payload;
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  gc(): void {
    const cutoff = Date.now() - this.opts.ttlMs;
    const stale: string[] = [];
    this.store.forEach((s, id) => {
      if (s.createdAt < cutoff) stale.push(id);
    });
    for (const id of stale) this.store.delete(id);
  }

  size(): number {
    return this.store.size;
  }
}

// ---------- Multer error → JSON ----------

/**
 * Normalize multer upload errors into a JSON 4xx instead of letting them
 * bubble through the Express error pipeline and surface as HTML 500s.
 * Returns true when the error was handled (the caller should return), false
 * otherwise.
 */
export function handleMulterError(err: unknown, res: Response): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string };
  if (e?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({
      ok: false,
      error: "Uploaded file exceeds the per-route size limit. Reduce the file size and retry.",
    });
    return true;
  }
  if (e?.code === "LIMIT_FILE_COUNT" || e?.code === "LIMIT_FIELD_COUNT") {
    res.status(413).json({ ok: false, error: e.message || "Upload field limit exceeded." });
    return true;
  }
  if (typeof e?.code === "string" && e.code.startsWith("LIMIT_")) {
    res.status(413).json({ ok: false, error: e.message || "Upload limit exceeded." });
    return true;
  }
  return false;
}

// ---------- Row count + buffer guard ----------

/**
 * Cap on rows we'll parse from an XLSX import. Beyond this we reject with
 * 422 — the operator should split the file or use the streaming API.
 * Picked empirically so the parsed payload stays under ~50 MB on a typical
 * Jomashop product workbook.
 */
export const MAX_IMPORT_ROWS = 25000;

/**
 * Guard for parsed row arrays. Returns true if the request was rejected
 * (the caller should return immediately), false to continue.
 */
export function rejectIfTooManyRows(
  res: Response,
  rowCount: number,
  max: number = MAX_IMPORT_ROWS,
): boolean {
  if (rowCount > max) {
    res.status(422).json({
      ok: false,
      error:
        `Uploaded workbook contains ${rowCount} rows; the per-import cap is ${max}. ` +
        `Split the workbook into smaller chunks and retry.`,
    });
    return true;
  }
  return false;
}

// ---------- Memory snapshot around a heavy block ----------

/**
 * Wrap a heavy async block so we log RSS/heap before and after it runs.
 * The wrapper does NOT catch the inner error — callers should still wrap
 * the body in try/catch and return a JSON error.
 */
export async function withMemorySnapshot<T>(
  label: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  logMemory(`${label}.start`, extra);
  try {
    const out = await fn();
    logMemory(`${label}.done`, extra);
    return out;
  } catch (err) {
    logMemory(`${label}.failed`, { ...extra, message: (err as Error)?.message });
    throw err;
  }
}
