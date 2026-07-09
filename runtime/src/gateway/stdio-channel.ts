/**
 * Stdio dev channel (TODO task 7).
 *
 * A line-oriented channel over stdin/stdout for local development and
 * end-to-end testing of the gateway run loop without any network transport.
 * One fixed conversation ("stdio") and sender ("local"), so with the default
 * pairing policy the first run prints a pairing code; add the sender to an
 * allowlist (or pair) to talk to the agent.
 *
 * Inbound: each stdin line is one message. Outbound: printed with an `agent>`
 * prefix. `supportsEdit: false` — each turn prints one final block.
 */

import { createInterface, type Interface } from "node:readline";
import { Readable, Writable } from "node:stream";

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  OutboundChannelMessage,
} from "./types.js";

export const STDIO_CHANNEL_ID = "stdio";
export const STDIO_PEER_ID = "local";
export const STDIO_CONVERSATION_ID = "stdio";

export interface StdioChannelOptions {
  readonly id?: string;
  readonly peerId?: string;
  readonly input?: Readable;
  readonly output?: Writable;
  /** Prefix on outbound lines; default "agent> ". */
  readonly outputPrefix?: string;
}

export class StdioChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly supportsEdit = false;
  readonly #peerId: string;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #prefix: string;
  #rl: Interface | null = null;

  constructor(options: StdioChannelOptions = {}) {
    this.id = options.id ?? STDIO_CHANNEL_ID;
    this.#peerId = options.peerId ?? STDIO_PEER_ID;
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#prefix = options.outputPrefix ?? "agent> ";
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#rl = createInterface({ input: this.#input, terminal: false });
    this.#rl.on("line", (line: string) => {
      const text = line.trimEnd();
      if (text.length === 0) return;
      void context
        .onMessage({
          channelId: this.id,
          sender: { peerId: this.#peerId, displayName: "local" },
          conversation: { kind: "dm", id: STDIO_CONVERSATION_ID },
          text,
        })
        .catch((error: unknown) => {
          this.#output.write(`gateway error: ${String(error)}\n`);
        });
    });
  }

  async stop(): Promise<void> {
    this.#rl?.close();
    this.#rl = null;
  }

  async send(message: OutboundChannelMessage): Promise<string> {
    // One block per outbound message; ignore editMessageId (no edit support).
    for (const line of message.text.split("\n")) {
      this.#output.write(`${this.#prefix}${line}\n`);
    }
    return `${this.id}-out`;
  }
}
