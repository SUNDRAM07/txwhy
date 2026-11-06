// End-to-end checks for the JSON-RPC door (POST /api/v1/rpc, method repairTransaction) against a running server.
// Unsigned transactions only: simulation runs with sigVerify off, so no keys are needed.
//   API=http://localhost:3111/api/v1/rpc node scripts/test-jsonrpc.mjs
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const API = process.env.API ?? "http://localhost:3111/api/v1/rpc";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const RICH = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const DEST = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const b64 = (blockhash, ixs) => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: RICH, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()).serialize()).toString("base64");

let nextId = 1;
async function call(method, params, raw) {
  const id = nextId++;
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: raw ?? JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { http: res.status, id, body: await res.json() };
}

let pass = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

const { blockhash } = await conn.getLatestBlockhash();
const transfer = SystemProgram.transfer({ fromPubkey: RICH, toPubkey: DEST, lamports: 1000 });
const lowBudget = b64(blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 100 }), transfer]);

{
  const r = await call("repairTransaction", [lowBudget]);
  const x = r.body.result;
  check("repairTransaction, base64 string: compute limit far too low", r.http === 200 && r.body.jsonrpc === "2.0" && r.body.id === r.id && x?.status === "repaired" && typeof x.repairedTransaction === "string" && x.simulation?.passed === true && x.verification?.ok === true, `status=${x?.status} sim=${x?.simulation?.passed} verified=${x?.verification?.ok} changes=${(x?.changes ?? []).map((c) => c.type).join(",")}`);
}
{
  const r = await call("txwhy_repairTransaction", [b64("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", [transfer])]);
  const x = r.body.result;
  check("txwhy_repairTransaction (namespaced name): expired blockhash", x?.status === "repaired" && (x.changes ?? []).some((c) => c.type === "blockhash"), `status=${x?.status} changes=${(x?.changes ?? []).map((c) => c.type).join(",")}`);
}
{
  const r = await call("repairTransaction", [{ transaction: b64(blockhash, [transfer]) }]);
  check("object params: a healthy transaction comes back valid", r.body.result?.status === "valid" && r.body.result?.simulation?.passed === true, `status=${r.body.result?.status}`);
}
{
  const r = await call("repairTransaction", { transaction: lowBudget });
  check("by-name params (an object, not an array)", r.body.result?.status === "repaired", `status=${r.body.result?.status}`);
}
{
  const sigs = await conn.getSignaturesForAddress(JUPITER, { limit: 200 }).catch(() => []);
  const failed = sigs.find((s) => s.err);
  if (!failed) check("signature of a landed failure", false, "no failed signature found to test with");
  else {
    const r = await call("repairTransaction", [failed.signature]);
    const x = r.body.result;
    check("signature string: a landed mainnet failure gets a verdict and a cause", ["repaired", "needs_requote", "not_repairable", "valid"].includes(x?.status) && typeof x?.summary === "string", `status=${x?.status} cause=${x?.cause?.title ?? "-"} (${failed.signature.slice(0, 12)})`);
  }
}
{
  const r = await call("repairTransaction", []);
  check("no params: -32602 with the accepted shapes spelled out", r.http === 400 && r.body.error?.code === -32602 && /base64 transaction/.test(r.body.error.message) && r.body.id === r.id, `http=${r.http} code=${r.body.error?.code}`);
}
{
  const r = await call("repairTransaction", ["not a transaction at all"]);
  check("garbage bytes: -32602, not a crash", r.body.error?.code === -32602, `http=${r.http} code=${r.body.error?.code} msg=${r.body.error?.message?.slice(0, 80)}`);
}
{
  const r = await call("repairTransaction", ["A".repeat(9000)]);
  check("oversized transaction refused before any work", r.body.error?.code === -32602 && /too large/i.test(r.body.error.message), `code=${r.body.error?.code}`);
}
{
  const r = await call("requestAirdrop", [RICH.toBase58(), 1]);
  check("a method that is not offered: -32601", r.http === 400 && r.body.error?.code === -32601, `code=${r.body.error?.code}`);
}
{
  const r = await call(null, null, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "repairTransaction", params: [lowBudget] }]));
  check("batches refused: -32600", r.body.error?.code === -32600, `code=${r.body.error?.code}`);
}
{
  const r = await call("getLatestBlockhash", []);
  check("pass-through still answers (getLatestBlockhash)", typeof r.body.result?.value?.blockhash === "string", `http=${r.http}`);
}

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
