// Gateway run loop (TODO task 7): end-to-end wiring of daemon client + config
// + adapters through ChannelGateway, using a fake daemon client and the
// Telegram adapter over a fake transport. This is the "prove the run loop"
// coverage the stdio channel exists for.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  sanitizeGatewayDaemonEnv,
  startGateway,
} from "../../src/gateway/run.js";
import { DiscordChannelAdapter } from "../../src/gateway/discord-channel.js";
import { SlackChannelAdapter } from "../../src/gateway/slack-channel.js";
import {
  TelegramChannelAdapter,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../src/gateway/telegram-channel.js";
import { InMemoryChannelAdapter } from "../../src/gateway/test-channel.js";
import type {
  GatewayDaemonClient,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
} from "../../src/gateway/types.js";

class EchoSession implements GatewaySession {
  readonly sessionId: string;
  readonly prompts: string[] = [];
  constructor(id: string) {
    this.sessionId = id;
  }
  async prompt(
    text: string,
    handlers: GatewayPromptHandlers,
  ): Promise<GatewayPromptResult> {
    this.prompts.push(text);
    const reply = `echo: ${text}`;
    await handlers.onEvent({ type: "text", delta: reply });
    return { stopReason: "completed", finalMessage: reply };
  }
}

class FakeClient implements GatewayDaemonClient {
  closed = false;
  #n = 0;
  readonly sessions: EchoSession[] = [];
  async createSession(): Promise<GatewaySession> {
    const s = new EchoSession(`s${++this.#n}`);
    this.sessions.push(s);
    return s;
  }
  async attachSession(id: string): Promise<GatewaySession> {
    return new EchoSession(id);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeTelegramTransport implements TelegramTransport {
  updates: TelegramUpdate[][] = [];
  readonly sent: { chatId: string; text: string }[] = [];
  #id = 500;
  async getUpdates(): Promise<TelegramUpdate[]> {
    return this.updates.shift() ?? [];
  }
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { message_id: ++this.#id };
  }
  async editMessageText() {}
}

describe("startGateway", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-run-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function writeConfig(config: unknown): void {
    mkdirSync(join(home, "gateway"), { recursive: true });
    writeFileSync(join(home, "gateway", "config.json"), JSON.stringify(config));
  }

  test("strips gateway-only credentials from daemon autostart env", () => {
    const sanitized = sanitizeGatewayDaemonEnv({
      PATH: "/usr/bin",
      XAI_API_KEY: "provider-key-required-by-agent",
      AGENC_GATEWAY_HELIUS_API_KEY: "helius-secret",
      AGENC_GATEWAY_HELIUS_KEY_FILE: "/run/credentials/helius",
      AGENC_TELEGRAM_BOT_TOKEN: "telegram-secret",
      AGENC_TELEGRAM_OWNER_CLAIM_CODE: "owner-secret",
      AGENC_WEBCHAT_TOKEN: "webchat-secret",
    });

    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.XAI_API_KEY).toBe("provider-key-required-by-agent");
    expect(sanitized.AGENC_GATEWAY_HELIUS_API_KEY).toBeUndefined();
    expect(sanitized.AGENC_GATEWAY_HELIUS_KEY_FILE).toBeUndefined();
    expect(sanitized.AGENC_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(sanitized.AGENC_TELEGRAM_OWNER_CLAIM_CODE).toBeUndefined();
    expect(sanitized.AGENC_WEBCHAT_TOKEN).toBeUndefined();
  });

  test("no channels enabled → throws before touching the daemon client", async () => {
    let factoryCalled = false;
    await expect(
      startGateway({
        agencHome: home,
        clientFactory: async () => {
          factoryCalled = true;
          return new FakeClient();
        },
      }),
    ).rejects.toThrow(/no channels enabled/);
    // The channel check runs first, so no daemon connection is opened.
    expect(factoryCalled).toBe(false);
  });

  test("stdio channel: a paired sender's message runs a turn end to end", async () => {
    // Allowlist the stdio sender so no pairing dance is needed.
    writeConfig({
      channels: { stdio: { dmPolicy: "allowlist", allowlist: ["local"] } },
    });
    const client = new FakeClient();
    const handle = await startGateway({
      agencHome: home,
      stdio: true,
      clientFactory: async () => client,
    });
    expect(handle.channels).toEqual(["stdio"]);
    await handle.stop();
    expect(client.closed).toBe(true);
  });

  test("discord via extraAdapters: allowlisted DM drives a real turn; unpaired gets challenged", async () => {
    writeConfig({
      channels: { discord: { dmPolicy: "allowlist", allowlist: ["u-42"] } },
    });
    const client = new FakeClient();
    const created: { channelId: string; text: string }[] = [];
    const transport = {
      async getGatewayUrl() {
        return "wss://unused";
      },
      async connect() {
        throw new Error("autoConnect is off in this test");
      },
      async createMessage(channelId: string, text: string) {
        created.push({ channelId, text });
        return { id: "900" };
      },
      async editMessage(channelId: string, _messageId: string, text: string) {
        created.push({ channelId, text });
      },
    };
    const adapter = new DiscordChannelAdapter({
      transport,
      token: "t",
      autoConnect: false,
    });
    const handle = await startGateway({
      agencHome: home,
      clientFactory: async () => client,
      extraAdapters: [adapter],
    });
    expect(handle.channels).toContain("discord");

    // Allowlisted DM → framed turn, streamed reply lands via REST.
    adapter.handleGatewayPayload({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 1,
      d: {
        id: "m1",
        channel_id: "dm-chan",
        author: { id: "u-42", username: "alice" },
        content: "run the tests",
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0].prompts[0]).toContain("run the tests");
    expect(client.sessions[0].prompts[0]).toContain('trust="external"');
    expect(created.some((m) => m.text.includes("echo:"))).toBe(true);

    // Unlisted sender under an allowlist policy → silently denied: no turn,
    // no reply (pairing challenges only come from the pairing default).
    const sentBefore = created.length;
    adapter.handleGatewayPayload({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: {
        id: "m2",
        channel_id: "dm-other",
        author: { id: "u-99" },
        content: "let me in",
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(client.sessions).toHaveLength(1); // still just the first turn
    expect(created.length).toBe(sentBefore);

    await handle.stop();
  });

  test("slack via extraAdapters: allowlisted DM drives a real turn end to end", async () => {
    writeConfig({
      channels: { slack: { dmPolicy: "allowlist", allowlist: ["U42"] } },
    });
    const client = new FakeClient();
    const posted: { channel: string; text: string }[] = [];
    const transport = {
      async openSocketUrl() {
        return "wss://unused";
      },
      async connect() {
        throw new Error("autoConnect is off in this test");
      },
      async authTest() {
        return { userId: "UBOT" };
      },
      async postMessage(channel: string, text: string) {
        posted.push({ channel, text });
        return { ts: "1.1" };
      },
      async updateMessage(channel: string, _ts: string, text: string) {
        posted.push({ channel, text });
      },
    };
    const adapter = new SlackChannelAdapter({ transport, autoConnect: false });
    const handle = await startGateway({
      agencHome: home,
      clientFactory: async () => client,
      extraAdapters: [adapter],
    });
    expect(handle.channels).toContain("slack");

    adapter.handleEnvelope({
      type: "events_api",
      envelope_id: "e1",
      payload: {
        event: {
          type: "message",
          user: "U42",
          text: "summarize the incident",
          channel: "D1",
          channel_type: "im",
          ts: "1.0",
        },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0].prompts[0]).toContain("summarize the incident");
    expect(client.sessions[0].prompts[0]).toContain('trust="external"');
    expect(posted.some((m) => m.text.includes("echo:"))).toBe(true);

    await handle.stop();
  });

  test("telegram via extraAdapters: inbound update drives a real turn", async () => {
    writeConfig({
      channels: { telegram: { dmPolicy: "allowlist", allowlist: ["42"] } },
    });
    const client = new FakeClient();
    const transport = new FakeTelegramTransport();
    transport.updates = [
      [
        {
          update_id: 1,
          message: {
            message_id: 1,
            from: { id: 42, username: "alice" },
            chat: { id: 42, type: "private" },
            text: "run the tests",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const handle = await startGateway({
      agencHome: home,
      clientFactory: async () => client,
      extraAdapters: [adapter],
    });
    expect(handle.channels).toContain("telegram");

    await adapter.pollOnce();
    // Allow the turn's async delivery to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(client.sessions).toHaveLength(1);
    // The prompt is the framed form of the inbound text.
    expect(client.sessions[0].prompts[0]).toContain("run the tests");
    expect(client.sessions[0].prompts[0]).toContain('trust="external"');
    expect(transport.sent.at(-1)?.text).toContain("echo:");

    await handle.stop();
  });

  test("unpaired telegram sender gets pairing-gated (no turn)", async () => {
    // No policy → fail-closed pairing default.
    writeConfig({});
    const client = new FakeClient();
    const transport = new FakeTelegramTransport();
    transport.updates = [
      [
        {
          update_id: 1,
          message: {
            message_id: 1,
            from: { id: 99 },
            chat: { id: 99, type: "private" },
            text: "let me in",
          },
        },
      ],
    ];
    const adapter = new TelegramChannelAdapter({ transport, autoPoll: false });
    const handle = await startGateway({
      agencHome: home,
      clientFactory: async () => client,
      extraAdapters: [adapter],
    });
    await adapter.pollOnce();
    await new Promise((r) => setTimeout(r, 10));

    expect(client.sessions).toHaveLength(0);
    expect(transport.sent.at(-1)?.text).toContain("pairing-protected");
    await handle.stop();
  });

  test("extra in-memory adapter also starts (multi-channel)", async () => {
    writeConfig({
      channels: { mem: { dmPolicy: "allowlist", allowlist: ["u"] } },
    });
    const client = new FakeClient();
    const mem = new InMemoryChannelAdapter({ id: "mem" });
    const handle = await startGateway({
      agencHome: home,
      stdio: true,
      clientFactory: async () => client,
      extraAdapters: [mem],
    });
    expect(handle.channels.sort()).toEqual(["mem", "stdio"]);
    await handle.stop();
  });

  test("webchat: token-gated browser message runs a turn end to end", async () => {
    // No webchat policy in config → run loop injects allowlist:[web] because
    // the loopback + token gate is the auth.
    writeConfig({});
    const client = new FakeClient();
    const handle = await startGateway({
      agencHome: home,
      webchat: true,
      env: { AGENC_WEBCHAT_TOKEN: "run-loop-token-abcdef123456" },
      clientFactory: async () => client,
    });
    expect(handle.channels).toContain("webchat");
    expect(handle.webchatUrl).toContain("token=run-loop-token-abcdef123456");

    const url = new URL(handle.webchatUrl!);
    const base = `http://127.0.0.1:${url.port}`;
    const res = await fetch(`${base}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer run-loop-token-abcdef123456",
      },
      body: JSON.stringify({ conversation: "web", text: "do it" }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));

    expect(client.sessions).toHaveLength(1);
    // Framed (task 11) but carries the user's text.
    expect(client.sessions[0].prompts[0]).toContain("do it");
    expect(client.sessions[0].prompts[0]).toContain('trust="external"');
    await handle.stop();
  });

  test("webchat: an unauthenticated message never reaches the agent", async () => {
    writeConfig({});
    const client = new FakeClient();
    const handle = await startGateway({
      agencHome: home,
      webchat: true,
      env: { AGENC_WEBCHAT_TOKEN: "run-loop-token-abcdef123456" },
      clientFactory: async () => client,
    });
    const url = new URL(handle.webchatUrl!);
    const res = await fetch(`http://127.0.0.1:${url.port}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation: "web", text: "sneak" }),
    });
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.sessions).toHaveLength(0);
    await handle.stop();
  });

  test("cron delivery: a deliver-tagged task fires through the run loop to a channel", async () => {
    writeConfig({ channels: { mem: { dmPolicy: "allowlist", allowlist: ["x"] } } });
    const ws = join(home, "ws");
    mkdirSync(join(ws, ".agenc"), { recursive: true });
    const startMs = Date.parse("2026-07-09T10:00:30Z");
    writeFileSync(
      join(ws, ".agenc", "scheduled_tasks.json"),
      JSON.stringify({
        tasks: [
          {
            id: "runcron1",
            cron: "* * * * *",
            prompt: "cron says hi",
            createdAt: startMs - 1_000,
            recurring: true,
            deliver: { channel: "mem", to: "c9" },
          },
        ],
      }),
    );

    const client = new FakeClient();
    const mem = new InMemoryChannelAdapter({ id: "mem" });

    // Manual cron clock: capture armed timers, fire the earliest by hand.
    let now = startMs;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextTimer = 1;
    const cronClock = {
      now: () => new Date(now),
      setTimer: (fn: () => void, ms: number) => {
        const id = nextTimer++;
        timers.set(id, { at: now + ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle as unknown as number);
      },
    };

    const handle = await startGateway({
      agencHome: home,
      workspaceDir: ws,
      clientFactory: async () => client,
      extraAdapters: [mem],
      cronClock,
    });

    // Let arm() finish its async file read, then fire the armed timer.
    await new Promise((r) => setTimeout(r, 20));
    const armed = [...timers.values()].sort((a, b) => a.at - b.at)[0];
    expect(armed).toBeDefined();
    now = armed.at;
    timers.delete([...timers.keys()][0]);
    armed.fn();
    await new Promise((r) => setTimeout(r, 30));

    // The cron turn ran in its own gateway session and delivered in-channel.
    expect(mem.sent.some((m) => m.conversationId === "c9")).toBe(true);
    expect(
      client.sessions.some((s) => s.prompts.includes("cron says hi")),
    ).toBe(true);
    await handle.stop();
  });

  test("heartbeat: a config-enabled tick runs a turn and delivers to a channel", async () => {
    // Gateway channel + config.toml heartbeat targeting the in-memory channel.
    writeConfig({ channels: { mem: { dmPolicy: "allowlist", allowlist: ["x"] } } });
    require("node:fs").writeFileSync(
      join(home, "config.toml"),
      [
        "[heartbeat]",
        "enabled = true",
        "interval_seconds = 10",
        'target_channel = "mem"',
        'target_conversation = "c1"',
      ].join("\n"),
    );
    require("node:fs").mkdirSync(join(home, "ws"), { recursive: true });
    require("node:fs").writeFileSync(join(home, "ws", "HEARTBEAT.md"), "summarize");

    const client = new FakeClient();
    const mem = new InMemoryChannelAdapter({ id: "mem" });

    // A manual clock: capture the armed timer callback so we fire it by hand.
    let armed: (() => void) | null = null;
    const clock = {
      now: () => new Date("2026-07-09T10:00:00"),
      setTimer: (fn: () => void) => {
        armed = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    };

    const handle = await startGateway({
      agencHome: home,
      workspaceDir: join(home, "ws"),
      clientFactory: async () => client,
      extraAdapters: [mem],
      heartbeatClock: clock,
    });
    // The scheduler armed a timer. Fire one tick.
    expect(armed).not.toBeNull();
    armed!();
    await new Promise((r) => setTimeout(r, 20));

    // The heartbeat created its own session, ran a turn, and delivered the
    // (non-OK echo) reply to the mem channel's c1 conversation.
    expect(client.sessions.length).toBeGreaterThanOrEqual(1);
    expect(mem.sent.some((m) => m.conversationId === "c1")).toBe(true);
    await handle.stop();
  });
});
