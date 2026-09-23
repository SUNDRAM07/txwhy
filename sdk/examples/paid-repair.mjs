// Pay per repair over x402: no account, no API key, no rate limit. The agent pays $0.001 in
// USDC on Solana for each repair and the charge only settles after a successful answer.
//
//   cd sdk && npm install            (installs @x402/fetch, @x402/svm, @solana/kit as dev deps)
//   $env:AGENT_PRIVATE_KEY = "<base58 private key from Phantom>"   (PowerShell, this window only)
//   node examples/paid-repair.mjs
//
// or AGENT_KEYPAIR=./agent.json for a Solana CLI keypair file.
// The wallet needs a little USDC (mainnet). The facilitator pays the network fee, so no SOL is needed.
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import bs58 from "bs58";
import { repair } from "../dist/index.js";

const BASE = process.env.TXWHY_BASE ?? "https://txwhy.vercel.app";
const secret = process.env.AGENT_PRIVATE_KEY
  ? bs58.decode(process.env.AGENT_PRIVATE_KEY.trim())
  : Uint8Array.from(JSON.parse(readFileSync(process.env.AGENT_KEYPAIR, "utf8")));
const signer = await createKeyPairSignerFromBytes(secret);
console.log(`paying from ${signer.address}`);
const fetchWithPayment = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmScheme(signer)));

// Something to repair: the demo's deliberately broken swap.
const demo = await (await fetch(`${BASE}/api/v1/example?kind=slippage`)).json();

// Exactly the same call as the free endpoint, with a paying fetch and the paid URL.
let receipt = null;
const result = await repair(
  { transaction: demo.transaction },
  {
    endpoint: `${BASE}/api/x402/repair`,
    client: process.env.TXWHY_CLIENT,
    fetch: async (url, init) => {
      const res = await fetchWithPayment(url, init);
      const header = res.headers.get("payment-response");
      if (header) receipt = decodePaymentResponseHeader(header);
      return res;
    },
  },
);

console.log(`${result.status}: ${result.summary}`);
for (const change of result.changes) console.log(`  ${change.type}: ${change.before} -> ${change.after}`);
console.log(`verification: ${result.verification?.ok ? "nothing else was touched" : result.verification?.violations.join(" ")}`);
if (receipt) {
  console.log(`paid: ${receipt.success ? "settled" : "settlement failed"} on ${receipt.network}`);
  if (receipt.transaction) console.log(`receipt: https://solscan.io/tx/${receipt.transaction}`);
}
