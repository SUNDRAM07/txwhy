/** Minimal JSON-RPC client. Never cached — repair works on live chain state. */

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
  }
}

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  if (!res.ok) throw new RpcError(`RPC responded ${res.status}`, res.status);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcError(body.error.message, body.error.code);
  return body.result as T;
}
