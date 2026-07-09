/**
 * In-memory channel adapter for tests and the stdio dev channel (TODO task 6).
 *
 * Records every outbound message and lets a test push inbound messages
 * through the full gateway pipeline. Not a network transport — the real
 * Telegram/Discord adapters (task 7+) implement the same interface.
 */

import type {
  ChannelAdapter,
  ChannelAdapterContext,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "./types.js";

export interface RecordedOutbound extends OutboundChannelMessage {
  readonly messageId: string;
}

export class InMemoryChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly supportsEdit: boolean;
  readonly sent: RecordedOutbound[] = [];
  #context: ChannelAdapterContext | null = null;
  #counter = 0;

  constructor(options: { readonly id: string; readonly supportsEdit?: boolean }) {
    this.id = options.id;
    this.supportsEdit = options.supportsEdit ?? false;
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#context = context;
  }

  async stop(): Promise<void> {
    this.#context = null;
  }

  async send(message: OutboundChannelMessage): Promise<string> {
    if (message.editMessageId !== undefined) {
      // Model edit-in-place: replace the recorded body, keep the id.
      const existing = this.sent.find(
        (m) => m.messageId === message.editMessageId,
      );
      if (existing !== undefined) {
        const idx = this.sent.indexOf(existing);
        this.sent[idx] = { ...existing, text: message.text };
        return existing.messageId;
      }
    }
    const messageId = `${this.id}-msg-${++this.#counter}`;
    this.sent.push({ ...message, messageId });
    return messageId;
  }

  /** Drive an inbound message through the gateway. */
  async receive(message: Omit<InboundChannelMessage, "channelId">): Promise<void> {
    if (this.#context === null) {
      throw new Error("adapter not started");
    }
    await this.#context.onMessage({ ...message, channelId: this.id });
  }

  /** Latest outbound body in a conversation (test convenience). */
  lastText(conversationId?: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const m = this.sent[i];
      if (conversationId === undefined || m.conversationId === conversationId) {
        return m.text;
      }
    }
    return undefined;
  }
}
