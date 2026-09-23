import { OnlinePumpAmmSdk, PumpAmmSdk, buyQuoteInput } from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { RPC_URL } from "./rpc";

/**
 * Builds a real PumpSwap buy for the demo payer whose maximum cost is set 10% below the current
 * price, so it fails on slippage exactly the way a stale trade does. Uses the program's own SDK
 * to build the instructions, so the demo is a genuine PumpSwap transaction, not an imitation.
 */

const PUMP_SWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/** Known active SOL-quoted pools, tried in order; a fallback scan finds one from recent trades. */
const CANDIDATE_POOLS = ["3wkj63fLFY93Ch7XPbfXffKbvuQzttsa9Zb6jJZqQs3c", "E6qed4HhJ3dJTS2pAwZyo8GPM74rEEfuCL4r5oZppLHU"];
const MIN_QUOTE_RESERVE_LAMPORTS = 20 * 1e9; // a pool with at least 20 SOL, so 0.01 SOL barely moves it
const SPEND_LAMPORTS = 10_000_000; // 0.01 SOL

let cachedPool: { key: PublicKey; until: number } | null = null;

async function recentPools(connection: Connection): Promise<PublicKey[]> {
  const sigs = (await connection.getSignaturesForAddress(PUMP_SWAP, { limit: 40 })).filter((s) => !s.err).slice(0, 12);
  const seen = new Map<string, number>();
  for (const s of sigs) {
    const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
    if (!tx) continue;
    for (const ix of tx.transaction.message.instructions) {
      if (ix.programId.equals(PUMP_SWAP) && "accounts" in ix && ix.accounts.length > 4) {
        const pool = ix.accounts[0].toBase58();
        seen.set(pool, (seen.get(pool) ?? 0) + 1);
      }
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => new PublicKey(k));
}

export async function buildStalePumpSwapBuy(payer: PublicKey): Promise<{ instructions: TransactionInstruction[]; description: string }> {
  const connection = new Connection(RPC_URL, "confirmed");
  const online = new OnlinePumpAmmSdk(connection);
  const candidates = cachedPool && cachedPool.until > Date.now() ? [cachedPool.key] : CANDIDATE_POOLS.map((p) => new PublicKey(p));
  let lastError = "";
  for (const source of [candidates, null] as const) {
    const pools = source ?? (await recentPools(connection));
    for (const pool of pools) {
      try {
        const state = await online.swapSolanaState(pool, payer);
        if (!state.pool.quoteMint.equals(new PublicKey("So11111111111111111111111111111111111111112"))) continue;
        if (state.poolQuoteAmount.lt(new BN(MIN_QUOTE_RESERVE_LAMPORTS))) continue;
        const quote = buyQuoteInput({
          quote: new BN(SPEND_LAMPORTS),
          slippage: 1,
          baseReserve: state.poolBaseAmount,
          quoteReserve: state.poolQuoteAmount,
          globalConfig: state.globalConfig,
          baseMintAccount: state.baseMintAccount,
          baseMint: state.baseMint,
          coinCreator: state.pool.coinCreator,
          creator: state.pool.creator,
          feeConfig: state.feeConfig,
          quoteMint: state.pool.quoteMint,
          isMayhemMode: state.pool.isMayhemMode,
        });
        // Buy exactly the tokens 0.01 SOL gets today, but allow only 90% of the real cost: a stale price.
        const baseOut = quote.base;
        const staleMax = new BN(SPEND_LAMPORTS).muln(90).divn(100);
        const instructions = await new PumpAmmSdk().buyInstructions(state, baseOut, staleMax);
        cachedPool = { key: pool, until: Date.now() + 10 * 60_000 };
        return {
          instructions,
          description: `A PumpSwap buy of ${baseOut.toString()} tokens (worth about 0.01 SOL) whose maximum cost is 10% below the current price, so it fails on slippage.`,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  throw new Error(`No suitable PumpSwap pool for the demo right now${lastError ? ` (${lastError.slice(0, 80)})` : ""}.`);
}
