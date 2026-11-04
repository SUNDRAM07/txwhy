// Prints live Meteora DBC pools that are still trading, from the program's most recent swaps, with the room left
// before graduation. Pick one for surfpool-scenarios/dbc-failures.ts.
//   npx tsx scripts/_dbc-live-pool.ts [limit]
import { Connection, PublicKey } from "@solana/web3.js";
// @ts-expect-error bs58 ships no types; the scripts in this folder decode inner-instruction data with it
import bs58 from "bs58";
import { CONFIG, DBC_PROGRAM, SWAP_IXS, fmtSol, readU64, viewPool } from "../surfpool-scenarios/dbc-layout";

const conn = new Connection(process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const limit = Number(process.argv[2] ?? 40);

async function main() {
  const sigs = await conn.getSignaturesForAddress(DBC_PROGRAM, { limit });
  const pools = new Map<string, string>();
  for (const s of sigs) {
    if (s.err || pools.size >= 8) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    await sleep(400);
    if (!tx) continue;
    const keys = tx.transaction.message.staticAccountKeys.concat(tx.meta?.loadedAddresses?.writable ?? [], tx.meta?.loadedAddresses?.readonly ?? []);
    const calls = tx.transaction.message.compiledInstructions
      .filter((ix) => keys[ix.programIdIndex]?.equals(DBC_PROGRAM))
      .map((ix) => ({ data: Buffer.from(ix.data), accounts: ix.accountKeyIndexes.map((k) => keys[k]) }));
    for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) if (keys[ix.programIdIndex]?.equals(DBC_PROGRAM)) calls.push({ data: Buffer.from(bs58.decode(ix.data)), accounts: ix.accounts.map((k) => keys[k]) });
    for (const c of calls) {
      const shape = SWAP_IXS[c.data.subarray(0, 8).toString("hex")];
      if (!shape || !/^swap/.test(shape.name)) continue;
      const pool = c.accounts[shape.poolIndex];
      if (pool && !pools.has(pool.toBase58())) pools.set(pool.toBase58(), `${shape.name} in ${s.signature.slice(0, 12)}`);
    }
  }
  for (const [address, via] of pools) {
    const [info] = await Promise.all([conn.getAccountInfo(new PublicKey(address))]);
    if (!info) continue;
    const v = viewPool(info.data);
    const cfg = await conn.getAccountInfo(v.config);
    await sleep(400);
    if (!cfg) continue;
    const threshold = readU64(cfg.data, CONFIG.migration_quote_threshold);
    const room = threshold - v.quoteReserve;
    console.log(`${address} | ${via} | raised ${fmtSol(v.quoteReserve)} of ${fmtSol(threshold)} | room ${fmtSol(room)} | migrated ${v.isMigrated} progress ${v.migrationProgress} | base ${v.baseMint.toBase58().slice(0, 8)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
