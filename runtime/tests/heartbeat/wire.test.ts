/**
 * Heartbeat ↔ gateway wire tests (TODO task 34): the persistent heartbeat
 * daemon session.
 *
 * Each gateway run must NOT accumulate a fresh daemon agent for the
 * heartbeat: the session id persists at `gateway/heartbeat-session` and is
 * reattached across restarts. When the daemon loses the backing agent
 * (daemon restart), the tick reprovisions once and retries instead of
 * failing every tick forever.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { startHeartbeat } from "../../src/heartbeat/wire.js";
import type { HeartbeatClock } from "../../src/heartbeat/types.js";
import { InMemoryChannelAdapter } from "../../src/gateway/test-channel.js";
import type {
  GatewayDaemonClient,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
  GatewaySessionCreateOptions,
} from "../../src/gateway/types.js";
import type { AgenCConfig } from "../../src/config/schema.js";

class EchoSession implements GatewaySession {
  readonly sessionId: string;
  readonly reply: string | Error;
  constructor(sessionId: string, reply: string | Error) {
    this.sessionId = sessionId;
    this.reply = reply;
  }
  async prompt(
    _text: string,
    handlers: GatewayPromptHandlers,
  ): Promise<GatewayPromptResult> {
    if (this.reply instanceof Error) throw this.reply;
    await handlers.onEvent({ type: "text", delta: this.reply });
    return { stopReason: "completed", finalMessage: this.reply };
  }
}

class RecordingClient implements GatewayDaemonClient {
  created = 0;
  attached: string[] = [];
  labels: (string | undefined)[] = [];
  readonly makeSession: (id: string) => GatewaySession;
  constructor(makeSession: (id: string) => GatewaySession) {
    this.makeSession = makeSession;
  }
  async createSession(
    options?: GatewaySessionCreateOptions,
  ): Promise<GatewaySession> {
    this.created += 1;
    this.labels.push(options?.label);
    return this.makeSession(`hb-sess-${this.created}`);
  }
  async attachSession(sessionId: string): Promise<GatewaySession> {
    this.attached.push(sessionId);
    return this.makeSession(sessionId);
  }
  async close(): Promise<void> {}
}

function manualClock(): { clock: HeartbeatClock; fire(): void } {
  let armed: (() => void) | null = null;
  return {
    clock: {
      now: () => new Date("2026-07-09T10:00:00"),
      setTimer: (fn: () => void) => {
        armed = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    },
    fire: () => {
      const fn = armed;
      armed = null;
      fn?.();
    },
  };
}

const HEARTBEAT_CONFIG = {
  heartbeat: {
    enabled: true,
    interval_seconds: 10,
    target_channel: "mem",
    target_conversation: "c1",
  },
} as unknown as AgenCConfig;

describe("startHeartbeat persistent session", () => {
  let home: string;
  let ws: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-hb-wire-"));
    ws = join(home, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "HEARTBEAT.md"), "check things");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  async function tickOnce(client: GatewayDaemonClient, mem: InMemoryChannelAdapter) {
    const { clock, fire } = manualClock();
    const scheduler = await startHeartbeat({
      agencHome: home,
      workspaceDir: ws,
      config: HEARTBEAT_CONFIG,
      env: {},
      client,
      adapters: [mem],
      clock,
    });
    expect(scheduler).not.toBeNull();
    fire();
    await new Promise((r) => setTimeout(r, 20));
    await scheduler!.stop();
  }

  test("first tick provisions a labeled session and persists its id; restart reattaches", async () => {
    const client1 = new RecordingClient((id) => new EchoSession(id, "did work"));
    const mem1 = new InMemoryChannelAdapter({ id: "mem" });
    await tickOnce(client1, mem1);

    expect(client1.created).toBe(1);
    expect(client1.labels).toEqual(["heartbeat"]);
    expect(mem1.lastText("c1")).toBe("did work");
    const persisted = readFileSync(
      join(home, "gateway", "heartbeat-session"),
      "utf8",
    ).trim();
    expect(persisted).toBe("hb-sess-1");

    // Simulated gateway restart: a fresh client must reattach the persisted
    // session, not create (= leak) another daemon agent.
    const client2 = new RecordingClient((id) => new EchoSession(id, "again"));
    const mem2 = new InMemoryChannelAdapter({ id: "mem" });
    await tickOnce(client2, mem2);

    expect(client2.created).toBe(0);
    expect(client2.attached).toEqual(["hb-sess-1"]);
    expect(mem2.lastText("c1")).toBe("again");
  });

  test("dead backing agent mid-tick: reprovisions once and completes the turn", async () => {
    const gone = Object.assign(
      new Error("AgenC daemon agent not running: hb-sess-1"),
      { data: { code: "AGENT_NOT_FOUND" } },
    );
    const client = new RecordingClient((id) =>
      id === "hb-sess-1"
        ? new EchoSession(id, gone)
        : new EchoSession(id, "recovered"),
    );
    const mem = new InMemoryChannelAdapter({ id: "mem" });
    await tickOnce(client, mem);

    expect(client.created).toBe(2);
    expect(mem.lastText("c1")).toBe("recovered");
    // The persisted id now points at the live replacement session.
    const persisted = readFileSync(
      join(home, "gateway", "heartbeat-session"),
      "utf8",
    ).trim();
    expect(persisted).toBe("hb-sess-2");
  });
});
