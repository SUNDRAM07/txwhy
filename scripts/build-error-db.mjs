// Regenerates src/lib/data/program-errors.json from the MIT-licensed `solana-idls` dataset.
// Usage: npm i -D solana-idls && node scripts/build-error-db.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const m = createRequire(import.meta.url)("solana-idls");
const out = {};
let total = 0;
for (const key of Object.keys(m)) {
  if (!key.endsWith("_PROGRAM_ID")) continue;
  const idl = m[key.slice(0, -"_PROGRAM_ID".length) + "_IDL"];
  const errors = idl?.errors ?? [];
  if (!errors.length) continue;
  const programId = String(m[key]);
  const meta = m.registry.getByProgramId?.(programId);
  out[programId] = {
    name: String(meta?.name ?? idl.metadata?.name ?? idl.name ?? key),
    errors: Object.fromEntries(errors.map((e) => [e.code, e.msg && e.msg !== e.name ? [e.name, e.msg] : [e.name]])),
  };
  total += errors.length;
}
writeFileSync(new URL("../src/lib/data/program-errors.json", import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(out).length} programs, ${total} errors`);
