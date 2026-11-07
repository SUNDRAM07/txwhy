// Prints the engine's full verdict for one or more landed signatures.  npx tsx scripts/_one.ts <sig> [sig...]
import { repair } from "../src/lib/repair";

async function main() {
  for (const sig of process.argv.slice(2)) {
    const r = await repair({ signature: sig });
    console.log(`\n### ${sig.slice(0, 12)}`);
    console.log(JSON.stringify({ status: r.status, title: r.cause?.title, summary: r.summary, cause: r.cause?.cause, fix: r.cause?.fix, notes: r.notes }, null, 1).slice(0, 2500));
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
