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

import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonObject, JsonValue } from "../protocol/index.js";

export interface AgenCStdioTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly onMessage: (message: JsonObject) => void | Promise<void>;
  readonly onError?: (error: Error, line: string) => void;
  readonly onClose?: () => void;
}

export class AgenCStdioTransport {
  readonly #options: AgenCStdioTransportOptions;
  readonly #pendingMessages = new Set<Promise<void>>();
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

    reader.on("line", (line) => {
      this.#handleLine(line);
    });
    reader.once("close", () => {
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

    const pending = Promise.resolve(this.#options.onMessage(message)).catch(
      (error) => {
        this.#options.onError?.(asError(error), line);
      },
    );
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

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
