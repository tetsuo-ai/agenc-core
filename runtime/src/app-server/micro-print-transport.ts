/** Bounded, non-reconnecting JSON-line transport for one resident invocation. */
import { createConnection, type Socket } from "node:net";
import type { Writable } from "node:stream";
import { BoundedJsonLineReader } from "../utils/bounded-json-lines.js";
import { isRecord } from "../utils/record.js";

export const MICRO_PRINT_MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 8;
const MAX_QUEUED_NOTIFICATIONS = 256;
export const microTransportError = (): Error => new Error("Daemon print connection failed");

/** Completion AND drain are required; a watermark by itself is not delivery. */
export function writeMicroOutput(output: Writable, data: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, returned = false, completed = false, drained = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      if (error === undefined && (!returned || !completed || !drained)) return;
      settled = true;
      output.off("error", onError); output.off("close", onClose); output.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve(); else reject(error);
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(microTransportError());
    const onAbort = (): void => finish(microTransportError());
    const onDrain = (): void => { drained = true; finish(); };
    if (signal.aborted || output.destroyed || output.writableEnded) { reject(microTransportError()); return; }
    output.on("error", onError); output.once("close", onClose); output.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const accepted = output.write(data, (error?: Error | null) => {
        completed = true;
        if (error) finish(error); else finish();
      });
      drained ||= accepted;
      returned = true;
      finish();
    } catch (error) { finish(error instanceof Error ? error : microTransportError()); }
  });
}

export interface MicroNotification { readonly method: string; readonly params: Record<string, unknown> }
export class MicroPrintTransport {
  readonly #socket: Socket;
  readonly #reader: BoundedJsonLineReader;
  readonly #abort = new AbortController();
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
  readonly #notifications: Array<{ notification: MicroNotification; bytes: number }> = [];
  #notificationBytes = 0;
  #notificationCount = 0;
  #pumping = false;
  #nextId = 0;
  #writing = 0;
  #writingBytes = 0;
  #handler: ((notification: MicroNotification) => Promise<void>) | undefined;
  readonly #notificationIdle: Array<() => void> = [];
  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("error", () => this.close());
    this.#reader = new BoundedJsonLineReader({ input: socket, maxLineBytes: MICRO_PRINT_MAX_FRAME_BYTES,
      onLine: line => this.#receive(line), onError: () => this.close(), onClose: () => this.close() });
    this.#reader.start();
  }
  static async connect(socketPath: string, timeoutMs: number): Promise<MicroPrintTransport> {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); done(microTransportError()); }, timeoutMs);
      const done = (error?: Error): void => {
        clearTimeout(timer); socket.off("error", onError); socket.off("connect", onConnect);
        if (error) { socket.destroy(); reject(microTransportError()); } else resolve();
      };
      const onError = (): void => done(microTransportError());
      const onConnect = (): void => done();
      socket.once("error", onError); socket.once("connect", onConnect);
    });
    return new MicroPrintTransport(socket);
  }
  get signal(): AbortSignal { return this.#abort.signal; }
  assertLive(): void { if (this.signal.aborted || this.#socket.destroyed) throw microTransportError(); }
  setNotificationHandler(handler: (notification: MicroNotification) => Promise<void>): void {
    if (this.#handler !== undefined) throw microTransportError();
    this.#handler = handler;
  }
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    this.assertLive();
    if (this.#pending.size >= MAX_PENDING_REQUESTS || this.#writing >= MAX_PENDING_REQUESTS) throw microTransportError();
    const id = ++this.#nextId;
    const data = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const bytes = Buffer.byteLength(data);
    if (bytes > MICRO_PRINT_MAX_FRAME_BYTES || this.#writingBytes + bytes > 2 * MICRO_PRINT_MAX_FRAME_BYTES) throw microTransportError();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => this.close(), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      // Responses can arrive before write callbacks. Account for both lifetimes.
      this.#writing++; this.#writingBytes += bytes;
      void writeMicroOutput(this.#socket, data, this.signal).catch(() => this.close()).finally(() => {
        this.#writing--; this.#writingBytes -= bytes;
      });
    });
  }
  async notificationsIdle(): Promise<void> {
    if (this.#pumping) await new Promise<void>(resolve => this.#notificationIdle.push(resolve));
    this.assertLive();
  }
  close(): void {
    if (this.signal.aborted) return;
    this.#abort.abort();
    this.#reader.close(); this.#socket.destroy();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(microTransportError()); }
    this.#pending.clear(); this.#notifications.length = 0;
    for (const resolve of this.#notificationIdle.splice(0)) resolve();
  }
  #receive(line: string): void {
    if (this.signal.aborted) return;
    try {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message) || message.jsonrpc !== "2.0") throw microTransportError();
      if (Object.hasOwn(message, "id")) {
        if (typeof message.id !== "number") throw microTransportError();
        const pending = this.#pending.get(message.id);
        if (pending === undefined || Object.hasOwn(message, "error") === Object.hasOwn(message, "result")) throw microTransportError();
        this.#pending.delete(message.id); clearTimeout(pending.timer);
        if (Object.hasOwn(message, "error")) pending.reject(microTransportError()); else pending.resolve(message.result);
      } else {
        if (typeof message.method !== "string" || !isRecord(message.params) || this.#handler === undefined) throw microTransportError();
        const bytes = Buffer.byteLength(line);
        if (this.#notificationCount >= MAX_QUEUED_NOTIFICATIONS || this.#notificationBytes + bytes > MICRO_PRINT_MAX_FRAME_BYTES) throw microTransportError();
        // Counters include the currently awaited callback and its retained data.
        this.#notificationCount++; this.#notificationBytes += bytes;
        this.#notifications.push({ notification: { method: message.method, params: message.params }, bytes });
        if (!this.#pumping) void this.#pump();
      }
    } catch { this.close(); }
  }
  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      while (!this.signal.aborted) {
        const entry = this.#notifications.shift();
        if (entry === undefined) break;
        await this.#handler!(entry.notification);
        this.#notificationCount--; this.#notificationBytes -= entry.bytes;
      }
    } catch { this.close(); }
    finally {
      this.#pumping = false;
      for (const resolve of this.#notificationIdle.splice(0)) resolve();
    }
  }
}
