import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { decodeTransactionError } from "@/lib/errors";
import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { RepairInputError, repair } from "@/lib/repair";
import { track } from "@/lib/stats";
import { extractSignature, getTrace } from "@/lib/trace";

export const maxDuration = 30;

/**
 * TxWhy as an MCP server (Streamable HTTP, stateless).
 * Any MCP-capable agent can add https://txwhy.vercel.app/api/mcp and call these tools
 * inside its own send loop. Nothing here ever receives a private key: transactions go
 * in unsigned or already signed, and always come back unsigned.
 */

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "repair_transaction",
      {
        title: "Repair a Solana transaction",
        description:
          "Give it a Solana transaction that failed, or one you are about to send. It finds the cause and returns a rebuilt UNSIGNED transaction that has been simulated against live mainnet state to prove it passes. Fixes expired blockhashes, compute-unit limits, priority fees, loaded-data limits, and slippage on plain Jupiter swaps (fresh quote, same tolerance). Handles legacy, v0 and version 1 (SIMD-0385) transactions and durable nonces. When the failure cannot be fixed by rebuilding (not enough funds, a private program's own error), it says so and explains why instead of returning something that would fail again. Pass exactly one of `transaction` or `signature`. Sign the returned transaction with your own key and send it within about 60 seconds.",
        inputSchema: z.object({
          transaction: z
            .string()
            .optional()
            .describe("Base64 serialized transaction, signed or unsigned. Use this before sending, or after a send failed."),
          signature: z
            .string()
            .optional()
            .describe("Signature (or explorer URL) of a transaction that already landed on mainnet and failed."),
        }),
      },
      async ({ transaction, signature }) => {
        if (!transaction && !signature) return failure('Pass either "transaction" or "signature".');
        const sig = signature ? extractSignature(signature) : null;
        if (signature && !sig) return failure("That does not look like a transaction signature.");
        try {
          const result = await repair({ transaction, signature: sig ?? undefined });
          await track({ kind: "repair", channel: "mcp", status: result.status, errorTitle: result.cause?.title });
          return text(result);
        } catch (e) {
          if (e instanceof RepairInputError) return failure(e.message);
          return failure(`Repair failed: ${e instanceof Error ? e.message : "unexpected error"}. Safe to retry.`);
        }
      },
    );

    server.registerTool(
      "diagnose_transaction",
      {
        title: "Diagnose a failed Solana transaction",
        description:
          "Explains why a transaction that landed on mainnet failed: the exact failing instruction in the call tree, the named error, its cause, and how to fix it. Read-only and fast. Use repair_transaction when you want a working transaction back.",
        inputSchema: z.object({
          signature: z.string().describe("Transaction signature or explorer URL."),
        }),
      },
      async ({ signature }) => {
        const sig = extractSignature(signature);
        if (!sig) return failure("That does not look like a transaction signature.");
        try {
          const trace = await getTrace(sig);
          if (!trace) return failure("Transaction not found on mainnet.");
          await track({ kind: "diagnosis", channel: "mcp", errorTitle: trace.error?.title });
          const failedPath: string[] = [];
          const walk = (nodes: typeof trace.tree) => {
            for (const n of nodes) {
              if (n.failed) {
                failedPath.push(`#${n.index} ${n.programName}${n.instructionName ? " " + n.instructionName : ""}`);
                walk(n.children);
              }
            }
          };
          walk(trace.tree);
          return text({
            signature: sig,
            success: trace.success,
            slot: trace.slot,
            feeLamports: trace.feeLamports,
            error: trace.error,
            failedPath,
            permalink: `https://txwhy.vercel.app/tx/${sig}`,
          });
        } catch (e) {
          return failure(`Could not fetch the transaction: ${e instanceof Error ? e.message : "RPC error"}.`);
        }
      },
    );

    server.registerTool(
      "explain_error",
      {
        title: "Explain a Solana program error code",
        description:
          "Looks up what a custom program error code means for a given program, using 1,800+ named errors from major Solana programs plus the runtime's own errors. Use it when you only have a code such as 6001 or 0x1771 from a simulation or an RPC response.",
        inputSchema: z.object({
          programId: z.string().describe("Base58 address of the program that raised the error."),
          code: z.union([z.number().int(), z.string()]).describe("Error code as a number, or a hex string like 0x1771."),
        }),
      },
      async ({ programId, code }) => {
        const n = typeof code === "number" ? code : Number(code.trim().startsWith("0x") ? parseInt(code, 16) : code);
        if (!Number.isInteger(n) || n < 0) return failure("code must be a non-negative integer or a hex string.");
        return text(decodeTransactionError({ InstructionError: [0, { Custom: n }] }, programId, [], null));
      },
    );
  },
  {
    serverInfo: { name: "txwhy", version: "0.2.0" },
  },
);

/** An MCP tool call carries at most one base64 transaction, so anything past this is not a real client. */
const MAX_BODY = 16_384;

function limited(request: Request) {
  const limit = rateLimit(request, "mcp", 60);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
    return Response.json({ error: `Body too large (limit ${MAX_BODY} bytes).` }, { status: 413 });
  }
  return handler(request);
}

export { limited as GET, limited as POST };
