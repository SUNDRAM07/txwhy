import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AccountRole,
  type Address,
  type Instruction,
  type TransactionMessage,
  type TransactionMessageWithFeePayer,
  type TransactionMessageWithLifetime,
  address,
  compileTransaction,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  createTransactionMessage,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

/**
 * Version 1 transactions (SIMD-0385, mainnet since Sep 15, 2026), read and rebuilt with @solana/kit 8.
 *
 * What differs from legacy and v0: the version byte comes first and signatures last; compute
 * settings (unit limit, priority fee in TOTAL lamports, loaded-data limit, heap) live in a header
 * config instead of ComputeBudget instructions; up to 64 addresses inline and no lookup tables;
 * 4,096 bytes. web3.js 1.99 can read v1 but never serialize it, so everything that produces v1
 * bytes goes through kit, and the rest of the engine keeps working on web3 instructions.
 */

export const V1_MAX_BYTES = 4096;

export type V1Message = TransactionMessage & TransactionMessageWithFeePayer & TransactionMessageWithLifetime & { version: 1 };

export interface V1Config {
  computeUnitLimit?: number;
  priorityFeeLamports?: bigint;
  loadedAccountsDataSizeLimit?: number;
  heapSize?: number;
}

export interface DecodedV1 {
  message: V1Message;
  payerKey: PublicKey;
  /** The message's instructions as web3 instructions, for the decoder, the re-quoter and the verifier. */
  instructions: TransactionInstruction[];
  config: V1Config;
  /** A blockhash lifetime, or the nonce value for a durable-nonce transaction. */
  lifetime: { blockhash: string } | { nonce: string };
  bytes: number;
}

export const isV1Wire = (bytes: { readonly length: number; readonly [i: number]: number }) => bytes.length > 0 && bytes[0] === 129;

/** Read v1 bytes. Throws when the bytes are not a v1 transaction. */
export function decodeV1(base64: string): DecodedV1 {
  const bytes = getBase64Encoder().encode(base64.trim());
  if (!isV1Wire(bytes)) throw new Error("not a version 1 transaction");
  const tx = getTransactionDecoder().decode(bytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (compiled.version !== 1) throw new Error("not a version 1 transaction");
  const message = decompileTransactionMessage(compiled) as V1Message;
  const config: V1Config = { ...(message.config ?? {}) };
  const constraint = message.lifetimeConstraint as { blockhash?: string; nonce?: string };
  return {
    message,
    payerKey: new PublicKey(message.feePayer.address),
    instructions: message.instructions.map(toWeb3),
    config,
    lifetime: constraint.nonce ? { nonce: String(constraint.nonce) } : { blockhash: String(constraint.blockhash) },
    bytes: bytes.length,
  };
}

/**
 * Produce unsigned v1 bytes from a decoded transaction with a new config, optionally new
 * instructions, and optionally a fresh blockhash. Nonce lifetimes are kept as they are.
 */
export function rebuildV1(
  decoded: DecodedV1,
  changes: {
    config?: V1Config;
    instructions?: TransactionInstruction[];
    /** Applied only to blockhash-lifetime transactions. */
    blockhash?: string;
    /** For durable-nonce transactions: the nonce account's current value (with its account and authority). */
    nonce?: { value: string; account: string; authority: string };
  },
): { base64: string; bytes: number } {
  let message: V1Message = decoded.message;
  if (changes.instructions) {
    message = { ...message, instructions: changes.instructions.map(fromWeb3) } as V1Message;
  }
  if (changes.nonce && "nonce" in decoded.lifetime) {
    // The nonce advance is already instruction 0 in these transactions; only the lifetime value changes.
    message = {
      ...message,
      lifetimeConstraint: { nonce: changes.nonce.value },
    } as V1Message;
  } else if (changes.blockhash && "blockhash" in decoded.lifetime) {
    message = setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: changes.blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"], lastValidBlockHeight: BigInt(Number.MAX_SAFE_INTEGER) },
      message,
    ) as V1Message;
  }
  const config = clean({ ...decoded.config, ...(changes.config ?? {}) });
  message = setTransactionMessageConfig(config, message) as V1Message;
  const compiled = compileTransaction(message);
  const base64 = getBase64EncodedWireTransaction(compiled);
  return { base64, bytes: getBase64Encoder().encode(base64).length };
}

/** Build a brand-new unsigned v1 transaction (used for demos and tests). */
export function buildV1(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[], config: V1Config): string {
  let message = createTransactionMessage({ version: 1 });
  message = setTransactionMessageFeePayer(address(payer.toBase58()) as Address, message);
  message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"], lastValidBlockHeight: BigInt(Number.MAX_SAFE_INTEGER) },
    message,
  );
  const withIxs = { ...message, instructions: instructions.map(fromWeb3) } as unknown as V1Message;
  const configured = setTransactionMessageConfig(clean(config), withIxs) as V1Message;
  return getBase64EncodedWireTransaction(compileTransaction(configured));
}

function clean(config: V1Config): V1Config {
  const out: V1Config = {};
  if (config.computeUnitLimit != null) out.computeUnitLimit = config.computeUnitLimit;
  if (config.priorityFeeLamports != null) out.priorityFeeLamports = config.priorityFeeLamports;
  if (config.loadedAccountsDataSizeLimit != null) out.loadedAccountsDataSizeLimit = config.loadedAccountsDataSizeLimit;
  if (config.heapSize != null) out.heapSize = config.heapSize;
  return out;
}

/** Kit instruction -> web3 instruction (same bytes, same accounts, same flags). */
export function toWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(new Uint8Array(ix.data ?? [])),
  });
}

/** web3 instruction -> kit instruction. */
export function fromWeb3(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()) as Address,
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()) as Address,
      role: k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  };
}

/** Distinct addresses a set of instructions plus the payer would need inline (v1 allows 64). */
export function inlineAddressCount(payer: PublicKey, instructions: TransactionInstruction[]): number {
  const set = new Set<string>([payer.toBase58()]);
  for (const ix of instructions) {
    set.add(ix.programId.toBase58());
    for (const k of ix.keys) set.add(k.pubkey.toBase58());
  }
  return set.size;
}
