/**
 * Per-instance sliding-window rate limiter.
 *
 * Serverless instances are reused across many requests, so this stops a single client
 * from hammering the RPC behind us. It is a floor, not a guarantee: limits are per
 * instance, not global. globalLimit() below is the global one, backed by the worker's Redis.
 */

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();
let lastSweep = 0;

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "unknown").trim();
}

export function rateLimit(
  request: Request,
  bucket: string,
  limitPerMinute: number,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  if (now - lastSweep > WINDOW_MS) {
    lastSweep = now;
    for (const [k, times] of hits) {
      if (times.every((t) => now - t > WINDOW_MS)) hits.delete(k);
    }
  }
  const key = `${bucket}:${clientKey(request)}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limitPerMinute) {
    hits.set(key, recent);
    return { ok: false, retryAfterSeconds: Math.ceil((WINDOW_MS - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true };
}

export function tooManyRequests(retryAfterSeconds: number, headers: Record<string, string> = {}) {
  return Response.json(
    { error: "Too many requests. Slow down and retry.", retryable: true, retryAfterSeconds },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds), ...headers } },
  );
}

const WORKER_URL = process.env.WORKER_URL?.replace(/\/$/, "");
const WORKER_SECRET = process.env.WORKER_SECRET;

/**
 * Global limit across every serverless instance, counted in the worker's Redis.
 *
 * Start it BEFORE the expensive work and await it AFTER, so it runs alongside the repair and
 * adds no latency. Fails open: if the worker is slow or down, the per-instance limit above
 * still applies and nobody is locked out.
 */
export async function globalLimit(
  request: Request,
  bucket: string,
  limitPerMinute: number,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  if (!WORKER_URL || !WORKER_SECRET) return { ok: true };
  try {
    const res = await fetch(`${WORKER_URL}/limit`, {
      method: "POST",
      headers: { authorization: `Bearer ${WORKER_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ caller: clientKey(request), bucket, limit: limitPerMinute }),
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { ok: true };
    const body = (await res.json()) as { ok: boolean; retryAfterSeconds?: number };
    return body.ok ? { ok: true } : { ok: false, retryAfterSeconds: body.retryAfterSeconds ?? 30 };
  } catch {
    return { ok: true };
  }
}
