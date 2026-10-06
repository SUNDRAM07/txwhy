#!/usr/bin/env node
// npx txwhy <signature | explorer URL | base64 transaction>
const arg = process.argv[2];
const json = process.argv.includes("--json");
if (!arg || arg === "-h" || arg === "--help") {
  console.log("Usage: npx txwhy <signature | explorer URL | base64 transaction> [--json]\n\nDiagnoses a failed Solana transaction and prints a rebuilt, unsigned one when it can be repaired.");
  process.exit(arg ? 0 : 1);
}
const endpoint = process.env.TXWHY_ENDPOINT ?? "https://txwhy.vercel.app/api/v1/repair";
const looksLikeSignature = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(arg) || /^https?:\/\//.test(arg);
const body = looksLikeSignature ? { signature: arg } : { transaction: arg };

const res = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", "x-txwhy-client": process.env.TXWHY_CLIENT ?? "cli" },
  body: JSON.stringify(body),
});
const out = await res.json().catch(() => null);
if (!res.ok || !out || out.error) {
  console.error(`txwhy: ${out?.error ?? `service answered ${res.status}`}`);
  process.exit(2);
}
if (json) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const c = process.stdout.isTTY ? { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" } : { g: "", r: "", d: "", b: "", x: "" };
const repaired = out.status === "repaired" || out.status === "valid";
const headline = { repaired: "REPAIRED", valid: "VALID AS IS", needs_requote: "NO REPAIR: QUOTE STALE", not_repairable: "NO REPAIR" }[out.status] ?? out.status.toUpperCase();
console.log(`\n${repaired ? c.g : c.r}${c.b}${headline}${c.x}  ${out.summary}\n`);
if (!repaired) console.log(`${c.r}No transaction is returned. Nothing below is a repair.${c.x}\n`);
if (out.cause) {
  console.log(`${c.b}${out.cause.title}${c.x}${out.cause.code ? `  ${c.d}${out.cause.code}${c.x}` : ""}`);
  console.log(`${out.cause.cause}\n`);
  if (out.status !== "repaired") console.log(`${c.d}Fix:${c.x} ${out.cause.fix}\n`);
}
if (repaired) for (const ch of out.changes ?? []) {
  console.log(`  ${ch.type.padEnd(28)} ${c.r}${ch.before}${c.x} -> ${c.g}${ch.after}${c.x}`);
  if (ch.reason) console.log(`  ${"".padEnd(28)} ${c.d}${ch.reason}${c.x}`);
}
if (out.simulation && repaired) console.log(`\nSimulation of the returned transaction: ${out.simulation.passed ? `${c.g}passed${c.x}` : `${c.r}failed${c.x}`}${out.simulation.unitsConsumed ? ` (${out.simulation.unitsConsumed} compute units)` : ""}`);
if (out.verification) console.log(`Verification: ${out.verification.ok ? `${c.g}nothing else was touched${c.x} (${out.verification.kept} instructions kept byte for byte)` : `${c.r}${out.verification.violations.join(" ")}${c.x}`}`);
if (out.status === "repaired" && out.repairedTransaction) console.log(`\n${c.d}Rebuilt transaction, unsigned, base64:${c.x}\n${out.repairedTransaction}`);
for (const n of out.notes ?? []) console.log(`${c.d}- ${n}${c.x}`);
console.log("");
