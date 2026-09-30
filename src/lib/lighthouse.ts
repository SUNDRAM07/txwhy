import type { DecodedError } from "./types";

/**
 * Lighthouse (L2TEx…3S95) is the open-source assertion program wallets and trading terminals append to
 * a transaction as a guard: "abort unless this account still looks the way it did when I previewed it".
 * When the guard trips, the whole transaction fails with Lighthouse's error 6001 (0x1771), which is the
 * same number as Jupiter's slippage code and is routinely mistaken for it.
 *
 * The instruction data says exactly what was required, so a failed guard can be explained precisely.
 * Layouts from github.com/Jac0xb/lighthouse (programs/lighthouse/src/instruction.rs and types/assert).
 */

export const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

export const LIGHTHOUSE_ERRORS: Record<number, [string, string]> = {
  6000: ["InvalidInstructionData", "The guard instruction itself is malformed."],
  6001: ["AssertionFailed", "A state guard did not hold when the transaction executed."],
  6002: ["NotEnoughAccounts", "The guard instruction was given fewer accounts than it needs."],
  6003: ["BumpNotFound", "A memory account's bump seed could not be found."],
  6004: ["AccountBorrowFailed", "The guarded account's data could not be read (it is already borrowed)."],
  6005: ["RangeOutOfBounds", "The guard reads past the end of the account's data."],
  6006: ["IndexOutOfBounds", "The guard points at an index that does not exist."],
  6007: ["FailedToDeserialize", "The guarded account's data does not have the expected layout."],
  6008: ["FailedToSerialize", "A value could not be written to the memory account."],
  6009: ["AccountOwnerMismatch", "The guarded account is owned by a different program than expected."],
  6010: ["AccountKeyMismatch", "The guarded account is not the expected address."],
  6011: ["AccountNotInitialized", "The guarded account does not exist or is empty."],
  6012: ["AccountOwnerValidationFailed", "The guarded account's owner check failed."],
  6013: ["AccountFundedValidationFailed", "The guarded account holds no lamports."],
  6014: ["AccountDiscriminatorValidationFailed", "The guarded account's discriminator is not the expected one."],
  6015: ["AccountValidationFailed", "The guarded account failed validation."],
  6016: ["CrossProgramInvokeViolation", "Lighthouse must be called directly, not through another program."],
};

const OPERATORS = ["equal to", "different from", "greater than", "less than", "at least", "at most", "containing the bits", "not containing the bits"];
const short = (a: string | undefined) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "an account");
const n = (v: bigint) => v.toLocaleString("en-US");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58ToBytes(text: string): Uint8Array {
  let value = BigInt(0);
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) return new Uint8Array();
    value = value * BigInt(58) + BigInt(i);
  }
  const out: number[] = [];
  while (value > BigInt(0)) {
    out.unshift(Number(value & BigInt(255)));
    value >>= BigInt(8);
  }
  for (const ch of text) {
    if (ch !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

class Reader {
  constructor(private readonly bytes: Uint8Array, public at = 0) {}
  u8(): number {
    if (this.at >= this.bytes.length) throw new Error("eof");
    return this.bytes[this.at++];
  }
  uint(size: number): bigint {
    if (this.at + size > this.bytes.length) throw new Error("eof");
    let v = BigInt(0);
    for (let i = size - 1; i >= 0; i--) v = (v << BigInt(8)) | BigInt(this.bytes[this.at + i]);
    this.at += size;
    return v;
  }
  int(size: number): bigint {
    const v = this.uint(size);
    const sign = BigInt(1) << BigInt(size * 8 - 1);
    return v >= sign ? v - (sign << BigInt(1)) : v;
  }
  /** Solana "compact" varint: 7 bits per byte, high bit means more. */
  compact(): number {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const b = this.u8();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
    }
    return value;
  }
  skip(size: number) {
    if (this.at + size > this.bytes.length) throw new Error("eof");
    this.at += size;
  }
}

/** Widths of DataValueAssertion variants 0..10: Bool, U8, I8, U16, I16, U32, I32, U64, I64, U128, I128. */
const DATA_WIDTHS = [1, 1, 1, 2, 2, 4, 4, 8, 8, 16, 16];
const DATA_SIGNED = [false, false, true, false, true, false, true, false, true, false, true];

function describeAccountData(r: Reader, account: string | undefined): string {
  const offset = r.compact();
  const variant = r.u8();
  if (variant > 10) return `the bytes at offset ${offset} of account ${short(account)} to match a fixed value`;
  const width = DATA_WIDTHS[variant];
  const value = DATA_SIGNED[variant] ? r.int(width) : r.uint(width);
  const operator = OPERATORS[r.u8()] ?? "compared with";
  const hint = offset === 64 && width === 8 ? " (byte 64 of a token account is its balance)" : "";
  return `the ${width * 8}-bit number at byte ${offset} of account ${short(account)}${hint} to be ${operator} ${n(value)}`;
}

function describeTokenAccount(r: Reader, account: string | undefined): string {
  const variant = r.u8();
  if (variant === 2 || variant === 6) {
    const value = r.uint(8);
    const operator = OPERATORS[r.u8()] ?? "compared with";
    return `the ${variant === 2 ? "token balance" : "delegated amount"} of token account ${short(account)} to be ${operator} ${n(value)} (raw units)`;
  }
  const field = ["mint", "owner", "", "delegate", "state", "native flag", "", "close authority"][variant] ?? "ownership";
  return `the ${field} of token account ${short(account)} to be unchanged`;
}

function describeClock(r: Reader): string {
  const variant = r.u8();
  const value = variant === 1 || variant === 4 ? r.int(8) : r.uint(8);
  const operator = OPERATORS[r.u8()] ?? "compared with";
  if (variant === 0) return `the current slot to be ${operator} ${n(value)}${/less|at most/.test(operator) ? " (an expiry: the transaction landed too late)" : ""}`;
  if (variant === 4) return `the chain's clock to be ${operator} ${new Date(Number(value) * 1000).toISOString().replace(".000Z", "Z")}${/less|at most/.test(operator) ? " (an expiry: the transaction landed too late)" : ""}`;
  return `the epoch to be ${operator} ${n(value)}`;
}

/**
 * What one Lighthouse instruction required, in words. Null when it is not an assertion we decode
 * (memory writes, merkle-tree checks), which the caller reports generically.
 */
export function describeLighthouseAssertion(data: Uint8Array, accounts: string[]): string | null {
  try {
    const r = new Reader(data);
    const tag = r.u8();
    if (tag < 2) return null; // MemoryWrite / MemoryClose are not assertions
    r.u8(); // log level
    switch (tag) {
      case 2:
        return describeAccountData(r, accounts[0]);
      case 3:
        return `several values inside account ${short(accounts[0])} to be unchanged`;
      case 4:
        return `account ${short(accounts[0])} and account ${short(accounts[1])} to stay in a fixed relation to each other`;
      case 5: {
        const variant = r.u8();
        if (variant === 0 || variant === 1 || variant === 4) {
          const value = r.uint(8);
          const operator = OPERATORS[r.u8()] ?? "compared with";
          const what = variant === 0 ? "SOL balance (in lamports)" : variant === 1 ? "data size" : "rent epoch";
          return `the ${what} of account ${short(accounts[0])} to be ${operator} ${n(value)}`;
        }
        if (variant === 2 || variant === 3) return `the owner program of account ${short(accounts[0])} to be unchanged`;
        if (variant === 8) return `the contents of account ${short(accounts[0])} to be byte for byte what they were at preview (a data hash)`;
        return `a property of account ${short(accounts[0])} to be unchanged`;
      }
      case 6:
        return `several properties of account ${short(accounts[0])} to be unchanged`;
      case 7:
      case 8:
        return `the token mint ${short(accounts[0])} (supply, authorities) to be unchanged`;
      case 9:
        return describeTokenAccount(r, accounts[0]);
      case 10:
        return `several fields of token account ${short(accounts[0])} (balance, owner, delegate) to be unchanged`;
      case 11:
      case 12:
        return `the stake account ${short(accounts[0])} to be unchanged`;
      case 13:
      case 14:
        return `the upgrade authority or code of program ${short(accounts[0])} to be unchanged`;
      case 15:
        return describeClock(r);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** The cause shown for a Lighthouse failure. `requirement` comes from describeLighthouseAssertion when the instruction is known. */
export function lighthouseCause(code: number, requirement?: string | null, instructionNumber?: number): DecodedError {
  const [name, plain] = LIGHTHOUSE_ERRORS[code] ?? [`Lighthouse error ${code}`, "The Lighthouse assertion program rejected this instruction."];
  const hex = `0x${code.toString(16)}`;
  if (code !== 6001) {
    return {
      title: `Lighthouse guard: ${name}`,
      code: `Custom(${code}) — ${hex}`,
      cause: `${plain} Lighthouse is the assertion program wallets and trading apps append to a transaction as a safety guard.`,
      fix: "This is a problem in how the app built its guard, not in your funds or the market. Retry from the app; if it repeats, report it to the app with this transaction.",
    };
  }
  const where = instructionNumber != null ? `Instruction #${instructionNumber}` : "A guard instruction";
  return {
    title: "Lighthouse guard: assertion failed",
    code: `Custom(6001) — 0x1771`,
    cause:
      `${where} is a safety guard added by the wallet or trading app that built this transaction (Lighthouse, the open-source assertion program). ` +
      (requirement ? `It required ${requirement}. At execution that was no longer true, so the guard aborted the whole transaction before anything else ran. ` : "What it required was no longer true at execution, so it aborted the whole transaction before anything else ran. ") +
      "This is not Jupiter's slippage error, although it shares the number 0x1771: the state the app previewed (a balance, a pool reserve, or a deadline) changed before the transaction landed.",
    fix: "Nothing was swapped or moved; only the network fee was paid. Build a fresh transaction in the app so it previews current state and sets new guards. If it keeps tripping on a fast-moving token, the app's guard range is tighter than the market is moving: raise the app's slippage or protection setting rather than retrying the same transaction.",
  };
}

export interface RawInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

/**
 * When the failing top-level instruction is a Lighthouse assertion, the exact requirement it carried.
 * `instructionAt` returns the transaction's top-level instruction at an index. Null for anything else.
 */
export function lighthouseDetail(err: unknown, instructionAt: (index: number) => RawInstruction | undefined): DecodedError | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (!Array.isArray(ie)) return null;
  const detail = ie[1] as { Custom?: unknown } | null;
  if (typeof detail !== "object" || detail == null || typeof detail.Custom !== "number") return null;
  const ix = instructionAt(ie[0]);
  if (!ix || ix.programId !== LIGHTHOUSE) return null;
  return lighthouseCause(detail.Custom, describeLighthouseAssertion(ix.data, ix.accounts), ie[0] + 1);
}
