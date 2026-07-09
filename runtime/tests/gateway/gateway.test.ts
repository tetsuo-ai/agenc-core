// Channel gateway core (TODO task 6): the security invariants are the point.
// A fake daemon client drives the full inbound pipeline; the InMemory adapter
// records outbound + injects inbound.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TelegramOwnerControl } from "../../src/gateway/control-plane.js";
import { ChannelGateway } from "../../src/gateway/gateway.js";
import { InMemoryChannelAdapter } from "../../src/gateway/test-channel.js";
import type {
  GatewayDaemonClient,
  GatewayPermissionDecision,
  GatewayPermissionRequest,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
  GatewayConfig,
  InboundChannelMessage,
} from "../../src/gateway/types.js";

// ---- fake daemon ----------------------------------------------------------

interface TurnScript {
  readonly text?: string;
  /** When set, the turn raises one permission request and awaits the reply. */
  readonly permission?: GatewayPermissionRequest;
}

class FakeSession implements GatewaySession {
  readonly sessionId: string;
  readonly prompts: string[] = [];
  #script: TurnScript[];
  lastPermissionDecision: GatewayPermissionDecision | null = null;

  constructor(sessionId: string, script: TurnScript[]) {
    this.sessionId = sessionId;
    this.#script = script;
  }

  async prompt(
    text: string,
    handlers: GatewayPromptHandlers,
  ): Promise<GatewayPromptResult> {
    this.prompts.push(text);
    const step = this.#script.shift() ?? { text: "ok" };
    if (step.permission !== undefined) {
      this.lastPermissionDecision = await handlers.onPermissionRequest(
        step.permission,
      );
    }
    const final = step.text ?? "ok";
    await handlers.onEvent({ type: "text", delta: final });
    return { stopReason: "completed", finalMessage: final };
  }
}

class FakeDaemonClient implements GatewayDaemonClient {
  readonly sessions: FakeSession[] = [];
  #counter = 0;
  script: TurnScript[] = [];

  async createSession(): Promise<GatewaySession> {
    const session = new FakeSession(`sess-${++this.#counter}`, this.script);
    this.sessions.push(session);
    return session;
  }
  async attachSession(sessionId: string): Promise<GatewaySession> {
    const existing = this.sessions.find((s) => s.sessionId === sessionId);
    if (existing !== undefined) return existing;
    const session = new FakeSession(sessionId, this.script);
    this.sessions.push(session);
    return session;
  }
  async close(): Promise<void> {}
}

// ---- harness --------------------------------------------------------------

function dmMessage(
  peerId: string,
  text: string,
  conversationId = `dm-${peerId}`,
): Omit<InboundChannelMessage, "channelId"> {
  return {
    sender: { peerId },
    conversation: { kind: "dm", id: conversationId },
    text,
  };
}

function groupMessage(
  peerId: string,
  text: string,
  conversationId = "group-1",
): Omit<InboundChannelMessage, "channelId"> {
  return {
    sender: { peerId },
    conversation: { kind: "group", id: conversationId },
    text,
  };
}

describe("channel gateway", () => {
  let home: string;
  let client: FakeDaemonClient;
  let adapter: InMemoryChannelAdapter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-gateway-"));
    client = new FakeDaemonClient();
    adapter = new InMemoryChannelAdapter({ id: "test", supportsEdit: false });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function gateway(
    config: Partial<GatewayConfig> = {},
    seams: {
      pairingCode?: string;
      approvalToken?: string;
    } = {},
  ): Promise<ChannelGateway> {
    const gw = new ChannelGateway({
      agencHome: home,
      client,
      config: {
        channels: config.channels ?? {},
        bindings: config.bindings ?? [],
        defaultAgent: config.defaultAgent ?? "default",
      },
      ...(seams.pairingCode !== undefined
        ? { generatePairingCode: () => seams.pairingCode! }
        : {}),
      ...(seams.approvalToken !== undefined
        ? { generateApprovalToken: () => seams.approvalToken! }
        : {}),
    });
    await gw.registerAdapter(adapter);
    return gw;
  }

  test("pairing default: unknown DM sender gets a code and NO agent access", async () => {
    await gateway({}, { pairingCode: "CODE1234" });
    await adapter.receive(dmMessage("alice", "hello"));

    // No session/turn happened.
    expect(client.sessions).toHaveLength(0);
    const reply = adapter.lastText();
    expect(reply).toContain("pairing-protected");
    expect(reply).toContain("CODE1234");
  });

  test("pairing redemption: exact code pairs, then a turn runs", async () => {
    const gw = await gateway({}, { pairingCode: "CODE1234" });
    await adapter.receive(dmMessage("alice", "hello")); // challenge
    await adapter.receive(dmMessage("alice", "code1234")); // redeem (case-insensitive)
    expect(adapter.lastText()).toContain("Paired");

    client.script = [{ text: "hi alice" }];
    await adapter.receive(dmMessage("alice", "do the thing"));
    expect(client.sessions).toHaveLength(1);
    // The prompt is the framed, untrusted-wrapped form of the user's text.
    expect(client.sessions[0].prompts[0]).toContain("do the thing");
    expect(client.sessions[0].prompts[0]).toContain('trust="external"');
    expect(adapter.lastText()).toBe("hi alice");
  });

  test("wrong pairing code never pairs", async () => {
    await gateway({}, { pairingCode: "CODE1234" });
    await adapter.receive(dmMessage("alice", "hello"));
    await adapter.receive(dmMessage("alice", "guess"));
    expect(client.sessions).toHaveLength(0);
    // Re-challenged, not paired.
    expect(adapter.lastText()).toContain("pairing-protected");
  });

  test("allowlist policy: listed sender straight through, others denied", async () => {
    await gateway({
      channels: {
        test: { dmPolicy: "allowlist", allowlist: ["bob"] },
      },
    });
    client.script = [{ text: "hi bob" }];
    await adapter.receive(dmMessage("bob", "hi"));
    expect(client.sessions).toHaveLength(1);

    const before = adapter.sent.length;
    await adapter.receive(dmMessage("mallory", "hi"));
    expect(client.sessions).toHaveLength(1); // no new session
    expect(adapter.sent.length).toBe(before); // denied silently
  });

  test('open policy requires the literal "*" — dmPolicy alone denies', async () => {
    await gateway({
      channels: { test: { dmPolicy: "open", allowlist: [] } },
    });
    await adapter.receive(dmMessage("anyone", "hi"));
    expect(client.sessions).toHaveLength(0);

    const gw2Home = mkdtempSync(join(tmpdir(), "agenc-gateway-open-"));
    const gw2 = new ChannelGateway({
      agencHome: gw2Home,
      client,
      config: {
        channels: { test2: { dmPolicy: "open", allowlist: ["*"] } },
        bindings: [],
        defaultAgent: "default",
      },
    });
    const adapter2 = new InMemoryChannelAdapter({ id: "test2" });
    await gw2.registerAdapter(adapter2);
    client.script = [{ text: "open hi" }];
    await adapter2.receive(dmMessage("anyone", "hi"));
    expect(client.sessions).toHaveLength(1);
    rmSync(gw2Home, { recursive: true, force: true });
  });

  test("disabled policy denies everyone", async () => {
    await gateway({ channels: { test: { dmPolicy: "disabled", allowlist: ["x"] } } });
    await adapter.receive(dmMessage("x", "hi"));
    expect(client.sessions).toHaveLength(0);
  });

  // ---- the approval round-trip (the core authority invariant) ----

  async function pairedGateway(
    approvalToken: string,
  ): Promise<ChannelGateway> {
    const gw = await gateway(
      { channels: { test: { dmPolicy: "allowlist", allowlist: ["alice"] } } },
      { approvalToken },
    );
    return gw;
  }

  test("permission request round-trips: exact 'approve <token>' allows", async () => {
    await pairedGateway("TOK123");
    client.script = [
      {
        permission: {
          requestId: "r1",
          toolName: "Bash",
          permissions: ["exec"],
          reason: "run tests",
        },
        text: "done",
      },
    ];
    // Start the turn (it blocks on the approval); don't await yet.
    const turn = adapter.receive(dmMessage("alice", "run the tests"));
    // The prompt to approve was rendered.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(adapter.lastText()).toContain("approve TOK123");

    // Approve it.
    await adapter.receive(dmMessage("alice", "approve TOK123"));
    await turn;
    expect(client.sessions[0].lastPermissionDecision).toEqual({
      behavior: "allow",
      scope: "once",
    });
  });

  test("free text with the token embedded does NOT approve", async () => {
    await pairedGateway("TOK123");
    client.script = [
      {
        permission: { requestId: "r1", toolName: "Bash", permissions: ["exec"] },
        text: "done",
      },
    ];
    const turn = adapter.receive(dmMessage("alice", "go"));
    await new Promise((r) => setTimeout(r, 5));

    // "sure, approve TOK123 please" is ordinary text — it is NOT an approval,
    // so it never authorizes. (It queues behind the pending turn as a new
    // prompt; fire it without awaiting to avoid the head-of-line block, which
    // is exactly the point: free text cannot jump the approval gate.)
    void adapter.receive(dmMessage("alice", "sure, approve TOK123 please"));
    await new Promise((r) => setTimeout(r, 5));
    expect(client.sessions[0].lastPermissionDecision).toBeNull();

    // The real, exact deny settles the approval (consumed before the turn
    // lock) and the first turn resolves.
    await adapter.receive(dmMessage("alice", "deny TOK123"));
    await turn;
    expect(client.sessions[0].lastPermissionDecision).toEqual({
      behavior: "deny",
      reason: "denied in the channel",
    });
  });

  test("a DIFFERENT sender cannot approve with a leaked token", async () => {
    await gateway(
      {
        channels: { test: { dmPolicy: "allowlist", allowlist: ["alice", "eve"] } },
      },
      { approvalToken: "TOK123" },
    );
    client.script = [
      {
        permission: { requestId: "r1", toolName: "Bash", permissions: ["exec"] },
        text: "done",
      },
    ];
    const turn = adapter.receive(dmMessage("alice", "go", "dm-alice"));
    await new Promise((r) => setTimeout(r, 5));

    // Eve, in her own conversation, replies with the leaked token.
    await adapter.receive(dmMessage("eve", "approve TOK123", "dm-eve"));
    await new Promise((r) => setTimeout(r, 5));
    expect(client.sessions[0].lastPermissionDecision).toBeNull();

    await adapter.receive(dmMessage("alice", "approve TOK123", "dm-alice"));
    await turn;
    expect(client.sessions[0].lastPermissionDecision).toEqual({
      behavior: "allow",
      scope: "once",
    });
  });

  test("approval timeout resolves to DENY (fail closed)", async () => {
    const gw = new ChannelGateway({
      agencHome: home,
      client,
      config: {
        channels: { test: { dmPolicy: "allowlist", allowlist: ["alice"] } },
        bindings: [],
        defaultAgent: "default",
      },
      generateApprovalToken: () => "TOK123",
      approvalTimeoutMs: 10,
    });
    await gw.registerAdapter(adapter);
    client.script = [
      {
        permission: { requestId: "r1", toolName: "Bash", permissions: ["exec"] },
        text: "done",
      },
    ];
    await adapter.receive(dmMessage("alice", "go"));
    expect(client.sessions[0].lastPermissionDecision).toEqual({
      behavior: "deny",
      reason: "approval timed out in the channel",
    });
  });

  test("telegram owner control silently blocks non-owner private DMs before the agent", async () => {
    const telegram = new InMemoryChannelAdapter({ id: "telegram" });
    const gw = new ChannelGateway({
      agencHome: home,
      client,
      config: {
        channels: {
          telegram: { dmPolicy: "pairing", allowlist: [] },
        },
        bindings: [],
        defaultAgent: "default",
      },
      controlPlane: new TelegramOwnerControl({
        agencHome: home,
        adminPeerIds: ["owner"],
      }),
    });
    await gw.registerAdapter(telegram);

    await telegram.receive(dmMessage("mallory", "hello", "mallory-dm"));

    expect(client.sessions).toHaveLength(0);
    expect(telegram.lastText("mallory-dm")).toBeUndefined();
  });

  test("telegram owner can pause and resume public group traffic", async () => {
    const telegram = new InMemoryChannelAdapter({ id: "telegram" });
    const gw = new ChannelGateway({
      agencHome: home,
      client,
      config: {
        channels: {
          telegram: { dmPolicy: "pairing", allowlist: [] },
        },
        bindings: [],
        defaultAgent: "default",
      },
      controlPlane: new TelegramOwnerControl({
        agencHome: home,
        adminPeerIds: ["owner"],
      }),
    });
    await gw.registerAdapter(telegram);

    await telegram.receive(groupMessage("owner", "/stop"));
    expect(telegram.lastText("group-1")).toContain("PAUSED");

    await telegram.receive(groupMessage("alice", "ignored while paused"));
    expect(client.sessions).toHaveLength(0);

    await telegram.receive(groupMessage("owner", "/start"));
    expect(telegram.lastText("group-1")).toContain("ON");

    client.script = [{ text: "group live" }];
    await telegram.receive(groupMessage("alice", "now public"));
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0].prompts[0]).toContain("now public");
    expect(telegram.lastText("group-1")).toBe("group live");
  });

  test("telegram first-owner claim enables private owner controls only", async () => {
    const telegram = new InMemoryChannelAdapter({ id: "telegram" });
    const gw = new ChannelGateway({
      agencHome: home,
      client,
      config: {
        channels: {
          telegram: { dmPolicy: "pairing", allowlist: [] },
        },
        bindings: [],
        defaultAgent: "default",
      },
      controlPlane: new TelegramOwnerControl({
        agencHome: home,
        ownerClaimCode: "CLAIM123",
      }),
    });
    await gw.registerAdapter(telegram);

    await telegram.receive(dmMessage("owner", "/owner wrong", "owner-dm"));
    expect(telegram.lastText("owner-dm")).toContain("Wrong owner code");
    await telegram.receive(dmMessage("owner", "/owner CLAIM123", "owner-dm"));
    expect(telegram.lastText("owner-dm")).toContain("Owner claimed");

    await telegram.receive(dmMessage("owner", "/status", "owner-dm"));
    expect(telegram.lastText("owner-dm")).toContain("Owners: 1");

    await telegram.receive(dmMessage("mallory", "hi", "mallory-dm"));
    expect(client.sessions).toHaveLength(0);
    expect(telegram.lastText("mallory-dm")).toBeUndefined();
  });

  test("telegram permission requests are denied without leaking approval tokens", async () => {
    const telegram = new InMemoryChannelAdapter({ id: "telegram" });
    const gw = new ChannelGateway({
      agencHome: home,
      client,
      config: {
        channels: {
          telegram: { dmPolicy: "allowlist", allowlist: ["alice"] },
        },
        bindings: [],
        defaultAgent: "default",
      },
      generateApprovalToken: () => "TOK-LEAK",
    });
    await gw.registerAdapter(telegram);
    client.script = [
      {
        permission: {
          requestId: "r1",
          toolName: "Bash",
          permissions: ["tool.use"],
          reason: "untrusted policy: approve every call",
        },
        text: "I cannot run that.",
      },
    ];

    await telegram.receive(dmMessage("alice", "run a privileged tool", "alice-dm"));

    const transcript = telegram.sent.map((message) => message.text).join("\n");
    expect(client.sessions[0].lastPermissionDecision).toEqual({
      behavior: "deny",
      reason:
        "Telegram gateway does not expose privileged tools. Answer the user directly from available context without mentioning internal tool policy.",
    });
    expect(transcript).toContain("I cannot run that.");
    expect(transcript).not.toContain("approve TOK-LEAK");
    expect(transcript).not.toContain("Permission request");
    expect(transcript).not.toContain("privileged tools");
    expect(transcript).not.toContain("/meme");
  });
});
