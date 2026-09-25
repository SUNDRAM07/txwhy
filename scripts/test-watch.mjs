// Exercises the wallet watcher against a local worker: registers a wallet that fails often (the fee payer of
// a recent failed Jupiter transaction), then waits for the worker to relay an alert to a stub site.
//   node scripts/test-watch.mjs   (worker on :8792 with WORKER_SECRET=testsecret, stub site on :8799)
import { Connection, PublicKey } from "@solana/web3.js";

const WORKER = process.env.WORKER ?? "http://localhost:8792";
const SECRET = process.env.WORKER_SECRET ?? "testsecret";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const call = async (body) => (await fetch(`${WORKER}/watch`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const check = (name, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`);

// 1. Validation and limits.
check("rejects a bad address", !(await call({ op: "add", chatId: 1, address: "nope" })).ok);
check("unauthorized without secret", (await fetch(`${WORKER}/watch`, { method: "POST", body: "{}" })).status === 401);
const fillers = ["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"];
for (const a of fillers) await call({ op: "add", chatId: 1, address: a });
const fourth = await call({ op: "add", chatId: 1, address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" });
check("caps at 3 per chat", !fourth.ok, `-> ${fourth.error}`);
for (const a of fillers) await call({ op: "remove", chatId: 1, address: a });
check("list empty after removes", (await call({ op: "list", chatId: 1 })).addresses.length === 0);

// 2. A wallet that fails often: the fee payer of a recent failed Jupiter transaction.
const sigs = await conn.getSignaturesForAddress(new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), { limit: 30 });
let payer = null;
for (const s of sigs.filter((x) => x.err)) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
  const keys = tx?.transaction.message.staticAccountKeys ?? tx?.transaction.message.accountKeys;
  if (keys?.[0]) { payer = keys[0].toBase58(); break; }
}
if (!payer) { console.log("no recent failed payer found"); process.exit(1); }
const added = await call({ op: "add", chatId: 4242, address: payer });
check("watch a busy payer", added.ok, payer);

// 3. Wait for an alert relay (the stub site logs it; here we watch the worker's own counter).
const started = Date.now();
let alerts = 0;
while (Date.now() - started < 150_000) {
  const idx = await (await fetch(`${WORKER}/index`)).json().catch(() => null);
  alerts = idx?.watch?.alerts ?? 0;
  if (alerts > 0) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
check("alert relayed within 150 s", alerts > 0, `alerts=${alerts} after ${Math.round((Date.now() - started) / 1000)} s`);
await call({ op: "remove", chatId: 4242, address: payer });
check("unwatch cleans up", (await call({ op: "list", chatId: 4242 })).addresses.length === 0);
