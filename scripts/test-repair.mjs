// End-to-end checks for POST /api/v1/repair against a running dev server.
// Builds deliberately broken UNSIGNED transactions (simulation uses sigVerify:false, so no keys needed).
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
const API = process.env.API ?? "http://localhost:3111/api/v1/repair";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
// A long-lived, well-funded public account used only as a simulated fee payer.
const RICH = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const DEST = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const b64 = (payer, blockhash, ixs) => Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()).serialize()).toString("base64");
const call = async (body) => (await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const show = (name, r, expect) => { const ok = r.status === expect; console.log(`\n${ok ? "PASS" : "FAIL"}  ${name}\n  status=${r.status} (expected ${expect})  sim.passed=${r.simulation?.passed} units=${r.simulation?.unitsConsumed}\n  summary: ${r.summary ?? r.error}\n  cause: ${r.cause?.title ?? "-"}\n  changes: ${(r.changes ?? []).map(c => `${c.type}: ${c.before} -> ${c.after}`).join(" | ") || "-"}\n  notes: ${(r.notes ?? []).slice(0, 1).join("")}`); return ok; };

const { blockhash } = await conn.getLatestBlockhash();
const bal = await conn.getBalance(RICH); console.log("fee payer balance SOL:", bal / 1e9);
const transfer = SystemProgram.transfer({ fromPubkey: RICH, toPubkey: DEST, lamports: 1000 });
let pass = 0, total = 0;
const t = async (name, body, expect) => { total++; try { if (show(name, await call(body), expect)) pass++; } catch (e) { console.log("FAIL", name, e.message); } };

await t("compute-unit limit far too low", { transaction: b64(RICH, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 100 }), transfer]) }, "repaired");
await t("expired blockhash", { transaction: b64(RICH, "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", [transfer]) }, "repaired");
await t("healthy transaction, no budget set", { transaction: b64(RICH, blockhash, [transfer]) }, "valid");
await t("insufficient funds", { transaction: b64(RICH, blockhash, [SystemProgram.transfer({ fromPubkey: RICH, toPubkey: DEST, lamports: BigInt(bal) * 1000n })]) }, "not_repairable");
await t("garbage input", { transaction: "not-a-transaction" }, undefined);
console.log(`\n${pass}/${total} passed`);
