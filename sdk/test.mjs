// End-to-end check of the built package against the live service. Nothing is ever sent:
// the demo payer is a public exchange wallet and sendTransaction is stubbed.
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { repair, sendWithRepair, verifyRepair, TxWhyError } from "./dist/index.js";
import { verifyInstructions } from "./dist/verify.js";

const BASE = process.env.TXWHY_BASE ?? "https://txwhy.vercel.app";
const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
connection.sendTransaction = async () => "STUBBED-NOT-SENT";
const opts = { client: "test", endpoint: `${BASE}/api/v1/repair` };
let pass = 0, total = 0;
const check = (name, ok, detail = "") => { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`); };

for (const kind of ["compute", "blockhash", "slippage"]) {
  const example = await (await fetch(`${BASE}/api/v1/example?kind=${kind}`)).json();
  const tx = VersionedTransaction.deserialize(Buffer.from(example.transaction, "base64"));
  const started = Date.now();
  const out = await sendWithRepair(connection, tx, (t) => t, { ...opts, onRepair: (r, v) => console.log(`      repaired: ${r.changes.map((c) => c.type).join(", ")} | local verification ok=${v?.ok} kept=${v?.kept}`) });
  check(`sendWithRepair(${kind})`, out.signature === "STUBBED-NOT-SENT" && out.repairs.length === 1, `${Date.now() - started} ms`);

  // A tampered "repair" must be refused locally even if a service returned it.
  if (kind === "compute") {
    const result = await repair({ transaction: tx }, opts);
    const honest = await verifyRepair(connection, tx, result.repairedTransaction);
    check("verifyRepair accepts the honest repair", honest.ok);
    const other = await (await fetch(`${BASE}/api/v1/example?kind=slippage`)).json();
    const swapped = await verifyRepair(connection, tx, other.transaction);
    check("verifyRepair refuses a different transaction", !swapped.ok, `-> ${swapped.violations[0]}`);
  }
}
check("verify entry point exports verifyInstructions", typeof verifyInstructions === "function");
try {
  await repair({ transaction: "not-a-transaction" }, opts);
  check("bad input throws TxWhyError", false);
} catch (e) {
  check("bad input throws TxWhyError", e instanceof TxWhyError, `-> ${e.message}`);
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
