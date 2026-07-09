// Telegram adapter (TODO task 7): update→inbound mapping, edit-in-place
// streaming, token validation. Driven by a fake Bot API transport so no
// network is touched.

import { describe, expect, test } from "vitest";

import {
  FetchTelegramTransport,
  TelegramBotApiError,
  TelegramChannelAdapter,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../src/gateway/telegram-channel.js";
import type {
  ChannelAdapterContext,
  InboundChannelMessage,
} from "../../src/gateway/types.js";

class FakeTransport implements TelegramTransport {
  updates: TelegramUpdate[][] = [];
  readonly sent: { chatId: string; text: string }[] = [];
  readonly edits: { chatId: string; messageId: number; text: string }[] = [];
  #nextId = 100;
  editShouldThrow = false;

  async getUpdates(): Promise<TelegramUpdate[]> {
    return this.updates.shift() ?? [];
  }
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { message_id: ++this.#nextId };
  }
  async editMessageText(chatId: string, messageId: number, text: string) {
    if (this.editShouldThrow) throw new Error("message is not modified");
    this.edits.push({ chatId, messageId, text });
  }
}

function collector(): {
  ctx: ChannelAdapterContext;
  messages: InboundChannelMessage[];
} {
  const messages: InboundChannelMessage[] = [];
  return {
    messages,
    ctx: {
      async onMessage(message) {
        messages.push(message);
      },
    },
  };
}

describe("TelegramChannelAdapter", () => {
  test("maps a DM update to an inbound message", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 1,
          message: {
            message_id: 5,
            from: { id: 42, username: "alice" },
            chat: { id: 42, type: "private" },
            text: "hello agent",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channelId: "telegram",
      sender: { peerId: "42", displayName: "alice" },
      conversation: { kind: "dm", id: "42" },
      text: "hello agent",
    });
  });

  test("maps a supergroup update to a group conversation", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 2,
          message: {
            message_id: 6,
            from: { id: 7, first_name: "Bob" },
            chat: { id: -100200, type: "supergroup" },
            text: "hi",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages[0].conversation).toEqual({ kind: "group", id: "-100200" });
    expect(messages[0].sender.displayName).toBe("Bob");
  });

  test("advances the offset so updates are not reprocessed", async () => {
    const transport = new FakeTransport();
    const offsets: number[] = [];
    transport.getUpdates = async (offset: number) => {
      offsets.push(offset);
      if (offset === 0) {
        return [
          {
            update_id: 10,
            message: {
              message_id: 1,
              from: { id: 1 },
              chat: { id: 1, type: "private" },
              text: "x",
            },
          },
        ];
      }
      return [];
    };
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.pollOnce();
    await adapter.stop();
    expect(offsets).toEqual([0, 11]);
  });

  test("send then edit updates the same message in place", async () => {
    const transport = new FakeTransport();
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);

    const handle = await adapter.send({ conversationId: "42", text: "Hel" });
    expect(transport.sent).toEqual([{ chatId: "42", text: "Hel" }]);

    await adapter.send({
      conversationId: "42",
      text: "Hello world",
      editMessageId: handle,
    });
    expect(transport.edits).toEqual([
      { chatId: "42", messageId: 101, text: "Hello world" },
    ]);
    await adapter.stop();
  });

  test("a no-op edit rejection does not fail the turn", async () => {
    const transport = new FakeTransport();
    transport.editShouldThrow = true;
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);
    const handle = await adapter.send({ conversationId: "42", text: "a" });
    // Should resolve, not throw.
    await expect(
      adapter.send({ conversationId: "42", text: "a", editMessageId: handle }),
    ).resolves.toBe(handle);
    await adapter.stop();
  });

  test("ignores updates without text or sender", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        { update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" } } },
        {
          update_id: 2,
          message: {
            message_id: 2,
            from: { id: 1 },
            chat: { id: 1, type: "private" },
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(0);
  });
});

describe("FetchTelegramTransport", () => {
  test("rejects a malformed token", () => {
    expect(() => new FetchTelegramTransport({ token: "not-a-token" })).toThrow(
      TelegramBotApiError,
    );
  });

  test("accepts a well-formed token and posts to the Bot API", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return {
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      } as Response;
    }) as unknown as typeof fetch;
    const transport = new FetchTelegramTransport({
      token: "123456:ABC-DEF_ghi",
      fetchImpl: fakeFetch,
    });
    await transport.sendMessage("42", "hi");
    expect(calls[0].url).toContain("/bot123456:ABC-DEF_ghi/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "42", text: "hi" });
  });

  test("throws on a Bot API error response", async () => {
    const fakeFetch = (async () =>
      ({
        json: async () => ({ ok: false, description: "Unauthorized" }),
      }) as Response) as unknown as typeof fetch;
    const transport = new FetchTelegramTransport({
      token: "1:AAA",
      fetchImpl: fakeFetch,
    });
    await expect(transport.sendMessage("1", "x")).rejects.toThrow(
      "Unauthorized",
    );
  });
});
