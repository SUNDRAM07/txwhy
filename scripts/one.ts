// Run one signature (or a base64 transaction) through the LOCAL engine and print the verdict in full.
//   npx tsx scripts/one.ts <signature>
import { repair } from "../src/lib/repair";

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("usage: npx tsx scripts/one.ts <signature|base64>");
  const r = await repair(input.length > 100 ? { transaction: input } : { signature: input });
  console.log("status:", r.status);
  console.log("summary:", r.summary);
  console.log("cause:", JSON.stringify(r.cause, null, 1));
  console.log("changes:", r.changes.map((c) => c.type).join(", ") || "none");
  console.log("notes:");
  for (const n of r.notes) console.log("  -", n);
  console.log("simulation:", r.simulation.passed ? "passed" : `failed (${r.simulation.error?.title ?? "?"})`);
}
main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
