/**
 * T11 Wave 3-A integration tests for `Session` and the turn-context
 * plumbing that consumes the per-session permission-mode registry.
 *
 * Covers:
 *   - `SessionServices.permissionModeRegistry` default bootstrap when the
 *     caller omits it (tests used to loose-cast through `unknown`).
 *   - `Session.setPendingProviderSwitch(...)` typed mutator honours the
 *     null-clear path.
 *   - `TurnContext.permissionMode` is the I-30 snapshot of the registry
 *     at `buildTurnContext` time.
 *   - Mutating the registry AFTER the TurnContext is built does NOT
 *     mutate the pinned per-turn snapshot (I-30 invariant).
 *   - `isPlanMode` returns true when `permissionContext.mode === "plan"`.
 */

import { describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import {
  Session,
  type Event,
  type PendingProviderSwitch,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import type { PendingWorktreeState } from "./pending-worktree.js";
import {
  buildTurnContext,
  newDefaultTurnWithSubId,
  type Config,
  type ManagedFeatures,
  type ModelInfo,
  type SessionConfiguration,
  type SessionForTurn,
} from "./turn-context.js";
import { isPlanMode } from "./plan-mode.js";
import type { TurnContext } from "./turn-context.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import type { LLMProvider } from "../llm/types.js";

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

/**
 * Minimal `Session` builder for the W3 integration tests. Mirrors the
 * loose-cast approach in `idle-input.test.ts` so the constructor's
 * permission-registry bootstrap is exercised.
 */
function buildSession(
  overrides: { services?: Partial<SessionServices> } = {},
): Session {
  const services = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: mkProvider(),
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    ...(overrides.services ?? {}),
  } as unknown as SessionServices;
  const opts: SessionOpts = {
    conversationId: "conv-test",
    initialState: {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
    },
    features: mkFeatures(),
    services,
    jsRepl: { id: "repl-test" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  };
  return new Session(opts);
}

function ctxWithPermissionMode(mode: PermissionMode): ToolPermissionContext {
  return {
    ...createEmptyToolPermissionContext(),
    mode,
  };
}

// ─────────────────────────────────────────────────────────────────────
// SessionServices.permissionModeRegistry bootstrap
// ─────────────────────────────────────────────────────────────────────

describe("SessionServices.permissionModeRegistry default bootstrap", () => {
  it("constructs a default registry when services.permissionModeRegistry is omitted", () => {
    const session = buildSession();
    // The registry must exist after construction even though the caller
    // cast the services through `unknown` without supplying one.
    const registry = session.services.permissionModeRegistry;
    expect(registry).toBeInstanceOf(PermissionModeRegistry);
    expect(registry.current().mode).toBe("default");
  });

  it("preserves a caller-supplied registry instead of replacing it", () => {
    const supplied = new PermissionModeRegistry(
      ctxWithPermissionMode("acceptEdits"),
    );
    const session = buildSession({
      services: { permissionModeRegistry: supplied },
    });
    expect(session.services.permissionModeRegistry).toBe(supplied);
    expect(session.services.permissionModeRegistry.current().mode).toBe(
      "acceptEdits",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Session.setPendingProviderSwitch
// ─────────────────────────────────────────────────────────────────────

describe("Session.setPendingProviderSwitch", () => {
  it("assigns a well-typed pending switch record", () => {
    const session = buildSession();
    const pending: PendingProviderSwitch = {
      provider: "xai",
      model: "grok-4-fast",
    };
    session.setPendingProviderSwitch(pending);
    expect(session.pendingProviderSwitch).toEqual(pending);
  });

  it("clears the slot when passed null", () => {
    const session = buildSession();
    session.setPendingProviderSwitch({
      provider: "xai",
      model: "grok-4-fast",
    });
    expect(session.pendingProviderSwitch).not.toBeNull();
    session.setPendingProviderSwitch(null);
    expect(session.pendingProviderSwitch).toBeNull();
  });

  it("round-trips the optional profile slot (T11 W2 extension)", () => {
    const session = buildSession();
    session.setPendingProviderSwitch({
      provider: "xai",
      model: "grok-4-fast",
      profile: "coding",
    });
    expect(session.pendingProviderSwitch?.profile).toBe("coding");
  });
});

describe("Session.setPendingWorktreeState", () => {
  it("stores and clears the active worktree binding", () => {
    const session = buildSession();
    const pending: PendingWorktreeState = {
      handle: {
        path: "/repo/.agenc-worktrees/feat",
        branch: "worktree-feat",
        gitRoot: "/repo",
        created: true,
      },
      baseCommit: "abc123",
      originalCwd: "/repo",
    };

    session.setPendingWorktreeState(pending);
    expect(session.pendingWorktreeState).toEqual(pending);

    session.setPendingWorktreeState(null);
    expect(session.pendingWorktreeState).toBeNull();
  });
});

describe("Session.abortTerminal", () => {
  it("emits turn_aborted with the real active turn id", async () => {
    const session = buildSession();
    await session.activeTurn.swap({
      turnId: "turn-live",
      startedAtMs: 123,
      abortController: new AbortController(),
    });

    session.abortTerminal("stdin_lost");

    const emitted = session.txEvent.tryRecv();
    expect(emitted).toMatchObject({
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: "turn-live",
          reason: "stdin_lost",
        },
      },
    });
  });

  it("omits turnId when no turn is active", () => {
    const session = buildSession();

    session.abortTerminal("signal_received");

    const emitted = session.txEvent.tryRecv();
    expect(emitted).toMatchObject({
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: undefined,
          reason: "signal_received",
        },
      },
    });
  });
});

describe("Session MCP ownership seams", () => {
  it("startMcpManager delegates attach/start ordering through the session boundary", async () => {
    const session = buildSession();
    const setCallObserver = vi.fn();
    const start = vi.fn().mockResolvedValue(undefined);
    const manager = {
      setCallObserver,
      start,
    } as unknown as Parameters<Session["startMcpManager"]>[0];

    await session.startMcpManager(manager);

    expect(setCallObserver).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(setCallObserver.mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0]!,
    );
  });

  it("hasPendingInput reflects queued mailbox traffic", () => {
    const session = buildSession();
    expect(session.hasPendingInput()).toBe(false);
    session.enqueueIdleInput({ role: "user", content: "queued" });
    expect(session.hasPendingInput()).toBe(true);
  });
});

describe("Session turn-driver hooks", () => {
  it("fans out phase events through subscribeToEvents", () => {
    const session = buildSession();
    const seen: Array<{ type: string }> = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      seen.push(event as { type: string });
    });

    session.emitPhaseEvent({ type: "turn_start", turnIndex: 0 });
    expect(seen).toEqual([{ type: "turn_start", turnIndex: 0 }]);

    unsubscribe();
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      stopReason: "completed",
    });
    expect(seen).toEqual([{ type: "turn_start", turnIndex: 0 }]);
  });

  it("serializes submit calls through the installed hook", async () => {
    const session = buildSession();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    session.installTurnDriverHooks({
      submit: vi.fn(async (message: string) => {
        started.push(message);
        if (message === "first") {
          await firstGate;
        }
      }),
    });

    const first = session.submit("first");
    const second = session.submit("second");
    await Promise.resolve();
    expect(started).toEqual(["first"]);

    releaseFirst();
    await first;
    await second;
    expect(started).toEqual(["first", "second"]);
  });

  it("flushEventLog falls back to the rollout store when no hook is installed", async () => {
    const session = buildSession();
    const flushDurable = vi.fn();
    session.rolloutStore = {
      flushDurable,
    } as unknown as Session["rolloutStore"];

    await session.flushEventLog();
    expect(flushDurable).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// TurnContext.permissionMode snapshot (I-30)
// ─────────────────────────────────────────────────────────────────────

describe("TurnContext.permissionMode (I-30 snapshot)", () => {
  it("reflects the registry state at buildTurnContext time", () => {
    const ctx = buildTurnContext({
      conversationId: "conv-tcs",
      subId: "sub-1",
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      sessionConfiguration: mkSessionConfiguration(),
      permissionMode: "plan",
      clock: { currentDate: "2026-04-20", timezone: "Etc/UTC" },
    });
    expect(ctx.permissionMode).toBe("plan");
  });

  it("defaults to 'default' when no permissionMode is provided", () => {
    const ctx = buildTurnContext({
      conversationId: "conv-tcs2",
      subId: "sub-1",
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      sessionConfiguration: mkSessionConfiguration(),
      clock: { currentDate: "2026-04-20", timezone: "Etc/UTC" },
    });
    expect(ctx.permissionMode).toBe("default");
  });

  it("newDefaultTurnWithSubId pins the snapshot from the session's registry", () => {
    const registry = new PermissionModeRegistry(
      ctxWithPermissionMode("acceptEdits"),
    );
    let subSeq = 0;
    const sessionLike: SessionForTurn = {
      conversationId: "conv-snap",
      sessionConfiguration: mkSessionConfiguration(),
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      permissionModeRegistry: registry,
      nextInternalSubId: () => `sub-${++subSeq}`,
    };
    const ctx = newDefaultTurnWithSubId(sessionLike, "sub-7");
    expect(ctx.permissionMode).toBe("acceptEdits");
  });

  it("Session.newDefaultTurnWithSubId uses the session-owned builder path", () => {
    const registry = new PermissionModeRegistry(
      ctxWithPermissionMode("acceptEdits"),
    );
    const session = buildSession({
      services: { permissionModeRegistry: registry },
    });
    const ctx = session.newDefaultTurnWithSubId("sub-owned");
    expect(ctx.subId).toBe("sub-owned");
    expect(ctx.permissionMode).toBe("acceptEdits");
    expect(ctx.config.model).toBe("test-model");
  });

  it("I-30: mutating the registry after buildTurnContext does not mutate the snapshot", async () => {
    const registry = new PermissionModeRegistry(
      ctxWithPermissionMode("default"),
    );
    let subSeq = 0;
    const sessionLike: SessionForTurn = {
      conversationId: "conv-i30",
      sessionConfiguration: mkSessionConfiguration(),
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      permissionModeRegistry: registry,
      nextInternalSubId: () => `sub-${++subSeq}`,
    };
    const ctx = newDefaultTurnWithSubId(sessionLike, "sub-a");
    expect(ctx.permissionMode).toBe("default");

    // Registry flips mid-turn — the snapshot on the already-built
    // TurnContext must remain pinned to the construction-time mode.
    await registry.update(ctxWithPermissionMode("plan"));
    expect(registry.current().mode).toBe("plan");
    expect(ctx.permissionMode).toBe("default");

    // Evaluator I-3 re-reads (live registry) see the new mode, proving
    // the two slots are intentionally decoupled.
    expect(registry.current().mode).not.toBe(ctx.permissionMode);
  });
});

// ─────────────────────────────────────────────────────────────────────
// isPlanMode gate (T11 W3 wiring)
// ─────────────────────────────────────────────────────────────────────

describe("isPlanMode via sessionConfiguration.permissionContext.mode", () => {
  it("returns true when the permission context is in plan mode", () => {
    const ctx = {
      subId: "t-plan",
      collaborationMode: { model: "test-model" },
      sessionConfiguration: {
        permissionContext: { mode: "plan" as const },
      },
    } as unknown as TurnContext;
    expect(isPlanMode(ctx)).toBe(true);
  });

  it("returns false when the permission context is any non-plan mode", () => {
    for (const mode of [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "dontAsk",
      "auto",
      "bubble",
    ] as const) {
      const ctx = {
        subId: "t-nonplan",
        collaborationMode: { model: "test-model" },
        sessionConfiguration: {
          permissionContext: { mode },
        },
      } as unknown as TurnContext;
      expect(isPlanMode(ctx)).toBe(false);
    }
  });
});
