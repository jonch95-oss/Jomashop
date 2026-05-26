// Lightweight RSS/heap logger used to diagnose Render OOMs during Shopify
// refresh / cache endpoints. Logs are best-effort and never throw — if
// process.memoryUsage isn't available, this becomes a no-op.

export function rssMb(): number {
  try {
    return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
  } catch {
    return -1;
  }
}

export function heapMb(): number {
  try {
    return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
  } catch {
    return -1;
  }
}

export function logMemory(label: string, extra?: Record<string, unknown>): void {
  const rss = rssMb();
  const heap = heapMb();
  const ts = new Date().toISOString();
  const tail = extra ? " " + JSON.stringify(extra) : "";
  // eslint-disable-next-line no-console
  console.log(`[mem ${ts}] ${label} rss=${rss}MB heap=${heap}MB${tail}`);
}
