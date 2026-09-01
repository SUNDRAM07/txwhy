import type { DecodedError } from "./types";

/**
 * Layer 3 knowledge base — error pattern → { cause, fix }.
 * Seeded from the six-category failure taxonomy
 * (account / balance / timing / program / provider / size).
 */

/** Transaction-level errors (meta.err as a plain string). */
const TX_ERRORS: Record<string, DecodedError> = {
  AccountNotFound: {
    title: "Account not found",
    cause:
      "The transaction references an account that does not exist on chain — often a token account that was never created, or an account closed before this transaction landed.",
    fix: "Verify every account address. If it is an associated token account, create it first (createAssociatedTokenAccountInstruction) or use an idempotent create.",
  },
  InsufficientFundsForFee: {
    title: "Insufficient SOL for the fee",
    cause: "The fee payer does not hold enough SOL to cover the transaction fee.",
    fix: "Top up the fee payer with SOL. Keep a buffer — priority fees raise the total beyond the base 5000 lamports per signature.",
  },
  InsufficientFundsForRent: {
    title: "Insufficient funds for rent",
    cause: "An account would drop below the rent-exempt minimum after this transaction.",
    fix: "Leave at least the rent-exempt minimum in the account (getMinimumBalanceForRentExemption), or close the account properly to reclaim lamports.",
  },
  BlockhashNotFound: {
    title: "Blockhash expired",
    cause:
      "The recent blockhash attached to the transaction is no longer valid — too much time passed between building and submitting (roughly 60–90 seconds).",
    fix: "Fetch a fresh blockhash right before sending, and implement retry-with-refresh on send failure.",
  },
  AlreadyProcessed: {
    title: "Duplicate transaction",
    cause: "A transaction with the same signature has already been processed — usually a client retrying with the same blockhash.",
    fix: "Treat as success if the original landed; otherwise rebuild with a fresh blockhash to get a new signature.",
  },
  AccountInUse: {
    title: "Account locked by another transaction",
    cause: "Another in-flight transaction holds a write lock on one of these accounts.",
    fix: "Retry with backoff. For hot accounts, serialize your writes or use durable nonces.",
  },
  WouldExceedMaxAccountCostLimit: {
    title: "Account compute cost limit exceeded",
    cause: "This block already saturated the write-cost limit for one of the accounts (a congested hot account).",
    fix: "Retry, add a priority fee (ComputeBudgetProgram.setComputeUnitPrice), or route around the hot account.",
  },
  ProgramAccountNotFound: {
    title: "Program not found",
    cause: "The target program ID does not exist on this cluster.",
    fix: "Confirm you are on the right cluster (mainnet vs devnet) and the program ID is correct.",
  },
};

/** Instruction-level error variants (meta.err.InstructionError[1] as a string). */
const IX_ERRORS: Record<string, DecodedError> = {
  InsufficientFunds: {
    title: "Insufficient funds",
    cause: "The source account does not hold enough lamports or tokens for the operation.",
    fix: "Check the balance before building the transaction; remember token amounts are in base units (respect decimals).",
  },
  InvalidAccountData: {
    title: "Invalid account data",
    cause:
      "An account's data does not match what the program expects — wrong account passed, uninitialized account, or an account owned by a different program.",
    fix: "Verify account order and derivation (PDAs, ATAs). Compare each account against the program's expected schema.",
  },
  AccountAlreadyInitialized: {
    title: "Account already initialized",
    cause: "An init instruction targeted an account that already exists.",
    fix: "Use an idempotent create variant, or check existence first and skip the init.",
  },
  UninitializedAccount: {
    title: "Account not initialized",
    cause: "The instruction requires an initialized account but got a fresh or empty one.",
    fix: "Initialize the account first (e.g. create the token account before transferring to it).",
  },
  MissingRequiredSignature: {
    title: "Missing required signature",
    cause: "An account that must sign this instruction did not sign the transaction.",
    fix: "Add the missing signer keypair, or fix the PDA seeds if the program should sign via invoke_signed.",
  },
  InvalidArgument: {
    title: "Invalid argument",
    cause: "An instruction argument failed the program's validation.",
    fix: "Check the instruction data encoding and each argument's range and format against the program's interface.",
  },
  ComputationalBudgetExceeded: {
    title: "Compute budget exceeded",
    cause: "The transaction ran out of compute units before completing.",
    fix: "Request more units via ComputeBudgetProgram.setComputeUnitLimit (up to 1.4M), or split the work across transactions.",
  },
  ProgramFailedToComplete: {
    title: "Program failed to complete",
    cause: "The program aborted mid-execution (panic, or exceeded limits).",
    fix: "Read the program logs above the failure for the panic message; test the same call on devnet with logging.",
  },
  AccountNotExecutable: {
    title: "Account not executable",
    cause: "A CPI targeted an account that is not a program.",
    fix: "Check the program ID passed to the CPI — a data account was supplied where a program was expected.",
  },
  PrivilegeEscalation: {
    title: "Privilege escalation",
    cause: "A CPI tried to use a signer or writable privilege the caller did not have.",
    fix: "Ensure the outer instruction marks the account as signer or writable, or sign via the correct PDA seeds.",
  },
};

/** Anchor framework error codes (stable, published). */
const ANCHOR_ERRORS: Record<number, DecodedError> = {
  100: {
    title: "InstructionMissing",
    cause: "8-byte instruction discriminator not found.",
    fix: "Call a real instruction on this program — likely wrong instruction data or wrong program.",
  },
  101: {
    title: "InstructionFallbackNotFound",
    cause: "Fallback handler not found for unrecognized instruction.",
    fix: "The instruction discriminator does not match any handler — check IDL or client version drift.",
  },
  2000: {
    title: "ConstraintMut",
    cause: "An account expected to be mutable was passed read-only.",
    fix: "Mark the account writable in the client (isWritable: true).",
  },
  2001: {
    title: "ConstraintHasOne",
    cause: "A has_one constraint failed — a referenced account does not match the field stored on the state account.",
    fix: "Pass the exact account recorded on the state (e.g. the correct authority or owner).",
  },
  2002: {
    title: "ConstraintSigner",
    cause: "An account expected to sign did not.",
    fix: "Add the account as a signer in the transaction.",
  },
  2003: {
    title: "ConstraintRaw",
    cause: "A raw constraint expression evaluated false.",
    fix: "Read the program source for the constraint on this instruction and satisfy it.",
  },
  2006: {
    title: "ConstraintSeeds",
    cause: "PDA seeds do not match the expected derivation.",
    fix: "Recompute the PDA with the program's exact seed order and bump.",
  },
  2012: {
    title: "ConstraintAddress",
    cause: "An account address does not equal the expected constant address.",
    fix: "Pass the exact address the program expects for this account slot.",
  },
  3007: {
    title: "AccountOwnedByWrongProgram",
    cause: "The account is owned by a different program than expected.",
    fix: "Pass an account created or owned by the expected program — commonly the wrong token program (Token vs Token-2022).",
  },
  3012: {
    title: "AccountNotInitialized",
    cause: "The account has no data — it was never initialized by the expected program.",
    fix: "Run the init instruction first, or derive the correct existing account.",
  },
};

/** SPL Token program custom error codes. */
const TOKEN_ERRORS: Record<number, DecodedError> = {
  0: {
    title: "NotRentExempt",
    cause: "Lamport balance below rent-exempt minimum.",
    fix: "Fund the account to the rent-exempt minimum.",
  },
  1: {
    title: "InsufficientFunds",
    cause: "The token account holds fewer tokens than the instruction needs.",
    fix: "Check the token balance in base units (respect mint decimals) before sending.",
  },
  2: {
    title: "InvalidMint",
    cause: "The mint account is not valid.",
    fix: "Verify the mint address and that it was created by the token program in use.",
  },
  3: {
    title: "MintMismatch",
    cause: "A token account belongs to a different mint than expected.",
    fix: "Pass token accounts whose mint matches the instruction's mint.",
  },
  4: {
    title: "OwnerMismatch",
    cause: "The owner of the token account does not match the signer or authority.",
    fix: "Use the account's real owner as the authority, or the correct delegate.",
  },
  6: {
    title: "AlreadyInUse",
    cause: "The account is already initialized.",
    fix: "Use createAssociatedTokenAccountIdempotent or skip the create.",
  },
  9: {
    title: "UninitializedState",
    cause: "The account is not initialized.",
    fix: "Create and initialize the token account first.",
  },
  17: {
    title: "AccountFrozen",
    cause: "The token account is frozen by the mint's freeze authority.",
    fix: "Only the freeze authority can thaw it — contact the token issuer.",
  },
};

const ANCHOR_LOG_RE =
  /AnchorError (?:thrown in .+?:\d+|occurred)\. Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/;

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

function decodeCustom(code: number, failedProgramId: string | null, logs: string[]): DecodedError {
  // Layer 2b — the log parser catches Anchor's own explanation when present.
  for (const line of logs) {
    const m = line.match(ANCHOR_LOG_RE);
    if (m && Number(m[2]) === code) {
      const kb = ANCHOR_ERRORS[code];
      return {
        title: m[1],
        code: `Custom(${code})`,
        cause: m[3],
        fix: kb
          ? kb.fix
          : "Search the program's source or IDL for this error name to see the exact constraint that failed.",
      };
    }
  }
  if (failedProgramId && TOKEN_PROGRAMS.has(failedProgramId) && TOKEN_ERRORS[code]) {
    return { ...TOKEN_ERRORS[code], code: `Custom(${code}) — 0x${code.toString(16)}` };
  }
  if (ANCHOR_ERRORS[code]) {
    return { ...ANCHOR_ERRORS[code], code: `Custom(${code}) — 0x${code.toString(16)}` };
  }
  if (code >= 6000) {
    return {
      title: `Program-defined error ${code} (0x${code.toString(16)})`,
      code: `Custom(${code})`,
      cause: "An Anchor program raised its own error code (6000+). The exact name lives in the program's IDL.",
      fix: `Look up code ${code} in the program's IDL errors section. Common culprits at 6000/6001 in AMMs: slippage tolerance exceeded — retry with a higher slippage or smaller size.`,
    };
  }
  return {
    title: `Custom error ${code} (0x${code.toString(16)})`,
    code: `Custom(${code})`,
    cause: "The program returned a custom error code that is not yet in the TxWhy knowledge base.",
    fix: "Check the program's documentation or source for this code — and open an issue on TxWhy so we add it.",
  };
}

export function decodeTransactionError(
  err: unknown,
  failedProgramId: string | null,
  logs: string[],
): DecodedError | null {
  if (err == null) return null;

  if (typeof err === "string") {
    const known = TX_ERRORS[err];
    if (known) return known;
    return {
      title: err,
      cause: "Transaction-level failure before or during execution.",
      fix: "Check cluster status and transaction construction; this code is not yet in the TxWhy knowledge base.",
    };
  }

  if (typeof err === "object" && "InstructionError" in (err as Record<string, unknown>)) {
    const ie = (err as { InstructionError: [number, unknown] }).InstructionError;
    const detail = ie[1];
    if (typeof detail === "string") {
      const known = IX_ERRORS[detail];
      if (known) return known;
      return {
        title: detail,
        cause: "The failing instruction returned this program error.",
        fix: "Check the program logs for detail; this code is not yet in the TxWhy knowledge base.",
      };
    }
    if (typeof detail === "object" && detail !== null && "Custom" in detail) {
      return decodeCustom((detail as { Custom: number }).Custom, failedProgramId, logs);
    }
  }

  return {
    title: "Unrecognized error",
    cause: JSON.stringify(err),
    fix: "Open an issue on TxWhy with this transaction signature so we can add coverage.",
  };
}
