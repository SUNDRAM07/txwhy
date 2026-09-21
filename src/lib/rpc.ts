/** Minimal JSON-RPC client. Never cached: repair works on live chain state. */

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
/** Used only when the primary endpoint keeps failing. */
const FALLBACK_URL = process.env.SOLANA_RPC_FALLBACK_URL ?? "https://api.mainnet-beta.solana.com";

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

async function once<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new RpcError(`RPC responded ${res.status}`, res.status);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcError(body.error.message, body.error.code);
  return body.result as T;
}

/**
 * Two quick retries on the primary endpoint, then one attempt on the fallback.
 * A transaction-repair service that dies on a single flaky upstream call would be a bad joke.
 */
export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  const plan = [RPC_URL, RPC_URL, RPC_URL, ...(FALLBACK_URL !== RPC_URL ? [FALLBACK_URL] : [])];
  for (let attempt = 0; attempt < plan.length; attempt++) {
    try {
      return await once<T>(plan[attempt], method, params);
    } catch (e) {
      last = e;
      const retryable =
        !(e instanceof RpcError) || // network failure or timeout
        (e.code !== undefined && (transientStatus(e.code) || transientRpcCode(e.code)));
      if (!retryable || attempt === plan.length - 1) break;
      await sleep(150 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new RpcError("RPC request failed");
}
