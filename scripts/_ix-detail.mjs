// Failing instruction of a landed transaction (any version, raw RPC): program, discriminator, u64 args, accounts, logs, balances.
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(s) { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const c of s) { if (c === "1") out.unshift(0); else break; } return Buffer.from(out); }
for (const sig of process.argv.slice(2)) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }) });
  const { result: tx } = await res.json();
  if (!tx) { console.log(sig.slice(0, 12), "not found"); continue; }
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const failIdx = tx.meta.err.InstructionError[0];
  const ix = tx.transaction.message.instructions[failIdx];
  const d = b58(ix.data);
  const u64s = []; for (let o = 8; o + 8 <= d.length && u64s.length < 4; o += 8) u64s.push(d.readBigUInt64LE(o).toString());
  console.log(`\n== ${sig.slice(0, 12)} version ${tx.version} fail ix#${failIdx + 1} program ${keys[ix.programIdIndex]} data ${d.length}B disc ${d.subarray(0, 8).toString("hex")} u64s ${u64s.join(" ")}`);
  console.log("   accounts:", ix.accounts.slice(0, 14).map((i, n) => `${n}:${keys[i].slice(0, 6)}`).join(" "));
  for (const l of tx.meta.logMessages.filter((l) => /Instruction: |AnchorError|failed:|consumed|Program log: (?!Instruction)/.test(l)).slice(-12)) console.log("   " + l.slice(0, 170));
  for (const b of (tx.meta.preTokenBalances ?? []).slice(0, 8)) console.log(`   pre acct#${b.accountIndex} ${keys[b.accountIndex]?.slice(0, 6)} owner ${(b.owner ?? "").slice(0, 6)} amount ${b.uiTokenAmount.amount} dec ${b.uiTokenAmount.decimals}`);
}
