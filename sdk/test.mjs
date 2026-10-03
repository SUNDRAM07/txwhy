// End-to-end check of the built package against the live service. Nothing is ever sent:
// the demo payer is a public exchange wallet and sendTransaction is stubbed.
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { repair, sendWithRepair, verifyRepair, explainError, TxWhyError } from "./dist/index.js";
import { verifyInstructions } from "./dist/verify.js";

const BASE = process.env.TXWHY_BASE ?? "https://txwhy.vercel.app";
const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
connection.sendTransaction = async () => "STUBBED-NOT-SENT";
const opts = { client: "test", endpoint: `${BASE}/api/v1/repair` };
let pass = 0, total = 0;
const check = (name, ok, detail = "") => { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`); };
/** The demo endpoint builds real transactions against live state; one retry covers a transient upstream hiccup. */
async function getExample(kind) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${BASE}/api/v1/example?kind=${kind}`, { headers: { "x-txwhy-client": "test" } });
    const json = await res.json().catch(() => null);
    if (json?.transaction) return json;
    console.log(`      example(${kind}) answered ${res.status}, retrying`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`example(${kind}) unavailable`);
}

for (const kind of ["compute", "blockhash", "slippage", "pump", "raydium"]) {
  const example = await getExample(kind);
  const tx = VersionedTransaction.deserialize(Buffer.from(example.transaction, "base64"));
  const started = Date.now();
  const out = await sendWithRepair(connection, tx, (t) => t, { ...opts, onRepair: (r, v) => console.log(`      repaired: ${r.changes.map((c) => c.type).join(", ")} | local verification ok=${v?.ok} kept=${v?.kept}`) });
  check(`sendWithRepair(${kind})`, out.signature === "STUBBED-NOT-SENT" && out.repairs.length === 1, `${Date.now() - started} ms`);

  // A tampered "repair" must be refused locally even if a service returned it.
  if (kind === "compute") {
    const result = await repair({ transaction: tx }, opts);
    const honest = await verifyRepair(connection, tx, result.repairedTransaction);
    check("verifyRepair accepts the honest repair", honest.ok);
    const other = await getExample("slippage");
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
// The @solana/kit entry: same loop, no web3.js, and version 1 transactions included.
{
  const { createSolanaRpc } = await import("@solana/kit");
  const kit = await import("./dist/kit.js");
  const real = createSolanaRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
  const rpc = new Proxy(real, { get: (t, p) => (p === "sendTransaction" ? () => ({ send: async () => "STUBBED-NOT-SENT" }) : Reflect.get(t, p)) });
  const examples = {};
  for (const kind of ["compute", "slippage", "v1"]) {
    const example = (examples[kind] = await getExample(kind));
    const started = Date.now();
    try {
      const out = await kit.sendWithRepair(rpc, example.transaction, (t) => t, { ...opts, maxRepairs: 2, onRepair: (r) => console.log(`      repaired: ${r.changes.map((c) => c.type).join(", ")}`) });
      check(`kit sendWithRepair(${kind})`, out.signature === "STUBBED-NOT-SENT" && out.repairs.length >= 1, `${Date.now() - started} ms, ${out.repairs.length} repair(s)`);
    } catch (e) {
      check(`kit sendWithRepair(${kind})`, false, `-> ${e.message}`);
    }
  }
  const v1 = examples.v1;
  const result = await kit.repair({ transaction: v1.transaction }, opts);
  const honest = await kit.verifyRepair(rpc, v1.transaction, result.repairedTransaction);
  check("kit verifyRepair accepts the honest v1 repair", honest.ok, honest.ok ? "" : `-> ${honest.violations[0]}`);
  const swapped = await kit.verifyRepair(rpc, v1.transaction, examples.slippage.transaction);
  check("kit verifyRepair refuses a different transaction", !swapped.ok, `-> ${swapped.violations[0]}`);
}
{
  const e = await explainError({ error: { InstructionError: [2, { Custom: 6001 }] }, logs: ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]", "Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.", "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771"] }, opts);
  check("explainError names a Jupiter slippage failure", e.cause?.title === "SlippageToleranceExceeded" && e.repairable === true, `-> ${e.cause?.title}`);
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
