// Robustness fuzz for POST /api/v1/rpc, the browser's narrow JSON-RPC pass-through. Every input below is
// malformed, oversized, off-list or hostile; the only acceptable answers are a JSON-RPC result or error
// (HTTP 200, 400, 413 or 502) or an honest 429. A 500, a hang past 30 s, or a non-JSON body is a bug.
//   TXWHY_URL=https://txwhy.vercel.app node scripts/fuzz-rpc.mjs
const BASE = process.env.TXWHY_URL ?? "http://localhost:3111";
const URL_ = `${BASE}/api/v1/rpc`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const cases = [
  ["empty body", ""],
  ["not json", "{not json"],
  ["json but not an object", "42"],
  ["json null", "null"],
  ["batch", `[${rpc("getBalance", ["11111111111111111111111111111111"])}]`],
  ["no method", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
  ["method not a string", JSON.stringify({ jsonrpc: "2.0", id: 1, method: 7, params: [] })],
  ["off-list method: getProgramAccounts", rpc("getProgramAccounts", ["11111111111111111111111111111111"])],
  ["off-list method: requestAirdrop", rpc("requestAirdrop", ["11111111111111111111111111111111", 1000])],
  ["off-list method: prototype name", rpc("__proto__", [])],
  ["off-list method: case trick", rpc("GETBALANCE", ["11111111111111111111111111111111"])],
  ["params not an array", rpc("getBalance", { pubkey: "11111111111111111111111111111111" })],
  ["params null", rpc("getBalance", null)],
  ["getBalance with garbage", rpc("getBalance", ["not-a-pubkey"])],
  ["getBalance with an object", rpc("getBalance", [{ a: 1 }])],
  ["getAccountInfo with garbage", rpc("getAccountInfo", ["zzz", { encoding: "base64" }])],
  ["getTransaction with garbage signature", rpc("getTransaction", ["nope", { encoding: "base64", maxSupportedTransactionVersion: 1 }])],
  ["getSignatureStatuses with 1,000 entries", rpc("getSignatureStatuses", [Array.from({ length: 1000 }, () => "4".repeat(87))])],
  ["sendTransaction with garbage base64", rpc("sendTransaction", ["@@@@", { encoding: "base64" }])],
  ["sendTransaction with random bytes", rpc("sendTransaction", [Buffer.from(Array.from({ length: 1200 }, () => Math.floor(Math.random() * 256))).toString("base64"), { encoding: "base64" }])],
  ["getLatestBlockhash with junk options", rpc("getLatestBlockhash", [{ commitment: "nope" }])],
  ["id is an object", rpc("getBalance", ["11111111111111111111111111111111"], { nested: true })],
  ["id is a 10 KB string", rpc("getBalance", ["11111111111111111111111111111111"], "x".repeat(10_000))],
  ["body of 70 KB", rpc("getBalance", ["11111111111111111111111111111111", { note: "y".repeat(70_000) }])],
  ["deeply nested params", `{"jsonrpc":"2.0","id":1,"method":"getBalance","params":[${"[".repeat(500)}${"]".repeat(500)}]}`],
  ["unicode in method", rpc("getBalance\u0000", ["11111111111111111111111111111111"])],
  ["extra top-level keys", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["11111111111111111111111111111111"], extra: { evil: true } })],
];

let bad = 0;
const started = Date.now();
for (const [name, body] of cases) {
  const t0 = Date.now();
  let status = 0, text = "", ok = false, note = "";
  try {
    const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(30_000) });
    status = res.status;
    text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    const jsonRpcShaped = json && typeof json === "object" && ("result" in json || "error" in json);
    ok = ([200, 400, 413, 502].includes(status) && jsonRpcShaped) || status === 429;
    note = json?.error?.message ? `-> ${String(json.error.message).slice(0, 70)}` : jsonRpcShaped ? "-> result" : `-> ${text.slice(0, 60)}`;
  } catch (e) {
    note = `-> ${e.name}: ${e.message}`;
  }
  if (!ok) bad++;
  console.log(`${ok ? "ok " : "BAD"}  ${String(status).padStart(3)}  ${String(Date.now() - t0).padStart(5)}ms  ${name}  ${note}`);
  await sleep(1100); // the route allows 60 a minute per client
}
console.log(`\n${cases.length - bad}/${cases.length} acceptable in ${Math.round((Date.now() - started) / 1000)}s; ${bad} bad`);
process.exit(bad ? 1 : 0);
