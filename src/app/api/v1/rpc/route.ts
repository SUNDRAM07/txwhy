import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { rpc } from "@/lib/rpc";

/**
 * A narrow JSON-RPC pass-through for the browser. The public Solana endpoint answers browsers with
 * 403, so the wallet flows on /repair and /tx read lookup tables, balances, a landed transaction's
 * bytes and signature statuses through here, and hand the wallet-signed bytes on for sending. Six
 * read-mostly methods, rate-limited per client, nothing else.
 */

export const runtime = "nodejs";

const ALLOWED = new Set(["getTransaction", "getAccountInfo", "getBalance", "getSignatureStatuses", "sendTransaction", "getLatestBlockhash"]);
const MAX_BODY = 64_000;

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

function reply(id: unknown, body: { result?: unknown; error?: { code: number; message: string } }, status = 200) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, ...body }, { status });
}

export async function POST(request: Request) {
  const limit = rateLimit(request, "rpc", 60);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const text = await request.text();
  if (text.length > MAX_BODY) return reply(null, { error: { code: -32600, message: `Body too large (limit ${MAX_BODY} bytes).` } }, 413);
  let body: JsonRpcRequest;
  try {
    body = JSON.parse(text) as JsonRpcRequest;
  } catch {
    return reply(null, { error: { code: -32700, message: "Body must be a JSON-RPC request." } }, 400);
  }
  if (Array.isArray(body)) return reply(null, { error: { code: -32600, message: "Batches are not offered by this proxy." } }, 400);
  if (body === null || typeof body !== "object") return reply(null, { error: { code: -32600, message: "Body must be a JSON-RPC request object." } }, 400);
  const { id, method, params } = body;
  if (typeof method !== "string" || !ALLOWED.has(method)) {
    return reply(id, { error: { code: -32601, message: `Method ${String(method)} is not offered by this proxy; it serves the wallet flows on the site only.` } }, 400);
  }
  if (params !== undefined && !Array.isArray(params)) return reply(id, { error: { code: -32602, message: "params must be an array." } }, 400);
  try {
    const result = await rpc<unknown>(method, (params as unknown[] | undefined) ?? []);
    return reply(id, { result });
  } catch (e) {
    return reply(id, { error: { code: -32000, message: e instanceof Error ? e.message : "upstream did not answer" } }, 502);
  }
}
