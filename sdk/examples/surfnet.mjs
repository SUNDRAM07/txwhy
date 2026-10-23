// TxWhy on a Surfpool surfnet: the transaction fails on your local mainnet fork, comes back repaired and verified,
// and lands on the surfnet. Nothing touches mainnet.
//
//   1. SURFNET_REMOTE_RPC=https://your-mainnet-rpc docker compose -f docker-compose.surfnet.yml up --build   (repo root)
//      or: surfpool start   and   SOLANA_RPC_URL=http://127.0.0.1:8899 npm run dev   (TxWhy on :3000)
//   2. npm i @solana/kit @solana/kit-plugin-rpc @solana/kit-plugin-signer @solana/surfpool @txwhy/sdk
//   3. node examples/surfnet.mjs
import { createClient, generateKeyPairSigner, pipe, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstruction, compileTransaction, address, lamports } from "@solana/kit";
import { surfpool } from "@solana/surfpool/kit";
import { payer } from "@solana/kit-plugin-signer";
import { getTransferSolInstruction } from "@solana-program/system";
import { txwhy } from "@txwhy/sdk/surfpool";

const SURFNET = process.env.SURFNET_RPC_URL ?? "http://127.0.0.1:8899";
const ENGINE = process.env.TXWHY_URL ?? "http://127.0.0.1:3000";

const me = await generateKeyPairSigner();
const client = createClient()
  .use(payer(me))
  .use(surfpool({ rpcUrl: SURFNET }))
  .use(txwhy({ endpoint: `${ENGINE}/api/v1/repair`, onRepair: (r) => console.log(`repaired: ${r.changes.map((c) => `${c.type} (${c.reason})`).join("; ")}`) }));

// Fund the throwaway wallet on the surfnet with a cheatcode, then build a transfer with a blockhash that is long dead.
await client.cheatcodes.setAccount(me.address, { lamports: lamports(1_000_000_000n) }).send();
const dead = { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n };
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayer(me.address, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(dead, m),
  (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: me, destination: address("11111111111111111111111111111111"), amount: lamports(1_000n) }), m),
);
const transaction = compileTransaction(message);

// Simulate on the surfnet, repair through the local engine, verify on this machine, sign with the payer, send to the surfnet.
const { signature, repairs } = await client.txwhy.sendWithRepair(transaction);
console.log(`landed on the surfnet: ${signature} after ${repairs.length} repair(s)`);
await client.surfnet?.stop?.();
