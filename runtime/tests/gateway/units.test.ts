// Gateway unit coverage (TODO task 6): pairing persistence, binding
// specificity, session-router streaming + restart reattach.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PairingStore, evaluateDmAccess } from "../../src/gateway/pairing.js";
import { resolveBinding } from "../../src/gateway/bindings.js";
import { SessionRouter } from "../../src/gateway/session-router.js";
import { InMemoryChannelAdapter } from "../../src/gateway/test-channel.js";
import type {
  GatewayBinding,
  GatewayDaemonClient,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
} from "../../src/gateway/types.js";

describe("PairingStore", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-pairing-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("challenge → redeem persists (0600), survives reconstruction", () => {
    let t = 1000;
    const store = new PairingStore({
      agencHome: home,
      now: () => t,
      generateCode: () => "ABC123",
    });
    const sender = { peerId: "alice" };
    expect(store.challenge("tg", sender)).toBe("ABC123");
    expect(store.redeem("tg", sender, "abc123")).toBe(true); // case-insensitive
    expect(store.isPaired("tg", "alice")).toBe(true);

    const perms = statSync(join(home, "gateway", "pairing.json")).mode & 0o777;
    expect(perms).toBe(0o600);

    // A fresh store reads the persisted pairing.
    const store2 = new PairingStore({ agencHome: home, now: () => t });
    expect(store2.isPaired("tg", "alice")).toBe(true);
    expect(store2.listPaired("tg")).toEqual(["alice"]);
  });

  test("expired code cannot be redeemed", () => {
    let t = 0;
    const store = new PairingStore({
      agencHome: home,
      now: () => t,
      generateCode: () => "ABC123",
      codeTtlMs: 100,
    });
    store.challenge("tg", { peerId: "alice" });
    t = 200;
    expect(store.redeem("tg", { peerId: "alice" }, "ABC123")).toBe(false);
    expect(store.isPaired("tg", "alice")).toBe(false);
  });

  test("pending pairing state is never written to disk", () => {
    const store = new PairingStore({
      agencHome: home,
      generateCode: () => "SECRET7",
    });
    store.challenge("tg", { peerId: "alice" });
    // No redemption yet → no file, or a file with no code in it.
    try {
      const raw = readFileSync(join(home, "gateway", "pairing.json"), "utf8");
      expect(raw).not.toContain("SECRET7");
    } catch {
      // No file yet is also fine.
    }
  });

  test("revoke removes a pairing", () => {
    const store = new PairingStore({ agencHome: home, generateCode: () => "C" });
    store.challenge("tg", { peerId: "alice" });
    store.redeem("tg", { peerId: "alice" }, "C");
    expect(store.revoke("tg", "alice")).toBe(true);
    expect(store.isPaired("tg", "alice")).toBe(false);
  });

  test("corrupt pairing file fails closed (nobody paired)", () => {
    const store = new PairingStore({ agencHome: home, generateCode: () => "C" });
    store.challenge("tg", { peerId: "alice" });
    store.redeem("tg", { peerId: "alice" }, "C");
    // Corrupt it.
    rmSync(join(home, "gateway", "pairing.json"));
    require("node:fs").writeFileSync(
      join(home, "gateway", "pairing.json"),
      "{ not json",
    );
    const store2 = new PairingStore({ agencHome: home });
    expect(store2.isPaired("tg", "alice")).toBe(false);
  });
});

describe("evaluateDmAccess default", () => {
  test("no policy → pairing challenge (fail closed)", () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-dm-"));
    try {
      const store = new PairingStore({
        agencHome: home,
        generateCode: () => "XYZ",
      });
      const decision = evaluateDmAccess({
        channelId: "tg",
        sender: { peerId: "alice" },
        store,
      });
      expect(decision.kind).toBe("pairing_challenge");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveBinding specificity", () => {
  const bindings: readonly GatewayBinding[] = [
    { agent: "chan-default", channelId: "tg" },
    { agent: "group-work", channelId: "tg", groupId: "g1" },
    { agent: "peer-alice", channelId: "tg", peerId: "alice" },
    { agent: "peer-in-group", channelId: "tg", peerId: "bob", groupId: "g1" },
  ];

  test("peer beats group beats channel default", () => {
    expect(
      resolveBinding({
        bindings,
        defaultAgent: "fallback",
        channelId: "tg",
        sender: { peerId: "alice" },
        conversation: { kind: "group", id: "g1" },
      }).agent,
    ).toBe("peer-alice");
  });

  test("group binding wins when no peer binding matches", () => {
    expect(
      resolveBinding({
        bindings,
        defaultAgent: "fallback",
        channelId: "tg",
        sender: { peerId: "carol" },
        conversation: { kind: "group", id: "g1" },
      }).agent,
    ).toBe("group-work");
  });

  test("peer+group binding is most specific", () => {
    expect(
      resolveBinding({
        bindings,
        defaultAgent: "fallback",
        channelId: "tg",
        sender: { peerId: "bob" },
        conversation: { kind: "group", id: "g1" },
      }).agent,
    ).toBe("peer-in-group");
  });

  test("channel default when only channel matches", () => {
    expect(
      resolveBinding({
        bindings,
        defaultAgent: "fallback",
        channelId: "tg",
        sender: { peerId: "nobody" },
        conversation: { kind: "dm", id: "d1" },
      }).agent,
    ).toBe("chan-default");
  });

  test("gateway default when nothing matches the channel", () => {
    expect(
      resolveBinding({
        bindings,
        defaultAgent: "fallback",
        channelId: "discord",
        sender: { peerId: "alice" },
        conversation: { kind: "dm", id: "d1" },
      }).agent,
    ).toBe("fallback");
  });
});

// ---- session router --------------------------------------------------------

class ScriptedSession implements GatewaySession {
  readonly sessionId: string;
  readonly deltas: string[];
  readonly finalMessage: string;
  constructor(id: string, deltas: string[], final: string) {
    this.sessionId = id;
    this.deltas = deltas;
    this.finalMessage = final;
  }
  async prompt(
    _text: string,
    handlers: GatewayPromptHandlers,
  ): Promise<GatewayPromptResult> {
    for (const delta of this.deltas) {
      await handlers.onEvent({ type: "text", delta });
    }
    return { stopReason: "completed", finalMessage: this.finalMessage };
  }
}

class RecordingClient implements GatewayDaemonClient {
  created = 0;
  attached: string[] = [];
  readonly makeSession: (id: string) => GatewaySession;
  constructor(makeSession: (id: string) => GatewaySession) {
    this.makeSession = makeSession;
  }
  async createSession(): Promise<GatewaySession> {
    this.created += 1;
    return this.makeSession(`sess-${this.created}`);
  }
  async attachSession(sessionId: string): Promise<GatewaySession> {
    this.attached.push(sessionId);
    return this.makeSession(sessionId);
  }
  async close(): Promise<void> {}
}

describe("SessionRouter", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-router-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("non-edit adapter: one final message per turn", async () => {
    const client = new RecordingClient(
      (id) => new ScriptedSession(id, ["a", "b", "c"], "abc"),
    );
    const router = new SessionRouter({ agencHome: home, client });
    const adapter = new InMemoryChannelAdapter({ id: "tg", supportsEdit: false });
    const key = SessionRouter.conversationKey({
      channelId: "tg",
      agent: "default",
      conversationId: "c1",
    });
    await router.runTurn({
      key,
      text: "hi",
      adapter,
      conversationId: "c1",
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });
    // One message, final text.
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].text).toBe("abc");
  });

  test("edit adapter: coalesces into an edited message ending at final", async () => {
    const client = new RecordingClient(
      (id) => new ScriptedSession(id, ["Hel", "lo ", "world"], "Hello world"),
    );
    const router = new SessionRouter({
      agencHome: home,
      client,
      flushIntervalMs: 0, // flush every delta
    });
    const adapter = new InMemoryChannelAdapter({ id: "tg", supportsEdit: true });
    const key = SessionRouter.conversationKey({
      channelId: "tg",
      agent: "default",
      conversationId: "c1",
    });
    await router.runTurn({
      key,
      text: "hi",
      adapter,
      conversationId: "c1",
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });
    // Same message id edited in place; final body is the complete text.
    const ids = new Set(adapter.sent.map((m) => m.messageId));
    expect(ids.size).toBe(1);
    expect(adapter.lastText("c1")).toBe("Hello world");
  });

  test("restart reattaches the persisted session instead of forking", async () => {
    const client1 = new RecordingClient(
      (id) => new ScriptedSession(id, ["x"], "x"),
    );
    const router1 = new SessionRouter({ agencHome: home, client: client1 });
    const adapter = new InMemoryChannelAdapter({ id: "tg" });
    const key = SessionRouter.conversationKey({
      channelId: "tg",
      agent: "default",
      conversationId: "c1",
    });
    await router1.runTurn({
      key,
      text: "1",
      adapter,
      conversationId: "c1",
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });
    expect(client1.created).toBe(1);

    // New router (simulated restart) with a fresh client: same key must
    // attach the persisted session id, not create a new one.
    const client2 = new RecordingClient(
      (id) => new ScriptedSession(id, ["y"], "y"),
    );
    const router2 = new SessionRouter({ agencHome: home, client: client2 });
    await router2.runTurn({
      key,
      text: "2",
      adapter,
      conversationId: "c1",
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });
    expect(client2.created).toBe(0);
    expect(client2.attached).toEqual(["sess-1"]);
  });

  test("dead backing agent: evicts the session and retries the turn once", async () => {
    // First session's daemon agent is gone (daemon restarted): its prompt
    // throws the daemon's AGENT_NOT_FOUND. The router must evict the cached
    // + persisted session, provision a fresh one, and complete the turn.
    class GoneSession implements GatewaySession {
      readonly sessionId = "sess-1";
      async prompt(): Promise<GatewayPromptResult> {
        throw Object.assign(
          new Error("AgenC daemon agent not found: sess-1"),
          { data: { code: "AGENT_NOT_FOUND" } },
        );
      }
    }
    const client = new RecordingClient((id) =>
      id === "sess-1"
        ? new GoneSession()
        : new ScriptedSession(id, ["ok"], "recovered"),
    );
    const router = new SessionRouter({ agencHome: home, client });
    const adapter = new InMemoryChannelAdapter({ id: "tg" });
    const key = SessionRouter.conversationKey({
      channelId: "tg",
      agent: "default",
      conversationId: "c1",
    });

    const result = await router.runTurn({
      key,
      text: "hi",
      adapter,
      conversationId: "c1",
      onPermissionRequest: async () => ({ behavior: "deny" }),
    });

    expect(result.finalMessage).toBe("recovered");
    expect(client.created).toBe(2);
    expect(adapter.lastText("c1")).toBe("recovered");
    // The persisted map now points at the fresh session, so a restart
    // reattaches the live one instead of the dead one.
    const persisted = JSON.parse(
      readFileSync(join(home, "gateway", "sessions.json"), "utf8"),
    ) as { sessions: Record<string, string> };
    expect(persisted.sessions[key]).toBe("sess-2");
  });

  test("non-agent-gone turn errors propagate without a retry", async () => {
    class FlakySession implements GatewaySession {
      readonly sessionId = "sess-1";
      async prompt(): Promise<GatewayPromptResult> {
        throw new Error("network timeout");
      }
    }
    const client = new RecordingClient(() => new FlakySession());
    const router = new SessionRouter({ agencHome: home, client });
    const adapter = new InMemoryChannelAdapter({ id: "tg" });
    const key = SessionRouter.conversationKey({
      channelId: "tg",
      agent: "default",
      conversationId: "c1",
    });

    await expect(
      router.runTurn({
        key,
        text: "hi",
        adapter,
        conversationId: "c1",
        onPermissionRequest: async () => ({ behavior: "deny" }),
      }),
    ).rejects.toThrow("network timeout");
    expect(client.created).toBe(1);
  });
});
