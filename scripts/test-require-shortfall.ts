// A bare require_gte! balance check (no error code of its own) gets the sell-shortfall verdict with figures, and a
// version 1 transaction the engine diagnosed but could not rebuild gets its own row. The first check replays a landed
// mainnet failure (Raydium LaunchLab sell_exact_in through the Bloom router, Nov 7 2026), so it needs the RPC.
// Run: npx tsx scripts/test-require-shortfall.ts
import { repair } from "../src/lib/repair";
import { reasonKey, whyNot } from "../worker/reason";

let failed = 0;
function ok(name: string, pass: boolean, detail = "") {
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : `\n     ${detail}`}`);
}

async function main() {
  // Balance 0, sell for 9,507,761,991,343 raw units; the program logged "Left: 0" and "Right: 9507761991343".
  const r = await repair({ signature: "2gLexTrpZLGS3oYXbU5VrEQEcwuzTPPfDqA83GKGgXAUGJrdzQ4Ngw4wXAhJDD1cDbjGsbEUfXW5J14ZGLQS232i" });
  ok("status is not_repairable", r.status === "not_repairable", r.status);
  ok("title names the shortfall, not the Anchor macro", r.cause?.title === "Not enough tokens to sell", r.cause?.title);
  ok("the cause carries the program, the instruction and both figures", /^Raydium LaunchLab's sell_exact_in refused this sell before touching the pool: the instruction sells [\d.,]+ (tokens|raw token units) and token account FcqaZo\w+ held 0 (tokens|raw token units) when it ran/.test(r.cause?.cause ?? ""), r.cause?.cause);
  ok("the router is named", /The trade came through \S+, which worked out the amount\./.test(r.cause?.cause ?? ""), r.cause?.cause);
  ok("it says why the error read RequireGteViolated", /no error code of its own/.test(r.cause?.cause ?? ""));
  ok("the fix says to rebuild from the balance", /^Rebuild the sell from the current balance/.test(r.cause?.fix ?? ""), r.cause?.fix);
  const bucket = whyNot(r);
  ok("worker bucket: no_funds", bucket === "no_funds", bucket);
  const row = reasonKey(r.cause?.title, r.summary);
  ok("ranked row keeps the heading and carries no figure or account", /^Not enough tokens to sell: Raydium LaunchLab's sell_exact_in refused this sell before touching the pool/.test(row) && !/\d|FcqaZo/.test(row) && row.length <= 120, row);

  // A version 1 transaction the engine diagnosed (slippage) but has no rebuild path for.
  const v1 = {
    status: "not_repairable",
    summary: "Diagnosed, but not rebuilt: this is a version 1 transaction (SIMD-0385, live on mainnet since Sep 15, 2026). Its compute settings live in the header rather than in instructions, and the rebuild path for that format is in progress.",
    cause: { title: "SlippageToleranceExceeded" },
    notes: ["Apply the fix above when you rebuild the transaction in your own client."],
  };
  ok("v1 diagnosed-not-rebuilt gets its own bucket", whyNot(v1) === "v1_not_rebuilt", whyNot(v1));
  ok("  but a v1 failure in a private program stays private_program", whyNot({ ...v1, cause: { title: "Error 6001 from a private program" } }) === "private_program");
  ok("  and a v1 failure for lack of funds stays no_funds", whyNot({ ...v1, cause: { title: "Not enough SOL" } }) === "no_funds");

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
