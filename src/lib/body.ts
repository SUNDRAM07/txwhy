/** Read a JSON body with a hard size cap, so nobody can make us buffer or decode megabytes. */
export class BodyError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BodyError";
  }
}

export async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new BodyError(`Body too large (limit ${maxBytes} bytes).`, 413);
  const text = await request.text();
  if (text.length > maxBytes) throw new BodyError(`Body too large (limit ${maxBytes} bytes).`, 413);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BodyError("Body must be JSON.", 400);
  }
}

/** A serialized Solana transaction is at most 1,232 bytes, about 1,650 characters of base64. */
export const REPAIR_BODY_LIMIT = 8_192;
