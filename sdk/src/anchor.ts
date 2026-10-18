// Anchor: wrap the provider once, and every program.methods.x().rpc() goes through simulate, repair,
// verify, sign, send, confirm. No dependency on @coral-xyz/anchor itself: AnchorProvider satisfies the
// slice below, and so does any object with a connection and a signing wallet.
import type { Commitment, Connection, Signer, Transaction, VersionedTransaction } from "@solana/web3.js";
import { TxWhyError, sendWithRepair, type RepairResult, type SendWithRepairOptions } from "./index";

/** The slice of an Anchor provider this needs. */
export interface ProviderLike {
  connection: Connection;
  wallet: {
    publicKey: { toBase58(): string };
    signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  };
  opts?: { commitment?: Commitment; skipPreflight?: boolean };
}

export interface SendAndConfirmOptions {
  commitment?: Commitment;
  skipPreflight?: boolean;
}

export type RepairingProvider<P extends ProviderLike> = P & {
  /** Every repair applied by the last sendAndConfirm, oldest first. Empty when the transaction passed as built. */
  readonly lastRepairs: RepairResult[];
  /**
   * Simulate; if it would fail, ask TxWhy for a rebuilt transaction, verify the repair locally,
   * sign with the provider's wallet (and any extra signers), send, and wait for confirmation.
   * Anchor's `.rpc()` calls this, so wrapping the provider covers every program call.
   */
  sendAndConfirm(tx: Transaction | VersionedTransaction, signers?: Signer[], opts?: SendAndConfirmOptions): Promise<string>;
};

/**
 * Wrap an Anchor provider so every program call goes through simulate, repair, verify, sign, send.
 *
 *   const provider = withRepairProvider(AnchorProvider.env());
 *   const program = new Program(idl, provider);
 *   await program.methods.swap(amount).accounts({ ... }).rpc();   // repaired on the way if it would fail
 *   provider.lastRepairs;                                         // what changed, with before and after
 *
 * Everything else on the provider is untouched: the wrapper inherits from it, so `connection`,
 * `wallet`, `publicKey` and `opts` are the provider's own. A rebuilt transaction that fails the
 * local verifier is never handed to the wallet.
 */
export function withRepairProvider<P extends ProviderLike>(provider: P, defaults: SendWithRepairOptions = {}): RepairingProvider<P> {
  let lastRepairs: RepairResult[] = [];
  const wrapped = Object.create(provider) as RepairingProvider<P>;
  Object.defineProperty(wrapped, "lastRepairs", { get: () => lastRepairs, enumerable: true });
  Object.defineProperty(wrapped, "sendAndConfirm", {
    enumerable: true,
    value: async (tx: Transaction | VersionedTransaction, signers: Signer[] = [], opts: SendAndConfirmOptions = {}): Promise<string> => {
      const { connection, wallet } = provider;
      if (!wallet || typeof wallet.signTransaction !== "function") {
        throw new TxWhyError("This provider's wallet cannot sign, so TxWhy cannot hand it the repaired transaction.");
      }
      const commitment: Commitment = opts.commitment ?? provider.opts?.commitment ?? "confirmed";
      const { signature, repairs, transaction } = await sendWithRepair(
        connection,
        tx,
        async (rebuilt) => {
          const signed = await wallet.signTransaction(rebuilt);
          if (signers.length > 0) signed.sign(signers);
          return signed;
        },
        {
          ...defaults,
          client: defaults.client ?? "anchor",
          sendOptions: { skipPreflight: opts.skipPreflight ?? provider.opts?.skipPreflight ?? false, ...defaults.sendOptions },
        },
      );
      lastRepairs = repairs;
      const { lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
      const confirmation = await connection.confirmTransaction({ signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight }, commitment);
      if (confirmation.value.err) {
        throw new TxWhyError(`The transaction was sent as ${signature} but failed on chain: ${JSON.stringify(confirmation.value.err)}`, repairs[repairs.length - 1]);
      }
      return signature;
    },
  });
  return wrapped;
}
