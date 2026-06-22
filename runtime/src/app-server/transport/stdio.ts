/**
 * Ports the donor app-server stdio transport's newline-delimited JSON framing
 * onto AgenC's daemon protocol primitives.
 *
 * Why this lives here:
 *   - F-03b owns transport framing only; request dispatch and session lifecycle
 *     are wired by later daemon rows.
 *
 * Cross-cuts deliberately NOT carried:
 *   - queue backpressure, overload responses, and connection multiplexing are
 *     daemon-server concerns owned by later F-03 rows.
 */

import { Buffer } from "node:buffer";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonObject, JsonValue } from "../protocol/index.js";
import { isRecord } from "../../utils/record.js";

/**
 * Default upper bound on a single unterminated input line, matching the
 * websocket transport's default max payload. A peer that streams bytes
 * without ever emitting a newline would otherwise grow the readline
 * internal buffer (and daemon memory) unbounded; the transport tracks the
 * bytes seen since the last newline and tears the connection down once this
 * cap is exceeded, treating it as a fatal framing violation.
 */
export const AGENC_STDIO_DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface AgenCStdioTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly onMessage: (message: JsonObject) => void | Promise<void>;
  readonly onError?: (error: Error, line: string) => void;
  readonly onClose?: () => void;
  readonly maxLineBytes?: number;
}

export class AgenCStdioTransport {
  readonly #options: AgenCStdioTransportOptions;
  readonly #pendingMessages = new Set<Promise<void>>();
  // Per-connection dispatch is serialized on this chain so that pipelined,
  // order-dependent requests on a single connection are handed to
  // onMessage in arrival order (rather than racing as fire-and-forget
  // promises). Cross-connection concurrency is preserved because each
  // transport instance owns its own chain.
  #dispatchChain: Promise<void> = Promise.resolve();
  #reader: Interface | null = null;

  constructor(options: AgenCStdioTransportOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#reader !== null) {
      throw new Error("AgenC stdio transport is already started");
    }

    const reader = createInterface({
      input: this.#options.input,
      crlfDelay: Infinity,
      terminal: false,
    });
    this.#reader = reader;

    // Node's readline does not enforce a maximum line length, so a peer that
    // streams bytes without ever emitting a newline would grow the internal
    // line buffer (and daemon memory) unbounded. Track the number of bytes
    // accumulated since the last newline and tear the connection down once it
    // exceeds the cap, mirroring the websocket transport's maxPayload bound.
    const maxLineBytes =
      this.#options.maxLineBytes ?? AGENC_STDIO_DEFAULT_MAX_LINE_BYTES;
    let unterminatedBytes = 0;
    const onData = (chunk: Buffer | string): void => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        unterminatedBytes += data.length;
      } else {
        unterminatedBytes = data.length - lastNewline - 1;
      }
      if (unterminatedBytes > maxLineBytes) {
        this.#options.onError?.(
          new RangeError(
            `AgenC stdio transport line exceeded ${maxLineBytes} bytes without a newline`,
          ),
          "",
        );
        this.#options.input.destroy();
      }
    };
    this.#options.input.on("data", onData);

    reader.on("line", (line) => {
      this.#handleLine(line);
    });
    reader.once("close", () => {
      this.#options.input.off("data", onData);
      this.#reader = null;
      this.#options.onClose?.();
    });
  }

  async send(message: JsonValue): Promise<void> {
    await writeJsonLine(this.#options.output, message);
  }

  async close(): Promise<void> {
    this.#reader?.close();
    this.#reader = null;
    if (this.#pendingMessages.size > 0) {
      await Promise.allSettled([...this.#pendingMessages]);
    }
  }

  #handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = parseJsonObjectLine(line);
    } catch (error) {
      this.#options.onError?.(asError(error), line);
      return;
    }

    if (isControlMessage(message)) {
      // Control messages (request.cancel) must NOT queue behind the in-flight
      // long request they target, or cancellation can never run. They carry no
      // ordering dependency on normal requests (they reference a target by
      // requestId, not by arrival position), so dispatch them off-chain. The
      // promise is still tracked in #pendingMessages so close() drains it.
      const pending = Promise.resolve(this.#options.onMessage(message)).catch(
        (error) => {
          this.#options.onError?.(asError(error), line);
        },
      );
      this.#pendingMessages.add(pending);
      pending.finally(() => {
        this.#pendingMessages.delete(pending);
      });
      return;
    }

    // Chain dispatch on a per-connection promise so pipelined,
    // order-dependent requests are handed to onMessage in arrival order
    // instead of racing. A handler rejection is caught here so it cannot
    // break the chain for subsequent messages.
    const pending = (this.#dispatchChain = this.#dispatchChain.then(() =>
      Promise.resolve(this.#options.onMessage(message)).catch((error) => {
        this.#options.onError?.(asError(error), line);
      }),
    ));
    this.#pendingMessages.add(pending);
    pending.finally(() => {
      this.#pendingMessages.delete(pending);
    });
  }
}

export function encodeJsonLine(message: JsonValue): string {
  const encoded = JSON.stringify(message);
  if (encoded === undefined) {
    throw new TypeError("AgenC stdio transport can only send JSON values");
  }
  return `${encoded}\n`;
}

export function parseJsonObjectLine(line: string): JsonObject {
  if (line.trim().length === 0) {
    throw new SyntaxError("AgenC stdio transport received an empty JSON line");
  }
  const value = JSON.parse(line) as JsonValue;
  if (!isJsonObject(value)) {
    throw new TypeError("AgenC stdio transport expected a JSON object");
  }
  return value;
}

export function writeJsonLine(
  output: Writable,
  message: JsonValue,
): Promise<void> {
  const line = encodeJsonLine(message);
  return new Promise((resolve, reject) => {
    output.write(line, "utf8", (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Pure-control messages that must bypass the per-connection dispatch FIFO.
 *
 * `request.cancel` references its target by requestId and has no ordering
 * dependency on normal requests, so queuing it behind a long-running request
 * would let that request starve the very cancellation meant to abort it. The
 * dispatcher handles it synchronously up to `controller.abort()`, so running it
 * off-chain is concurrency-safe. Extend this predicate to the other side-effect
 * free aborts (`session.cancelTurn`, `tool.cancel`, `commandExec.terminate`)
 * only if they prove starved as well — never to anything with ordering or
 * mutating side effects, which must stay strictly FIFO.
 */
function isControlMessage(message: JsonObject): boolean {
  return message.method === "request.cancel";
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return isRecord(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
