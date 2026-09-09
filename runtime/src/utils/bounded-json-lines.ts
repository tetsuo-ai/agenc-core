import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";

interface BoundedJsonLineReaderOptions {
  readonly input: Readable;
  readonly maxLineBytes: number;
  readonly onLine: (line: string) => void;
  readonly onError: (error: Error) => void;
  readonly onClose: () => void;
}

function findLineEnd(data: Buffer | string, start: number): number {
  let end = start;
  while (end < data.length) {
    const character = data[end];
    if (character === 0x0a || character === 0x0d || character === "\n" || character === "\r") {
      return end;
    }
    end += 1;
  }
  return end;
}

export class BoundedJsonLineReader {
  readonly #options: BoundedJsonLineReaderOptions;
  #buffer: Buffer = Buffer.alloc(0);
  #length = 0;
  #skipLineFeed = false;
  #started = false;
  #closed = false;

  constructor(options: BoundedJsonLineReaderOptions) {
    if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes < 0) {
      throw new RangeError(
        "JSON line byte limit must be a nonnegative safe integer",
      );
    }
    this.#options = options;
  }

  start(): void {
    if (this.#started || this.#closed) {
      throw new Error("JSON line reader is already started or closed");
    }
    this.#started = true;
    const { input } = this.#options;
    if (input.readableEnded || input.destroyed) {
      this.close();
      return;
    }
    input.once("end", this.#onEnd);
    input.once("close", this.#onClose);
    input.on("error", this.#onError);
    input.on("data", this.#onData);
  }

  close(): void {
    if (this.#stop()) this.#options.onClose();
  }

  #stop(): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    const { input } = this.#options;
    input.off("data", this.#onData);
    input.off("end", this.#onEnd);
    input.off("close", this.#onClose);
    input.off("error", this.#onError);
    input.pause();
    this.#buffer = Buffer.alloc(0);
    this.#length = 0;
    return true;
  }

  readonly #onClose = (): void => {
    this.close();
  };

  readonly #onEnd = (): void => {
    try {
      if (this.#length > 0) this.#emitLine();
    } finally {
      this.close();
    }
  };

  readonly #onError = (error: Error): void => {
    if (!this.#stop()) return;
    try {
      this.#options.onError(error);
    } finally {
      try {
        this.#options.onClose();
      } finally {
        this.#options.input.destroy();
      }
    }
  };

  readonly #onData = (chunk: Buffer | string): void => {
    const data = chunk;
    const lineFeed = typeof data === "string" ? "\n" : 0x0a;
    const carriageReturn = typeof data === "string" ? "\r" : 0x0d;
    let offset = 0;
    while (offset < data.length && !this.#closed) {
      if (this.#skipLineFeed) {
        this.#skipLineFeed = false;
        if (data[offset] === lineFeed) {
          offset += 1;
          continue;
        }
      }
      const end = findLineEnd(data, offset);
      if (!this.#append(data, offset, end)) return;
      if (end < data.length) {
        this.#skipLineFeed = data[end] === carriageReturn;
        this.#emitLine();
      }
      offset = end + 1;
    }
  };

  #append(data: Buffer | string, start: number, end: number): boolean {
    const byteLength = typeof data === "string"
      ? Buffer.byteLength(data.slice(start, end), "utf8")
      : end - start;
    const required = this.#length + byteLength;
    const { maxLineBytes } = this.#options;
    if (required > maxLineBytes) {
      this.#onError(new RangeError(`JSON line exceeded ${maxLineBytes} bytes`));
      return false;
    }
    if (required > this.#buffer.length) {
      const capacity = Math.min(
        maxLineBytes,
        Math.max(1024, required, this.#buffer.length * 2),
      );
      const expanded = Buffer.allocUnsafe(capacity);
      this.#buffer.copy(expanded, 0, 0, this.#length);
      this.#buffer = expanded;
    }
    if (typeof data === "string") {
      this.#buffer.write(data.slice(start, end), this.#length, byteLength, "utf8");
    } else {
      data.copy(this.#buffer, this.#length, start, end);
    }
    this.#length = required;
    return true;
  }

  #emitLine(): void {
    const line = this.#buffer.toString("utf8", 0, this.#length);
    this.#length = 0;
    this.#options.onLine(line);
  }
}
