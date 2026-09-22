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

const DEFAULT_ENDPOINT = "https://txwhy.vercel.app/api/v1/repair";

export type RepairStatus = "repaired" | "valid" | "needs_requote" | "not_repairable";

export interface RepairChange {
  type: "blockhash" | "compute_unit_limit" | "priority_fee" | "swap_quote" | "loaded_accounts_data_limit";
  before: string;
  after: string;
  reason: string;
}

export interface RepairResult {
  status: RepairStatus;
  summary: string;
  cause: { title: string; code?: string; cause: string; fix: string } | null;
  changes: RepairChange[];
  /** Base64, unsigned. Present when status is "repaired" or "valid". */
  repairedTransaction: string | null;
  /** Simulation of the transaction exactly as returned. */
  simulation: { passed: boolean; unitsConsumed: number | null; error: RepairResult["cause"]; logsTail: string[] };
  verification?: Verification;
  notes: string[];
}

export interface TxWhyOptions {
  /** Override to point at a self-hosted TxWhy. */
  endpoint?: string;
  fetch?: typeof fetch;
  /** Reported as the usage channel. Leave alone unless you are writing tests ("test" is never counted). */
  client?: string;
}

export class TxWhyError extends Error {
  constructor(
    message: string,
    /** The service's answer, when there was one. `result.cause` says why the transaction fails. */
    public readonly result?: RepairResult,
    public readonly verification?: Verification,
  ) {
    super(message);
    this.name = "TxWhyError";
  }
}

type AnyTransaction = VersionedTransaction | Transaction;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function serialize(tx: AnyTransaction | string): string {
  if (typeof tx === "string") return tx;
  if (tx instanceof VersionedTransaction) return toBase64(tx.serialize());
  return toBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function toVersioned(tx: AnyTransaction | string): VersionedTransaction {
  if (tx instanceof VersionedTransaction) return tx;
  return VersionedTransaction.deserialize(fromBase64(serialize(tx)));
}

/** The reason inside an x402 "payment-required" header, when the payment was attempted and refused. */
function paymentProblem(res: Response): string | null {
  try {
    const header = res.headers.get("payment-required");
    if (!header) return null;
    const { error } = JSON.parse(atob(header)) as { error?: string };
    return error && error !== "Payment required" ? `the facilitator refused the payment (${error})` : null;
  } catch {
    return null;
  }
}

/**
 * Ask TxWhy to diagnose and rebuild a transaction.
 * Pass the transaction you are about to send (signed or not), or the signature of one that already failed.
 */
export async function repair(
  input: { transaction: AnyTransaction | string } | { signature: string },
  options: TxWhyOptions = {},
): Promise<RepairResult> {
  const body = "signature" in input ? { signature: input.signature } : { transaction: serialize(input.transaction) };
  const res = await (options.fetch ?? fetch)(options.endpoint ?? DEFAULT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-txwhy-client": options.client ?? "sdk" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (RepairResult & { error?: string }) | null;
  if (res.status === 402) throw new TxWhyError(`Payment required: ${paymentProblem(res) ?? json?.error ?? "this endpoint is paid per repair over x402"}.`);
  if (!res.ok || !json || json.error) throw new TxWhyError(json?.error ?? `TxWhy answered ${res.status}.`);
  return json;
}

async function decompile(connection: Connection, tx: VersionedTransaction) {
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of tx.message.addressTableLookups) {
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
