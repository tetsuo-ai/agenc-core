import type { JsonObject } from "./protocol/index.js";

export const PRINT_OUTPUT_MAX_BYTES = 1024 * 1024;
export const PRINT_OUTPUT_MAX_FRAMES = 256;

/** Serial output with one bounded frame in flight per invocation.
 *
 * Retain each canonical write once and frame it lazily. In particular, JSON
 * mode already owns one potentially large final-result string; eagerly
 * duplicating it into a frame queue must not impose a total-output limit.
 * Producers must await flush() between events/batches (PrintInvocation does).
 * Like Writable.write, false requests backpressure, not cancellation.
 */
export class PrintOutput {
  readonly #id: string;
  readonly #send: (message: JsonObject) => void | Promise<void>;
  readonly #abort: (error: Error) => void;
  readonly #queue: Array<{ stream: string; data: string; offset: number }> = [];
  #frameBytes = 0;
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
  get pendingFrames(): number { return this.#frameBytes > 0 ? 1 : 0; }
  get inFlightBytes(): number { return this.#frameBytes; }
  write(stream: "stdout" | "stderr", data: string): boolean {
    if (this.#failure !== undefined) return false;
    if (data.length === 0) return true;
    this.#queue.push({ stream, data, offset: 0 });
    this.#bytes += Buffer.byteLength(data, "utf8");
    if (!this.#pumping) void this.#pump();
    return this.#bytes < PRINT_OUTPUT_MAX_BYTES && this.#queue.length < PRINT_OUTPUT_MAX_FRAMES;
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
    this.#queue.length = 0; this.#bytes = 0; this.#frameBytes = 0;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear(); this.#abort(error);
  }
  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && this.#failure === undefined) {
        const write = this.#queue[0]!;
        // Leave JSON-escaping headroom under the client's 1 MiB frame limit,
        // without splitting a UTF-16 surrogate pair between UTF-8 writes.
        let end = Math.min(write.offset + 16_384, write.data.length);
        const last = write.data.charCodeAt(end - 1);
        if (end < write.data.length && last >= 0xd800 && last <= 0xdbff) end--;
        const frame = { sequence: ++this.#sequence, stream: write.stream, data: write.data.slice(write.offset, end) };
        this.#frameBytes = Buffer.byteLength(frame.data, "utf8");
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
        this.#bytes -= this.#frameBytes; this.#frameBytes = 0;
        write.offset = end;
        if (end === write.data.length) this.#queue.shift();
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
