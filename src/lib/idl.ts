import { PublicKey } from "@solana/web3.js";
import { inflateSync } from "zlib";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export interface IdlErrorEntry {
  name: string;
  msg?: string;
}

/** In-process cache — IDLs change rarely; a trace burst shouldn't refetch. */
const idlErrorCache = new Map<string, Map<number, IdlErrorEntry> | null>();

/**
 * Layer 2 of the decoder: fetch a program's Anchor IDL from its on-chain
 * IDL account and return the error-code map, or null when no IDL is published.
 *
 * Anchor stores the IDL at createWithSeed(base, "anchor:idl", programId)
 * where base = findProgramAddress([], programId). Account layout:
 * 8-byte discriminator | 32-byte authority | u32 length | zlib-compressed JSON.
 */
export async function fetchIdlErrors(
  programIdStr: string,
): Promise<Map<number, IdlErrorEntry> | null> {
  const cached = idlErrorCache.get(programIdStr);
  if (cached !== undefined) return cached;

  try {
    const programId = new PublicKey(programIdStr);
    const [base] = PublicKey.findProgramAddressSync([], programId);
    const idlAddress = await PublicKey.createWithSeed(base, "anchor:idl", programId);

    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [idlAddress.toBase58(), { encoding: "base64" }],
      }),
      next: { revalidate: 86400 },
    });
    const { result } = (await res.json()) as {
      result: { value: { data: [string, string] } | null };
    };
    if (!result?.value) {
      idlErrorCache.set(programIdStr, null);
      return null;
    }

    const raw = Buffer.from(result.value.data[0], "base64");
    const dataLen = raw.readUInt32LE(40); // 8 discriminator + 32 authority
    const compressed = raw.subarray(44, 44 + dataLen);
    const idl = JSON.parse(inflateSync(compressed).toString("utf8")) as {
      errors?: { code: number; name: string; msg?: string }[];
    };

    const map = new Map<number, IdlErrorEntry>();
    for (const e of idl.errors ?? []) {
      map.set(e.code, { name: e.name, msg: e.msg });
    }
    idlErrorCache.set(programIdStr, map);
    return map;
  } catch {
    idlErrorCache.set(programIdStr, null);
    return null;
  }
}
