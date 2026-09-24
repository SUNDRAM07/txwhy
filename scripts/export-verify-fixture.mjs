// Exports a real original + repaired transaction pair (from the live API) as plain JSON
// instructions, so the Rust crate can prove it reaches the same verdict as the TypeScript verifier.
import "./_env.mjs";
import { Connection, VersionedTransaction, Transaction, TransactionMessage } from "@solana/web3.js";
const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
import { writeFileSync } from "node:fs";
const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const h = { "content-type": "application/json", "x-txwhy-client": "test" };
async function decode(b64) {
  const bytes = Buffer.from(b64, "base64");
  let payer, ixs;
  try {
    const vt = VersionedTransaction.deserialize(bytes);
    const tables = [];
    for (const l of vt.message.addressTableLookups ?? []) { const t = await connection.getAddressLookupTable(l.accountKey); if (t.value) tables.push(t.value); }
    const msg = TransactionMessage.decompile(vt.message, { addressLookupTableAccounts: tables });
    payer = msg.payerKey.toBase58(); ixs = msg.instructions;
  } catch (e) {
    if (!/legacy|version/i.test(String(e))) throw e;
    const t = Transaction.from(bytes); payer = t.feePayer.toBase58(); ixs = t.instructions;
  }
  return { payer, instructions: ixs.map((ix) => ({ program_id: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), is_signer: k.isSigner, is_writable: k.isWritable })), data: Buffer.from(ix.data).toString("hex") })) };
}
const out = {};
for (const kind of ["compute", "slippage", "pump", "raydium"]) {
  const ex = await (await fetch(`${BASE}/api/v1/example?kind=${kind}`, { headers: h })).json();
  const r = await (await fetch(`${BASE}/api/v1/repair`, { method: "POST", headers: h, body: JSON.stringify({ transaction: ex.transaction }) })).json();
  if (r.status !== "repaired") { console.log(kind, r.status, r.summary); continue; }
  out[kind] = { original: await decode(ex.transaction), repaired: await decode(r.repairedTransaction), expected: r.verification };
  console.log(kind, "ok", r.verification.ok, r.verification.changes.map((c) => c.kind).join(","));
}
writeFileSync("crates/txwhy-verify/tests/fixtures.json", JSON.stringify(out, null, 1));
