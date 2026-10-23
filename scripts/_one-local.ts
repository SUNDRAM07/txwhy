// Run the engine from the working tree on one landed signature (no server), to check a verdict before deploying.
//   npx tsx scripts/_one-local.ts <signature>
import { repair } from "../src/lib/repair";
async function main() {
const sig = process.argv[2];
if (!sig) { console.log("usage: npx tsx scripts/_one-local.ts <signature>"); process.exit(1); }
const r = await repair({ signature: sig });
console.log(JSON.stringify({ status: r.status, title: r.cause?.title, cause: r.cause?.cause, fix: r.cause?.fix, summary: r.summary, notes: r.notes, changes: r.changes.map((c) => c.type), probe: r.simulation.error?.title, probeLogs: r.simulation.logsTail.slice(-6) }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
