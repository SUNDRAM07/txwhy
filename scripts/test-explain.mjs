// POST /api/v1/explain against a deployment: real err objects, logs and instruction bytes from mainnet.
//   node scripts/test-explain.mjs                      # https://txwhy.vercel.app
const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const headers = { "content-type": "application/json", "x-txwhy-client": "test" };
let pass = 0, total = 0;
const check = (name, ok, detail = "") => { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`); };
const explain = async (body) => { const res = await fetch(`${BASE}/api/v1/explain`, { method: "POST", headers, body: JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };

// 1. Lighthouse guard, with the instruction bytes from 4eSSiRGP…kU2Bv (instruction #5).
{
  const r = await explain({
    error: { InstructionError: [4, { Custom: 6001 }] },
    logs: ["Program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 invoke [1]", "Program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 failed: custom program error: 0x1771"],
    instruction: { programId: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95", accounts: ["F8w15ZZnSQiZxdNazTti6b1dsvapQXA2cYZCT7KTyAp5"], data: "AfehheFXYEfbVfjd6" },
  });
  check("wallet guard decoded from err + instruction", r.status === 200 && r.json?.cause?.title === "Lighthouse guard: assertion failed" && /at most 10,756,344/.test(r.json.cause.cause) && r.json.failingProgram?.isWalletGuard === true && r.json.repairable === false, r.json?.cause?.title);
}
// 2. Jupiter slippage from err + logs only.
{
  const r = await explain({ error: { InstructionError: [2, { Custom: 6001 }] }, logs: ["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]", "Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.", "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771"] });
  check("Jupiter slippage from err + logs", r.status === 200 && r.json?.cause?.title === "SlippageToleranceExceeded" && r.json.repairable === true && /Jupiter/.test(r.json.failingProgram?.name ?? ""), `${r.json?.cause?.title} | repairable=${r.json?.repairable}`);
}
// 3. Insufficient lamports, string error form.
{
  const r = await explain({ error: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program 11111111111111111111111111111111 invoke [1]", "Transfer: insufficient lamports 1000, need 2039280", "Program 11111111111111111111111111111111 failed: custom program error: 0x1"] });
  check("system program insufficient lamports", r.status === 200 && /Insufficient|insufficient/.test(`${r.json?.cause?.title} ${r.json?.cause?.cause}`), r.json?.cause?.title);
}
// 4. Transaction-level error string.
{
  const r = await explain({ error: "BlockhashNotFound" });
  check("transaction-level error string", r.status === 200 && r.json?.cause?.title, r.json?.cause?.title);
}
// 4b. A transaction-level error with a payload: the runtime's rent check, which names an account by index (tester report, Oct 9).
{
  const r = await explain({ error: { InsufficientFundsForRent: { account_index: 1 } }, logs: [] });
  check("rent error with an account index is named, not unrecognized", r.status === 200 && /rent/i.test(r.json?.cause?.title ?? "") && /#2 in the transaction/.test(r.json?.cause?.cause ?? ""), `${r.json?.cause?.title} | ${(r.json?.cause?.cause ?? "").slice(0, 90)}`);
}
// 5. Bad input.
{
  const a = await explain({});
  const b = await fetch(`${BASE}/api/v1/explain`, { method: "POST", headers, body: "{{{" });
  check("missing error is a 400", a.status === 400);
  check("bad json is a 400", b.status === 400);
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
