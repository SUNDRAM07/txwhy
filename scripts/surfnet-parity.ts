/**
 * Surfnet parity: real landed mainnet failures, replayed through the TxWhy engine twice, once with mainnet as the RPC
 * and once with a Surfpool surfnet, then diffed. A divergence with byte-identical account data is the runtime, not the
 * state. The report is what a nightly run publishes and what gets filed upstream with the reproducing calls.
 *
 *   npx tsx scripts/surfnet-parity.ts sample [perProgram=3] [out=parity/sample.json]
 *   npx tsx scripts/surfnet-parity.ts run <rpcUrl> <sample.json> <out.json>
 *   npx tsx scripts/surfnet-parity.ts diff <mainnet.json> <surfnet.json> [outDir=parity]
 *
 * `run` sets SOLANA_RPC_URL before the engine loads, so each side is its own process. The mainnet side falls back to
 * nothing; the surfnet side falls back to MAINNET_RPC_URL for getTransaction when the surfnet has no record.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MAINNET = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const WATCHED: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora DBC",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium LaunchLab",
};
const SIM_OPTS = { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, commitment: "confirmed", encoding: "base64" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(url: string, method: string, params: unknown[], tries = 4): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
      if (res.status === 429 && i < tries) { await sleep(5000 * (i + 1)); continue; }
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
      return j.result;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

interface Sampled { program: string; signature: string; err: unknown }
interface Sim { err: string; units: number | null; lastLog: string | null }
/** `simRef` is the same bytes simulated on mainnet in the same second as the surfnet simulation, so drift between the two reads is as small as it can be. */
interface Verdict { program: string; signature: string; status: string; title: string | null; summary: string; changes: string[]; sim: Sim; simRef?: Sim; ms: number; error?: string }

async function sample(perProgram: number, out: string) {
  const picked: Sampled[] = [];
  for (const [address, program] of Object.entries(WATCHED)) {
    const sigs: { signature: string; err: unknown }[] = await rpc(MAINNET, "getSignaturesForAddress", [address, { limit: 200 }]).catch(() => []);
    const failed = sigs.filter((s) => s.err);
    const step = Math.max(1, Math.floor(failed.length / perProgram));
    for (let i = 0; i < failed.length && picked.filter((p) => p.program === program).length < perProgram; i += step) picked.push({ program, signature: failed[i].signature, err: failed[i].err });
    await sleep(1200);
  }
  mkdirSync(out.replace(/[^/\\]+$/, "") || ".", { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), perProgram, sample: picked }, null, 1));
  console.log(`${picked.length} landed failures sampled from ${Object.keys(WATCHED).length} programs -> ${out}`);
}

async function run(rpcUrl: string, sampleFile: string, out: string) {
  process.env.SOLANA_RPC_URL = rpcUrl;
  if (rpcUrl !== MAINNET) process.env.SOLANA_RPC_FALLBACK_URL = MAINNET;
  const { repair } = await import("../src/lib/repair");
  const { sample: items } = JSON.parse(readFileSync(sampleFile, "utf8")) as { sample: Sampled[] };
  const version = await rpc(rpcUrl, "getVersion", []).catch(() => null);
  const results: Verdict[] = [];
  for (const item of items) {
    const started = Date.now();
    const base: Verdict = { program: item.program, signature: item.signature, status: "", title: null, summary: "", changes: [], sim: { err: "", units: null, lastLog: null }, ms: 0 };
    try {
      const r = await repair({ signature: item.signature });
      base.status = r.status; base.title = r.cause?.title ?? null; base.summary = r.summary.slice(0, 200); base.changes = r.changes.map((c) => c.type);
    } catch (e) {
      base.status = "error"; base.error = (e as Error).message.slice(0, 160);
    }
    try {
      const tx = await rpc(MAINNET, "getTransaction", [item.signature, { maxSupportedTransactionVersion: 1, encoding: "base64" }]);
      const pick = (sim: any): Sim => ({ err: JSON.stringify(sim.value.err), units: sim.value.unitsConsumed ?? null, lastLog: ((sim.value.logs ?? []) as string[]).filter((l) => /failed|Error|Left|Right/.test(l)).slice(-1)[0] ?? null });
      if (rpcUrl !== MAINNET) {
        const [ref, sim] = await Promise.all([rpc(MAINNET, "simulateTransaction", [tx.transaction[0], SIM_OPTS]), rpc(rpcUrl, "simulateTransaction", [tx.transaction[0], SIM_OPTS])]);
        base.simRef = pick(ref);
        base.sim = pick(sim);
      } else {
        base.sim = pick(await rpc(rpcUrl, "simulateTransaction", [tx.transaction[0], SIM_OPTS]));
      }
    } catch (e) {
      base.sim = { err: `sim error: ${(e as Error).message.slice(0, 120)}`, units: null, lastLog: null };
    }
    base.ms = Date.now() - started;
    results.push(base);
    console.log(`${item.program.padEnd(18)} ${item.signature.slice(0, 10)} ${base.status.padEnd(15)} ${base.title ?? "-"} | sim ${base.sim.err}`);
    await sleep(1500);
  }
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rpc: rpcUrl.replace(/\/\/[^@]*@/, "//"), version, results }, null, 1));
  console.log(`-> ${out}`);
}

async function accountsIdentical(signature: string, surfUrl: string): Promise<{ identical: boolean; dataDiffs: number; lamportsOnly: number } | null> {
  try {
    const tx = await rpc(MAINNET, "getTransaction", [signature, { maxSupportedTransactionVersion: 1, encoding: "json" }]);
    const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    const [m, s] = await Promise.all([rpc(MAINNET, "getMultipleAccounts", [keys, { encoding: "base64" }]), rpc(surfUrl, "getMultipleAccounts", [keys, { encoding: "base64" }])]);
    const hash = (a: any) => (a == null ? "missing" : createHash("sha256").update(Buffer.from(a.data[0], "base64")).digest("hex").slice(0, 12));
    let dataDiffs = 0, lamportsOnly = 0;
    keys.forEach((k, i) => {
      if (k === "SysvarRecentB1ockHashes11111111111111111111") return;
      const a = m.value[i], b = s.value[i];
      if (hash(a) !== hash(b)) dataDiffs++;
      else if (a && b && a.lamports !== b.lamports) lamportsOnly++;
    });
    return { identical: dataDiffs === 0, dataDiffs, lamportsOnly };
  } catch {
    return null;
  }
}

async function diff(mainFile: string, surfFile: string, outDir: string) {
  const main = JSON.parse(readFileSync(mainFile, "utf8")) as { at: string; version: any; results: Verdict[] };
  const surf = JSON.parse(readFileSync(surfFile, "utf8")) as { at: string; rpc: string; version: any; results: Verdict[] };
  const date = surf.at.slice(0, 10);
  const rows: { v: Verdict; w: Verdict; kind: string; accounts: Awaited<ReturnType<typeof accountsIdentical>> }[] = [];
  let same = 0;
  for (const v of main.results) {
    const w = surf.results.find((x) => x.signature === v.signature);
    if (!w) continue;
    const sameVerdict = v.status === w.status && v.title === w.title;
    const ref = w.simRef ?? v.sim; // mainnet at the same second when the surfnet run recorded it
    const sameSim = ref.err === w.sim.err;
    if (sameVerdict && sameSim) { same++; continue; }
    const accounts = sameSim ? null : await accountsIdentical(v.signature, surf.rpc);
    const rentShaped = /"Custom":2005\}|^"InsufficientFundsForRent|\[\d+,\{"Custom":1\}\]$/.test(w.sim.err) && !/"Custom":2005\}/.test(ref.err);
    const minutesApart = Math.round(Math.abs(Date.parse(surf.at) - Date.parse(main.at)) / 60000);
    const kind = w.status === "error"
      ? `surfnet RPC error during the engine run (${w.error ?? "unknown"}); the simulation itself matched mainnet`
      : sameSim
      ? `verdicts differ with identical simulations: state moved between the two engine runs (about ${minutesApart} min apart), or a quote differed`
      : accounts?.identical
        ? "runtime (same account data, different outcome)"
        : rentShaped
          ? "runtime, rent parameters (#870): the surfnet fails a rent check mainnet passes"
          : accounts
            ? `state drift (${accounts.dataDiffs} accounts differ between the two reads)`
            : "unclassified";
    rows.push({ v, w, kind, accounts });
    await sleep(1500);
  }
  const ver = (x: any) => (x ? `${x["surfnet-version"] ? `surfpool ${x["surfnet-version"]}, ` : ""}solana-core ${x["solana-core"]}, feature set ${x["feature-set"]}` : "unknown");
  const md: string[] = [];
  md.push(`# Surfnet parity, ${date}`);
  md.push("");
  md.push(`Real landed mainnet failures, replayed through the same TxWhy engine with mainnet and with a Surfpool surfnet as the RPC, and the landed bytes simulated on both. Mainnet: ${ver(main.version)}. Surfnet: ${ver(surf.version)}.`);
  md.push("");
  md.push(`**${main.results.length} failures from ${new Set(main.results.map((r) => r.program)).size} programs. Same verdict and same simulation outcome on ${same}. Diverging on ${rows.length}.**`);
  md.push("");
  if (rows.length) {
    md.push("| Program | Signature | Mainnet verdict | Surfnet verdict | Simulation, mainnet | Simulation, surfnet | Classification |");
    md.push("|---|---|---|---|---|---|---|");
    for (const { v, w, kind } of rows) {
      md.push(`| ${v.program} | ${v.signature.slice(0, 12)}… | ${v.status}${v.title ? ` (${v.title})` : ""} | ${w.status}${w.title ? ` (${w.title})` : ""} | ${(w.simRef ?? v.sim).err} | ${w.sim.err} | ${kind} |`);
    }
    md.push("");
    md.push("Runtime divergences are the ones worth filing: the surfnet held the same bytes in every account the transaction touches and still ran it differently. State divergences are balance or pool drift between the two reads and say nothing about the runtime.");
    md.push("");
    md.push("Reproduce any row: `getTransaction(signature, {encoding: \"base64\", maxSupportedTransactionVersion: 1})` on mainnet, then `simulateTransaction` of those bytes with `sigVerify: false, replaceRecentBlockhash: true` on both RPCs.");
  } else {
    md.push("No divergence today.");
  }
  md.push("");
  md.push(`Full signatures and verdicts: \`${date}.json\` beside this file. Known upstream: solana-foundation/surfpool #870 (rent parameters behind SIMD-0437; fix in #873).`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/${date}.json`, JSON.stringify({ date, mainnet: main, surfnet: surf, divergences: rows.map(({ v, w, kind, accounts }) => ({ program: v.program, signature: v.signature, mainnet: v, surfnet: w, kind, accounts })) }, null, 1));
  writeFileSync(`${outDir}/latest.md`, md.join("\n") + "\n");
  console.log(md.join("\n"));
}

const [cmd, ...args] = process.argv.slice(2);
const main = async () => {
  if (cmd === "sample") return sample(Number(args[0] ?? 3), args[1] ?? "parity/sample.json");
  if (cmd === "run") return run(args[0], args[1], args[2]);
  if (cmd === "diff") return diff(args[0], args[1], args[2] ?? "parity");
  console.log("usage: sample [perProgram] [out] | run <rpcUrl> <sample.json> <out.json> | diff <mainnet.json> <surfnet.json> [outDir]");
};
main().catch((e) => { console.error(e); process.exit(1); });
