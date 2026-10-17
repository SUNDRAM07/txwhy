/**
 * Byte readers that work on any Uint8Array, in Node and in every browser bundle. The verifier and the
 * swap-shape readers run inside wallets and dApps, where the Buffer polyfill may be an old one without
 * the BigInt methods, so nothing here depends on Buffer.
 */

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

export const u16le = (data: Uint8Array, offset: number): number => view(data).getUint16(offset, true);
export const u32le = (data: Uint8Array, offset: number): number => view(data).getUint32(offset, true);
export const u64le = (data: Uint8Array, offset: number): bigint => view(data).getBigUint64(offset, true);

export function hex(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
