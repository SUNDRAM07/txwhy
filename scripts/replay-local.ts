// Replay fresh landed failures from one program through the LOCAL engine (not production), so an engine
// change can be measured before it ships.
//   npx tsx scripts/replay-local.ts <program> <code> [count=10]
import { Connection, PublicKey } from "@solana/web3.js";
import { repair } from "../src/lib/repair";

const [program, code, count] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4] ?? 10)];
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
let sigs: Awaited<ReturnType<typeof conn.getSignaturesForAddress>> = [];
for (let i = 0; i < 6 && !sigs.length; i++) sigs = await conn.getSignaturesForAddress(new PublicKey(program), { limit: 1000 }).catch(async () => (await sleep(4000), []));
const wanted = sigs.filter((s) => (s.err as { InstructionError?: [number, { Custom?: number }] } | null)?.InstructionError?.[1]?.Custom === code).slice(0, count);
console.log(`${sigs.length} recent, ${wanted.length} with code ${code} taken`);
const tally: Record<string, number> = {};
for (const s of wanted) {
  await sleep(3000);
  try {
    const r = await repair({ signature: s.signature });
    const change = r.changes.find((c) => c.type === "swap_quote");
    const why = r.status === "repaired" ? "REPAIRED" : `${r.status}: ${(r.notes.find((n) => /cannot be repaired|Could not price|moved more than|still fails|fits its own/.test(n)) ?? r.summary).replace(/\d[\d.,]*/g, "N").slice(0, 170)}`;
    tally[why] = (tally[why] ?? 0) + 1;
    console.log(`${s.signature.slice(0, 12)} ${r.status}${change ? `\n    ${change.before}\n    ${change.after}` : ""}${r.status === "repaired" ? `\n    verified=${r.verification?.ok} ${r.verification?.violations?.join(" ") ?? ""}` : `\n    ${r.notes.slice(0, 3).join("\n    ").slice(0, 600)}`}`);
  } catch (e) {
    const k = `THREW: ${e instanceof Error ? e.message.slice(0, 120) : e}`;
    tally[k] = (tally[k] ?? 0) + 1;
    console.log(s.signature.slice(0, 12), k);
  }
}
console.log("\nTALLY");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(3), k);
}
main();
