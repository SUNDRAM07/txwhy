/**
 * `@txwhy/sdk/kit`: the same send loop for @solana/kit users, including version 1 transactions
 * (SIMD-0385), which web3.js 1.x cannot sign or send. Nothing from @solana/web3.js is imported.
 *
 *   import { sendWithRepair } from "@txwhy/sdk/kit";
 *   const { signature } = await sendWithRepair(rpc, transaction, (tx) => signTransaction([keyPair], tx));
 */
import {
  AccountRole,
  decompileTransactionMessage,
  decompileTransactionMessageFetchingLookupTables,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Base64EncodedWireTransaction,
  type GetMultipleAccountsApi,
  type Instruction,
  type Rpc,
  type SendTransactionApi,
  type SimulateTransactionApi,
  type Transaction,
} from "@solana/kit";
import { verifyInstructions, type Verification } from "../../src/lib/verify";
import { fromBase64, requestRepair, TxWhyError, type RepairResult, type TxWhyOptions } from "./core";

export { TxWhyError, explainError } from "./core";
export type { Explanation } from "./core";
export type { RepairChange, RepairResult, RepairStatus, TxWhyOptions } from "./core";
export type { InstructionChange, Verification } from "../../src/lib/verify";

/** A kit `Transaction` (any version) or its base64 wire bytes. */
export type KitTransaction = Transaction | string;

export type RepairRpc = Rpc<SimulateTransactionApi & SendTransactionApi & GetMultipleAccountsApi>;

const toWire = (tx: KitTransaction): Base64EncodedWireTransaction =>
  (typeof tx === "string" ? tx.trim() : getBase64EncodedWireTransaction(tx)) as Base64EncodedWireTransaction;

const toTransaction = (tx: KitTransaction): Transaction => (typeof tx === "string" ? getTransactionDecoder().decode(fromBase64(tx.trim())) : tx);

/** Ask TxWhy to diagnose and rebuild a transaction (legacy, v0 or v1), or explain a landed failure. */
export async function repair(input: { transaction: KitTransaction } | { signature: string }, options: TxWhyOptions = {}): Promise<RepairResult> {
  return requestRepair("signature" in input ? { signature: input.signature } : { transaction: toWire(input.transaction) }, options);
}

/** Kit returns RPC numbers as bigints, which JSON.stringify refuses. */
const describeError = (err: unknown) => JSON.stringify(err, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v));

type CompiledMessage = Parameters<typeof decompileTransactionMessageFetchingLookupTables>[0];

/** The verifier compares base58 strings and raw bytes only, so kit instructions are passed as plain objects. */
async function decompile(rpc: Rpc<GetMultipleAccountsApi>, tx: KitTransaction) {
  const transaction = toTransaction(tx);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as CompiledMessage;
  const lookups = "addressTableLookups" in compiled ? (compiled.addressTableLookups?.length ?? 0) : 0;
  const message = lookups ? await decompileTransactionMessageFetchingLookupTables(compiled, rpc) : decompileTransactionMessage(compiled);
  const key = (address: string) => ({ toBase58: () => address });
  const instructions = message.instructions as readonly Instruction[];
  return {
    payer: key(String(message.feePayer.address)),
    instructions: instructions.map((ix) => ({
      programId: key(String(ix.programAddress)),
      keys: (ix.accounts ?? []).map((a) => ({
        pubkey: key(String(a.address)),
        isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
        isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
      })),
      data: ix.data ?? new Uint8Array(),
    })),
  };
}

type VerifyInput = Parameters<typeof verifyInstructions>[0];

/**
 * Prove locally that a repaired transaction only differs from the original in the ways a repair is
 * allowed to. The rpc is used only to expand address lookup tables (v0); v1 and legacy need no call.
 * TxWhy is not contacted.
 */
export async function verifyRepair(rpc: Rpc<GetMultipleAccountsApi>, original: KitTransaction, repaired: KitTransaction): Promise<Verification> {
  const [before, after] = await Promise.all([decompile(rpc, original), decompile(rpc, repaired)]);
  return verifyInstructions(before as unknown as VerifyInput, after as unknown as VerifyInput);
}

export interface SendWithRepairOptions extends TxWhyOptions {
  /** How many times a failing transaction may be rebuilt before giving up. Default 1. */
  maxRepairs?: number;
  /** Check every repair locally before signing it. Default true. Turning this off means trusting the service. */
  verify?: boolean;
  /** Called with each repair that is about to be signed. Throw to veto it. */
  onRepair?: (result: RepairResult, verification: Verification | null) => void | Promise<void>;
  /** Passed to sendTransaction. */
  sendOptions?: { skipPreflight?: boolean; maxRetries?: bigint; minContextSlot?: bigint };
}

export interface SendWithRepairResult {
  signature: string;
  /** Every repair that was applied before the transaction went out. Empty when it was fine as built. */
  repairs: RepairResult[];
  /** The signed transaction that was sent. */
  transaction: Transaction;
}

/**
 * Simulate, repair if it would fail, verify the repair locally, sign, send. Works for legacy, v0 and
 * v1 transactions. `sign` receives the transaction that will actually be sent, so your keys never
 * leave your process: TxWhy only ever sees, and returns, unsigned bytes.
 */
export async function sendWithRepair(
  rpc: RepairRpc,
  transaction: KitTransaction,
  sign: (tx: Transaction) => Promise<Transaction> | Transaction,
  options: SendWithRepairOptions = {},
): Promise<SendWithRepairResult> {
  const maxRepairs = options.maxRepairs ?? 1;
  const repairs: RepairResult[] = [];
  let current = toWire(transaction);

  for (let attempt = 0; ; attempt++) {
    const simulation = await rpc.simulateTransaction(current, { encoding: "base64", sigVerify: false, commitment: "confirmed" }).send();
    if (!simulation.value.err) break;
    if (attempt >= maxRepairs) {
      throw new TxWhyError(`Still failing after ${maxRepairs} repair(s): ${describeError(simulation.value.err)}`, repairs[repairs.length - 1]);
    }
    const result = await requestRepair({ transaction: current }, options);
    if (result.status === "valid") break; // state moved in our favour between the two simulations
    if (result.status !== "repaired" || !result.repairedTransaction) throw new TxWhyError(result.summary, result);

    let verification: Verification | null = null;
    if (options.verify !== false) {
      verification = await verifyRepair(rpc, current, result.repairedTransaction);
      if (!verification.ok) {
        throw new TxWhyError(`Refusing to sign: the repair failed local verification. ${verification.violations.join(" ")}`, result, verification);
      }
    }
    await options.onRepair?.(result, verification);
    repairs.push(result);
    current = result.repairedTransaction.trim() as Base64EncodedWireTransaction;
  }

  const signed = await sign(toTransaction(current));
  const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", ...options.sendOptions }).send();
  return { signature: String(signature), repairs, transaction: signed };
}
