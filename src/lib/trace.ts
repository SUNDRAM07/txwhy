import { decodeTransactionError } from "./errors";
import { fetchIdlErrors } from "./idl";
import { programName } from "./programs";
import type { Trace, TraceNode } from "./types";

import { FALLBACK_URL, RPC_URL } from "./rpc";

interface ParsedInstruction {
  programId: string;
  program?: string;
  parsed?: { type?: string } | string;
  stackHeight?: number | null;
}

interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    logMessages?: string[];
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[];
  };
  transaction: {
    message: { instructions: ParsedInstruction[] };
  };
}

/** Pull a signature out of raw input — accepts bare signatures and explorer URLs. */
export function extractSignature(input: string): string | null {
  if (typeof input !== "string" || input.length > 2_000) return null;
  // A signature is 64 bytes, which base58 encodes to 87 or 88 characters. Inside a URL it is
  // delimited by / ? # or the end of the string, so a longer run of base58 is not a signature.
  const matches = input.trim().match(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![1-9A-HJ-NP-Za-km-z])/g);
  if (!matches) return null;
  return matches[0] ?? null;
}

/**
 * Programs that logged a "failed" line. The FIRST such line is the innermost
 * failure — CPI failures propagate outward, so the deepest program logs first.
 */
function failureInfoFromLogs(logs: string[]): {
  failedPrograms: Set<string>;
  innermostFailedProgram: string | null;
} {
  const failedPrograms = new Set<string>();
  let innermostFailedProgram: string | null = null;
  for (const line of logs) {
    const m = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/);
    if (m) {
      if (!innermostFailedProgram) innermostFailedProgram = m[1];
      failedPrograms.add(m[1]);
    }
  }
  return { failedPrograms, innermostFailedProgram };
}

function instructionName(ix: ParsedInstruction): string | undefined {
  if (typeof ix.parsed === "object" && ix.parsed?.type) return ix.parsed.type;
  return undefined;
}

function toNode(ix: ParsedInstruction, index: string, depth: number, failed: boolean): TraceNode {
  return {
    index,
    programId: ix.programId,
    programName: programName(ix.programId, ix.program),
    instructionName: instructionName(ix),
    failed,
    depth,
    children: [],
  };
}

/** Precompiles are verified before execution and never log an invoke line. */
const SILENT_PROGRAMS = new Set([
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
]);

interface Invocation {
  programId: string;
  failed: boolean;
}

/**
 * Replay the runtime's own bookkeeping. Every program call logs "invoke [depth]" and then
 * either "success" or "failed", so the log is an exact record of which calls failed.
 * Returns calls in execution order, or null when the log was truncated and cannot be trusted.
 */
function invocationsFromLogs(logs: string[]): Invocation[] | null {
  const calls: Invocation[] = [];
  const stack: Invocation[] = [];
  for (const line of logs) {
    if (line.startsWith("Log truncated")) return null;
    const invoke = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/);
    if (invoke) {
      const call = { programId: invoke[1], failed: false };
      calls.push(call);
      stack.push(call);
      continue;
    }
    const end = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed)/);
    if (end && stack.length > 0 && stack[stack.length - 1].programId === end[1]) {
      const call = stack.pop() as Invocation;
      if (end[2] === "failed") call.failed = true;
    }
  }
  return calls;
}

/**
 * Build the instruction tree: outer instructions from the message, CPIs nested underneath
 * via meta.innerInstructions stackHeight. Failure marks come from the log replay, so a call
 * that completed before its sibling failed is never implicated. When the log is truncated
 * we fall back to marking by program id along the failing outer instruction.
 */
function buildTree(
  tx: RpcTransaction,
  failedOuterIndex: number | null,
  failedPrograms: Set<string>,
  logs: string[],
): TraceNode[] {
  const inner = new Map<number, ParsedInstruction[]>();
  for (const group of tx.meta.innerInstructions ?? []) {
    inner.set(group.index, group.instructions);
  }

  const ordered: TraceNode[] = []; // execution (pre-order) sequence, for matching against the log
  const roots = tx.transaction.message.instructions.map((ix, i) => {
    const outerFailed = failedOuterIndex === i;
    const root = toNode(ix, String(i + 1), 0, outerFailed);
    ordered.push(root);

    const stack: TraceNode[] = [root];
    for (const cpi of inner.get(i) ?? []) {
      const height = cpi.stackHeight ?? 2; // depth 1 == stackHeight 2
      const depth = Math.max(1, height - 1);
      while (stack.length > depth) stack.pop();
      while (stack.length < depth) {
        const last = stack[stack.length - 1].children.at(-1);
        if (!last) break;
        stack.push(last);
      }
      const parent = stack[stack.length - 1];
      const failed = outerFailed && failedPrograms.has(cpi.programId);
      const node = toNode(cpi, `${parent.index}.${parent.children.length + 1}`, stack.length, failed);
      parent.children.push(node);
      ordered.push(node);
    }
    return root;
  });

  // Precise pass: align executed calls with the tree, in order.
  const calls = invocationsFromLogs(logs);
  if (calls && calls.length > 0) {
    const executable = ordered.filter((n) => !SILENT_PROGRAMS.has(n.programId));
    const aligned = calls.every((c, i) => executable[i]?.programId === c.programId);
    if (aligned) {
      for (const n of ordered) n.failed = false;
      calls.forEach((c, i) => {
        executable[i].failed = c.failed;
      });
    }
  }
  return roots;
}

/** Confirmed transactions never change, so the response is cached for a day. */
async function fetchTransaction(url: string, signature: string): Promise<RpcTransaction | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
      ],
    }),
    next: { revalidate: 86400 },
  });
  if (!res.ok) throw new Error(`RPC responded ${res.status}`);
  const { result } = (await res.json()) as { result: RpcTransaction | null };
  return result;
}

export async function getTrace(signature: string): Promise<Trace | null> {
  // The fast endpoint keeps only recent history. Older signatures are found on the history endpoint.
  let result = await fetchTransaction(RPC_URL, signature).catch((e) => {
    if (FALLBACK_URL === RPC_URL) throw e;
    return null;
  });
  if (!result && FALLBACK_URL !== RPC_URL) result = await fetchTransaction(FALLBACK_URL, signature);
  if (!result) return null;

  const err = result.meta.err;
  let failedOuterIndex: number | null = null;
  if (err && typeof err === "object" && "InstructionError" in err) {
    failedOuterIndex = (err as { InstructionError: [number, unknown] }).InstructionError[0];
  }

  const logs = result.meta.logMessages ?? [];
  const { failedPrograms, innermostFailedProgram } = failureInfoFromLogs(logs);

  // The program to decode against: the innermost failure when CPIs are involved,
  // falling back to the outer instruction's program.
  const failedProgramId =
    innermostFailedProgram ??
    (failedOuterIndex != null
      ? (result.transaction.message.instructions[failedOuterIndex]?.programId ?? null)
      : null);

  // Layer 2: the failing program's on-chain Anchor IDL, when published.
  const idlErrors =
    err != null && failedProgramId ? await fetchIdlErrors(failedProgramId) : null;

  return {
    signature,
    slot: result.slot,
    blockTime: result.blockTime,
    success: err == null,
    feeLamports: result.meta.fee,
    failedOuterIndex,
    error: decodeTransactionError(err, failedProgramId, logs, idlErrors),
    logs,
    tree: buildTree(result, failedOuterIndex, failedPrograms, logs),
  };
}
