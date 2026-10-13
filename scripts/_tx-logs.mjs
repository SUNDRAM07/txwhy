import { Connection } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const tx = await conn.getTransaction(process.argv[2], { maxSupportedTransactionVersion: 0 });
const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map(String);
const failIdx = tx.meta.err.InstructionError[0];
const ix = tx.transaction.message.compiledInstructions[failIdx];
console.log("accounts of failing ix:"); ix.accountKeyIndexes.forEach((i, n) => console.log(`  ${n}: ${keys[i]}`));
console.log("logs:"); for (const l of tx.meta.logMessages) console.log("  " + l.slice(0, 160));
