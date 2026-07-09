// Gateway run loop (TODO task 7): end-to-end wiring of daemon client + config
// + adapters through ChannelGateway, using a fake daemon client and the
// Telegram adapter over a fake transport. This is the "prove the run loop"
// coverage the stdio channel exists for.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { startGateway } from "../../src/gateway/run.js";
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

  test("no channels enabled → throws and closes the client", async () => {
    const client = new FakeClient();
    await expect(
      startGateway({ agencHome: home, clientFactory: async () => client }),
    ).rejects.toThrow(/no channels enabled/);
    expect(client.closed).toBe(true);
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
    expect(client.sessions[0].prompts).toEqual(["run the tests"]);
    expect(transport.sent.at(-1)?.text).toBe("echo: run the tests");

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
});
