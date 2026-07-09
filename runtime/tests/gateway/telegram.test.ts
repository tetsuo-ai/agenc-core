// Telegram adapter (TODO task 7): update→inbound mapping, edit-in-place
// streaming, token validation. Driven by a fake Bot API transport so no
// network is touched.

import { describe, expect, test } from "vitest";

import {
  FetchTelegramTransport,
  TelegramBotApiError,
  TelegramChannelAdapter,
  type TelegramAudioOptions,
  type TelegramBotIdentity,
  type TelegramSendOptions,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../src/gateway/telegram-channel.js";
import type {
  ChannelAdapterContext,
  InboundChannelMessage,
} from "../../src/gateway/types.js";

class FakeTransport implements TelegramTransport {
  updates: TelegramUpdate[][] = [];
  readonly sent: {
    chatId: string;
    text: string;
    messageThreadId?: number;
    parseMode?: "HTML";
  }[] = [];
  readonly photos: {
    chatId: string;
    photoUrl: string;
    caption?: string;
    messageThreadId?: number;
    parseMode?: "HTML";
  }[] = [];
  readonly audios: {
    chatId: string;
    audioBytes: Uint8Array;
    caption?: string;
    fileName?: string;
    contentType?: string;
    title?: string;
    performer?: string;
    messageThreadId?: number;
    parseMode?: "HTML";
  }[] = [];
  readonly edits: {
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: "HTML";
  }[] = [];
  readonly commands: { commands: unknown; scope?: unknown }[] = [];
  identity: TelegramBotIdentity = { id: 999, username: "agenc_test_bot" };
  #nextId = 100;
  editShouldThrow = false;

  async getMe(): Promise<TelegramBotIdentity> {
    return this.identity;
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    return this.updates.shift() ?? [];
  }
  async sendMessage(
    chatId: string,
    text: string,
    options: TelegramSendOptions = {},
  ) {
    this.sent.push({
      chatId,
      text,
      ...(options.messageThreadId !== undefined
        ? { messageThreadId: options.messageThreadId }
        : {}),
      ...(options.parseMode !== undefined ? { parseMode: options.parseMode } : {}),
    });
    return { message_id: ++this.#nextId };
  }
  async setMyCommands(commands: unknown, scope?: unknown): Promise<void> {
    this.commands.push({ commands, ...(scope !== undefined ? { scope } : {}) });
  }
  async sendPhoto(
    chatId: string,
    photoUrl: string,
    caption?: string,
    options: TelegramSendOptions = {},
  ) {
    this.photos.push({
      chatId,
      photoUrl,
      ...(caption !== undefined ? { caption } : {}),
      ...(options.messageThreadId !== undefined
        ? { messageThreadId: options.messageThreadId }
        : {}),
      ...(options.parseMode !== undefined ? { parseMode: options.parseMode } : {}),
    });
    return { message_id: ++this.#nextId };
  }
  async sendAudio(
    chatId: string,
    audioBytes: Uint8Array,
    options: TelegramAudioOptions = {},
  ) {
    this.audios.push({
      chatId,
      audioBytes,
      ...(options.caption !== undefined ? { caption: options.caption } : {}),
      ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.performer !== undefined ? { performer: options.performer } : {}),
      ...(options.messageThreadId !== undefined
        ? { messageThreadId: options.messageThreadId }
        : {}),
      ...(options.parseMode !== undefined ? { parseMode: options.parseMode } : {}),
    });
    return { message_id: ++this.#nextId };
  }
  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: TelegramSendOptions = {},
  ) {
    if (this.editShouldThrow) throw new Error("message is not modified");
    this.edits.push({
      chatId,
      messageId,
      text,
      ...(options.parseMode !== undefined ? { parseMode: options.parseMode } : {}),
    });
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

  test("installs Telegram command menus by configured scope", async () => {
    const transport = new FakeTransport();
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      commandMenus: [
        {
          commands: [{ command: "image", description: "generate image" }],
          scope: { type: "all_group_chats" },
        },
        {
          commands: [{ command: "stop", description: "pause public group replies" }],
          scope: { type: "chat", chat_id: "42" },
        },
      ],
    });
    const { ctx } = collector();
    await adapter.start(ctx);
    await adapter.stop();

    expect(transport.commands).toEqual([
      {
        commands: [{ command: "image", description: "generate image" }],
        scope: { type: "all_group_chats" },
      },
      {
        commands: [{ command: "stop", description: "pause public group replies" }],
        scope: { type: "chat", chat_id: "42" },
      },
    ]);
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

  test("keeps forum topic replies in the same Telegram thread", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 25,
          message: {
            message_id: 12,
            message_thread_id: 777,
            from: { id: 7, first_name: "Bob" },
            chat: { id: -100200, type: "supergroup" },
            text: "topic hello",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.send({
      conversationId: messages[0].conversation.id,
      text: "topic reply",
    });
    await adapter.stop();
    expect(messages[0].conversation).toEqual({
      kind: "group",
      id: "-100200:777",
    });
    expect(transport.sent[0]).toEqual({
      chatId: "-100200",
      text: "topic reply",
      messageThreadId: 777,
      parseMode: "HTML",
    });
  });

  test("mention-only group addressing ignores ambient group chatter", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 3,
          message: {
            message_id: 7,
            from: { id: 7, first_name: "Bob" },
            chat: { id: -100200, type: "supergroup" },
            text: "hi everyone",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      groupAddressing: "mentions",
    });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(0);
  });

  test("mention-only group addressing forwards @bot mentions with mention stripped", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 4,
          message: {
            message_id: 8,
            from: { id: 7, first_name: "Bob" },
            chat: { id: -100200, type: "supergroup" },
            text: "@agenc_test_bot hi there",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      groupAddressing: "mentions",
    });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("hi there");
  });

  test("mention-only group addressing forwards sender_chat mentions", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 45,
          message: {
            message_id: 85,
            sender_chat: {
              id: -100200,
              type: "supergroup",
              title: "AgenC group",
            },
            chat: { id: -100200, type: "supergroup" },
            text: "@agenc_test_bot hi from anonymous admin",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      groupAddressing: "mentions",
    });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toEqual({
      peerId: "-100200",
      displayName: "AgenC group",
    });
    expect(messages[0].text).toBe("hi from anonymous admin");
  });

  test("mention-only group addressing forwards channel posts with @bot mentions", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 46,
          channel_post: {
            message_id: 86,
            sender_chat: {
              id: -100300,
              type: "channel",
              title: "AgenC channel",
            },
            chat: { id: -100300, type: "channel" },
            text: "@agenc_test_bot explain AgenC",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      groupAddressing: "mentions",
    });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(1);
    expect(messages[0].conversation).toEqual({ kind: "group", id: "-100300" });
    expect(messages[0].text).toBe("explain AgenC");
  });

  test("mention-only group addressing ignores ambient channel posts", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 47,
          channel_post: {
            message_id: 87,
            sender_chat: {
              id: -100300,
              type: "channel",
              title: "AgenC channel",
            },
            chat: { id: -100300, type: "channel" },
            text: "ambient channel post",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      groupAddressing: "mentions",
    });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(0);
  });

  test("mention-only group addressing forwards caption mentions", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 48,
          message: {
            message_id: 88,
            from: { id: 7, first_name: "Bob" },
            chat: { id: -100200, type: "supergroup" },
            caption: "@agenc_test_bot explain this image",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      groupAddressing: "mentions",
    });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("explain this image");
  });

  test("mention-only group addressing forwards replies to the bot", async () => {
    const transport = new FakeTransport();
    transport.updates = [
      [
        {
          update_id: 5,
          message: {
            message_id: 9,
            from: { id: 7, first_name: "Bob" },
            chat: { id: -100200, type: "supergroup" },
            text: "answer this",
            reply_to_message: {
              from: { id: 999, is_bot: true, username: "agenc_test_bot" },
            },
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({
      transport,
      autoPoll: false,
      groupAddressing: "mentions",
    });
    const { ctx, messages } = collector();
    await adapter.start(ctx);
    await adapter.pollOnce();
    await adapter.stop();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("answer this");
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
    expect(transport.sent).toEqual([
      { chatId: "42", text: "Hel", parseMode: "HTML" },
    ]);

    await adapter.send({
      conversationId: "42",
      text: "Hello world",
      editMessageId: handle,
    });
    expect(transport.edits).toEqual([
      { chatId: "42", messageId: 101, text: "Hello world", parseMode: "HTML" },
    ]);
    await adapter.stop();
  });

  test("renders safe Markdown as Telegram HTML", async () => {
    const transport = new FakeTransport();
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);

    await adapter.send({
      conversationId: "42",
      text: "**What else AgenC does**\n\n- **Code work** with `npm test`\nIn short: agents can *do* work. [docs](https://agenc.ag/docs)",
    });

    expect(transport.sent[0]).toEqual({
      chatId: "42",
      parseMode: "HTML",
      text:
        "<b>What else AgenC does</b>\n\n" +
        "- <b>Code work</b> with <code>npm test</code>\n" +
        'In short: agents can <i>do</i> work. <a href="https://agenc.ag/docs">docs</a>',
    });
    await adapter.stop();
  });

  test("escapes raw HTML before Telegram rich rendering", async () => {
    const transport = new FakeTransport();
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);

    await adapter.send({
      conversationId: "42",
      text: "**Safe** <script>alert(1)</script> [bad](javascript:alert(1))",
    });

    expect(transport.sent[0]).toEqual({
      chatId: "42",
      parseMode: "HTML",
      text:
        "<b>Safe</b> &lt;script&gt;alert(1)&lt;/script&gt; " +
        "[bad](javascript:alert(1))",
    });
    await adapter.stop();
  });

  test("renders Markdown tables as Telegram preformatted blocks", async () => {
    const transport = new FakeTransport();
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);

    await adapter.send({
      conversationId: "42",
      text:
        "**Protocol facts**\n\n" +
        "| Topic | AgenC Protocol |\n" +
        "|---|---|\n" +
        "| What it is | Solana mainnet protocol |\n" +
        "| Safety | <reviewed> task specs |\n\n" +
        "See [docs](https://agenc.ag/docs).",
    });

    expect(transport.sent[0]).toEqual({
      chatId: "42",
      parseMode: "HTML",
      text:
        "<b>Protocol facts</b>\n\n" +
        "<pre>Topic      | AgenC Protocol\n" +
        "---------- | -----------------------\n" +
        "What it is | Solana mainnet protocol\n" +
        "Safety     | &lt;reviewed&gt; task specs</pre>\n\n" +
        'See <a href="https://agenc.ag/docs">docs</a>.',
    });
    await adapter.stop();
  });

  test("sends photo messages through Telegram native media", async () => {
    const transport = new FakeTransport();
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);

    await adapter.send({
      conversationId: "42",
      text: "AgenC meme",
      photoUrl: "https://img.example/meme.png",
      caption: "AgenC meme",
    });

    expect(transport.sent).toEqual([]);
    expect(transport.photos).toEqual([
      {
        chatId: "42",
        photoUrl: "https://img.example/meme.png",
        caption: "AgenC meme",
        parseMode: "HTML",
      },
    ]);
    await adapter.stop();
  });

  test("sends audio messages through Telegram native media", async () => {
    const transport = new FakeTransport();
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const { ctx } = collector();
    await adapter.start(ctx);

    await adapter.send({
      conversationId: "42",
      text: "AgenC voice",
      audioBytes: new Uint8Array([1, 2, 3]),
      audioFileName: "voice.mp3",
      audioContentType: "audio/mpeg",
      audioTitle: "AgenC voice",
      audioPerformer: "AgenC",
      caption: "**AgenC voice**",
    });

    expect(transport.sent).toEqual([]);
    expect(transport.audios).toEqual([
      {
        chatId: "42",
        audioBytes: new Uint8Array([1, 2, 3]),
        fileName: "voice.mp3",
        contentType: "audio/mpeg",
        title: "AgenC voice",
        performer: "AgenC",
        caption: "<b>AgenC voice</b>",
        parseMode: "HTML",
      },
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
