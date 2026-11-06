import { after } from "next/server";
import { REPAIR_BODY_LIMIT } from "@/lib/body";
import { clientKey, globalLimit, rateLimit } from "@/lib/ratelimit";
import { RepairInputError, repair } from "@/lib/repair";
import { RpcError, rpc } from "@/lib/rpc";
import { track } from "@/lib/stats";
import { extractSignature } from "@/lib/trace";

/**
 * JSON-RPC 2.0 door, two jobs.
 *
 * 1. `repairTransaction`: the repair engine as an RPC method, for anyone whose stack already speaks
 *    JSON-RPC to a Solana node (an RPC provider's gateway, a bot, a backend). Same engine, same
 *    limits and same answer as POST /api/v1/repair, in a JSON-RPC envelope:
 *
 *      {"jsonrpc":"2.0","id":1,"method":"repairTransaction","params":["<base64 transaction, signed or unsigned>"]}
 *      {"jsonrpc":"2.0","id":1,"method":"repairTransaction","params":["<signature of a landed failure>"]}
 *      {"jsonrpc":"2.0","id":1,"method":"repairTransaction","params":[{"transaction":"..."}]}   (or {"signature":"..."})
 *
 *    `result` is the repair object: status, cause, changes, repairedTransaction (unsigned), the
 *    simulation and the verifier's proof. `txwhy_repairTransaction` is the same method under a
 *    namespaced name, for gateways that route by prefix.
 *
 * 2. A narrow pass-through for the browser. The public Solana endpoint answers browsers with 403, so
 *    the wallet flows on /repair and /tx read lookup tables, balances, a landed transaction's bytes
 *    and signature statuses through here, and hand the wallet-signed bytes on for sending. Six
 *    read-mostly methods, rate-limited per client, nothing else.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const ALLOWED = new Set(["getTransaction", "getAccountInfo", "getBalance", "getSignatureStatuses", "sendTransaction", "getLatestBlockhash"]);
const REPAIR_METHODS = new Set(["repairTransaction", "txwhy_repairTransaction"]);
const MAX_BODY = 64_000;
const PARAMS_HELP = 'params must be ["<base64 transaction>"], ["<signature>"], or [{ "transaction": "..." }] / [{ "signature": "..." }].';

type JsonRpcRequest = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type JsonRpcError = { code: number; message: string; data?: unknown };

function reply(id: unknown, body: { result?: unknown; error?: JsonRpcError }, status = 200, headers: Record<string, string> = {}) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, ...body }, { status, headers });
}

function slowDown(id: unknown, retryAfterSeconds: number) {
  return reply(id, { error: { code: -32005, message: "Too many requests. Slow down and retry.", data: { retryable: true, retryAfterSeconds } } }, 429, { "retry-after": String(retryAfterSeconds) });
}

/** A string that is a signature or an explorer link is a landed transaction; any other string is transaction bytes. */
function repairInput(params: unknown): { signature?: string; transaction?: string } | string {
  const first = Array.isArray(params) ? params[0] : params;
  const asSignature = (s: string) => {
    const signature = extractSignature(s);
    return signature ? { signature } : "That does not look like a transaction signature or explorer link.";
  };
  if (typeof first === "string") {
    const s = first.trim();
    if (/^https?:\/\//i.test(s) || /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s)) return asSignature(s);
    return s.length > REPAIR_BODY_LIMIT ? `Transaction too large (limit ${REPAIR_BODY_LIMIT} characters of base64).` : { transaction: s };
  }
  if (first && typeof first === "object") {
    const o = first as { signature?: unknown; transaction?: unknown };
    if (typeof o.transaction === "string") {
      return o.transaction.length > REPAIR_BODY_LIMIT ? `Transaction too large (limit ${REPAIR_BODY_LIMIT} characters of base64).` : { transaction: o.transaction };
    }
    if (typeof o.signature === "string") return asSignature(o.signature);
  }
  return PARAMS_HELP;
}

async function repairMethod(request: Request, id: unknown, params: unknown) {
  // The JSON-RPC door and the REST door draw on one repair budget.
  const limit = rateLimit(request, "repair", 30);
  if (!limit.ok) return slowDown(id, limit.retryAfterSeconds);

  const input = repairInput(params);
  if (typeof input === "string") return reply(id, { error: { code: -32602, message: input } }, 400);

  try {
    const allowed = Promise.all([globalLimit(request, "repair", 60), globalLimit(request, "repair-all", 1200, "everyone")]).then(
      (v) => v.find((x) => !x.ok) ?? { ok: true as const },
    );
    // Vercel stops the function at maxDuration. Answer before that with something a client can act on.
    const result = await Promise.race([
      repair(input),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RpcError("upstream did not answer in time")), 26_000)),
    ]);
    const verdict = await allowed;
    if (!verdict.ok) return slowDown(id, verdict.retryAfterSeconds);
    if (request.headers.get("x-txwhy-client") !== "test") {
      const caller = clientKey(request);
      after(() => track({ kind: "repair", channel: "api", status: result.status, errorTitle: result.cause?.title, caller }));
    }
    return reply(id, { result });
  } catch (e) {
    if (e instanceof RepairInputError) return reply(id, { error: { code: -32602, message: e.message } }, 400);
    if (e instanceof RpcError) return reply(id, { error: { code: -32000, message: `Upstream RPC error: ${e.message}`, data: { retryable: true } } }, 502);
    return reply(id, { error: { code: -32603, message: e instanceof Error ? e.message : "Unexpected error" } }, 500);
  }
}

export async function POST(request: Request) {
  const limit = rateLimit(request, "rpc", 60);
  if (!limit.ok) return slowDown(null, limit.retryAfterSeconds);

  const text = await request.text();
  if (text.length > MAX_BODY) return reply(null, { error: { code: -32600, message: `Body too large (limit ${MAX_BODY} bytes).` } }, 413);
  let body: JsonRpcRequest;
  try {
    body = JSON.parse(text) as JsonRpcRequest;
  } catch {
    return reply(null, { error: { code: -32700, message: "Body must be a JSON-RPC request." } }, 400);
  }
  if (Array.isArray(body)) return reply(null, { error: { code: -32600, message: "Batches are not offered by this endpoint." } }, 400);
  if (body === null || typeof body !== "object") return reply(null, { error: { code: -32600, message: "Body must be a JSON-RPC request object." } }, 400);
  const { id, method, params } = body;
  if (typeof method === "string" && REPAIR_METHODS.has(method)) return repairMethod(request, id, params);
  if (typeof method !== "string" || !ALLOWED.has(method)) {
    return reply(id, { error: { code: -32601, message: `Method ${String(method)} is not offered here. This endpoint serves repairTransaction and the six read methods the site's wallet flows use.` } }, 400);
  }
  if (params !== undefined && !Array.isArray(params)) return reply(id, { error: { code: -32602, message: "params must be an array." } }, 400);
  try {
    const result = await rpc<unknown>(method, (params as unknown[] | undefined) ?? []);
    return reply(id, { result });
  } catch (e) {
    return reply(id, { error: { code: -32000, message: e instanceof Error ? e.message : "upstream did not answer" } }, 502);
  }
}
