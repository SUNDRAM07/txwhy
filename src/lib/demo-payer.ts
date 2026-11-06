import { PublicKey } from "@solana/web3.js";
import { rpc } from "./rpc";

/**
 * Who pays in the demo transactions.
 *
 * The demos are unsigned transactions that only ever get simulated, so the fee payer is a public
 * exchange wallet: an account with SOL (and, for the swap demos, USDC) that nobody but its owner
 * could sign for. One fixed wallet was enough until October 30, 2026, when the USDC account of the
 * wallet the demos had used since launch was frozen by the mint's freeze authority: every USDC swap
 * for it began to fail with AccountFrozen, which the engine named correctly and which no rebuild can
 * fix, so two demos showed a refusal where they meant to show a repair.
 *
 * So the payer is now chosen from a short list by what the chain says right now: enough SOL for any
 * demo, and for the swap demos a USDC account that exists, is not frozen and holds a few dollars.
 * One getMultipleAccounts call, cached for ten minutes.
 */

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** In order of preference. The first is the wallet every demo used until its USDC account was frozen. */
const CANDIDATES = [
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
  "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm",
  "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w",
].map((a) => new PublicKey(a));

const MIN_LAMPORTS = 1_000_000_000; // 1 SOL covers the largest demo (a 2 SOL buy is quoted, never funded) and every fee
const MIN_USDC = 5_000_000; // 5 USDC; the Raydium demo spends 1

export interface DemoPayers {
  /** Has SOL. For the transfer, compute, blockhash, v1, Pump and price-impact demos. */
  payer: PublicKey;
  /** Has SOL and a USDC account that is not frozen. For the Jupiter and Raydium swap demos. */
  swapPayer: PublicKey;
}

type Parsed = { lamports?: number; data?: { parsed?: { info?: { state?: string; tokenAmount?: { amount?: string } } } } } | null;

const usdcAccount = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC.toBuffer()], ATA_PROGRAM)[0];

let cache: { at: number; value: DemoPayers } | null = null;

export async function demoPayers(): Promise<DemoPayers> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.value;
  const fallback: DemoPayers = { payer: CANDIDATES[0], swapPayer: CANDIDATES[1] };
  try {
    const keys = [...CANDIDATES.map((c) => c.toBase58()), ...CANDIDATES.map((c) => usdcAccount(c).toBase58())];
    const { value } = await rpc<{ value: Parsed[] }>("getMultipleAccounts", [keys, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const n = CANDIDATES.length;
    const funded = CANDIDATES.map((_, i) => (value[i]?.lamports ?? 0) >= MIN_LAMPORTS);
    const usdcOk = CANDIDATES.map((_, i) => {
      const info = value[n + i]?.data?.parsed?.info;
      return info?.state === "initialized" && BigInt(info.tokenAmount?.amount ?? "0") >= BigInt(MIN_USDC);
    });
    const payerIndex = funded.indexOf(true);
    const swapIndex = CANDIDATES.findIndex((_, i) => funded[i] && usdcOk[i]);
    const picked: DemoPayers = {
      payer: payerIndex >= 0 ? CANDIDATES[payerIndex] : fallback.payer,
      swapPayer: swapIndex >= 0 ? CANDIDATES[swapIndex] : fallback.swapPayer,
    };
    cache = { at: Date.now(), value: picked };
    return picked;
  } catch {
    // The node did not answer; the demo still builds, on the wallets that were healthy when this was written.
    return fallback;
  }
}
