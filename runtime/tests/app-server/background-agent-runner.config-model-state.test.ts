import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
} from "../../src/app-server/background-agent-runner.js";
import type { AgentStatus } from "../../src/agents/status.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import {
  getActiveConfigModel,
  setActiveConfigModel,
} from "../../src/bootstrap/state.js";

function makeStubConversationThreadManager(threadId: string) {
  let listeners: ((status: AgentStatus) => void)[] = [];
  let currentStatus: AgentStatus = {
    status: "running",
    turnId: "turn-stub",
    startedAtMs: 0,
  } as AgentStatus;
  const managedThread = {
    threadId,
    agentPath: "/root",
    kind: "root" as const,
    status: () => currentStatus,
    subscribeStatus: (cb: (status: AgentStatus) => void) => {
      cb(currentStatus);
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((listener) => listener !== cb);
      };
    },
    submit: vi.fn(async () => threadId),
    appendMessage: vi.fn(async () => threadId),
    shutdown: vi.fn(async () => {}),
    totalTokenUsage: () => ({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    configSnapshot: () => ({}),
  };
  return {
    hasThread: (id: string) => id === threadId,
    getThread: (id: string) => {
      if (id !== threadId) {
        throw new Error(`stub conversationThreadManager has no thread ${id}`);
      }
      return managedThread;
    },
    removeThread: vi.fn(() => managedThread),
    thread: managedThread,
  };
}

/**
 * Minimal in-process runner harness with a session that exposes the
 * config-apply + model-switch surfaces (configStore, sessionConfiguration
 * state, and setPendingProviderSwitch) used by applyAgentConfig/setAgentModel.
 * Mirrors the shape of the real in-process Session.
 */
function makeRunnerHarness(opts: {
  readonly configStore: Record<string, unknown>;
  readonly sessionConfiguration?: Record<string, unknown>;
  readonly onStagedSwitch?: (spec: {
    provider: string;
    model: string;
    profile?: string;
  }) => void;
}) {
  const conversationId = "parent-session";
  const permissionModeRegistry = {
    current: () => createEmptyToolPermissionContext(),
    update: vi.fn(async (_context: ToolPermissionContext) => {}),
  };
  const stub = makeStubConversationThreadManager(conversationId);
  const eventLogSubscribers: Array<(event: unknown) => void> = [];
  const phaseSubscribers: Array<(phase: unknown) => void> = [];
  const stateObject = {
    sessionConfiguration: opts.sessionConfiguration ?? {
      collaborationMode: { model: "base-model" },
      provider: { slug: "openai" },
    },
  };
  const session = {
    conversationId,
    permissionModeRegistry,
    eventLog: {
      subscribe: (listener: (event: unknown) => void) => {
        eventLogSubscribers.push(listener);
        return () => {
          const index = eventLogSubscribers.indexOf(listener);
          if (index >= 0) eventLogSubscribers.splice(index, 1);
        };
      },
    },
    subscribeToEvents: (listener: (phase: unknown) => void) => {
      phaseSubscribers.push(listener);
      return () => {
        const index = phaseSubscribers.indexOf(listener);
        if (index >= 0) phaseSubscribers.splice(index, 1);
      };
    },
    emit: vi.fn(),
    services: {
      conversationThreadManager: stub,
      configStore: opts.configStore,
    },
    setPendingProviderSwitch: (spec: {
      provider: string;
      model: string;
      profile?: string;
    }) => {
      opts.onStagedSwitch?.(spec);
    },
    state: {
      unsafePeek: () => stateObject,
      with: async (fn: (state: unknown) => void) => {
        fn(stateObject);
      },
    },
  };
  const control = {
    shutdown: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(),
    openThreadSpawnChildren: vi.fn(() => []),
    clearConversationHistory: vi.fn(async () => {}),
  };
  const bootstrap = vi.fn(async () => ({
    session,
    registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
    shutdown: vi.fn(async () => {}),
  })) as unknown as ReturnType<typeof vi.fn> & AgenCBootstrapFunction;
  const runner = new AgenCDelegateBackgroundAgentRunner({
    bootstrap,
    ensureAgentControl: vi.fn(() => ({
      control,
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction,
    argv: ["node", "agenc"],
    now: () => "2026-05-09T00:00:00.000Z",
  });
  return { runner, session, stateObject };
}

describe("daemon config/model state refresh + atomicity", () => {
  afterEach(() => {
    // Reset the process-global so cross-test order can't leak a selection.
    setActiveConfigModel(undefined);
  });

  // GAP #4: the model-switch path must refresh the process-global
  // activeConfigModel so the util-layer model helpers stop reading the stale
  // startup selection for the daemon's life.
  it("setAgentModel refreshes activeConfigModel on an applied switch", async () => {
    setActiveConfigModel({ provider: "openai", model: "startup-model" });
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => ({ model: "base-model", model_provider: "openai" }),
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.setAgentModel("parent-session", {
      sessionId: "session_1",
      model: "switched-model",
      provider: "openai",
    });

    expect(result.applied).toBe(true);
    expect(getActiveConfigModel()).toEqual({
      provider: "openai",
      model: "switched-model",
    });
  });

  it("setAgentModel fills the provider from the live session when only a model is supplied", async () => {
    setActiveConfigModel({ provider: "openai", model: "startup-model" });
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => ({ model: "base-model", model_provider: "openai" }),
      },
      sessionConfiguration: {
        collaborationMode: { model: "base-model" },
        provider: { slug: "openai" },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.setAgentModel("parent-session", {
      sessionId: "session_1",
      model: "switched-model",
    });

    expect(result.applied).toBe(true);
    expect(getActiveConfigModel()).toEqual({
      provider: "openai",
      model: "switched-model",
    });
  });

  // bug-audit-2026-07-11.md #10: a provider-only switch is staged for the
  // NEXT turn, so the live session still reports the pre-switch selection.
  // Backfilling that model produced mixed pairs like {provider: "grok",
  // model: "qwen3-coder-next-fp8"} in the process-global, which later daemon
  // sessions inherited and sent to the wrong API.
  it("setAgentModel does NOT poison activeConfigModel with the pre-switch model on a provider-only switch", async () => {
    setActiveConfigModel({ provider: "openai-compatible", model: "qwen-local" });
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => ({
          model: "qwen-local",
          model_provider: "openai-compatible",
        }),
      },
      sessionConfiguration: {
        collaborationMode: { model: "qwen-local" },
        provider: { slug: "openai-compatible" },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.setAgentModel("parent-session", {
      sessionId: "session_1",
      provider: "grok",
    });

    expect(result.applied).toBe(true);
    // The pre-switch qwen model must never be paired with the new provider.
    expect(getActiveConfigModel()).not.toEqual({
      provider: "grok",
      model: "qwen-local",
    });
  });

  it("applyAgentConfig refreshes activeConfigModel when a profile stages a switch", async () => {
    setActiveConfigModel({ provider: "openai", model: "startup-model" });
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => ({
          model: "base-model",
          model_provider: "openai",
          profiles: {
            fast: { model: "fast-model", model_provider: "openai" },
          },
        }),
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      profile: "fast",
    });

    expect(result.applied).toBe(true);
    expect(getActiveConfigModel()).toEqual({
      provider: "openai",
      model: "fast-model",
    });
  });

  // GAP #12: an unknown profile must be a true no-op — the shared config store
  // must NOT have been reloaded (mutated + subscribers fired) before the
  // unknown-profile error surfaces.
  it("applyAgentConfig with reload rejects an unknown profile WITHOUT reloading the shared store", async () => {
    const reload = vi.fn(async () => ({}));
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => ({
          model: "base-model",
          model_provider: "openai",
          profiles: {
            fast: { model: "fast-model", model_provider: "openai" },
          },
        }),
        reload,
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.applyAgentConfig("parent-session", {
        sessionId: "session_1",
        profile: "does-not-exist",
        reload: true,
      }),
    ).rejects.toThrow(/Unknown profile/);

    // The reload is the mutation that advances the shared snapshot + fires
    // subscribers. A non-atomic implementation would have already called it
    // before validating the profile.
    expect(reload).not.toHaveBeenCalled();
  });

  it("applyAgentConfig still reloads + stages for a known profile", async () => {
    const reload = vi.fn(async () => ({}));
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => ({
          model: "base-model",
          model_provider: "openai",
          profiles: {
            fast: { model: "fast-model", model_provider: "openai" },
          },
        }),
        reload,
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      profile: "fast",
      reload: true,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.summary).toContain("config reloaded from disk");
  });
});
