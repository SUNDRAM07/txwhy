/**
 * Transport and types shared by the web3.js entry (`@txwhy/sdk`) and the kit entry
 * (`@txwhy/sdk/kit`). No Solana library is imported here.
 */
import type { Verification } from "../../src/lib/verify";

export const DEFAULT_ENDPOINT = "https://txwhy.vercel.app/api/v1/repair";

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

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The reason inside an x402 "payment-required" header, when the payment was attempted and refused. */
export function paymentProblem(res: Response): string | null {
  try {
    const header = res.headers.get("payment-required");
    if (!header) return null;
    const { error } = JSON.parse(atob(header)) as { error?: string };
    return error && error !== "Payment required" ? `the facilitator refused the payment (${error})` : null;
  } catch {
    return null;
  }
}

/** One call to the repair endpoint with an already-serialized body. */
export async function requestRepair(body: { transaction: string } | { signature: string }, options: TxWhyOptions = {}): Promise<RepairResult> {
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
