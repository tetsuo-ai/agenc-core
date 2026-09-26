import { AGENC_SDK_MAX_FRAME_BYTES } from "./limits.js";

/**
 * Incremental newline-delimited frame decoder shared by the SDK transports.
 *
 * LF, CRLF, and a lone CR are delimiters. None of those bytes count toward
 * {@link maxBytes}. UTF-8 is decoded only after a frame is within the bound.
 * Overflow is sticky: later chunks are ignored.
 */
export class SdkNewlineFrameDecoder {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #overflowed = false;
  /** A CR already ended the frame; a following LF is the same delimiter. */
  #skipLf = false;

  constructor(readonly maxBytes: number = AGENC_SDK_MAX_FRAME_BYTES) {}

  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(chunk: Buffer | string): string[] {
    if (this.#overflowed) return [];
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const frames: string[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#skipLf) {
        this.#skipLf = false;
        if (bytes[offset] === 0x0a) {
          offset += 1;
          continue;
        }
      }
      const newline = bytes.indexOf(0x0a, offset);
      const carriageReturn = bytes.indexOf(0x0d, offset);
      const end = earlierIndex(newline, carriageReturn, bytes.length);
      if (!this.#commit(bytes.subarray(offset, end))) return frames;
      if (end === bytes.length) return frames;
      this.#skipLf = bytes[end] === 0x0d;
      frames.push(this.#decodeCurrent());
      this.reset();
      offset = end + 1;
    }
    return frames;
  }

  flush(): string | undefined {
    if (this.#overflowed || this.#bytes === 0) return undefined;
    const line = this.#decodeCurrent();
    this.reset();
    this.#skipLf = false;
    return line;
  }

  reset(): void {
    this.#chunks.length = 0;
    this.#bytes = 0;
  }

  #commit(segment: Buffer): boolean {
    if (segment.length === 0) return true;
    if (this.#bytes + segment.length > this.maxBytes) {
      this.#overflowed = true;
      this.reset();
      this.#skipLf = false;
      return false;
    }
    this.#chunks.push(Buffer.from(segment));
    this.#bytes += segment.length;
    return true;
  }

  #decodeCurrent(): string {
    return Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
  }
}

function earlierIndex(newline: number, carriageReturn: number, length: number): number {
  if (newline === -1 && carriageReturn === -1) return length;
  if (newline === -1) return carriageReturn;
  if (carriageReturn === -1) return newline;
  return Math.min(newline, carriageReturn);
}
