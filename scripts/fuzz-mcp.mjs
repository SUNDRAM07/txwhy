// Robustness fuzz for the MCP endpoint (/api/mcp). Malformed JSON-RPC, wrong tool names, wrong
// argument types, oversized bodies, hostile values. Acceptable: an HTTP 200 carrying a JSON-RPC
// result or error, or HTTP 400/406/413/429 with JSON. A 500, a hang, or a non-JSON body is a bug.
//   node scripts/fuzz-mcp.mjs                      # local dev server on :3111
//   TXWHY_URL=https://txwhy.vercel.app node scripts/fuzz-mcp.mjs
const BASE = process.env.TXWHY_URL ?? "http://localhost:3111";
const PER_MINUTE = BASE.includes("localhost") ? 0 : 25;

const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const cases = [];
const add = (name, body) => cases.push({ name, body });

add("empty body", "");
add("not json", "{");
add("array", "[]");
add("array of one call", JSON.stringify([call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: 6001 })]));
add("no jsonrpc field", { id: 1, method: "tools/list" });
add("jsonrpc 1.0", { jsonrpc: "1.0", id: 1, method: "tools/list" });
add("unknown method", rpc("tools/explode", {}));
add("tools/list", rpc("tools/list", {}));
add("tools/call no params", rpc("tools/call"));
add("tools/call params null", rpc("tools/call", null));
add("tools/call params string", rpc("tools/call", "x"));
add("unknown tool", call("nope", {}));
add("tool name number", rpc("tools/call", { name: 5, arguments: {} }));
add("arguments string", rpc("tools/call", { name: "explain_error", arguments: "x" }));
add("arguments null", rpc("tools/call", { name: "explain_error", arguments: null }));
add("id null", rpc("tools/list", {}, null));
add("id object", rpc("tools/list", {}, { a: 1 }));
add("id huge", rpc("tools/list", {}, 1e308));
// repair_transaction
add("repair no args", call("repair_transaction", {}));
add("repair transaction number", call("repair_transaction", { transaction: 12 }));
add("repair transaction empty", call("repair_transaction", { transaction: "" }));
add("repair transaction garbage", call("repair_transaction", { transaction: "!!!not base64!!!" }));
add("repair transaction random b64", call("repair_transaction", { transaction: Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256))).toString("base64") }));
add("repair signature garbage", call("repair_transaction", { signature: "zzz" }));
add("repair signature url traversal", call("repair_transaction", { signature: "https://solscan.io/tx/../../../etc" }));
add("repair signature 10 KB", call("repair_transaction", { signature: "1".repeat(10_000) }));
add("repair both fields", call("repair_transaction", { transaction: "AA==", signature: "1".repeat(88) }));
add("repair extra fields", call("repair_transaction", { transaction: "AA==", evil: { deep: [1, 2, 3] } }));
add("repair body 15 KB", call("repair_transaction", { transaction: "A".repeat(15_000) }));
add("repair body 17 KB (over cap)", call("repair_transaction", { transaction: "A".repeat(17_000) }));
add("repair body 1 MB", call("repair_transaction", { transaction: "A".repeat(1_000_000) }));
// diagnose_transaction
add("diagnose no args", call("diagnose_transaction", {}));
add("diagnose signature number", call("diagnose_transaction", { signature: 1 }));
add("diagnose signature empty", call("diagnose_transaction", { signature: "" }));
add("diagnose signature unicode", call("diagnose_transaction", { signature: "🙂".repeat(30) }));
add("diagnose nonexistent", call("diagnose_transaction", { signature: "1".repeat(87) }));
// explain_error
add("explain no args", call("explain_error", {}));
add("explain programId empty", call("explain_error", { programId: "", code: 1 }));
add("explain programId not base58", call("explain_error", { programId: "0OIl", code: 1 }));
add("explain programId 31 bytes", call("explain_error", { programId: "1".repeat(43), code: 1 }));
add("explain programId 10 KB", call("explain_error", { programId: "J".repeat(10_000), code: 1 }));
add("explain code negative", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: -1 }));
add("explain code float", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: 1.5 }));
add("explain code huge", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: 1e20 }));
add("explain code hex", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: "0x1771" }));
add("explain code 0x only", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: "0x" }));
add("explain code words", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: "banana" }));
add("explain code 1e3 string", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: "1e3" }));
add("explain code object", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: { a: 1 } }));
add("explain code null", call("explain_error", { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", code: null }));
add("explain unknown program", call("explain_error", { programId: "11111111111111111111111111111111", code: 6001 }));
add("explain system program code 1", call("explain_error", { programId: "11111111111111111111111111111111", code: 1 }));

let bad = 0;
for (let i = 0; i < cases.length; i++) {
  const { name, body } = cases[i];
  const t = Date.now();
  let status = 0, kind = "";
  try {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-txwhy-client": "test",
        ...(PER_MINUTE ? {} : { "x-forwarded-for": `10.1.${(i >> 8) & 255}.${i & 255}` }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    status = res.status;
    const text = await res.text();
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("text/event-stream")) {
      const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      try { const j = JSON.parse(data); kind = j.error ? `rpc-error ${j.error.code}: ${j.error.message}` : j.result?.isError ? `tool-error: ${j.result.content?.[0]?.text}` : `result ${Object.keys(j.result ?? {}).join(",")}`; } catch { kind = "NON-JSON-SSE"; }
    } else {
      try { const j = JSON.parse(text); kind = j.error ? `rpc-error ${j.error.code ?? ""}: ${j.error.message ?? j.error}` : `json ${Object.keys(j).join(",")}`; } catch { kind = text ? "NON-JSON" : "empty"; }
    }
  } catch (e) { status = -1; kind = e.name === "TimeoutError" ? "TIMEOUT" : e.message; }
  const ms = Date.now() - t;
  const ok = [200, 202, 400, 404, 405, 406, 413, 429].includes(status) && !kind.startsWith("NON-JSON") && ms < 30_000;
  if (!ok) bad++;
  console.log(`${ok ? "ok " : "BAD"} ${String(status).padStart(3)} ${String(ms).padStart(5)}ms  ${name}  -> ${kind.slice(0, 110).replace(/\n/g, " ")}`);
  if (PER_MINUTE) await new Promise((r) => setTimeout(r, 60_000 / PER_MINUTE));
}
console.log(`\n${cases.length - bad}/${cases.length} acceptable; ${bad} bad`);
process.exit(bad ? 1 : 0);
