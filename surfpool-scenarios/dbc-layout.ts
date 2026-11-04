/**
 * Byte offsets of Meteora DBC account fields, computed from the program's IDL (meteora-dbc/idl.json) by walking the
 * Borsh layout. Used to read live pools and to patch them on a surfnet with surfnet_setAccount until Surfpool ships a
 * DBC override template (the one in this folder, meteora-dbc/overrides.yaml, is the proposed template).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } } | { option: IdlType } | { vec: IdlType };
interface IdlField { name: string; type: IdlType }
interface Idl {
  types: { name: string; type: { kind: string; fields?: IdlField[]; variants?: unknown[] } }[];
  errors: { code: number; name: string; msg?: string }[];
  instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[];
}

export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const idl: Idl = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "meteora-dbc", "idl.json"), "utf8"));

const PRIMITIVE: Record<string, number> = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };

function sizeOf(t: IdlType): number {
  if (typeof t === "string") { const s = PRIMITIVE[t]; if (s === undefined) throw new Error(`unsized primitive ${t}`); return s; }
  if ("array" in t) return sizeOf(t.array[0]) * t.array[1];
  if ("defined" in t) {
    const def = idl.types.find((x) => x.name === t.defined.name);
    if (!def) throw new Error(`type ${t.defined.name} not in IDL`);
    if (def.type.kind === "enum") return 1;
    return def.type.fields!.reduce((n, f) => n + sizeOf(f.type), 0);
  }
  throw new Error(`variable-size type ${JSON.stringify(t)} has no fixed offset`);
}

export interface Field { offset: number; size: number; type: IdlType }

/** Field name -> { offset, size, type } for an account type, discriminator included (offset 8 is the first field). */
export function layout(account: string): Record<string, Field> {
  const def = idl.types.find((x) => x.name === account);
  if (!def?.type.fields) throw new Error(`${account} not in IDL`);
  const out: Record<string, Field> = {};
  let off = 8;
  for (const f of def.type.fields) { const size = sizeOf(f.type); out[f.name] = { offset: off, size, type: f.type }; off += size; }
  return out;
}

export const POOL = layout("VirtualPool");
export const CONFIG = layout("PoolConfig");

/** Discriminator (hex) and the index of the `pool` account for every DBC instruction that names one. */
export const SWAP_IXS = Object.fromEntries(
  idl.instructions
    .filter((i) => i.accounts.some((a) => a.name === "pool"))
    .map((i) => [Buffer.from(i.discriminator).toString("hex"), { name: i.name, poolIndex: i.accounts.findIndex((a) => a.name === "pool") }]),
) as Record<string, { name: string; poolIndex: number }>;

export const readU64 = (d: Buffer, f: Field): bigint => d.readBigUInt64LE(f.offset);
export const readU128 = (d: Buffer, f: Field): bigint => d.readBigUInt64LE(f.offset) + (d.readBigUInt64LE(f.offset + 8) << BigInt(64));
export const readPubkey = (d: Buffer, f: Field): PublicKey => new PublicKey(d.subarray(f.offset, f.offset + 32));
export const writeU64 = (d: Buffer, f: Field, v: bigint) => d.writeBigUInt64LE(v, f.offset);
export function writeU128(d: Buffer, f: Field, v: bigint) {
  d.writeBigUInt64LE(v & ((BigInt(1) << BigInt(64)) - BigInt(1)), f.offset);
  d.writeBigUInt64LE(v >> BigInt(64), f.offset + 8);
}
export const errorName = (code: number): string => idl.errors.find((e) => e.code === code)?.name ?? `code ${code}`;

export interface PoolView { config: PublicKey; baseMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; baseReserve: bigint; quoteReserve: bigint; sqrtPrice: bigint; isMigrated: number; migrationProgress: number; activationPoint: bigint }
export function viewPool(d: Buffer): PoolView {
  return {
    config: readPubkey(d, POOL.config), baseMint: readPubkey(d, POOL.base_mint), baseVault: readPubkey(d, POOL.base_vault), quoteVault: readPubkey(d, POOL.quote_vault),
    baseReserve: readU64(d, POOL.base_reserve), quoteReserve: readU64(d, POOL.quote_reserve), sqrtPrice: readU128(d, POOL.sqrt_price),
    isMigrated: d[POOL.is_migrated.offset], migrationProgress: d[POOL.migration_progress.offset], activationPoint: readU64(d, POOL.activation_point),
  };
}
export const fmtSol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4) + " SOL";
