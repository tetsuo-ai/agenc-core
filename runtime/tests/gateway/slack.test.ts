/**
 * Slack channel adapter (TODO task 9): Socket Mode envelope handling
 * (ack-everything discipline), DM/channel mapping with mention gating,
 * thread conversations, chat.update edits, and disconnect-driven socket
 * recycling — all against a scripted fake transport.
 */

import { describe, expect, test, vi } from "vitest";

import {
  parseSlackConversationId,
  SlackChannelAdapter,
  SLACK_MESSAGE_LIMIT,
  type SlackEnvelope,
  type SlackMessageEvent,
  type SlackSocketHandlers,
  type SlackTransport,
} from "../../src/gateway/slack-channel.js";
import type { InboundChannelMessage } from "../../src/gateway/types.js";

class FakeSlackTransport implements SlackTransport {
  readonly sentFrames: Record<string, unknown>[] = [];
  readonly posted: { channel: string; text: string; threadTs?: string }[] = [];
  readonly updated: { channel: string; ts: string; text: string }[] = [];
  handlers: SlackSocketHandlers | null = null;
  closed = 0;
  opens = 0;
  authTestFails = false;
  #nextTs = 1000;

  async openSocketUrl(): Promise<string> {
    this.opens += 1;
    return "wss://fake.slack";
  }

  async connect(_url: string, handlers: SlackSocketHandlers) {
    this.handlers = handlers;
    return {
      send: (frame: Record<string, unknown>) => {
        this.sentFrames.push(frame);
      },
      close: () => {
        this.closed += 1;
        handlers.onClose(1000);
      },
    };
  }

  async authTest(): Promise<{ userId: string }> {
    if (this.authTestFails) throw new Error("auth.test down");
    return { userId: "UBOT" };
  }

  async postMessage(channel: string, text: string, threadTs?: string) {
    this.posted.push({
      channel,
      text,
      ...(threadTs !== undefined ? { threadTs } : {}),
    });
    return { ts: String(++this.#nextTs) };
  }

  async updateMessage(channel: string, ts: string, text: string) {
    this.updated.push({ channel, ts, text });
  }
}

interface Harness {
  adapter: SlackChannelAdapter;
  transport: FakeSlackTransport;
  inbound: InboundChannelMessage[];
  timers: { fn: () => void; ms: number }[];
}

async function makeAdapter(
  options: {
    groupAddressing?: "all" | "mentions";
    authTestFails?: boolean;
  } = {},
): Promise<Harness> {
  const transport = new FakeSlackTransport();
  transport.authTestFails = options.authTestFails ?? false;
  const inbound: InboundChannelMessage[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const adapter = new SlackChannelAdapter({
    transport,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    ...(options.groupAddressing !== undefined
      ? { groupAddressing: options.groupAddressing }
      : {}),
  });
  await adapter.start({
    onMessage: async (message) => {
      inbound.push(message);
    },
  });
  return { adapter, transport, inbound, timers };
}

function messageEnvelope(
  event: Partial<SlackMessageEvent>,
  envelopeId = "env-1",
): SlackEnvelope {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      event: {
        type: "message",
        user: "U123",
        text: "hello agent",
        channel: "C1",
        channel_type: "im",
        ts: "1.0",
        ...event,
      },
    },
  };
}

describe("SlackChannelAdapter envelopes", () => {
  test("EVERY acknowledgeable envelope is acked — even dropped ones", async () => {
    const h = await makeAdapter();
    // A bot message that will be dropped must STILL be acked, or Slack
    // redelivers it and eventually flags the app.
    h.adapter.handleEnvelope(
      messageEnvelope({ bot_id: "B99" }, "env-dropped"),
    );
    // A normal message is acked too.
    h.adapter.handleEnvelope(messageEnvelope({}, "env-ok"));

    expect(h.transport.sentFrames).toEqual([
      { envelope_id: "env-dropped" },
      { envelope_id: "env-ok" },
    ]);
  });

  test("disconnect envelope recycles the socket and reconnect reopens a fresh URL", async () => {
    const h = await makeAdapter();
    expect(h.transport.opens).toBe(1);
    h.adapter.handleEnvelope({ type: "disconnect", reason: "link_refresh" });
    expect(h.transport.closed).toBe(1);
    // onClose armed a reconnect timer; firing it reopens via
    // apps.connections.open (a fresh URL every time).
    expect(h.timers.length).toBeGreaterThan(0);
    h.timers.at(-1)!.fn();
    await vi.waitFor(() => expect(h.transport.opens).toBe(2));
  });
});

describe("SlackChannelAdapter inbound mapping", () => {
  test("im message maps to a dm conversation", async () => {
    const h = await makeAdapter();
    h.adapter.handleEnvelope(messageEnvelope({}));
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
    expect(h.inbound[0]).toMatchObject({
      channelId: "slack",
      sender: { peerId: "U123" },
      conversation: { kind: "dm", id: "C1" },
      text: "hello agent",
    });
  });

  test("bot, self, and subtyped messages never reach the agent", async () => {
    const h = await makeAdapter();
    h.adapter.handleEnvelope(messageEnvelope({ bot_id: "B1" }, "e1"));
    h.adapter.handleEnvelope(messageEnvelope({ user: "UBOT" }, "e2"));
    h.adapter.handleEnvelope(
      messageEnvelope({ subtype: "message_changed" }, "e3"),
    );
    // app_mention duplicates the message event — ignored to avoid double turns.
    h.adapter.handleEnvelope(
      messageEnvelope({ type: "app_mention", text: "<@UBOT> hi" }, "e4"),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(h.inbound).toHaveLength(0);
  });

  test("channel messages are mention-gated by default; mention stripped", async () => {
    const h = await makeAdapter();
    h.adapter.handleEnvelope(
      messageEnvelope({ channel_type: "channel", text: "random chatter" }, "e1"),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(h.inbound).toHaveLength(0);

    h.adapter.handleEnvelope(
      messageEnvelope(
        { channel_type: "channel", text: "<@UBOT> summarize the incident" },
        "e2",
      ),
    );
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
    expect(h.inbound[0]).toMatchObject({
      conversation: { kind: "group", id: "C1" },
      text: "summarize the incident",
    });
  });

  test("groupAddressing 'all' forwards unmentioned channel messages", async () => {
    const h = await makeAdapter({ groupAddressing: "all" });
    h.adapter.handleEnvelope(
      messageEnvelope({ channel_type: "channel", text: "broadcast" }),
    );
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
  });

  test("auth.test failure fails CLOSED for channels, open for DMs", async () => {
    const h = await makeAdapter({ authTestFails: true });
    // Channel message: no self id → mention gate cannot match → dropped.
    h.adapter.handleEnvelope(
      messageEnvelope({ channel_type: "channel", text: "<@UBOT> hi" }, "e1"),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(h.inbound).toHaveLength(0);
    // DM still works (pairing gate is upstream in the gateway).
    h.adapter.handleEnvelope(messageEnvelope({}, "e2"));
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
  });

  test("thread messages get their own conversation keyed by thread_ts", async () => {
    const h = await makeAdapter();
    h.adapter.handleEnvelope(
      messageEnvelope({
        channel_type: "channel",
        text: "<@UBOT> continue here",
        thread_ts: "171.5",
      }),
    );
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
    expect(h.inbound[0].conversation).toEqual({
      kind: "group",
      id: "C1:171.5",
    });
  });
});

describe("slack run-loop wiring contract", () => {
  // Source contract: startGateway constructs the production adapter only
  // when BOTH Slack tokens are present (bot xoxb- for the Web API, app
  // xapp- for Socket Mode) and warns on a half-configured pair.
  test("run.ts wires the Slack token pair to the Slack adapter", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/gateway/run.ts"),
      "utf8",
    );
    expect(source).toContain("AGENC_SLACK_BOT_TOKEN");
    expect(source).toContain("AGENC_SLACK_APP_TOKEN");
    expect(source).toContain("new SlackChannelAdapter({");
    expect(source).toContain("slack needs BOTH");
  });
});

describe("SlackChannelAdapter outbound", () => {
  test("send posts to the channel; thread conversations post with thread_ts", async () => {
    const h = await makeAdapter();
    await h.adapter.send({ conversationId: "C1", text: "plain" });
    await h.adapter.send({ conversationId: "C1:171.5", text: "threaded" });
    expect(h.transport.posted).toEqual([
      { channel: "C1", text: "plain" },
      { channel: "C1", text: "threaded", threadTs: "171.5" },
    ]);
  });

  test("edit routes chat.update to the stored target", async () => {
    const h = await makeAdapter();
    const handle = await h.adapter.send({ conversationId: "C1", text: "v1" });
    await h.adapter.send({
      conversationId: "C1",
      text: "v2",
      editMessageId: handle,
    });
    expect(h.transport.updated).toEqual([
      { channel: "C1", ts: "1001", text: "v2" },
    ]);
  });

  test("oversized messages are truncated with a marker", async () => {
    const h = await makeAdapter();
    await h.adapter.send({
      conversationId: "C1",
      text: "z".repeat(SLACK_MESSAGE_LIMIT + 500),
    });
    expect(h.transport.posted[0].text.length).toBeLessThanOrEqual(
      SLACK_MESSAGE_LIMIT + 20,
    );
    expect(h.transport.posted[0].text).toContain("(truncated)");
  });

  test("parseSlackConversationId round-trips channel and thread forms", () => {
    expect(parseSlackConversationId("C1")).toEqual({ channel: "C1" });
    expect(parseSlackConversationId("C1:17.5")).toEqual({
      channel: "C1",
      threadTs: "17.5",
    });
  });
});
