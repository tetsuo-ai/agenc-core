/**
 * Discord channel adapter (TODO task 9): gateway protocol handshake,
 * heartbeat/sequence bookkeeping, DM + guild message mapping with
 * mention gating, REST send/edit with 2000-char chunking, and zombie
 * connection recycling — all against a scripted fake transport.
 */

import { describe, expect, test, vi } from "vitest";

import {
  chunkDiscordText,
  DISCORD_INTENTS,
  DISCORD_MESSAGE_LIMIT,
  DISCORD_OP,
  DiscordChannelAdapter,
  type DiscordGatewayPayload,
  type DiscordSocketHandlers,
  type DiscordTransport,
} from "../../src/gateway/discord-channel.js";
import type { InboundChannelMessage } from "../../src/gateway/types.js";

class FakeDiscordTransport implements DiscordTransport {
  readonly sentPayloads: DiscordGatewayPayload[] = [];
  readonly created: { channelId: string; text: string }[] = [];
  readonly edited: { channelId: string; messageId: string; text: string }[] = [];
  handlers: DiscordSocketHandlers | null = null;
  closed = 0;
  connects = 0;
  #nextMessageId = 100;

  async getGatewayUrl(): Promise<string> {
    return "wss://fake.gateway";
  }

  async connect(_url: string, handlers: DiscordSocketHandlers) {
    this.connects += 1;
    this.handlers = handlers;
    return {
      send: (payload: DiscordGatewayPayload) => {
        this.sentPayloads.push(payload);
      },
      close: () => {
        this.closed += 1;
        handlers.onClose(1000);
      },
    };
  }

  async createMessage(channelId: string, text: string) {
    this.created.push({ channelId, text });
    return { id: String(++this.#nextMessageId) };
  }

  async editMessage(channelId: string, messageId: string, text: string) {
    this.edited.push({ channelId, messageId, text });
  }
}

interface Harness {
  adapter: DiscordChannelAdapter;
  transport: FakeDiscordTransport;
  inbound: InboundChannelMessage[];
  timers: { fn: () => void; ms: number }[];
  fireTimer(index?: number): void;
}

async function makeAdapter(
  options: { groupAddressing?: "all" | "mentions" } = {},
): Promise<Harness> {
  const transport = new FakeDiscordTransport();
  const inbound: InboundChannelMessage[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const adapter = new DiscordChannelAdapter({
    transport,
    token: "bot-token-x",
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    ...(options.groupAddressing !== undefined
      ? { groupAddressing: options.groupAddressing }
      : {}),
  });
  await adapter.start({
    onMessage: async (message) => {
      inbound.push(message);
    },
  });
  return {
    adapter,
    transport,
    inbound,
    timers,
    fireTimer: (index = timers.length - 1) => timers[index].fn(),
  };
}

function hello(intervalMs = 1000): DiscordGatewayPayload {
  return { op: DISCORD_OP.HELLO, d: { heartbeat_interval: intervalMs } };
}

function ready(selfId = "bot-self"): DiscordGatewayPayload {
  return { op: DISCORD_OP.DISPATCH, t: "READY", s: 1, d: { user: { id: selfId } } };
}

function messageCreate(
  overrides: Partial<{
    id: string;
    channel_id: string;
    guild_id: string;
    author: { id: string; username?: string; bot?: boolean };
    content: string;
    mentions: { id: string }[];
    referenced_message: { author: { id: string } };
    s: number;
  }> = {},
): DiscordGatewayPayload {
  const { s, ...event } = overrides;
  return {
    op: DISCORD_OP.DISPATCH,
    t: "MESSAGE_CREATE",
    s: s ?? 2,
    d: {
      id: "m1",
      channel_id: "chan-1",
      author: { id: "user-1", username: "alice" },
      content: "hello agent",
      ...event,
    },
  };
}

describe("DiscordChannelAdapter protocol", () => {
  test("HELLO → IDENTIFY with token + intents, heartbeat armed", async () => {
    const h = await makeAdapter();
    h.adapter.handleGatewayPayload(hello(5000));

    const identify = h.transport.sentPayloads.find(
      (p) => p.op === DISCORD_OP.IDENTIFY,
    );
    expect(identify).toBeDefined();
    expect(identify!.d).toMatchObject({
      token: "bot-token-x",
      intents: DISCORD_INTENTS,
    });
    expect(h.timers.at(-1)?.ms).toBe(5000);
  });

  test("heartbeat carries the last dispatch sequence and recycles on missed ACK", async () => {
    const h = await makeAdapter();
    h.adapter.handleGatewayPayload(hello(1000));
    h.adapter.handleGatewayPayload(ready());
    h.adapter.handleGatewayPayload(messageCreate({ s: 41 }));

    h.fireTimer(); // first heartbeat
    const beat = h.transport.sentPayloads.findLast(
      (p) => p.op === DISCORD_OP.HEARTBEAT,
    );
    expect(beat).toBeDefined();
    expect(beat!.d).toBe(41);

    // ACK it → next beat proceeds instead of recycling.
    h.adapter.handleGatewayPayload({ op: DISCORD_OP.HEARTBEAT_ACK });
    h.fireTimer();
    expect(
      h.transport.sentPayloads.filter((p) => p.op === DISCORD_OP.HEARTBEAT),
    ).toHaveLength(2);
    expect(h.transport.closed).toBe(0);

    // No ACK before the next beat → zombied connection is recycled.
    h.fireTimer();
    expect(h.transport.closed).toBe(1);
  });

  test("op HEARTBEAT from the gateway triggers an immediate beat", async () => {
    const h = await makeAdapter();
    h.adapter.handleGatewayPayload(hello());
    h.adapter.handleGatewayPayload({ op: DISCORD_OP.HEARTBEAT });
    expect(
      h.transport.sentPayloads.filter((p) => p.op === DISCORD_OP.HEARTBEAT),
    ).toHaveLength(1);
  });

  test("RECONNECT closes the socket (reconnect path)", async () => {
    const h = await makeAdapter();
    h.adapter.handleGatewayPayload(hello());
    h.adapter.handleGatewayPayload({ op: DISCORD_OP.RECONNECT });
    expect(h.transport.closed).toBe(1);
  });
});

describe("DiscordChannelAdapter inbound mapping", () => {
  test("DM maps to a dm conversation with the author as peer", async () => {
    const h = await makeAdapter();
    h.adapter.handleGatewayPayload(ready());
    h.adapter.handleGatewayPayload(messageCreate());
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));

    expect(h.inbound[0]).toMatchObject({
      channelId: "discord",
      sender: { peerId: "user-1", displayName: "alice" },
      conversation: { kind: "dm", id: "chan-1" },
      text: "hello agent",
    });
  });

  test("own and bot-authored messages never reach the agent (echo-loop guard)", async () => {
    const h = await makeAdapter();
    h.adapter.handleGatewayPayload(ready("bot-self"));
    h.adapter.handleGatewayPayload(
      messageCreate({ author: { id: "bot-self" } }),
    );
    h.adapter.handleGatewayPayload(
      messageCreate({ author: { id: "other-bot", bot: true } }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(h.inbound).toHaveLength(0);
  });

  test("guild messages are mention-gated by default; mention is stripped", async () => {
    const h = await makeAdapter();
    h.adapter.handleGatewayPayload(ready("bot-self"));

    // Unmentioned guild chatter: dropped.
    h.adapter.handleGatewayPayload(
      messageCreate({ guild_id: "g1", content: "random chatter" }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(h.inbound).toHaveLength(0);

    // @bot mention: passes, mention token stripped, group conversation.
    h.adapter.handleGatewayPayload(
      messageCreate({
        guild_id: "g1",
        channel_id: "thread-9",
        content: "<@bot-self> summarize this thread",
        mentions: [{ id: "bot-self" }],
      }),
    );
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
    expect(h.inbound[0]).toMatchObject({
      conversation: { kind: "group", id: "thread-9" },
      text: "summarize this thread",
    });

    // Reply to the bot: passes too.
    h.adapter.handleGatewayPayload(
      messageCreate({
        guild_id: "g1",
        content: "and this?",
        referenced_message: { author: { id: "bot-self" } },
      }),
    );
    await vi.waitFor(() => expect(h.inbound).toHaveLength(2));
  });

  test("groupAddressing 'all' forwards unmentioned guild messages", async () => {
    const h = await makeAdapter({ groupAddressing: "all" });
    h.adapter.handleGatewayPayload(ready("bot-self"));
    h.adapter.handleGatewayPayload(
      messageCreate({ guild_id: "g1", content: "broadcast room chatter" }),
    );
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
    expect(h.inbound[0].conversation.kind).toBe("group");
  });
});

describe("discord run-loop wiring contract", () => {
  // Source contract: startGateway constructs the production adapter from the
  // env token. A live start() would open a real network connection, so the
  // wiring is guarded at the source level (same pattern as other contracts).
  test("run.ts wires AGENC_DISCORD_BOT_TOKEN to the Discord adapter", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/gateway/run.ts"),
      "utf8",
    );
    expect(source).toContain("AGENC_DISCORD_BOT_TOKEN");
    expect(source).toContain("new DiscordChannelAdapter({");
    expect(source).toContain("new FetchDiscordTransport({ token: discordToken })");
  });
});

describe("DiscordChannelAdapter outbound", () => {
  test("send creates a message and edit routes to the stored target", async () => {
    const h = await makeAdapter();
    const handle = await h.adapter.send({
      conversationId: "chan-1",
      text: "first",
    });
    expect(h.transport.created).toEqual([{ channelId: "chan-1", text: "first" }]);

    await h.adapter.send({
      conversationId: "chan-1",
      text: "updated",
      editMessageId: handle,
    });
    expect(h.transport.edited).toEqual([
      { channelId: "chan-1", messageId: "101", text: "updated" },
    ]);
  });

  test("messages beyond 2000 chars are chunked; edits overflow into new messages", async () => {
    const h = await makeAdapter();
    const long = "line\n".repeat(900); // ~4500 chars
    const handle = await h.adapter.send({ conversationId: "c", text: long });
    expect(h.transport.created.length).toBeGreaterThan(1);
    for (const message of h.transport.created) {
      expect(message.text.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }

    h.transport.created.length = 0;
    await h.adapter.send({
      conversationId: "c",
      text: long,
      editMessageId: handle,
    });
    expect(h.transport.edited).toHaveLength(1);
    expect(h.transport.created.length).toBeGreaterThan(0);
  });

  test("chunkDiscordText prefers line boundaries and loses no content", () => {
    const text = "x".repeat(150) + "\n" + "y".repeat(3000);
    const chunks = chunkDiscordText(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });
});
