import type { JsonObject } from "./protocol/index.js";

export const PRINT_OUTPUT_MAX_BYTES = 1024 * 1024;
export const PRINT_OUTPUT_MAX_FRAMES = 256;

/** One bounded, serial, acknowledged output queue per print invocation. */
export class PrintOutput {
  readonly #id: string;
  readonly #send: (message: JsonObject) => void | Promise<void>;
  readonly #abort: (error: Error) => void;
  readonly #queue: Array<{ sequence: number; stream: string; data: string; bytes: number }> = [];
  readonly #waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  #bytes = 0;
  #sequence = 0;
  #pumping = false;
  #failure: Error | undefined;
  #ack: { sequence: number; resolve(): void; reject(error: Error): void } | undefined;
  constructor(id: string, send: (message: JsonObject) => void | Promise<void>, abort: (error: Error) => void) {
    this.#id = id; this.#send = send; this.#abort = abort;
  }
  get pendingBytes(): number { return this.#bytes; }
  get pendingFrames(): number { return this.#queue.length; }
  write(stream: "stdout" | "stderr", data: string): boolean {
    if (this.#failure !== undefined) return false;
    if (data.length === 0) return true;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > PRINT_OUTPUT_MAX_BYTES - this.#bytes || this.#queue.length >= PRINT_OUTPUT_MAX_FRAMES) {
      this.fail(new Error("daemon print output delivery limit exceeded"));
      return false;
    }
    // Leave ample JSON-escaping headroom under the client's 1 MiB frame
    // limit, without splitting a UTF-16 surrogate pair between UTF-8 writes.
    const chunks: string[] = [];
    for (let start = 0; start < data.length;) {
      let end = Math.min(start + 16_384, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      chunks.push(data.slice(start, end)); start = end;
    }
    if (chunks.length > PRINT_OUTPUT_MAX_FRAMES - this.#queue.length) {
      this.fail(new Error("daemon print output delivery limit exceeded"));
      return false;
    }
    for (const chunk of chunks) this.#queue.push({ sequence: ++this.#sequence, stream, data: chunk, bytes: Buffer.byteLength(chunk, "utf8") });
    this.#bytes += bytes;
    if (!this.#pumping) void this.#pump();
    return true;
  }
  acknowledge(sequence: number): void {
    if (this.#ack?.sequence !== sequence) throw new Error("invalid print output acknowledgment");
    const ack = this.#ack; this.#ack = undefined; ack.resolve();
  }
  flush(): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => this.#waiters.add({ resolve, reject }));
  }
  fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#ack?.reject(error); this.#ack = undefined;
    this.#queue.length = 0; this.#bytes = 0;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear(); this.#abort(error);
  }
  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && this.#failure === undefined) {
        const frame = this.#queue[0]!;
        const acknowledgment = new Promise<void>((resolve, reject) => { this.#ack = { sequence: frame.sequence, resolve, reject }; });
        // Attach handlers to both waits immediately. Abort wakes the pump even
        // when the transport itself is blocked in its bounded socket writer.
        await Promise.all([
          Promise.resolve().then(() => this.#failure === undefined ? this.#send({ jsonrpc: "2.0", method: "print.output", params: {
            invocationId: this.#id, sequence: frame.sequence, stream: frame.stream, data: frame.data,
          } }) : undefined),
          acknowledgment,
        ]);
        if (this.#failure !== undefined) break;
        this.#queue.shift(); this.#bytes -= frame.bytes;
      }
      if (this.#failure === undefined) {
        for (const waiter of this.#waiters) waiter.resolve();
        this.#waiters.clear();
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally { this.#pumping = false; }
  }
}
