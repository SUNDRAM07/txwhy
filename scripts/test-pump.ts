// Direct Pump.fun / PumpSwap slippage repairs on real failed mainnet transactions. Run: npx tsx scripts/test-pump.ts
// Landed failures are old, so most will have moved more than the 25% cap; the point is that every one
// gets either a verified repair or an honest "moved too far" verdict, never a crash or a fake fix.
import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { buildStalePumpSwapBuy } from "../src/lib/pump-demo";
import { repair } from "../src/lib/repair";

const c = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROGRAMS: [string, string, number[]][] = [
  ["PumpSwap", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", [6040, 6004]],
  ["Pump.fun", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", [6002, 6003, 6042]],
];

async function main() {
  let ok = 0;
  let total = 0;
  const tally: Record<string, number> = {};

  // Pre-send case: a genuine PumpSwap buy built with the program's SDK, max cost 10% under the price.
  {
    total++;
    const t = Date.now();
    try {
      const payer = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
      const { instructions } = await buildStalePumpSwapBuy(payer);
      const { blockhash } = await c.getLatestBlockhash();
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions] }).compileToLegacyMessage());
      const r = await repair({ transaction: Buffer.from(tx.serialize()).toString("base64") });
      const swap = r.changes.find((x) => x.type === "swap_quote");
      const good = r.status === "repaired" && !!swap && r.simulation.passed && r.verification?.ok === true && r.verification.changes.some((ch) => ch.kind === "swap_limit_moved");
      if (good) ok++;
      tally[good ? "REPAIRED" : "FAIL"] = (tally[good ? "REPAIRED" : "FAIL"] ?? 0) + 1;
      console.log(`${good ? "REPAIRED" : "FAIL    "} pre-send PumpSwap buy (${Date.now() - t} ms) | ${r.cause?.title ?? "-"} | ${swap ? `${swap.before} -> ${swap.after}` : r.summary.slice(0, 120)} | verified ${r.verification?.ok} (${r.verification?.changes.map((ch) => ch.kind).join(",")})`);
      if (!good) for (const n of r.notes) console.log("   -", n.slice(0, 200));
    } catch (e) {
      tally.ERROR = (tally.ERROR ?? 0) + 1;
      console.log(`ERROR    pre-send PumpSwap buy: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  for (const [name, pid, codes] of PROGRAMS) {
    const sigs = await c.getSignaturesForAddress(new PublicKey(pid), { limit: 120 });
    const hits = sigs.filter((s) => {
      const m = JSON.stringify(s.err ?? "").match(/"Custom":(\d+)/);
      return m && codes.includes(Number(m[1]));
    }).slice(0, 5);
    console.log(`\n=== ${name}: ${hits.length} recent slippage failures`);
    for (const h of hits) {
      total++;
      const t = Date.now();
      try {
        const r = await repair({ signature: h.signature });
        const swap = r.changes.find((x) => x.type === "swap_quote");
        const verdict = r.status === "repaired" && swap ? "REPAIRED" : r.status === "not_repairable" && /moved more than/.test(r.summary) ? "CAPPED  " : r.status.toUpperCase().padEnd(8);
        if (verdict === "REPAIRED" || verdict === "CAPPED  ") ok++;
        tally[verdict.trim()] = (tally[verdict.trim()] ?? 0) + 1;
        console.log(`${verdict} ${h.signature.slice(0, 10)} (${Date.now() - t} ms) | ${r.cause?.title ?? "-"} | ${swap ? `${swap.before} -> ${swap.after}` : r.summary.slice(0, 110)}${r.verification ? ` | verified ${r.verification.ok}` : ""}`);
        if (verdict.trim() === "NEEDS_REQUOTE") console.log(`         why: ${r.notes.filter((n) => /Pump|price|limit|found|swap/i.test(n)).join(" | ").slice(0, 260)}`);
      } catch (e) {
        tally.ERROR = (tally.ERROR ?? 0) + 1;
        console.log(`ERROR    ${h.signature.slice(0, 10)}: ${(e as Error).message.slice(0, 120)}`);
      }
      await sleep(300);
    }
  }
  console.log(`\n${ok}/${total} handled (repaired or honestly capped) | ${JSON.stringify(tally)}`);
  process.exit(ok === total ? 0 : 1);
}
main();
