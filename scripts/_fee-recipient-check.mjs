// Is the fee-recipient account a failed Pump.fun buy/sell passed one of the protocol's current ones?
// Reads the Global account directly (layout from the pump IDL: ... creator_fee_basis_points u64, then fee_recipients [pubkey; 7]).
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP);
const info = await conn.getAccountInfo(global);
const d = info.data;
const pk = (o) => new PublicKey(d.subarray(o, o + 32)).toBase58();
console.log("global", global.toBase58(), "bytes", d.length);
console.log("fee_recipient @41:", pk(41));
const seven = []; for (let i = 0; i < 7; i++) seven.push(pk(162 + 32 * i));
console.log("fee_recipients @162:", seven.map((s) => s.slice(0, 8)).join(" "));
const current = new Set([pk(41), ...seven]);
for (const sig of process.argv.slice(2)) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map(String);
  const failIdx = tx.meta.err.InstructionError[0];
  const ix = tx.transaction.message.compiledInstructions[failIdx];
  const passed = keys[ix.accountKeyIndexes[1]];
  console.log(`${sig.slice(0, 10)} program ${keys[ix.programIdIndex].slice(0, 6)} accounts ${ix.accountKeyIndexes.length} fee account #2 ${passed} current: ${current.has(passed)}`);
}
