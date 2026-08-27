import { describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
} from "../../src/app-server/background-agent-runner.js";
import type { AgentStatus } from "../../src/agents/status.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import {
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
  sessionConfigurationFromAgenCConfig,
  sessionExecutionAuthorityFromAgenCConfig,
} from "../../src/session/configuration.js";

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
  const permissionModeRegistry = new PermissionModeRegistry(
    createEmptyToolPermissionContext(),
  );
  const stub = makeStubConversationThreadManager(conversationId);
  const eventLogSubscribers: Array<(event: unknown) => void> = [];
  const phaseSubscribers: Array<(phase: unknown) => void> = [];
  const baseConfiguration = sessionConfigurationFromAgenCConfig({
    config: {},
    workspaceRoot: process.cwd(),
    model: "base-model",
    provider: "openai",
    projectTrust: "trusted",
  });
  const stateObject = {
    sessionConfiguration: {
      ...baseConfiguration,
      ...(opts.sessionConfiguration ?? {}),
    },
  };
  const rolloutItems: unknown[] = [];
  let lastSeq = 0;
  const configStore = {
    projectRoot: process.cwd(),
    stateRepository: {
      reload: vi.fn(() => ({})),
      getNamespace: vi.fn(() => ({})),
    },
    authoritySnapshot: () => ({ config: {}, layers: [] }),
    sources: () => [],
    ...opts.configStore,
  };
  if (typeof configStore.prepareReload !== "function") {
    Object.assign(configStore, {
      prepareReload: async () => {
        const previous = configStore.current() as Record<string, unknown>;
        const staged =
          typeof configStore.reload === "function"
            ? await configStore.reload()
            : previous;
        let state: "prepared" | "committed" | "published" | "rolled_back" =
          "prepared";
        let settled = false;
        const authority = {
          ...configStore,
          current: () => staged,
          authoritySnapshot: () => ({ config: staged, layers: [] }),
          sources: () => [],
          ignored: () => [],
          warnings: () => [],
          provenance: () => undefined,
        };
        return {
          config: staged,
          authority,
          get state() {
            return state;
          },
          get settled() {
            return settled;
          },
          commit: () => {
            state = "committed";
          },
          publish: () => {
            state = "published";
          },
          rollback: () => {
            state = "rolled_back";
          },
          settle: () => {
            settled = true;
          },
        };
      },
    });
  }
  let configuredExecutionAuthority = sessionExecutionAuthorityFromAgenCConfig({
    config: {},
    workspaceRoot: process.cwd(),
    projectTrust: "trusted",
  });
  const sandboxExecutionBroker = new SandboxExecutionBroker({
    cwd: process.cwd(),
    ...sandboxExecutionBrokerAuthorityFromSessionAuthority(
      configuredExecutionAuthority,
      process.cwd(),
    ),
  });
  const session = {
    abortController: new AbortController(),
    abortTerminal: vi.fn(),
    conversationId,
    permissionModeRegistry,
    get sessionConfiguration() {
      return stateObject.sessionConfiguration;
    },
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
    prepareEmit: vi.fn((event: Record<string, unknown>) => {
      const stamped = { ...event, seq: ++lastSeq };
      rolloutItems.push({ type: "event_msg", payload: stamped });
      return { event: stamped, publish: () => stamped };
    }),
    publishPreparedEvent: vi.fn((event: unknown) => event),
    emit: vi.fn((event: Record<string, unknown>) => {
      const prepared = session.prepareEmit(event);
      return prepared.publish();
    }),
    services: {
      conversationThreadManager: stub,
      configStore,
      sandboxExecutionBroker,
    },
    pendingProviderSwitch: null as {
      provider: string;
      model: string;
      profile?: string;
    } | null,
    prepareProviderSwitch: vi.fn(
      async (spec: { provider: string; model: string; profile?: string }) => ({
        pending: Object.freeze({ ...spec }),
        provider: { expectedRevision: 0 },
        modelInfo: { slug: spec.model },
        baseInstructions: "",
      }),
    ),
    stagePreparedProviderSwitch(
      prepared: {
        pending: { provider: string; model: string; profile?: string };
      },
      expectedPending: {
        provider: string;
        model: string;
        profile?: string;
      } | null,
    ) {
      if (this.pendingProviderSwitch !== expectedPending) {
        throw new Error(
          "pending provider selection changed during test preparation",
        );
      }
      this.pendingProviderSwitch = prepared.pending;
      opts.onStagedSwitch?.(prepared.pending);
    },
    setPendingProviderSwitch: (
      spec: {
        provider: string;
        model: string;
        profile?: string;
      } | null,
    ) => {
      session.pendingProviderSwitch = spec;
      if (spec === null) return;
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
  const rolloutStore = {
    rolloutPath: `/tmp/${conversationId}.jsonl`,
    readAll: () => [...rolloutItems],
    recordRunRuntimeSettingsEvent: vi.fn(() => {}),
    syncCanonicalTail: vi.fn(() => {}),
  };
  const bootstrap = vi.fn(async () => ({
    workspaceRoot: process.cwd(),
    configStore,
    get configuredExecutionAuthority() {
      return configuredExecutionAuthority;
    },
    prepareConfiguredExecutionAuthority: (config: Record<string, unknown>) => {
      const previous = configuredExecutionAuthority;
      const authority = sessionExecutionAuthorityFromAgenCConfig({
        config,
        workspaceRoot: process.cwd(),
        projectTrust: "trusted",
      });
      let committed = false;
      return {
        authority,
        commit: () => {
          configuredExecutionAuthority = authority;
          committed = true;
        },
        rollback: () => {
          if (!committed) return;
          configuredExecutionAuthority = previous;
          committed = false;
        },
      };
    },
    session,
    rolloutStore,
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
    const config = {
      model: "base-model",
      model_provider: "openai",
      profiles: {
        fast: { model: "fast-model", model_provider: "openai" },
      },
    };
    const reload = vi.fn(async () => config);
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => config,
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

  it("rejects a profile model denied by managed availableModels before staging", async () => {
    const stagedSwitches: Array<{
      provider: string;
      model: string;
      profile?: string;
    }> = [];
    const config = {
      model: "base-model",
      model_provider: "openai",
      availableModels: ["base-model"],
      profiles: {
        forbidden: { model: "gpt-5", model_provider: "openai" },
      },
    };
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => config,
      },
      onStagedSwitch: (selection) => stagedSwitches.push(selection),
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.applyAgentConfig("parent-session", {
        sessionId: "session_1",
        profile: "forbidden",
      }),
    ).rejects.toThrow(/managed availableModels policy/u);
    expect(stagedSwitches).toEqual([]);
  });

  it("rejects a reloaded model policy before publishing the prepared config", async () => {
    const currentConfig = {
      model: "base-model",
      model_provider: "openai",
      availableModels: ["base-model"],
    };
    const reloadedConfig = {
      model: "gpt-5",
      model_provider: "openai",
      availableModels: ["base-model"],
    };
    const commit = vi.fn();
    const publish = vi.fn();
    const rollback = vi.fn();
    const settle = vi.fn();
    let reloadState = "prepared";
    let reloadSettled = false;
    const prepareReload = vi.fn(async () => ({
      config: reloadedConfig,
      authority: {
        current: () => reloadedConfig,
        authoritySnapshot: () => ({ config: reloadedConfig, layers: [] }),
        sources: () => [],
      },
      get state() {
        return reloadState;
      },
      get settled() {
        return reloadSettled;
      },
      commit: () => {
        commit();
        reloadState = "committed";
      },
      publish: () => {
        publish();
        reloadState = "published";
      },
      rollback: () => {
        rollback();
        reloadState = "rolled_back";
      },
      settle: () => {
        settle();
        reloadSettled = true;
      },
    }));
    const stagedSwitches: Array<{ provider: string; model: string }> = [];
    const { runner } = makeRunnerHarness({
      configStore: {
        current: () => currentConfig,
        prepareReload,
      },
      onStagedSwitch: (selection) => stagedSwitches.push(selection),
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.applyAgentConfig("parent-session", {
        sessionId: "session_1",
        reload: true,
      }),
    ).rejects.toThrow(/managed availableModels policy/u);

    expect(prepareReload).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(stagedSwitches).toEqual([]);
    expect(currentConfig).toEqual({
      model: "base-model",
      model_provider: "openai",
      availableModels: ["base-model"],
    });
  });
});
