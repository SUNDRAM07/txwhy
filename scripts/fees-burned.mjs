// How much do failed transactions on the busiest programs cost their senders? Sample recent failures, read meta.fee.
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROGRAMS = {
  Jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "Raydium LaunchLab": "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  "Meteora DBC": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
};
const out = {};
for (const [name, id] of Object.entries(PROGRAMS)) {
  let sigs = [];
  for (let i = 0; i < 4 && !sigs.length; i++) sigs = await conn.getSignaturesForAddress(new PublicKey(id), { limit: 300 }).catch(async () => (await sleep(3000), []));
  const failed = sigs.filter((s) => s.err).slice(0, 25);
  const fees = [];
  for (const s of failed) {
    await sleep(700);
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (tx?.meta?.fee != null) fees.push(tx.meta.fee);
  }
  fees.sort((a, b) => a - b);
  const sum = fees.reduce((a, b) => a + b, 0);
  out[name] = { n: fees.length, failShare: (sigs.filter((s) => s.err).length / sigs.length).toFixed(2), meanLamports: Math.round(sum / fees.length), medianLamports: fees[Math.floor(fees.length / 2)], p90: fees[Math.floor(fees.length * 0.9)] };
  console.log(name, JSON.stringify(out[name]));
}
