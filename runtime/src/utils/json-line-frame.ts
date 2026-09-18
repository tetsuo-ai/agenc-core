/**
 * Shared newline-delimited JSON frame budget.
 *
 * The daemon stdio reader counts only JSON bytes, but the persistent client
 * checks its unterminated receive buffer before splitting on the delimiter.
 * Count the trailing newline so a complete on-the-wire line that the client
 * or transport accepts cannot overflow either side.
 */

export const AGENC_JSON_LINE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function jsonUtf8Bytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("value is not JSON-serializable");
  }
  return Buffer.byteLength(encoded, "utf8");
}

/** Serialized JSON plus the terminating newline, in UTF-8 bytes. */
export function jsonLineFrameBytes(value: unknown): number {
  return jsonUtf8Bytes(value) + 1;
}

export function jsonLineFitsFrame(
  value: unknown,
  maxFrameBytes: number = AGENC_JSON_LINE_MAX_FRAME_BYTES,
): boolean {
  return jsonLineFrameBytes(value) <= maxFrameBytes;
}
