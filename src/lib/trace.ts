import { decodeTransactionError } from "./errors";
import { fetchIdlErrors } from "./idl";
import { programName } from "./programs";
import type { Trace, TraceNode } from "./types";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

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
  const matches = input.trim().match(/[1-9A-HJ-NP-Za-km-z]{80,90}/g);
  if (!matches) return null;
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
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

/**
 * Build the instruction tree: outer instructions from the message,
 * CPIs nested underneath via meta.innerInstructions stackHeight.
 * Failure marking follows the log-derived failure path, so a CPI that
 * completed before its sibling failed is not falsely implicated.
 */
function buildTree(
  tx: RpcTransaction,
  failedOuterIndex: number | null,
  failedPrograms: Set<string>,
): TraceNode[] {
  const inner = new Map<number, ParsedInstruction[]>();
  for (const group of tx.meta.innerInstructions ?? []) {
    inner.set(group.index, group.instructions);
  }

  return tx.transaction.message.instructions.map((ix, i) => {
    const outerFailed = failedOuterIndex === i;
    const root = toNode(ix, String(i + 1), 0, outerFailed);

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
    }
    return root;
  });
}

export async function getTrace(signature: string): Promise<Trace | null> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ],
    }),
    next: { revalidate: 86400 }, // confirmed transactions are immutable
  });
  if (!res.ok) throw new Error(`RPC responded ${res.status}`);
  const { result } = (await res.json()) as { result: RpcTransaction | null };
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
    tree: buildTree(result, failedOuterIndex, failedPrograms),
  };
}
