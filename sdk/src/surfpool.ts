/**
 * `@txwhy/sdk/surfpool`: TxWhy as a @solana/kit client plugin, made to sit next to `@solana/surfpool/kit`.
 *
 *   import { createClient } from "@solana/kit";
 *   import { surfpool } from "@solana/surfpool/kit";
 *   import { txwhy } from "@txwhy/sdk/surfpool";
 *
 *   const client = await createClient().use(surfpool()).use(txwhy({ endpoint: "http://127.0.0.1:3000/api/v1/repair" }));
 *   const { signature, repairs } = await client.txwhy.sendWithRepair(transaction);
 *
 * Every repair is simulated by the TxWhy engine against the client's own RPC: a surfnet when the engine runs next
 * to one (docker-compose.surfnet.yml), mainnet otherwise. The plugin works with any kit client that has an `rpc`;
 * nothing from `@solana/surfpool` is imported, so it is also a plain kit plugin.
 */
import { extendClient, signTransaction, type ClientPlugin, type ExtendedClient, type Transaction } from "@solana/kit";
import type { RepairResult, TxWhyOptions } from "./core";
import { repair, sendWithRepair, verifyRepair, type KitTransaction, type RepairRpc, type SendWithRepairOptions, type SendWithRepairResult } from "./kit";
import type { Verification } from "../../src/lib/verify";

export { TxWhyError } from "./kit";
export type { RepairResult, RepairStatus, TxWhyOptions } from "./kit";
export type { KitTransaction, SendWithRepairOptions, SendWithRepairResult } from "./kit";
export type { Verification } from "../../src/lib/verify";

/** What the plugin needs from the client: a kit RPC, and optionally the payer `@solana/surfpool/kit` or `@solana/kit-plugin-signer` installed. */
export interface TxWhyClientInput {
  rpc: RepairRpc;
  payer?: { address?: unknown; keyPair?: CryptoKeyPair };
}

export type TxWhyPluginOptions = SendWithRepairOptions;

export type Signer = (tx: Transaction) => Promise<Transaction> | Transaction;

export interface TxWhyClientApi {
  /** The options the plugin was created with. */
  readonly options: TxWhyPluginOptions;
  /** Diagnose and rebuild a transaction (legacy, v0 or v1), or explain a landed failure by signature. */
  repair(input: { transaction: KitTransaction } | { signature: string }): Promise<RepairResult>;
  /** Prove locally, without contacting TxWhy, that a repair only changed what a repair may change. */
  verifyRepair(original: KitTransaction, repaired: KitTransaction): Promise<Verification>;
  /**
   * Simulate on the client's RPC, repair if it would fail, verify locally, sign, send. `sign` may be omitted when the
   * client carries a key-pair payer (surfpool's embedded mode, or `payer(keyPairSigner)`): the payer then signs.
   */
  sendWithRepair(transaction: KitTransaction, sign?: Signer, options?: SendWithRepairOptions): Promise<SendWithRepairResult>;
}

export type ClientWithTxWhy<C extends object> = ExtendedClient<C, { txwhy: TxWhyClientApi }>;

/** A kit client plugin: `createClient().use(surfpool()).use(txwhy({ endpoint }))` adds `client.txwhy`. */
export function txwhy<C extends TxWhyClientInput>(options: TxWhyPluginOptions = {}): ClientPlugin<C, ClientWithTxWhy<C>> {
  return (client) => {
    const payerSigner = (): Signer => {
      const keyPair = client.payer?.keyPair;
      if (!keyPair) throw new Error("sendWithRepair needs a signer: pass one, or give the client a key-pair payer (surfpool() embedded mode, or payer(keyPairSigner)).");
      return (tx) => signTransaction([keyPair], tx);
    };
    const api: TxWhyClientApi = {
      options,
      repair: (input) => repair(input, options),
      verifyRepair: (original, repaired) => verifyRepair(client.rpc, original, repaired),
      sendWithRepair: async (transaction, sign, overrides) => sendWithRepair(client.rpc, transaction, sign ?? payerSigner(), { ...options, ...overrides }),
    };
    return extendClient(client, { txwhy: api });
  };
}

/** The same loop as a plain function, for code that holds an rpc but no kit client. */
export { repair, sendWithRepair, verifyRepair };
export type { TxWhyOptions as RepairOptions };
