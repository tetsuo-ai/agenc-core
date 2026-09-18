import { AGENC_SDK_MAX_FRAME_BYTES } from "./limits.js";

/**
 * Incremental newline-delimited frame decoder for the subprocess transport.
 *
 * Counts raw payload bytes (excluding LF and a preceding CR) and decodes
 * UTF-8 only after a frame is within {@link maxBytes}. Overflow is sticky:
 * later chunks are ignored.
 */
export class SdkNewlineFrameDecoder {
  #chunks: Buffer[] = [];
  #bytes = 0;
  #overflowed = false;

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
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      if (this.#bytes + segment.length > this.maxBytes) {
        this.#overflowed = true;
        this.reset();
        return frames;
      }
      if (segment.length > 0) {
        this.#chunks.push(Buffer.from(segment));
        this.#bytes += segment.length;
      }
      if (newline === -1) return frames;
      frames.push(this.#decodeCurrent());
      this.reset();
      offset = newline + 1;
    }
    return frames;
  }

  flush(): string | undefined {
    if (this.#overflowed || this.#bytes === 0) return undefined;
    const line = this.#decodeCurrent();
    this.reset();
    return line;
  }

  reset(): void {
    this.#chunks.length = 0;
    this.#bytes = 0;
  }

  #decodeCurrent(): string {
    return Buffer.concat(this.#chunks, this.#bytes)
      .toString("utf8")
      .replace(/\r$/u, "");
  }
}
