// One line for any dApp: the wallet only ever signs a transaction that already passes simulation.
// Works with any wallet-adapter wallet (useWallet()), Phantom's injected window.solana, or anything
// that has signTransaction. No dependency on wallet-adapter itself.
import type { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { TxWhyError, sendWithRepair, type SendWithRepairOptions, type SendWithRepairResult } from "./index";

/** The slice of a wallet this needs. `useWallet()` from @solana/wallet-adapter-react satisfies it; so does `window.solana`. */
export interface SigningWallet {
  publicKey?: { toBase58(): string } | null;
  signTransaction?: (<T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>) | undefined;
}

export interface RepairingWallet {
  /**
   * Simulate; if it would fail, ask TxWhy for a rebuilt transaction, verify the repair locally,
   * then prompt the wallet to sign the transaction that will actually land, and send it.
   */
  sendTransaction(transaction: Transaction | VersionedTransaction, options?: SendWithRepairOptions): Promise<SendWithRepairResult>;
}

/**
 * Wrap a connected wallet so every send goes through simulate, repair, verify, sign, send.
 *
 *   const { connection } = useConnection();
 *   const wallet = useWallet();
 *   const { signature, repairs } = await withRepair(wallet, connection).sendTransaction(tx);
 *
 * The user sees one signature prompt, for the transaction that passes. If the rebuilt transaction
 * fails local verification, nothing is ever shown to the wallet.
 */
export function withRepair(wallet: SigningWallet, connection: Connection, defaults: SendWithRepairOptions = {}): RepairingWallet {
  return {
    sendTransaction(transaction, options = {}) {
      const sign = wallet.signTransaction;
      if (!sign) throw new TxWhyError("This wallet does not support signTransaction, so TxWhy cannot hand it the repaired transaction to sign.");
      if (!wallet.publicKey) throw new TxWhyError("Connect the wallet first: it has no public key.");
      return sendWithRepair(connection, transaction, (tx) => sign.call(wallet, tx) as Promise<VersionedTransaction>, { ...defaults, ...options, client: options.client ?? defaults.client ?? "wallet" });
    },
  };
}
