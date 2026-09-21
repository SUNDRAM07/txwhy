// A trading agent with and without TxWhy in its send loop.
//
//   node examples/agent.mjs                      dry run: nothing is signed or sent
//   AGENT_KEYPAIR=./agent.json node examples/agent.mjs --send
//                                                real run: swaps 0.001 SOL to USDC from that wallet
//
// The agent trades on a quote that has gone stale, which is the most common way an agent's swap
// fails. Without TxWhy the agent stops. With TxWhy the same call comes back repaired, is checked
// locally, and lands.
import { readFileSync } from "node:fs";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { sendWithRepair, TxWhyError } from "../dist/index.js";

const SEND = process.argv.includes("--send");
const BASE = process.env.TXWHY_BASE ?? "https://txwhy.vercel.app";
const JUPITER = "https://lite-api.jup.ag/swap/v1";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

const c = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", y: "\x1b[33m", x: "\x1b[0m" };
const say = (who, text) => console.log(`${c.d}${new Date().toISOString().slice(11, 19)}${c.x}  ${c.b}${who.padEnd(7)}${c.x} ${text}`);

/** Build the agent's swap. The quote is aged on purpose: the market "moved" 5% since it was taken. */
async function buildStaleSwap(keypair) {
  if (!keypair) {
    const demo = await (await fetch(`${BASE}/api/v1/example?kind=slippage`)).json();
    return VersionedTransaction.deserialize(Buffer.from(demo.transaction, "base64"));
  }
  const quote = await (await fetch(`${JUPITER}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=1000000&slippageBps=50`)).json();
  const stale = { ...quote, outAmount: String(Math.floor(Number(quote.outAmount) * 1.05)), otherAmountThreshold: String(Math.floor(Number(quote.otherAmountThreshold) * 1.05)) };
  const swap = await (
    await fetch(`${JUPITER}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: stale, userPublicKey: keypair.publicKey.toBase58(), dynamicComputeUnitLimit: true }),
    })
  ).json();
  return VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
}

const keypair = SEND ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.AGENT_KEYPAIR, "utf8")))) : null;
if (!SEND) connection.sendTransaction = async () => "(dry run: not sent)";
const sign = (tx) => {
  if (keypair) tx.sign([keypair]);
  return tx;
};

say("agent", `task: swap ${keypair ? "0.001" : "0.05"} SOL to USDC, 0.5% slippage tolerance${SEND ? "" : `  ${c.d}(dry run)${c.x}`}`);
const tx = await buildStaleSwap(keypair);
say("agent", "transaction built from the quote it took earlier");

console.log(`\n${c.b}--- without TxWhy ---${c.x}`);
const plain = await connection.simulateTransaction(tx, { sigVerify: false });
if (plain.value.err) {
  say("rpc", `${c.r}simulation failed: ${JSON.stringify(plain.value.err)}${c.x}`);
  say("agent", `${c.r}custom program error 0x1771. No idea what that means. Task abandoned.${c.x}`);
} else {
  say("rpc", "simulation passed (the market moved back in our favour, run it again)");
}

console.log(`\n${c.b}--- with TxWhy: one line ---${c.x}`);
const started = Date.now();
try {
  const { signature, repairs } = await sendWithRepair(connection, tx, sign, {
    client: process.env.TXWHY_CLIENT,
    onRepair: (result, verification) => {
      say("txwhy", `${c.y}${result.cause?.title}${c.x}: ${result.cause?.cause}`);
      for (const change of result.changes) say("txwhy", `  ${change.type}: ${c.r}${change.before}${c.x} -> ${c.g}${change.after}${c.x}`);
      say("txwhy", `rebuilt transaction passes simulation (${result.simulation.unitsConsumed} compute units)`);
      say("local", `${c.g}verified on this machine: ${verification.kept} instructions untouched, same payer, same signers, same trade${c.x}`);
    },
  });
  say("agent", `${c.g}${repairs.length ? (SEND ? "repaired, signed with my own key, sent" : "repaired and verified, ready to sign") : "sent as built"} in ${Date.now() - started} ms${c.x}`);
  say("agent", SEND ? `https://solscan.io/tx/${signature}` : signature);
} catch (e) {
  if (!(e instanceof TxWhyError)) throw e;
  say("txwhy", `${c.r}${e.message}${c.x}`);
  if (e.result?.cause) say("txwhy", `${e.result.cause.title}: ${e.result.cause.fix}`);
  process.exit(1);
}
