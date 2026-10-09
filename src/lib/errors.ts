import PROGRAM_ERRORS from "./data/program-errors.json";
import type { IdlErrorEntry } from "./idl";
import { isNamedProgram, programName } from "./programs";
import { LIGHTHOUSE, lighthouseCause } from "./lighthouse";
import type { DecodedError } from "./types";

/**
 * Layer 3 knowledge base — error pattern → { cause, fix }.
 * Organized around the six-category failure taxonomy:
 * account / balance / timing / program / provider / size.
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
  AccountLoadedTwice: {
    title: "Account loaded twice",
    cause: "The same account appears twice in the transaction's account list.",
    fix: "Deduplicate the account keys when composing the transaction message.",
  },
  TooManyAccountLocks: {
    title: "Too many account locks",
    cause: "The transaction locks more accounts than the runtime allows (64 for legacy, 128 with lookup tables).",
    fix: "Split the work across transactions or move addresses into an address lookup table.",
  },
  WouldExceedMaxAccountCostLimit: {
    title: "Account compute cost limit exceeded",
    cause: "This block already saturated the write-cost limit for one of the accounts (a congested hot account).",
    fix: "Retry, add a priority fee (ComputeBudgetProgram.setComputeUnitPrice), or route around the hot account.",
  },
  WouldExceedMaxBlockCostLimit: {
    title: "Block cost limit exceeded",
    cause: "The transaction did not fit in the block's total compute budget during congestion.",
    fix: "Retry with a priority fee and, if possible, reduce the transaction's compute usage.",
  },
  WouldExceedMaxVoteCostLimit: {
    title: "Vote cost limit exceeded",
    cause: "Block vote-cost budget was exhausted.",
    fix: "Retry — this is congestion at the block producer, not a bug in your transaction.",
  },
  WouldExceedAccountDataBlockLimit: {
    title: "Account data block limit exceeded",
    cause: "The block's account-data load budget was exhausted.",
    fix: "Retry with a priority fee; consider loading fewer/lighter accounts.",
  },
  MaxLoadedAccountsDataSizeExceeded: {
    title: "Loaded accounts data size exceeded",
    cause: "The transaction loads more account data than its declared limit (default 64MB).",
    fix: "Raise the limit with ComputeBudgetProgram.setLoadedAccountsDataSizeLimit, or reference fewer heavy accounts.",
  },
  DuplicateInstruction: {
    title: "Duplicate instruction",
    cause: "The runtime rejected a duplicate instruction it requires to be unique (e.g. two identical ComputeBudget instructions).",
    fix: "Include each ComputeBudget instruction type at most once per transaction.",
  },
  InvalidRentPayingAccount: {
    title: "Rent-paying account not allowed",
    cause: "The transaction would create or leave an account in a rent-paying state — no longer allowed.",
    fix: "Fund new accounts to the full rent-exempt minimum.",
  },
  SanitizeFailure: {
    title: "Transaction failed sanitization",
    cause: "The message is structurally invalid — bad indexes, malformed header, or inconsistent account list.",
    fix: "Rebuild the transaction with a maintained SDK rather than hand-crafting the message bytes.",
  },
  SignatureFailure: {
    title: "Signature verification failed",
    cause: "One of the signatures does not verify against its public key and the message bytes.",
    fix: "Re-sign after any mutation of the message — signing must be the last step before sending.",
  },
  UnsupportedVersion: {
    title: "Unsupported transaction version",
    cause: "The node does not accept this transaction version.",
    fix: "Use legacy or v0 transactions; when fetching, pass maxSupportedTransactionVersion: 0.",
  },
  InvalidProgramForExecution: {
    title: "Invalid program for execution",
    cause: "A program account in the transaction is not executable (closed, not deployed on this cluster, or mid-upgrade).",
    fix: "Verify the program ID on this cluster and retry if the program was upgrading.",
  },
  ProgramAccountNotFound: {
    title: "Program not found",
    cause: "The target program ID does not exist on this cluster.",
    fix: "Confirm you are on the right cluster (mainnet vs devnet) and the program ID is correct.",
  },
  AddressLookupTableNotFound: {
    title: "Address lookup table not found",
    cause: "A v0 transaction references a lookup table account that does not exist.",
    fix: "Verify the lookup table address and that it is active on this cluster.",
  },
  InvalidAddressLookupTableData: {
    title: "Invalid address lookup table data",
    cause: "The referenced lookup table account exists but its data is invalid or deactivated.",
    fix: "Recreate or re-extend the lookup table; wait one slot after extension before use.",
  },
  InvalidAddressLookupTableIndex: {
    title: "Invalid address lookup table index",
    cause: "The transaction indexes past the end of the lookup table.",
    fix: "Rebuild the transaction against the current table contents — the table may have been shorter than the client assumed.",
  },
  ProgramExecutionTemporarilyRestricted: {
    title: "Program temporarily restricted",
    cause: "The program is temporarily blocked from executing (usually mid-upgrade in this slot).",
    fix: "Retry in a few slots.",
  },
  ClusterMaintenance: {
    title: "Cluster maintenance",
    cause: "The cluster is in a maintenance window and rejecting transactions.",
    fix: "Wait and retry; check cluster status feeds.",
  },
};

/** Instruction-level error variants (meta.err.InstructionError[1] as a string). */
const IX_ERRORS: Record<string, DecodedError> = {
  GenericError: {
    title: "Generic program error",
    cause: "The program returned a nonspecific failure.",
    fix: "Read the program logs above the failure line — the real reason is usually printed there.",
  },
  InvalidArgument: {
    title: "Invalid argument",
    cause: "An instruction argument failed the program's validation.",
    fix: "Check the instruction data encoding and each argument's range and format against the program's interface.",
  },
  InvalidInstructionData: {
    title: "Invalid instruction data",
    cause: "The program could not parse the instruction data — wrong discriminator, wrong layout, or truncated bytes.",
    fix: "Regenerate the client from the program's current IDL; version drift between client and program is the usual cause.",
  },
  InvalidAccountData: {
    title: "Invalid account data",
    cause:
      "An account's data does not match what the program expects — wrong account passed, uninitialized account, or an account owned by a different program.",
    fix: "Verify account order and derivation (PDAs, ATAs). Compare each account against the program's expected schema.",
  },
  AccountDataTooSmall: {
    title: "Account data too small",
    cause: "The account's data buffer is smaller than the program requires.",
    fix: "Allocate the account with the correct size, or realloc before writing.",
  },
  InsufficientFunds: {
    title: "Insufficient funds",
    cause: "The source account does not hold enough lamports or tokens for the operation.",
    fix: "Check the balance before building the transaction; remember token amounts are in base units (respect decimals).",
  },
  IncorrectProgramId: {
    title: "Incorrect program ID",
    cause: "An account is owned by a different program than the instruction expects.",
    fix: "Common with Token vs Token-2022 mismatches — pass the token program that actually owns the accounts involved.",
  },
  MissingRequiredSignature: {
    title: "Missing required signature",
    cause: "An account that must sign this instruction did not sign the transaction.",
    fix: "Add the missing signer keypair, or fix the PDA seeds if the program should sign via invoke_signed.",
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
  UnbalancedInstruction: {
    title: "Unbalanced instruction",
    cause: "Lamports were created or destroyed — total lamports before and after the instruction differ.",
    fix: "Program bug: every debit must have a matching credit. Audit lamport arithmetic in the program.",
  },
  ModifiedProgramId: {
    title: "Modified program ID",
    cause: "The instruction tried to change an account's owner illegally.",
    fix: "Only the current owner program may reassign ownership, and only for accounts it owns with zeroed data.",
  },
  ExternalAccountLamportSpend: {
    title: "External account lamport spend",
    cause: "The program spent lamports from an account it does not own.",
    fix: "Move lamports out of foreign accounts via CPI to the owning program (e.g. System transfer), not directly.",
  },
  ExternalAccountDataModified: {
    title: "External account data modified",
    cause: "The program wrote to the data of an account it does not own.",
    fix: "Only the owner program can mutate account data — route the change through the owner via CPI.",
  },
  ReadonlyLamportChange: {
    title: "Read-only account lamports changed",
    cause: "A read-only account's balance changed during the instruction.",
    fix: "Mark the account writable in the transaction if the program needs to credit/debit it.",
  },
  ReadonlyDataModified: {
    title: "Read-only account data modified",
    cause: "A read-only account's data changed during the instruction.",
    fix: "Mark the account writable in the transaction message.",
  },
  ExecutableModified: {
    title: "Executable flag modified",
    cause: "The instruction tried to flip an account's executable flag outside the loader.",
    fix: "Deploy/upgrade through the BPF loader; programs cannot set this flag themselves.",
  },
  RentEpochModified: {
    title: "Rent epoch modified",
    cause: "The instruction tried to modify an account's rent epoch — not allowed.",
    fix: "Remove whatever writes rent_epoch; it is runtime-managed.",
  },
  NotEnoughAccountKeys: {
    title: "Not enough account keys",
    cause: "The instruction received fewer accounts than the program requires.",
    fix: "Compare your account list against the program's interface — one or more accounts are missing.",
  },
  AccountBorrowFailed: {
    title: "Account borrow failed",
    cause: "The program tried to borrow account data already borrowed mutably (double borrow).",
    fix: "Program bug: drop the first borrow before taking the second, or restructure to avoid aliasing the same account.",
  },
  AccountBorrowOutstanding: {
    title: "Account borrow outstanding",
    cause: "A CPI was made while still holding a mutable borrow of an account the callee also needs.",
    fix: "Release (drop) account borrows before invoking the CPI.",
  },
  DuplicateAccountOutOfSync: {
    title: "Duplicate account out of sync",
    cause: "The same account was passed twice to a CPI and the copies diverged.",
    fix: "Avoid passing the same account under two roles in one instruction.",
  },
  UnsupportedProgramId: {
    title: "Unsupported program ID",
    cause: "The runtime cannot execute this program ID (not a recognized loader/builtin).",
    fix: "Check the program was deployed with a supported loader on this cluster.",
  },
  CallDepth: {
    title: "CPI call depth exceeded",
    cause: "The CPI chain went deeper than the runtime's limit (4 levels).",
    fix: "Flatten the call chain — restructure so intermediate programs are not needed.",
  },
  ReentrancyNotAllowed: {
    title: "Reentrancy not allowed",
    cause: "A program appeared twice in the CPI stack (A → B → A). Only direct self-recursion is permitted.",
    fix: "Restructure the flow so control does not re-enter a program through an intermediary.",
  },
  MaxSeedLengthExceeded: {
    title: "PDA seed too long",
    cause: "A seed passed to PDA derivation exceeds 32 bytes, or too many seeds were given.",
    fix: "Keep each seed ≤ 32 bytes (hash longer values) and at most 16 seeds.",
  },
  InvalidSeeds: {
    title: "Invalid PDA seeds",
    cause: "The seeds do not derive the given address — wrong seed values, order, or bump.",
    fix: "Recompute with findProgramAddress using the program's exact seed schema; pass the canonical bump.",
  },
  InvalidRealloc: {
    title: "Invalid realloc",
    cause: "Account reallocation exceeded the per-instruction growth limit (10KB) or shrank below data in use.",
    fix: "Grow accounts across multiple instructions, 10KB at a time.",
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
  ProgramFailedToCompile: {
    title: "Program failed to compile",
    cause: "The program's bytecode failed verification/JIT.",
    fix: "Redeploy the program built with a current toolchain.",
  },
  Immutable: {
    title: "Account is immutable",
    cause: "The instruction tried to modify an immutable account.",
    fix: "This account can never be written — remove the write or target the right account.",
  },
  IncorrectAuthority: {
    title: "Incorrect authority",
    cause: "The provided authority does not match the account's actual authority.",
    fix: "Pass the authority recorded on the account (check with getAccountInfo), and have it sign.",
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
  ArithmeticOverflow: {
    title: "Arithmetic overflow",
    cause: "A checked arithmetic operation in the program overflowed.",
    fix: "Reduce the amounts involved; if you own the program, audit the math around this instruction.",
  },
  MaxAccountsDataAllocationsExceeded: {
    title: "Max data allocations exceeded",
    cause: "The transaction allocated more new account data than allowed.",
    fix: "Create fewer/smaller accounts per transaction.",
  },
  MaxInstructionTraceLengthExceeded: {
    title: "Instruction trace length exceeded",
    cause: "Too many instructions (outer + CPI) executed in one transaction.",
    fix: "Split the flow into multiple transactions.",
  },
  BuiltinProgramsMustConsumeComputeUnits: {
    title: "Builtin must consume compute units",
    cause: "Runtime invariant on builtin programs was violated.",
    fix: "Usually transient/runtime-level — retry, and report if persistent.",
  },
};

/** Anchor framework error codes (stable, published). */
export const ANCHOR_ERRORS: Record<number, DecodedError> = {
  100: { title: "InstructionMissing", cause: "8-byte instruction discriminator not found.", fix: "Call a real instruction on this program — likely wrong instruction data or wrong program." },
  101: { title: "InstructionFallbackNotFound", cause: "Fallback handler not found for unrecognized instruction.", fix: "The instruction discriminator does not match any handler — check IDL or client version drift." },
  102: { title: "InstructionDidNotDeserialize", cause: "The instruction data failed to deserialize into the expected arguments.", fix: "Regenerate the client from the current IDL — argument layout drifted." },
  2000: { title: "ConstraintMut", cause: "An account expected to be mutable was passed read-only.", fix: "Mark the account writable in the client (isWritable: true)." },
  2001: { title: "ConstraintHasOne", cause: "A has_one constraint failed — a referenced account does not match the field stored on the state account.", fix: "Pass the exact account recorded on the state (e.g. the correct authority or owner)." },
  2002: { title: "ConstraintSigner", cause: "An account expected to sign did not.", fix: "Add the account as a signer in the transaction." },
  2003: { title: "ConstraintRaw", cause: "A raw constraint expression evaluated false.", fix: "Read the program source for the constraint on this instruction and satisfy it." },
  2004: { title: "ConstraintOwner", cause: "An account's owner does not match the constraint.", fix: "Pass an account owned by the expected program (watch for Token vs Token-2022)." },
  2005: { title: "ConstraintRentExempt", cause: "The account is not rent-exempt.", fix: "Fund the account to the rent-exempt minimum for its size." },
  2006: { title: "ConstraintSeeds", cause: "PDA seeds do not match the expected derivation.", fix: "Recompute the PDA with the program's exact seed order and bump." },
  2007: { title: "ConstraintExecutable", cause: "An account expected to be a program is not executable.", fix: "Pass the program account, not a data account." },
  2009: { title: "ConstraintAssociated", cause: "Associated account constraint failed.", fix: "Derive the associated account (ATA) for the exact owner+mint pair the program expects." },
  2011: { title: "ConstraintClose", cause: "Close-target constraint failed.", fix: "The account being closed must not be the same as the destination for its lamports." },
  2012: { title: "ConstraintAddress", cause: "An account address does not equal the expected constant address.", fix: "Pass the exact address the program expects for this account slot." },
  2013: { title: "ConstraintZero", cause: "The account is expected to be zeroed but has data.", fix: "Pass a freshly created, never-used account." },
  2014: { title: "ConstraintTokenMint", cause: "The token account's mint does not match.", fix: "Pass a token account for the exact mint the instruction operates on." },
  2015: { title: "ConstraintTokenOwner", cause: "The token account's owner does not match.", fix: "Pass the token account owned by the expected wallet." },
  2019: { title: "ConstraintSpace", cause: "The account's size does not match the constraint.", fix: "Create the account with the exact space the program declares." },
  3000: { title: "AccountDiscriminatorAlreadySet", cause: "Init found the discriminator already set.", fix: "The account is already initialized — skip the init or use a fresh account." },
  3001: { title: "AccountDiscriminatorNotFound", cause: "No discriminator — the account was never initialized by this program.", fix: "Initialize the account first, or pass the correct existing account." },
  3002: { title: "AccountDiscriminatorMismatch", cause: "The account holds a different Anchor account type than expected.", fix: "You passed the wrong account (right program, wrong type). Check derivations." },
  3003: { title: "AccountDidNotDeserialize", cause: "The account data failed to deserialize into the expected type.", fix: "Account layout drift — verify program version and account address." },
  3005: { title: "AccountNotEnoughKeys", cause: "Fewer accounts supplied than the instruction context requires.", fix: "Regenerate the client from the IDL so the account list matches." },
  3006: { title: "AccountNotMutable", cause: "An account that must be writable was passed read-only.", fix: "Mark it writable in the transaction." },
  3007: { title: "AccountOwnedByWrongProgram", cause: "The account is owned by a different program than expected.", fix: "Pass an account created or owned by the expected program — commonly the wrong token program (Token vs Token-2022)." },
  3008: { title: "InvalidProgramId", cause: "A program account has an unexpected ID.", fix: "Pass the exact program the instruction expects (e.g. the right token program)." },
  3010: { title: "AccountNotSigner", cause: "The account did not sign.", fix: "Add it as a signer." },
  3011: { title: "AccountNotSystemOwned", cause: "The account is not owned by the System Program.", fix: "init needs a fresh system-owned account — this one already belongs to another program." },
  3012: { title: "AccountNotInitialized", cause: "The account has no data — it was never initialized by the expected program.", fix: "Run the init instruction first, or derive the correct existing account." },
  3014: { title: "AccountNotAssociatedTokenAccount", cause: "The account is not the canonical ATA for the owner+mint.", fix: "Derive with getAssociatedTokenAddress and pass that address." },
  4100: { title: "DeclaredProgramIdMismatch", cause: "The program's declare_id does not match its deployed address.", fix: "Program-side: fix declare_id! and redeploy. Client-side: you may be calling a fork at the wrong address." },
};

/** SPL Token program custom error codes. */
export const TOKEN_ERRORS: Record<number, DecodedError> = {
  0: { title: "NotRentExempt", cause: "Lamport balance below rent-exempt minimum.", fix: "Fund the account to the rent-exempt minimum." },
  1: { title: "InsufficientFunds", cause: "The token account holds fewer tokens than the instruction needs.", fix: "Check the token balance in base units (respect mint decimals) before sending." },
  2: { title: "InvalidMint", cause: "The mint account is not valid.", fix: "Verify the mint address and that it was created by the token program in use." },
  3: { title: "MintMismatch", cause: "A token account belongs to a different mint than expected.", fix: "Pass token accounts whose mint matches the instruction's mint." },
  4: { title: "OwnerMismatch", cause: "The owner of the token account does not match the signer or authority.", fix: "Use the account's real owner as the authority, or the correct delegate." },
  5: { title: "FixedSupply", cause: "This mint has no mint authority — supply is fixed.", fix: "You cannot mint more of this token." },
  6: { title: "AlreadyInUse", cause: "The account is already initialized.", fix: "Use createAssociatedTokenAccountIdempotent or skip the create." },
  7: { title: "InvalidNumberOfProvidedSigners", cause: "Multisig signer count is out of range.", fix: "Provide between 1 and 11 signers matching the multisig configuration." },
  8: { title: "InvalidNumberOfRequiredSigners", cause: "Required-signer count is out of range for the multisig.", fix: "Match the multisig account's m-of-n configuration." },
  9: { title: "UninitializedState", cause: "The account is not initialized.", fix: "Create and initialize the token account first." },
  10: { title: "NativeNotSupported", cause: "This instruction does not work on the native SOL wrapper account.", fix: "Unwrap (close) the wSOL account instead, or use a non-native token account." },
  11: { title: "NonNativeHasBalance", cause: "Attempted to close a token account that still holds tokens.", fix: "Transfer or burn the remaining balance before closing." },
  12: { title: "InvalidInstruction", cause: "The token program could not parse this instruction.", fix: "Client/program version drift — rebuild with a current SPL Token client." },
  13: { title: "InvalidState", cause: "The account is in an invalid state for this operation.", fix: "Check for frozen/uninitialized state before the operation." },
  14: { title: "Overflow", cause: "The operation would overflow the token amount (u64).", fix: "Reduce the amount — check for double-scaling by decimals in the client." },
  15: { title: "AuthorityTypeNotSupported", cause: "This authority type does not apply to this account.", fix: "Use a valid authority type for the target (mint vs account authorities differ)." },
  16: { title: "MintCannotFreeze", cause: "This mint has no freeze authority.", fix: "Freezing is impossible for this token." },
  17: { title: "AccountFrozen", cause: "The token account is frozen by the mint's freeze authority.", fix: "Only the freeze authority can thaw it — contact the token issuer." },
  18: { title: "MintDecimalsMismatch", cause: "The decimals argument does not match the mint's decimals.", fix: "Pass the mint's actual decimals (transferChecked and friends verify this)." },
  19: { title: "NonNativeNotSupported", cause: "This instruction only works on native (wSOL) accounts.", fix: "Use a wrapped-SOL account for this operation.", },
};

const ANCHOR_LOG_RE =
  /AnchorError (?:thrown in .+?:\d+|occurred)\. Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/;

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

/**
 * Layer 2c: bundled error tables for major programs that do not publish an IDL on chain
 * (Orca, Raydium, Meteora, Pump.fun, Drift, Metaplex and others). Extracted from the
 * MIT-licensed solana-idls dataset by tenequm. See src/lib/data/ATTRIBUTION.md.
 */
const BUNDLED = PROGRAM_ERRORS as unknown as Record<
  string,
  { name: string; errors: Record<string, string[]> }
>;

function bundledError(programId: string | null, code: number) {
  if (!programId) return null;
  const program = BUNDLED[programId];
  const hit = program?.errors[String(code)];
  if (!program || !hit) return null;
  return { program: program.name, name: hit[0], msg: hit[1] as string | undefined };
}

/** The System Program's own error enum. Its custom codes are small integers that look meaningless on their own. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SYSTEM_ERRORS: Record<number, DecodedError> = {
  0: { title: "Account already in use", cause: "The System Program was asked to create an account at an address that already exists.", fix: "Use a fresh address, or skip creation when the account is already there. For token accounts prefer the idempotent create instruction." },
  1: { title: "Insufficient SOL", cause: "A transfer or account creation needs more lamports than the source account holds.", fix: "Fund the source account or lower the amount. Remember rent for any account being created." },
  2: { title: "Invalid program id", cause: "The account was assigned to, or expected to be owned by, a different program.", fix: "Check the owner program passed when creating or assigning the account." },
  3: { title: "Invalid account data length", cause: "The requested account size is not allowed (too large, or not what the program expects).", fix: "Allocate exactly the size the owning program requires, within the 10 MB limit." },
  4: { title: "Seed too long", cause: "A seed used to derive the address exceeds 32 bytes.", fix: "Shorten the seed, or hash it to 32 bytes before deriving the address." },
  5: { title: "Address does not match seeds", cause: "The provided address is not the one derived from the base, seed and program.", fix: "Derive the address with the same base, seed and owner that the instruction uses." },
  6: { title: "Nonce account has no recent blockhashes", cause: "Advancing the nonce failed because the recent blockhashes sysvar was empty.", fix: "Retry. This is a transient cluster condition." },
  7: { title: "Nonce blockhash not expired", cause: "The durable nonce was advanced twice in the same slot, so its stored blockhash has not changed yet.", fix: "Wait one slot before advancing the nonce again, and never reuse a nonce across two in-flight transactions." },
  8: { title: "Unexpected nonce value", cause: "The transaction's blockhash does not match the value stored in the nonce account. Another transaction used the nonce first.", fix: "Re-read the nonce account and rebuild the transaction with its current value." },
};

function decodeCustom(
  code: number,
  failedProgramId: string | null,
  logs: string[],
  idlErrors: Map<number, IdlErrorEntry> | null,
): DecodedError {
  // Lighthouse guards share Jupiter's 6001 and are routinely mistaken for slippage; name them first.
  if (failedProgramId === LIGHTHOUSE) return lighthouseCause(code);
  // Layer 2a — the program's own on-chain IDL names the error precisely.
  const idlHit = idlErrors?.get(code);
  // Layer 2b — the log parser catches Anchor's runtime explanation when present.
  let logMsg: { name: string; msg: string } | null = null;
  for (const line of logs) {
    const m = line.match(ANCHOR_LOG_RE);
    if (m && Number(m[2]) === code) {
      logMsg = { name: m[1], msg: m[3] };
      break;
    }
  }

  const bundled = bundledError(failedProgramId, code);

  if (idlHit || logMsg || bundled) {
    const name = idlHit?.name ?? logMsg?.name ?? bundled!.name;
    const msg = idlHit?.msg ?? logMsg?.msg ?? bundled?.msg;
    const kb = ANCHOR_ERRORS[code];
    return {
      title: name,
      code: `Custom(${code}) — 0x${code.toString(16)}`,
      cause: enrichCause(name, msg),
      fix:
        kb?.fix ??
        suggestFixForName(name) ??
        "The error name above is the program's own diagnosis — search the program's docs or source for it.",
    };
  }

  if (failedProgramId === SYSTEM_PROGRAM && SYSTEM_ERRORS[code]) {
    return { ...SYSTEM_ERRORS[code], code: `Custom(${code}) — 0x${code.toString(16)}` };
  }
  if (failedProgramId && TOKEN_PROGRAMS.has(failedProgramId) && TOKEN_ERRORS[code]) {
    return { ...TOKEN_ERRORS[code], code: `Custom(${code}) — 0x${code.toString(16)}` };
  }
  if (ANCHOR_ERRORS[code]) {
    return { ...ANCHOR_ERRORS[code], code: `Custom(${code}) — 0x${code.toString(16)}` };
  }
  const hex = `0x${code.toString(16)}`;
  const knownName = failedProgramId && isNamedProgram(failedProgramId) ? programName(failedProgramId) : undefined;
  if (failedProgramId && !knownName) {
    const short = `${failedProgramId.slice(0, 4)}…${failedProgramId.slice(-4)}`;
    return {
      title: `Error ${code} from a private program (${short})`,
      code: `Custom(${code}) — ${hex}`,
      cause: `Program ${failedProgramId} raised this code. It has not published an IDL or an error list, which is typical of private trading and arbitrage programs, so only its authors know what ${code} means.`,
      fix: "If you were using a trading app or bot, this is their program and the message belongs to them: retry from the app, and if it keeps happening, send them this transaction. If it is your own program, publish its IDL on chain (anchor idl init) so every tool can decode its errors.",
    };
  }
  return {
    title: `${knownName ?? "Program"} error ${code} (${hex})`,
    code: `Custom(${code})`,
    cause: `${knownName ?? "The program"} returned a code that is not in its published error list.`,
    fix: "Check the program's current source or docs for this code. It may have been added in a recent upgrade.",
  };
}

/** Programs often publish a message that just repeats the error name. Say what it actually means. */
export function enrichCause(name: string, msg: string | undefined): string {
  const n = name.toLowerCase();
  const thin = !msg || msg.replace(/[^a-z]/gi, "").toLowerCase() === name.replace(/[^a-z]/gi, "").toLowerCase() || msg.split(" ").length <= 4;
  const slippage = n.includes("slippage") || n.includes("toolittle") || n.includes("toomuch") || n.includes("belowmin") || n.includes("amountoutbelow") || n.includes("exceededslippage");
  // Slippage messages from programs are one terse line ("instruction exceeds desired slippage limit"); say what actually happened.
  if (slippage) {
    return "The swap would have paid out less than the minimum this transaction allowed (or cost more than its maximum). The price moved between the moment the quote was taken and the moment the transaction executed, by more than the slippage tolerance set in the swap.";
  }
  if (n === "invalidsqrtpricelimitdirection") {
    return "The client passed a sqrt_price_limit on the wrong side of the current price for this swap's direction. Orca rejects the swap before touching the pool. This is a bug in how the transaction was built, not a market move.";
  }
  if (n === "insufficientliquidity" || n === "swapamountisoverathreshold" || n === "notenoughliquidity") {
    return "The pool does not have enough liquidity left to fill a trade of this size. On a launch pool (a bonding curve such as Meteora DBC) it means the buy is larger than what is left before the pool graduates, and the program refuses the whole swap rather than fill part of it.";
  }
  if (n === "pooliscompleted") {
    return "The launch pool has completed its bonding curve and graduated. Its liquidity has moved, or is moving, to the AMM pool it migrates to, so no swap against the launch pool can succeed any more.";
  }
  if (!thin) return msg as string;
  if (n.includes("slippage") || n.includes("toolittle") || n.includes("belowmin") || n.includes("amountoutbelow")) {
    return "The swap would have paid out less than the minimum this transaction allowed. The price moved between the moment the quote was taken and the moment the transaction executed, by more than the slippage tolerance set in the swap.";
  }
  if (n.includes("overflow") || n.includes("underflow")) {
    return "An arithmetic operation inside the program went out of range. In exchanges this usually means the amount, price or liquidity at that moment produced a number the pool cannot represent, often a trade far larger than the pool can absorb.";
  }
  if (n.includes("insufficient") || n.includes("notenough")) {
    return "The account does not hold enough of the token or SOL this instruction tried to spend.";
  }
  if (n.includes("expired") || n.includes("stale")) {
    return "The data this instruction relied on (a quote, price or order) was already out of date when it executed.";
  }
  return msg ?? "The program raised this named error and published no further explanation.";
}

/** Heuristic fixes for common IDL error names when the KB has no entry. */
export function suggestFixForName(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n === "invalidsqrtpricelimitdirection") return "Rebuild the swap with the program's SDK, which computes sqrt_price_limit for the direction (or pass 0 for no limit). Retrying the same transaction cannot succeed.";
  if (n.includes("slippage") || n.includes("toolittle") || n.includes("toomuch") || n.includes("belowmin") || n.includes("amountoutbelow")) return "Get a fresh quote and resend with the same tolerance; the price has moved on. Widen the tolerance only if it keeps failing on a fast-moving token, and know that a wide tolerance is what sandwich bots feed on.";
  if (n.includes("expired") || n.includes("stale")) return "Refresh the quote/price data and rebuild the transaction — the inputs went stale.";
  if (n === "insufficientliquidity" || n === "swapamountisoverathreshold" || n === "notenoughliquidity") return "Trade a smaller amount. On Meteora DBC, buy at most what is left before graduation, or use swap2 in partial-fill mode, which buys what is left and returns the rest. Paste the failed transaction into TxWhy to see the exact room left.";
  if (n === "pooliscompleted") return "Trade the token on the pool it migrated to (Meteora DAMM v2 for DBC launches), directly or through Jupiter. Paste the failed transaction into TxWhy to get that pool's address.";
  if (n.includes("insufficient")) return "Top up the relevant balance (check both SOL for fees and the token being spent).";
  if (n.includes("paused") || n.includes("frozen") || n.includes("disabled")) return "The protocol has this feature paused — wait or check the project's status channels.";
  if (n.includes("exceed") || n.includes("cap") || n.includes("maxamount") || n.endsWith("limit")) return "Reduce the amount; a protocol limit or cap applies.";
  return undefined;
}

export function decodeTransactionError(
  err: unknown,
  failedProgramId: string | null,
  logs: string[],
  idlErrors: Map<number, IdlErrorEntry> | null = null,
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
      return decodeCustom((detail as { Custom: number }).Custom, failedProgramId, logs, idlErrors);
    }
    if (typeof detail === "object" && detail !== null && "BorshIoError" in detail) {
      return {
        title: "Borsh deserialization error",
        code: "BorshIoError",
        cause: "The program failed to (de)serialize data: " + String((detail as { BorshIoError: unknown }).BorshIoError),
        fix: "Client/program layout drift — regenerate the client from the program's current IDL.",
      };
    }
  }

  // Transaction-level errors with a payload: {"InsufficientFundsForRent":{"account_index":1}}, {"DuplicateInstruction":3},
  // {"ProgramExecutionTemporarilyRestricted":{"account_index":2}}. Same table as the bare string form, plus where it points.
  if (typeof err === "object" && err !== null) {
    const [key] = Object.keys(err as Record<string, unknown>);
    const known = key ? TX_ERRORS[key] : undefined;
    if (known) {
      const detail = (err as Record<string, unknown>)[key];
      const index =
        detail && typeof detail === "object" && "account_index" in (detail as Record<string, unknown>)
          ? Number((detail as { account_index: number }).account_index)
          : typeof detail === "number"
            ? detail
            : null;
      const where = index == null ? "" : key === "DuplicateInstruction" ? ` Instruction #${index + 1} is the duplicate.` : ` The account is #${index + 1} in the transaction's account list.`;
      return { ...known, code: key, cause: `${known.cause}${where}` };
    }
  }

  return {
    title: "Unrecognized error",
    cause: JSON.stringify(err),
    fix: "Open an issue on TxWhy with this transaction signature so we can add coverage.",
  };
}
