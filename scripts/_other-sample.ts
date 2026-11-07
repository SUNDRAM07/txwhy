// What is in the worker's "Other" bucket? Pushes a fresh sample of landed failures on the nine watched programs
// through the engine, exactly as the worker does, and prints the title + reason of every verdict whyNot files as
// "other" (and, with "all", the full bucket tally). No network beyond the RPC.
//   npx tsx scripts/_other-sample.ts [perProgram] [all]
import { repair } from "../src/lib/repair";
import { reasonKey, whyNot } from "../worker/reason";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const WATCHED: Record<string, string> = {
  Jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "Raydium AMM": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "Orca Whirlpool": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "Meteora DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "Raydium LaunchLab": "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  "Meteora DBC": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  "Meteora DAMM v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
};
const PER = Number(process.argv[2] ?? 8);
const ALL = process.argv.includes("all");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = (await r.json()) as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result as T;
    } catch (e) {
      await sleep(3000 * (i + 1));
      if (i === 5) throw e;
    }
  }
  throw new Error("unreachable");
}

async function main() {
  const tally: Record<string, number> = {};
  const other: { program: string; sig: string; row: string; status: string; notes: string[] }[] = [];
  let n = 0;
  for (const [label, id] of Object.entries(WATCHED)) {
    const sigs = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [id, { limit: 400 }]);
    const failed = sigs.filter((s) => s.err);
    const step = Math.max(1, Math.floor(failed.length / PER));
    for (const s of failed.filter((_, i) => i % step === 0).slice(0, PER)) {
      await sleep(1500);
      let r;
      try {
        r = await repair({ signature: s.signature });
      } catch (e) {
        tally["exception: " + String((e as Error).message).slice(0, 40)] = (tally["exception: " + String((e as Error).message).slice(0, 40)] ?? 0) + 1;
        continue;
      }
      n++;
      const verdict = r.status === "repaired" ? "repaired" : r.status === "valid" ? "valid" : r.status === "needs_requote" ? "moved_too_far" : "not_repairable";
      const why = verdict === "repaired" || verdict === "valid" ? verdict : whyNot(r);
      tally[why] = (tally[why] ?? 0) + 1;
      if (why === "other" || why === "needs_requote_other") other.push({ program: label, sig: s.signature, row: reasonKey(r.cause?.title, r.summary), status: r.status, notes: r.notes.slice(0, 2) });
    }
    console.log(`${label}: done (${n} so far)`);
  }
  console.log(`\n${n} replayed`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t${k}`);
  console.log(`\n== other (${other.length})`);
  for (const o of other) console.log(`${o.program}\t${o.sig}\n   ${o.row}\n   notes: ${o.notes.join(" | ").slice(0, 300)}`);
  if (ALL) console.log(JSON.stringify(other, null, 1));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
