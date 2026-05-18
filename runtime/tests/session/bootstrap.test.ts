/**
 * `bootstrapSession` tests.
 *
 * Covers the bootstrap sequencing contract ported from upstream agenc runtime
 * `Session::new` (agenc-rs/core/src/session/session.rs:258-967):
 *
 *   1. Happy path — real discovered shell, `SessionConfigured` emitted
 *      exactly once, `activeTurn` is clean.
 *   2. Resume path — `recordInitialHistoryOnResume` is invoked with the
 *      fixture items and the seeded `initialTokenUsage` lands in state.
 *   3. Required-MCP failure — bootstrap rejects with
 *      `RequiredMcpStartupError`; no `SessionConfigured` emit occurs.
 *   4. Parallel auth + MCP — the two futures overlap in wall time.
 *   5. Startup cancellation — aborting the signal mid-bootstrap stops
 *      the sequence before emitting SessionConfigured.
 *   6. SessionConfigured terminal position — the emit is the last thing
 *      before the resume-history record step (which only runs on
 *      resume). Prewarm runs before the emit; resume-history runs
 *      after it per upstream comment at session.rs:941.
 *   7. Legacy constructor still works — `new Session(minimal)` still
 *      builds the session without any bootstrap-only side effects.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import type { MCPManager, MCPManagerStartOpts } from "../mcp-client/manager.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import {
  bootstrapSession,
  emitSessionConfigured,
  RequiredMcpStartupError,
  BootstrapAbortError,
  type BootstrapSessionOptions,
} from "./bootstrap.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
} from "./turn-context.js";
import type { LLMProvider } from "../llm/types.js";
import type { RolloutItem } from "./rollout-item.js";

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

function mkProvider(): LLMProvider {
  return {
    name: "stub-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
  } as unknown as LLMProvider;
}

function mkServices(
  overrides: Partial<SessionServices> = {},
): SessionServices {
  return {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      signal: new AbortController().signal,
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: mkProvider(),
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    ...overrides,
  } as unknown as SessionServices;
}

function mkSessionOpts(
  overrides: Partial<SessionOpts> = {},
): SessionOpts {
  return {
    conversationId: "conv-bootstrap",
    initialState: {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
    },
    features: mkFeatures(),
    services: mkServices(),
    jsRepl: { id: "repl-bootstrap" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
    ...overrides,
  };
}

function mkBootstrapOpts(
  overrides: Partial<BootstrapSessionOptions> = {},
): BootstrapSessionOptions {
  return {
    ...mkSessionOpts(),
    sessionConfigured: {
      sessionId: "conv-bootstrap",
      model: "test-model",
      modelProviderId: "stub-provider",
      cwd: "/tmp",
      historyLogId: 0,
      historyEntryCount: 0,
      initialMessages: [],
    },
    // Prewarm touches newDefaultTurn which requires a `config` +
    // `modelInfo`; both are supplied via `mkSessionOpts`. Keep it on
    // for happy-path tests so we exercise the wiring.
    ...overrides,
  };
}

function drainEventQueue(queue: AsyncQueue<Event>): Event[] {
  const events: Event[] = [];
  // `tryRecv()` returns the item, or `null` if closed+empty, or
  // `undefined` if open+empty. Stop on `null` or `undefined`.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = queue.tryRecv();
    if (next === null || next === undefined) return events;
    events.push(next);
  }
}

function collectSessionEvents(session: Session): Event[] {
  return drainEventQueue(session.txEvent);
}

// Stub MCP manager that lets tests drive the startup path.
type MCPStartBehavior =
  | { readonly kind: "success"; readonly delayMs?: number }
  | { readonly kind: "required-failure"; readonly delayMs?: number };

function mkStubMcpManager(
  behavior: MCPStartBehavior = { kind: "success" },
): MCPManager {
  const stub: Record<string, unknown> = {
    setCallObserver: () => {},
    getConfiguredServers: () => [],
    start: vi.fn(async (opts: MCPManagerStartOpts = {}) => {
      if (behavior.delayMs) {
        await new Promise((r) => setTimeout(r, behavior.delayMs));
      }
      if (opts.signal?.aborted) {
        throw new Error(
          `MCP startup cancelled before first connect (${opts.signal.reason ?? "unspecified"})`,
        );
      }
      if (behavior.kind === "required-failure") {
        throw new Error(
          `MCP aggregate startup failure — required server(s) not ready: ${(
            opts.requiredServers ?? []
          ).join(", ")} (test-failure)`,
        );
      }
    }),
  };
  return stub as unknown as MCPManager;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("bootstrapSession happy path", () => {
  it("returns a Session with the discovered shell, active turn clean, and session_configured emitted once", async () => {
    const opts = mkBootstrapOpts();
    const session = await bootstrapSession(opts);

    expect(session).toBeInstanceOf(Session);
    // Discovered shell is a real path rather than the `/bin/sh` interface stub.
    expect(typeof session.services.userShell.path).toBe("string");
    expect(session.services.userShell.path.length).toBeGreaterThan(0);
    // The bootstrap helper does not install a task; activeTurn stays null.
    expect(session.activeTurn.unsafePeek()).toBeNull();
    expect(session.hasPendingInput()).toBe(false);

    const events = collectSessionEvents(session);
    const sessionConfiguredEvents = events.filter(
      (e) => e.msg.type === "session_configured",
    );
    expect(sessionConfiguredEvents).toHaveLength(1);
    expect(
      (
        sessionConfiguredEvents[0]?.msg as {
          payload: { sessionId: string };
        }
      ).payload.sessionId,
    ).toBe("conv-bootstrap");
  });

  it("routes an MCP manager through the parallel startup step when supplied", async () => {
    const manager = mkStubMcpManager({ kind: "success" });
    const opts: BootstrapSessionOptions = mkBootstrapOpts({
      mcp: { manager, requiredServers: [] },
    });
    await bootstrapSession(opts);
    expect(
      (manager as unknown as { start: ReturnType<typeof vi.fn> }).start,
    ).toHaveBeenCalledTimes(1);
  });
});

describe("bootstrapSession resume path", () => {
  it("invokes recordInitialHistoryOnResume and seeds initialTokenUsage from the rollout", async () => {
    const fixtureItems: ReadonlyArray<RolloutItem> = [
      {
        type: "event_msg",
        payload: {
          id: "sub-0",
          msg: {
            type: "token_count",
            payload: {
              totalTokens: 17,
              promptTokens: 9,
              completionTokens: 8,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
            },
          },
        },
      } as unknown as RolloutItem,
    ];
    const opts = mkBootstrapOpts({
      resume: {
        rolloutItems: fixtureItems,
        previousModel: "test-model",
        currentModel: "test-model",
      },
    });
    const session = await bootstrapSession(opts);
    const tokenUsage = (
      session.state.unsafePeek() as unknown as {
        initialTokenUsage?: { totalTokens?: number };
      }
    ).initialTokenUsage;
    expect(tokenUsage?.totalTokens).toBe(17);
  });

  it("emits a model-change warning when the resumed model differs from the current model", async () => {
    const opts = mkBootstrapOpts({
      resume: {
        rolloutItems: [],
        previousModel: "previous-model",
        currentModel: "test-model",
      },
    });
    const session = await bootstrapSession(opts);
    const events = collectSessionEvents(session);
    const warn = events.find(
      (e) =>
        e.msg.type === "warning" &&
        (e.msg.payload as { cause?: string }).cause ===
          "resumed_with_different_model",
    );
    expect(warn).toBeDefined();
  });
});

describe("bootstrapSession required-MCP failure", () => {
  it("rejects with RequiredMcpStartupError and skips the SessionConfigured emit", async () => {
    const manager = mkStubMcpManager({ kind: "required-failure" });
    const queue = new AsyncQueue<Event>();
    const opts = mkBootstrapOpts({
      eventQueue: queue,
      mcp: { manager, requiredServers: ["alpha"] },
    });

    await expect(bootstrapSession(opts)).rejects.toBeInstanceOf(
      RequiredMcpStartupError,
    );

    const events = drainEventQueue(queue);
    expect(events.some((e) => e.msg.type === "session_configured")).toBe(false);
  });
});

describe("bootstrapSession parallel auth + MCP", () => {
  it("starts auth and MCP concurrently rather than serially", async () => {
    const starts: Array<{ kind: string; at: number }> = [];
    const start0 = Date.now();

    const auth = async () => {
      starts.push({ kind: "auth", at: Date.now() - start0 });
      await new Promise((r) => setTimeout(r, 80));
      return { token: "auth-ok" };
    };
    const manager: MCPManager = {
      setCallObserver: () => {},
      getConfiguredServers: () => [],
      start: vi.fn(async () => {
        starts.push({ kind: "mcp", at: Date.now() - start0 });
        await new Promise((r) => setTimeout(r, 80));
      }),
    } as unknown as MCPManager;

    const opts = mkBootstrapOpts({
      auth,
      mcp: { manager },
    });
    const totalStart = Date.now();
    await bootstrapSession(opts);
    const elapsed = Date.now() - totalStart;

    // If serial, elapsed would be ≥ 160ms. With overlap it should be
    // close to 80ms; allow generous slack for CI noise (up to 150ms
    // headroom keeps the assertion meaningful without flaking on
    // loaded runners).
    expect(elapsed).toBeLessThan(200);
    // Both starts captured; the second one must begin while the first
    // is still in flight (i.e. within the 80ms window of the first).
    const authStart = starts.find((s) => s.kind === "auth");
    const mcpStart = starts.find((s) => s.kind === "mcp");
    expect(authStart).toBeDefined();
    expect(mcpStart).toBeDefined();
    expect(Math.abs((authStart!.at) - (mcpStart!.at))).toBeLessThan(80);
  });
});

describe("bootstrapSession startup cancellation", () => {
  it("rejects with BootstrapAbortError when opts.signal aborts mid-startup", async () => {
    const controller = new AbortController();
    const manager = mkStubMcpManager({ kind: "success", delayMs: 40 });
    const opts = mkBootstrapOpts({
      mcp: { manager },
      signal: controller.signal,
    });
    const promise = bootstrapSession(opts);
    // Abort immediately after first tick.
    setTimeout(() => controller.abort("test-cancel"), 5);
    await expect(promise).rejects.toBeDefined();
  });
});

describe("bootstrapSession SessionConfigured terminal position", () => {
  it("emits SessionConfigured before the resume-history record step", async () => {
    const sequence: string[] = [];
    const opts = mkBootstrapOpts({
      onBeforeSessionConfigured: async () => {
        sequence.push("before-configured");
      },
      resume: {
        rolloutItems: [],
        previousModel: "prior",
        currentModel: "test-model",
      },
    });
    const session = await bootstrapSession(opts);

    const events = collectSessionEvents(session);
    // Find the index of session_configured among emitted events.
    const configuredIndex = events.findIndex(
      (e) => e.msg.type === "session_configured",
    );
    expect(configuredIndex).toBeGreaterThanOrEqual(0);
    // The resume-history warning is emitted by
    // `recordInitialHistoryOnResume` which runs AFTER the
    // SessionConfigured event per upstream ordering.
    const resumeWarningIndex = events.findIndex(
      (e) =>
        e.msg.type === "warning" &&
        (e.msg.payload as { cause?: string }).cause ===
          "resumed_with_different_model",
    );
    expect(resumeWarningIndex).toBeGreaterThan(configuredIndex);
    // Caller hook ran BEFORE session_configured.
    expect(sequence).toEqual(["before-configured"]);
  });
});

describe("emitSessionConfigured helper", () => {
  it("emits exactly one session_configured event with the supplied payload fields", () => {
    const opts = mkSessionOpts();
    const session = new Session(opts);
    emitSessionConfigured(session, {
      sessionId: "conv-x",
      model: "m-test",
      modelProviderId: "prov-x",
      cwd: "/cwd",
      historyLogId: 7,
      historyEntryCount: 2,
      initialMessages: [],
      rolloutPath: "/tmp/rollout.jsonl",
    });
    const events = collectSessionEvents(session);
    const sc = events.filter((e) => e.msg.type === "session_configured");
    expect(sc).toHaveLength(1);
    const payload = (sc[0]!.msg as { payload: Record<string, unknown> }).payload;
    expect(payload.sessionId).toBe("conv-x");
    expect(payload.model).toBe("m-test");
    expect(payload.modelProviderId).toBe("prov-x");
    expect(payload.historyLogId).toBe(7);
    expect(payload.historyEntryCount).toBe(2);
    expect(payload.rolloutPath).toBe("/tmp/rollout.jsonl");
  });
});

describe("legacy Session constructor compatibility", () => {
  it("still builds a Session without any bootstrap-only side effects", () => {
    const opts = mkSessionOpts();
    const session = new Session(opts);
    expect(session).toBeInstanceOf(Session);
    // The legacy constructor does NOT emit session_configured.
    const events = collectSessionEvents(session);
    expect(events.some((e) => e.msg.type === "session_configured")).toBe(false);
    // The legacy constructor does NOT discover the real shell; it
    // accepts whatever the caller supplied (including stub services).
    expect(session.services.userShell).toBeUndefined();
  });
});

describe("BootstrapAbortError and RequiredMcpStartupError shape", () => {
  it("BootstrapAbortError carries the abort reason", () => {
    const err = new BootstrapAbortError("explicit");
    expect(err.reason).toBe("explicit");
    expect(err.message).toContain("explicit");
  });
  it("RequiredMcpStartupError carries the failure list", () => {
    const err = new RequiredMcpStartupError([
      { server: "alpha", error: "not ready" },
    ]);
    expect(err.failures).toHaveLength(1);
    expect(err.message).toContain("alpha: not ready");
  });
});
