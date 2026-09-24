// Robustness fuzz for POST /api/v1/repair. Every input below is malformed, truncated, oversized or
// adversarial; the only acceptable answers are 200 (diagnosed), 400 (bad input), 413 (too big) or
// 502 (upstream RPC). A 500, a hang past the deadline, or a non-JSON body is a bug.
//
//   node scripts/fuzz-repair.mjs                       # local dev server on :3111
//   TXWHY_URL=https://txwhy.vercel.app node scripts/fuzz-repair.mjs
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, Transaction, MessageV0 } from "@solana/web3.js";
import { writeFileSync } from "node:fs";

const BASE = process.env.TXWHY_URL ?? "http://localhost:3111";
const PER_MINUTE = BASE.includes("localhost") ? 0 : 25; // the public limit is 30 per minute per IP
const b64 = (u8) => Buffer.from(u8).toString("base64");
const rnd = (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = Math.floor(Math.random() * 256); return u; };
const payer = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const BLOCKHASH = "11111111111111111111111111111111";

function legacy(instructions, feePayer = payer) {
  const tx = new Transaction({ feePayer, recentBlockhash: BLOCKHASH });
  if (instructions.length) tx.add(...instructions);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
function v0(instructions, feePayer = payer) {
  const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}
const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const PUMP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAY = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const NONCE_ADVANCE = SystemProgram.nonceAdvance({ noncePubkey: Keypair.generate().publicKey, authorizedPubkey: payer });
const ix = (programId, data, keys = [{ pubkey: payer, isSigner: true, isWritable: true }]) => ({ programId, keys, data: Buffer.from(data) });

// A version-1 wire image built by hand: version byte 129, then header fields, so we control every byte.
function v1Bytes({ accounts = 2, instructions = 1, computeLimit = 200_000, fee = 5_000, loaded = 0, heap = 0, ixProgramIndex = 1, ixAccountIndex = 0, dataLen = 12, sigs = 1, numRequiredSignatures = 1 } = {}) {
  const out = [129];
  const u32 = (n) => out.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const u64 = (n) => { let x = BigInt(n); for (let i = 0; i < 8; i++) { out.push(Number(x & 255n)); x >>= 8n; } };
  out.push(numRequiredSignatures, 0, 1); // header: required sigs, readonly signed, readonly unsigned
  out.push(0b0111 | (loaded ? 0b1000 : 0) | (heap ? 0b10000 : 0)); // config mask (limit, fee, heap/loaded flags): shape only
  u32(computeLimit); u64(fee); if (loaded) u32(loaded); if (heap) u32(heap);
  out.push(accounts);
  out.push(...payer.toBytes());
  for (let i = 1; i < accounts; i++) out.push(...(i === 1 ? SystemProgram.programId.toBytes() : Keypair.generate().publicKey.toBytes()));
  out.push(...Buffer.from(BLOCKHASH, "utf8").subarray(0, 32));
  out.push(instructions);
  for (let i = 0; i < instructions; i++) { out.push(ixProgramIndex, 1, ixAccountIndex, dataLen); for (let j = 0; j < dataLen; j++) out.push(j === 0 ? 2 : 0); }
  out.push(sigs); for (let i = 0; i < sigs; i++) out.push(...new Array(64).fill(0));
  return new Uint8Array(out);
}

const cases = [];
const add = (name, body) => cases.push({ name, body });

// Body shapes
add("empty body", "");
add("not json", "{{{");
add("array body", "[]");
add("null transaction", { transaction: null });
add("number transaction", { transaction: 12345 });
add("object transaction", { transaction: { a: 1 } });
add("empty string", { transaction: "" });
add("whitespace", { transaction: "   \n\t " });
add("both fields", { transaction: b64(legacy([transfer])), signature: "abc" });
add("signature garbage", { signature: "not-a-signature!!" });
add("signature too short", { signature: "abc" });
add("signature url weird", { signature: "https://solscan.io/tx/../../etc/passwd" });
add("signature nonexistent", { signature: "1".repeat(87) });
add("signature 88 chars of 9", { signature: "9".repeat(88) });
add("deep nesting", JSON.stringify({ transaction: { a: { b: { c: { d: [[[[[[[[[[]]]]]]]]]] } } } } }));
add("unicode base64", { transaction: "🙂🙂🙂🙂" });
add("base64 with url alphabet", { transaction: b64(legacy([transfer])).replace(/\+/g, "-").replace(/\//g, "_") });
add("base64 padding stripped", { transaction: b64(legacy([transfer])).replace(/=+$/, "") });
add("hex instead of base64", { transaction: Buffer.from(legacy([transfer])).toString("hex") });
add("body 7.9 KB", { transaction: "A".repeat(7900) });
add("body 9 KB", { transaction: "A".repeat(9000) });
add("body 1 MB", { transaction: "A".repeat(1_000_000) });

// Random and truncated bytes
for (const n of [1, 2, 3, 4, 8, 16, 64, 128, 300, 1232, 1233, 4096, 4097]) add(`random ${n} bytes`, { transaction: b64(rnd(n)) });
for (const first of [0, 1, 127, 128, 129, 130, 255]) add(`first byte ${first} then random`, { transaction: b64(new Uint8Array([first, ...rnd(200)])) });
const good = legacy([budget, transfer]);
for (const cut of [1, 3, 64, 65, 66, 67, 100, good.length - 40, good.length - 1]) add(`legacy truncated at ${cut}`, { transaction: b64(good.subarray(0, cut)) });
const goodV0 = v0([budget, transfer]);
for (const cut of [1, 65, 66, 70, 100, goodV0.length - 1]) add(`v0 truncated at ${cut}`, { transaction: b64(goodV0.subarray(0, cut)) });
add("legacy with extra trailing bytes", { transaction: b64(new Uint8Array([...good, ...rnd(50)])) });
add("v0 with extra trailing bytes", { transaction: b64(new Uint8Array([...goodV0, ...rnd(50)])) });
{ const t = new Uint8Array(good); t[1] ^= 0xff; add("legacy signature-count byte flipped", { transaction: b64(t) }); }
{ const t = new Uint8Array(goodV0); t[65] = 255; add("v0 header required-signatures 255", { transaction: b64(t) }); }
{ const t = new Uint8Array(goodV0); t[t.length - 1] = 200; add("v0 last byte 200 (data length overflow)", { transaction: b64(t) }); }

// Structurally valid but hostile
add("zero instructions", { transaction: b64(legacy([])) });
add("only compute budget", { transaction: b64(legacy([budget])) });
add("25 compute budget ixs", { transaction: b64(legacy(new Array(25).fill(budget))) });
add("compute limit 0", { transaction: b64(legacy([ComputeBudgetProgram.setComputeUnitLimit({ units: 0 }), transfer])) });
add("compute limit u32 max", { transaction: b64(legacy([ComputeBudgetProgram.setComputeUnitLimit({ units: 4294967295 }), transfer])) });
add("priority fee u64 max", { transaction: b64(legacy([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt("18446744073709551615") }), transfer])) });
add("compute budget garbage data", { transaction: b64(legacy([ix(ComputeBudgetProgram.programId, [9, 1, 2, 3]), transfer])) });
add("compute budget empty data", { transaction: b64(legacy([ix(ComputeBudgetProgram.programId, []), transfer])) });
add("compute budget tag 2 with 1 byte", { transaction: b64(legacy([ix(ComputeBudgetProgram.programId, [2, 1]), transfer])) });
add("jupiter empty data", { transaction: b64(legacy([ix(JUP, [])])) });
add("jupiter 7-byte data", { transaction: b64(legacy([ix(JUP, [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad])])) });
add("jupiter route disc only", { transaction: b64(legacy([ix(JUP, [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a])])) });
add("jupiter route_v2 short amounts", { transaction: b64(legacy([ix(JUP, [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14, 1, 2, 3])])) });
add("jupiter route_v2 no accounts", { transaction: b64(legacy([ix(JUP, [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14, ...new Array(40).fill(0)], [])])) });
add("jupiter route 200 zero bytes", { transaction: b64(legacy([ix(JUP, [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a, ...new Array(200).fill(0)])])) });
add("pumpswap buy disc only", { transaction: b64(legacy([ix(PUMP, [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea])])) });
add("pumpswap buy 20 bytes no accounts", { transaction: b64(legacy([ix(PUMP, [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea, ...new Array(12).fill(0)], [])])) });
add("pumpswap buy amount u64 max", { transaction: b64(legacy([ix(PUMP, [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea, ...new Array(16).fill(255), 0])])) });
add("pumpswap buy limit 0", { transaction: b64(legacy([ix(PUMP, [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea, 1, 0, 0, 0, 0, 0, 0, 0, ...new Array(8).fill(0), 0])])) });
add("raydium tag 9 short", { transaction: b64(legacy([ix(RAY, [9, 1, 2])])) });
add("raydium tag 17 no accounts", { transaction: b64(legacy([ix(RAY, [17, ...new Array(16).fill(1)], [])])) });
add("raydium tag 9 with 3 accounts", { transaction: b64(legacy([ix(RAY, [9, ...new Array(16).fill(1)], [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: payer, isSigner: false, isWritable: true }, { pubkey: payer, isSigner: false, isWritable: false }])])) });
add("raydium unknown tag 200", { transaction: b64(legacy([ix(RAY, [200, ...new Array(16).fill(1)])])) });
add("nonce advance only", { transaction: b64(legacy([NONCE_ADVANCE])) });
add("nonce advance twice", { transaction: b64(legacy([NONCE_ADVANCE, NONCE_ADVANCE, transfer])) });
add("nonce advance after transfer", { transaction: b64(legacy([transfer, NONCE_ADVANCE])) });
add("transfer to self", { transaction: b64(legacy([SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })])) });
add("transfer u64 max lamports", { transaction: b64(legacy([SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: BigInt("18446744073709551615") })])) });
add("unknown program random data", { transaction: b64(legacy([ix(Keypair.generate().publicKey, rnd(100))])) });
add("20 transfers (near size cap)", { transaction: b64(legacy(new Array(20).fill(0).map(() => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })))) });
add("60 transfers as v0 (over 1232, hand-assembled)", { transaction: b64(new Uint8Array([...goodV0, ...rnd(1300)])) });
add("payer is system program", { transaction: b64(legacy([transfer], SystemProgram.programId)) });
add("payer is default pubkey", { transaction: b64(legacy([transfer], PublicKey.default)) });
add("v0 with fake lookup table", (() => { const m = MessageV0.compile({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [transfer], addressLookupTableAccounts: [] }); const raw = new VersionedTransaction(m).serialize(); const t = new Uint8Array([...raw]); t[t.length - 1] = 1; return { transaction: b64(t) }; })());
add("v0 with 1 real-looking lookup table", { transaction: b64(new Uint8Array([...goodV0.subarray(0, goodV0.length - 1), 1, ...Keypair.generate().publicKey.toBytes(), 2, 0, 1, 1, 0])) });

// Version 1 wire images
add("v1 minimal", { transaction: b64(v1Bytes()) });
add("v1 compute limit 0", { transaction: b64(v1Bytes({ computeLimit: 0 })) });
add("v1 compute limit u32 max", { transaction: b64(v1Bytes({ computeLimit: 0xffffffff })) });
add("v1 fee u64 max", { transaction: b64(v1Bytes({ fee: "18446744073709551615" })) });
add("v1 loaded u32 max", { transaction: b64(v1Bytes({ loaded: 0xffffffff })) });
add("v1 heap u32 max", { transaction: b64(v1Bytes({ heap: 0xffffffff })) });
add("v1 zero instructions", { transaction: b64(v1Bytes({ instructions: 0 })) });
add("v1 program index out of range", { transaction: b64(v1Bytes({ ixProgramIndex: 40 })) });
add("v1 account index out of range", { transaction: b64(v1Bytes({ ixAccountIndex: 40 })) });
add("v1 zero accounts", { transaction: b64(v1Bytes({ accounts: 0 })) });
add("v1 65 accounts", { transaction: b64(v1Bytes({ accounts: 65 })) });
add("v1 required signatures 0", { transaction: b64(v1Bytes({ numRequiredSignatures: 0 })) });
add("v1 required signatures 255", { transaction: b64(v1Bytes({ numRequiredSignatures: 255 })) });
add("v1 no signatures", { transaction: b64(v1Bytes({ sigs: 0 })) });
add("v1 data length 255", { transaction: b64(v1Bytes({ dataLen: 255 })) });
for (const cut of [1, 2, 4, 10, 20, 40, 80, 120]) add(`v1 truncated at ${cut}`, { transaction: b64(v1Bytes().subarray(0, cut)) });
add("v1 random after version byte 4095", { transaction: b64(new Uint8Array([129, ...rnd(4095)])) });
add("v1 5000 bytes", { transaction: b64(new Uint8Array([129, ...rnd(4999)])) });

// Run
const results = [];
let bad = 0;
const started = Date.now();
for (let i = 0; i < cases.length; i++) {
  const { name, body } = cases[i];
  const t = Date.now();
  let status = 0, kind = "", text = "";
  try {
    const res = await fetch(`${BASE}/api/v1/repair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-txwhy-client": "test", ...(PER_MINUTE ? {} : { "x-forwarded-for": `10.0.${(i >> 8) & 255}.${i & 255}` }) }, // local: one bucket per case so the per-instance limiter does not mask results
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    status = res.status;
    text = await res.text();
    try { const j = JSON.parse(text); kind = j.status ?? j.error ?? "?"; } catch { kind = "NON-JSON"; }
  } catch (e) { status = -1; kind = e.name === "TimeoutError" ? "TIMEOUT" : e.message; }
  const ms = Date.now() - t;
  const ok = [200, 400, 413, 429, 502].includes(status) && kind !== "NON-JSON" && ms < 30_000;
  if (!ok) bad++;
  results.push({ name, status, kind: String(kind).slice(0, 90), ms, ok });
  console.log(`${ok ? "ok " : "BAD"} ${String(status).padStart(3)} ${String(ms).padStart(5)}ms  ${name}  -> ${String(kind).slice(0, 90)}`);
  if (PER_MINUTE) await new Promise((r) => setTimeout(r, 60_000 / PER_MINUTE));
}
writeFileSync(new URL("./fuzz-results.json", import.meta.url), JSON.stringify(results, null, 1));
console.log(`\n${cases.length - bad}/${cases.length} acceptable in ${((Date.now() - started) / 1000).toFixed(0)}s; ${bad} bad`);
process.exit(bad ? 1 : 0);
