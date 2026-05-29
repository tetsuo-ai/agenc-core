/**
 * Ports donor `mcp-server/src/lib.rs` stdin/stdout JSON-RPC task wiring onto
 * AgenC's MCP server framework.
 *
 * Why this lives here:
 *   - MS-03 owns server-side stdio framing only. CLI entrypoints, HTTP/SSE,
 *     and permission integration are later MS-* items.
 */

import { Buffer } from "node:buffer";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  McpServerFramework,
  ensureMcpOutgoingSerializable,
} from "./framework.js";
import type { McpOutgoingMessage } from "./types.js";

/**
 * Default upper bound on a single unterminated input line, mirroring the
 * app-server stdio transport's `AGENC_STDIO_DEFAULT_MAX_LINE_BYTES`. Node's
 * readline imposes no maximum line length, so a peer that streams bytes
 * without ever emitting a newline would grow the readline internal buffer
 * (and MCP server memory) unbounded. The transport tracks the bytes seen
 * since the last newline and tears the connection down once this cap is
 * exceeded, treating it as a fatal framing violation.
 */
export const AGENC_MCP_STDIO_DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface McpStdioServerTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly server: McpServerFramework;
  readonly onError?: (error: Error, line?: string) => void;
  readonly onClose?: () => void;
  readonly maxLineBytes?: number;
}

export class McpStdioServerTransport {
  readonly #options: McpStdioServerTransportOptions;
  #reader: Interface | null = null;
  #startupQueue: Promise<void> = Promise.resolve();
  #writeQueue: Promise<void> = Promise.resolve();
  readonly #activeLines = new Set<Promise<void>>();
  #closeScheduled = false;
  #closeNotified = false;
  #closed = false;

  constructor(options: McpStdioServerTransportOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#reader !== null) {
      throw new Error("AgenC MCP stdio transport is already started");
    }
    if (this.#closed) {
      throw new Error("AgenC MCP stdio transport is already closed");
    }

    const reader = createInterface({
      input: this.#options.input,
      crlfDelay: Infinity,
      terminal: false,
    });
    this.#reader = reader;

    // Node's readline does not enforce a maximum line length, so a peer that
    // streams bytes without ever emitting a newline would grow the internal
    // line buffer (and MCP server memory) unbounded. Track the number of bytes
    // accumulated since the last newline and tear the connection down once it
    // exceeds the cap, mirroring the app-server stdio transport.
    const maxLineBytes =
      this.#options.maxLineBytes ?? AGENC_MCP_STDIO_DEFAULT_MAX_LINE_BYTES;
    let unterminatedBytes = 0;
    const onData = (chunk: Buffer | string): void => {
      const data =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        unterminatedBytes += data.length;
      } else {
        unterminatedBytes = data.length - lastNewline - 1;
      }
      if (unterminatedBytes > maxLineBytes) {
        this.#options.onError?.(
          new RangeError(
            `AgenC MCP stdio transport line exceeded ${maxLineBytes} bytes without a newline`,
          ),
        );
        this.#options.input.destroy();
      }
    };
    this.#options.input.on("data", onData);

    reader.on("line", (line) => {
      this.#enqueueLine(line);
    });
    reader.once("close", () => {
      this.#options.input.off("data", onData);
      this.#reader = null;
      this.#closed = true;
      this.#notifyCloseAfterQueue();
    });
  }

  async send(message: McpOutgoingMessage): Promise<void> {
    await this.#writeMessage(message);
  }

  async close(): Promise<void> {
    this.#reader?.close();
    this.#reader = null;
    this.#closed = true;
    await this.#drain();
    this.#emitClose();
  }

  #enqueueLine(line: string): void {
    if (this.#options.server.snapshot().initialized) {
      this.#runLine(line);
      return;
    }

    const queued = this.#startupQueue
      .then(
        () => this.#processLine(line),
        () => this.#processLine(line),
      )
      .catch((error: unknown) => {
        this.#options.onError?.(asError(error), line);
      });
    this.#startupQueue = queued;
    this.#trackLine(queued);
  }

  #runLine(line: string): void {
    const task = this.#processLine(line).catch((error: unknown) => {
      this.#options.onError?.(asError(error), line);
    });
    this.#trackLine(task);
  }

  #trackLine(task: Promise<void>): void {
    this.#activeLines.add(task);
    void task.finally(() => {
      this.#activeLines.delete(task);
    });
  }

  async #processLine(line: string): Promise<void> {
    const messages = await this.#options.server.handleRawMessageAsync(line);
    for (const message of messages) {
      await this.#writeMessage(message);
    }
  }

  #notifyCloseAfterQueue(): void {
    if (this.#closeScheduled) return;
    this.#closeScheduled = true;
    void this.#drain().then(
      () => this.#emitClose(),
      () => this.#emitClose(),
    );
  }

  #writeMessage(message: McpOutgoingMessage): Promise<void> {
    const write = this.#writeQueue.then(() =>
      writeMcpJsonLine(this.#options.output, message),
    );
    this.#writeQueue = write.catch(() => {});
    return write;
  }

  async #drain(): Promise<void> {
    while (this.#activeLines.size > 0) {
      await Promise.allSettled([...this.#activeLines]);
    }
    await this.#writeQueue;
  }

  #emitClose(): void {
    if (!this.#closeScheduled) this.#closeScheduled = true;
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    try {
      this.#options.onClose?.();
    } catch (error) {
      this.#options.onError?.(asError(error));
    }
  }
}

export function encodeMcpJsonLine(message: McpOutgoingMessage): string {
  return `${ensureMcpOutgoingSerializable(message)}\n`;
}

function writeMcpJsonLine(
  output: Writable,
  message: McpOutgoingMessage,
): Promise<void> {
  const line = encodeMcpJsonLine(message);
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
