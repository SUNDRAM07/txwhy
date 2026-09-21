/**
 * Per-instance sliding-window rate limiter.
 *
 * Serverless instances are reused across many requests, so this stops a single client
 * from hammering the RPC behind us. It is a floor, not a guarantee: limits are per
 * instance, not global. Swap the store for Redis when one is attached.
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
