import {
  AddressLookupTableAccount,
  Connection,
  SendOptions,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { verifyInstructions, type Verification } from "../../src/lib/verify";

export { verifyInstructions } from "../../src/lib/verify";
export type { InstructionChange, Verification } from "../../src/lib/verify";

export { TxWhyError, paymentProblem } from "./core";
export type { RepairChange, RepairResult, RepairStatus, TxWhyOptions } from "./core";
import { fromBase64, requestRepair, toBase64, TxWhyError, type RepairResult, type TxWhyOptions } from "./core";

type AnyTransaction = VersionedTransaction | Transaction;

/** Version 1 transactions (SIMD-0385) can be read by web3.js 1.99 but never serialized, signed or sent by it. */
const isV1 = (tx: AnyTransaction) => tx instanceof VersionedTransaction && (tx.version as number) === 1;

function serialize(tx: AnyTransaction | string): string {
  if (typeof tx === "string") return tx;
  if (isV1(tx)) {
    throw new TxWhyError("This is a version 1 transaction, which web3.js cannot serialize. Pass its base64 bytes instead (repair() and verifyRepair() accept strings) and sign the result with @solana/kit.");
  }
  if (tx instanceof VersionedTransaction) return toBase64(tx.serialize());
  return toBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function toVersioned(tx: AnyTransaction | string): VersionedTransaction {
  if (tx instanceof VersionedTransaction) return tx;
  return VersionedTransaction.deserialize(fromBase64(serialize(tx)));
}

/**
 * Ask TxWhy to diagnose and rebuild a transaction.
 * Pass the transaction you are about to send (signed or not), or the signature of one that already failed.
 */
export async function repair(
  input: { transaction: AnyTransaction | string } | { signature: string },
  options: TxWhyOptions = {},
): Promise<RepairResult> {
  return requestRepair("signature" in input ? { signature: input.signature } : { transaction: serialize(input.transaction) }, options);
}

async function decompile(connection: Connection, tx: VersionedTransaction) {
  const tables: AddressLookupTableAccount[] = [];
  // Version 1 messages carry no lookup tables; everything is inline.
  for (const lookup of tx.message.addressTableLookups ?? []) {
    const { value } = await connection.getAddressLookupTable(lookup.accountKey);
    if (!value) throw new TxWhyError(`Address lookup table ${lookup.accountKey.toBase58()} was not found.`);
    tables.push(value);
  }
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  return { payer: message.payerKey, instructions: message.instructions };
}

/**
 * Prove locally that a repaired transaction only differs from the original in the ways a repair
 * is allowed to: compute budget, blockhash, and at most one Jupiter swap replaced by the same
 * trade on a fresh quote. The connection is only used to expand address lookup tables, through
 * YOUR RPC. TxWhy is not contacted.
 */
export async function verifyRepair(
  connection: Connection,
  original: AnyTransaction | string,
  repaired: AnyTransaction | string,
): Promise<Verification> {
  const [before, after] = await Promise.all([decompile(connection, toVersioned(original)), decompile(connection, toVersioned(repaired))]);
  return verifyInstructions(before, after);
}

export interface SendWithRepairOptions extends TxWhyOptions {
  /** How many times a failing transaction may be rebuilt before giving up. Default 1. */
  maxRepairs?: number;
  /** Check every repair locally before signing it. Default true. Turning this off means trusting the service. */
  verify?: boolean;
  /** Called with each repair that is about to be signed. Throw to veto it. */
  onRepair?: (result: RepairResult, verification: Verification | null) => void | Promise<void>;
  sendOptions?: SendOptions;
}

export interface SendWithRepairResult {
  signature: string;
  /** Every repair that was applied before the transaction went out. Empty when it was fine as built. */
  repairs: RepairResult[];
  transaction: VersionedTransaction;
}

/**
 * Simulate, repair if it would fail, verify the repair locally, sign, send.
 *
 *   const { signature } = await sendWithRepair(connection, tx, (t) => wallet.signTransaction(t));
 *
 * `sign` receives the transaction that will actually be sent. Your keys never leave your process:
 * TxWhy only ever sees, and returns, unsigned bytes.
 */
export async function sendWithRepair(
  connection: Connection,
  transaction: AnyTransaction,
  sign: (tx: VersionedTransaction) => Promise<VersionedTransaction> | VersionedTransaction,
  options: SendWithRepairOptions = {},
): Promise<SendWithRepairResult> {
  const maxRepairs = options.maxRepairs ?? 1;
  const repairs: RepairResult[] = [];
  let current = toVersioned(transaction);
  if (isV1(current)) {
    throw new TxWhyError(
      "sendWithRepair cannot sign or send a version 1 transaction: web3.js 1.x only reads that format. Call repair({ transaction: base64 }) and verifyRepair(), then sign and send the returned bytes with @solana/kit.",
    );
  }

  for (let attempt = 0; ; attempt++) {
    const simulation = await connection.simulateTransaction(current, { sigVerify: false, commitment: "confirmed" });
    if (!simulation.value.err) break;
    if (attempt >= maxRepairs) {
      throw new TxWhyError(`Still failing after ${maxRepairs} repair(s): ${JSON.stringify(simulation.value.err)}`, repairs[repairs.length - 1]);
    }

    const result = await repair({ transaction: current }, options);
    if (result.status === "valid") break; // state moved in our favour between the two simulations
    if (result.status !== "repaired" || !result.repairedTransaction) throw new TxWhyError(result.summary, result);

    const rebuilt = VersionedTransaction.deserialize(fromBase64(result.repairedTransaction));
    let verification: Verification | null = null;
    if (options.verify !== false) {
      verification = await verifyRepair(connection, current, rebuilt);
      if (!verification.ok) {
        throw new TxWhyError(`Refusing to sign: the repair failed local verification. ${verification.violations.join(" ")}`, result, verification);
      }
    }
    await options.onRepair?.(result, verification);
    repairs.push(result);
    current = rebuilt;
  }

  const signed = await sign(current);
  const signature = await connection.sendTransaction(signed, options.sendOptions);
  return { signature, repairs, transaction: signed };
}
