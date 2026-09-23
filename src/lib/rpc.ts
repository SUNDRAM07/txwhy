/** Minimal JSON-RPC client with the three things a burst needs: a cap on in-flight calls, coalescing of identical calls, and very short caches for the two lookups every repair repeats. Chain state used for decisions is never served stale beyond those windows. */

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
/**
 * Used when the primary endpoint keeps failing, and for history: fast RPC providers keep only
 * recent transactions, so an older signature that comes back empty is looked up here instead.
 */
export const FALLBACK_URL = process.env.SOLANA_RPC_FALLBACK_URL ?? "https://api.mainnet-beta.solana.com";

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Worth retrying: rate limits, upstream hiccups, and node-behind errors. Never retry a request the node understood and rejected. */
const transientStatus = (status: number) => status === 429 || status >= 500;
const transientRpcCode = (code: number) => code === -32005 || code === -32004 || code === -32014 || code === -32016;
/** Some nodes report a warming-up or overloaded state with an ordinary code but a telling message. */
const transientMessage = (message: string) => /not ready|behind|overloaded|unhealthy|timed? ?out|try again|too many requests/i.test(message);

/** At most this many RPC calls in flight per instance; the rest queue. Bursts become a steady stream instead of a wall of 429s. */
const MAX_IN_FLIGHT = 12;
let inFlight = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}
function release() {
  inFlight--;
  waiters.shift()?.();
}

/** Seconds a retry should wait after a 429, from the Retry-After header when the node sends one. */
let retryAfterHint = 0;

async function once<T>(url: string, method: string, params: unknown[]): Promise<T> {
  await acquire();
  try {
    return await onceUnguarded<T>(url, method, params);
  } finally {
    release();
  }
}

async function onceUnguarded<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (res.status === 429) retryAfterHint = Math.min(5, Number(res.headers.get("retry-after") ?? 0) || 0);
  if (!res.ok) throw new RpcError(`RPC responded ${res.status}`, res.status);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcError(body.error.message, body.error.code);
  return body.result as T;
}

/**
 * Two quick retries on the primary endpoint, then one attempt on the fallback.
 * A transaction-repair service that dies on a single flaky upstream call would be a bad joke.
 */
/** Windows during which an identical call may be answered from the previous answer. */
const CACHE_MS: Record<string, number> = {
  getLatestBlockhash: 1_500, // a blockhash lives 60 to 90 seconds; sharing one across a burst is safe
  getMultipleAccounts: 20_000, // lookup tables and mint decimals, which change rarely
};
const cache = new Map<string, { until: number; value: Promise<unknown> }>();
const pending = new Map<string, Promise<unknown>>();

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const key = `${method}:${JSON.stringify(params)}`;
  const ttl = CACHE_MS[method];
  const now = Date.now();
  const hit = ttl ? cache.get(key) : undefined;
  if (hit && hit.until > now) return hit.value as Promise<T>;
  // Identical calls in flight at the same moment share one request.
  const shared = pending.get(key);
  if (shared) return shared as Promise<T>;
  const work = rpcUncached<T>(method, params);
  pending.set(key, work);
  if (ttl) cache.set(key, { until: now + ttl, value: work });
  try {
    return await work;
  } catch (e) {
    cache.delete(key);
    throw e;
  } finally {
    pending.delete(key);
    if (cache.size > 500) for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
  }
}

async function rpcUncached<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  const plan = [RPC_URL, RPC_URL, RPC_URL, ...(FALLBACK_URL !== RPC_URL ? [FALLBACK_URL] : [])];
  for (let attempt = 0; attempt < plan.length; attempt++) {
    try {
      const result = await once<T>(plan[attempt], method, params);
      if (result == null && method === "getTransaction" && FALLBACK_URL !== RPC_URL && plan[attempt] === RPC_URL) {
        return await once<T>(FALLBACK_URL, method, params).catch(() => result);
      }
      return result;
    } catch (e) {
      last = e;
      const retryable =
        !(e instanceof RpcError) || // network failure or timeout
        (e.code !== undefined && (transientStatus(e.code) || transientRpcCode(e.code))) ||
        transientMessage(e.message);
      if (!retryable || attempt === plan.length - 1) break;
      // A rate limit needs real backoff (and the node's own hint when it gives one); other hiccups only a beat.
      const rateLimited = e instanceof RpcError && e.code === 429;
      await sleep(rateLimited ? Math.max(retryAfterHint * 1000, 400 * 2 ** attempt) + Math.random() * 250 : 150 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new RpcError("RPC request failed");
}
