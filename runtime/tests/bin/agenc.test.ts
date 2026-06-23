/**
 * T9 integration seams for `bin/agenc.ts`:
 *   - slash-command short-circuit through the canonical dispatcher path
 *   - `system.agent.delegate` built-in tool
 *
 * T10 Group I integration seams:
 *   - I-60 ambiguous-model hard-fail (`resolveModelOrThrow`)
 *   - I-47 between-turn config reload (`maybeReloadConfigBetweenTurns`)
 *   - AgenCConfig → SessionConfiguration bridge
 *   - Memory auto-save sidecar + per-turn attachments
 *   - System-prompt assembly with project instructions + memory
 *
 * End-to-end CLI invocation is out of scope here (requires a live
 * provider + rollout on disk). These tests cover the extracted units
 * that back the integration.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDelegateTool } from "./delegate-tool.js";
import {
  PROVIDER_MODEL_CATALOG,
  __resetActiveInkUnmountForTest,
  __setDaemonCliDepsForTest,
  __setActiveInkUnmountForTest,
  bootTUIEntry,
  detectStartupShortCircuit,
  formatUnavailableCliCwdMessage,
  formatCliHelpText,
  initializeCliRuntime,
  installInitSignalHandlers,
  installSignalHandlers,
  isUnavailableCliCwdError,
  main,
  maybeReloadConfigBetweenTurns,
  oneShotCLI,
  prepareTurnRuntimeInputs,
  resolveCliCwdForStartup,
  resolveModelOrThrow,
  resumeTUIEntry,
  runSingleTurn,
  sessionConfigurationFromAgenCConfig,
  shouldLoadMcpCliConfig,
  validateAgencHome,
  type ConfigReloadLatch,
} from "./agenc.js";
import { ConfigStore } from "../config/store.js";
import {
  AmbiguousModelError,
  defaultConfig,
  UnknownModelError,
} from "../config/schema.js";
import * as configUtils from "../config/init.js";
import {
  assembleSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "../prompts/system-prompt.js";
import {
  clearSystemPromptSections,
  __systemPromptSectionCacheSize,
} from "../prompts/sections.js";
import type { Session } from "../session/session.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";

function stubSession() {
  return {
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    services: {},
    conversationId: "conv-stub-1",
  } as unknown as Session;
}

type MockProcess = Pick<NodeJS.Process, "once" | "on" | "removeListener">;

function createMockSignalProcess(): {
  proc: MockProcess;
  onceHandlers: Map<string, () => void>;
  onHandlers: Map<string, () => void>;
  removeListener: ReturnType<typeof vi.fn>;
} {
  const onceHandlers = new Map<string, () => void>();
  const onHandlers = new Map<string, () => void>();
  const removeListener = vi.fn();
  return {
    proc: {
      once: vi.fn((signal: string, handler: () => void) => {
        onceHandlers.set(signal, handler);
        return process;
      }) as MockProcess["once"],
      on: vi.fn((signal: string, handler: () => void) => {
        onHandlers.set(signal, handler);
        return process;
      }) as MockProcess["on"],
      removeListener: vi.fn((signal: string, handler: () => void) => {
        removeListener(signal, handler);
        return process;
      }) as MockProcess["removeListener"],
    },
    onceHandlers,
    onHandlers,
    removeListener,
  };
}

function trustWorkspaceForTest(agencHome: string, workspace: string): void {
  trustProjectSync({
    agencHome,
    projectRoot: workspace,
    env: process.env,
  });
}

async function waitForValue<T>(
  label: string,
  read: () => T | null | undefined,
  timeoutMs = 1_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function installDaemonCliDepsForTest(
  options: {
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly runtimeSessionId?: string;
    readonly cwd?: string;
    readonly oneShotEvents?: readonly unknown[];
    /**
     * Causality-faithful hook for tests that model the production daemon: the
     * runner does NOT emit a terminal status while a tool decision is pending.
     * Invoked when the one-shot client answers a `tool.deny`/`tool.approve`
     * request; use `emit` to deliver the follow-up (e.g. terminal) events that
     * the daemon would only produce once the suspended turn resumes.
     */
    readonly onToolDecision?: (info: {
      readonly method: "tool.deny" | "tool.approve";
      readonly requestId: string;
      readonly emit: (event: unknown) => void;
    }) => void;
    readonly createConnectedTuiClientError?: Error;
    readonly requestErrors?: Partial<Record<string, Error>>;
    readonly mcpManager?: unknown;
  } = {},
): {
  readonly agentId: string;
  readonly sessionId: string;
  readonly runtimeSessionId: string;
  readonly requests: Array<{ method: string; params: unknown }>;
  readonly client: {
    request: ReturnType<typeof vi.fn>;
    subscribeToSessionEvents: ReturnType<typeof vi.fn>;
    getConnectionState: ReturnType<typeof vi.fn>;
    subscribeToConnectionState: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  readonly startPromptAgent: ReturnType<typeof vi.fn>;
  readonly stopPromptAgent: ReturnType<typeof vi.fn>;
  readonly createConnectedTuiClient: ReturnType<typeof vi.fn>;
  readonly findAgentBySessionId: ReturnType<typeof vi.fn>;
  readonly createTuiContext: ReturnType<typeof vi.fn>;
  readonly ensureDaemonReady: ReturnType<typeof vi.fn>;
} {
  const agentId = options.agentId ?? "agent_test";
  const sessionId = options.sessionId ?? "session_test";
  const runtimeSessionId = options.runtimeSessionId ?? sessionId;
  const cwd = options.cwd ?? process.cwd();
  const requests: Array<{ method: string; params: unknown }> = [];
  let sessionEventEmit: ((event: unknown) => void) | null = null;
  const oneShotEvents =
    options.oneShotEvents ??
    ([
      {
        method: "event.message_chunk",
        params: {
          sessionId,
          eventId: "delta_test",
          agentId,
          delta: "daemon answer",
        },
      },
      {
        method: "event.agent_status",
        params: {
          sessionId,
          eventId: "complete_test",
          agentId,
          status: "idle",
          runStatus: "completed",
        },
      },
    ] satisfies readonly unknown[]);
  const agent = {
    agentId,
    objective: "test objective",
    status: "running",
    createdAt: "2026-05-06T00:00:00.000Z",
    startedAt: "2026-05-06T00:00:00.100Z",
    lastActiveAt: "2026-05-06T00:00:00.100Z",
    cwd,
    activeSessionIds: [sessionId],
    metadata: {},
  };
  const client = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params });
      const requestError = options.requestErrors?.[method];
      if (requestError !== undefined) throw requestError;
      if (method === "agent.create") {
        return {
          ...agent,
          objective:
            typeof params?.objective === "string"
              ? params.objective.trim()
              : agent.objective,
          sessionId,
        };
      }
      if (method === "agent.list") {
        return { agents: [agent] };
      }
      if (method === "agent.attach") {
        return {
          agentId,
          attachmentId: "attachment_test",
          sessionIds: [sessionId],
          runtimeSessionId,
        };
      }
      if (method === "agent.stop") {
        return { agentId, stopped: true };
      }
      if (method === "tool.deny" || method === "tool.approve") {
        const requestId =
          typeof params?.requestId === "string" ? params.requestId : "";
        if (options.onToolDecision !== undefined && sessionEventEmit !== null) {
          const emit = sessionEventEmit;
          options.onToolDecision({
            method,
            requestId,
            emit: (event) => queueMicrotask(() => emit(event)),
          });
        }
        return {
          requestId,
          decision: method === "tool.deny" ? "denied" : "approved",
        };
      }
      if (method === "message.stream") {
        return {
          messageId: "message_test",
          streamId:
            typeof params?.streamId === "string"
              ? params.streamId
              : "stream_test",
          acceptedAt: "2026-05-06T00:00:01.000Z",
        };
      }
      throw new Error(`unexpected daemon request: ${method}`);
    }),
    subscribeToSessionEvents: vi.fn(
      (targetSessionId: string, cb: (event: unknown) => void) => {
        if (targetSessionId === sessionId) {
          sessionEventEmit = cb;
          queueMicrotask(() => {
            for (const event of oneShotEvents) cb(event);
          });
        }
        return () => undefined;
      },
    ),
    getConnectionState: vi.fn(() => ({ status: "connected" })),
    subscribeToConnectionState: vi.fn(() => () => undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const startPromptAgent = vi.fn(
    async (params: {
      prompt: string;
      initialContent?: string | readonly unknown[];
    }) => {
      return {
        ...agent,
        objective: params.prompt.trim(),
        sessionId,
      };
    },
  );
  const stopPromptAgent = vi.fn(async () => undefined);
  const createConnectedTuiClient = vi.fn(async () => {
    if (options.createConnectedTuiClientError !== undefined) {
      throw options.createConnectedTuiClientError;
    }
    return client;
  });
  const findAgentBySessionId = vi.fn(async (_client, targetSessionId: string) =>
    targetSessionId === sessionId ? agent : null,
  );
  const createTuiContext = vi.fn(async (params: {
    env?: NodeJS.ProcessEnv;
    cwd: string;
    conversationId: string;
  }) => {
    const abortController = new AbortController();
    return {
      configStore: {
        agencHome: params.env?.AGENC_HOME ?? "/tmp/agenc-test-home",
        current: () => ({
          ...defaultConfig(),
          model: "grok-4.3",
          model_provider: "xai",
        }),
        subscribe: () => () => undefined,
        warnings: () => [],
      },
      baseSession: {
        conversationId: params.conversationId,
        cwd: params.cwd,
        home: params.env?.HOME ?? "/tmp/agenc-test-user",
        sessionConfiguration: {
          cwd: params.cwd,
          provider: { slug: "xai" },
        },
        services: {
          permissionModeRegistry: new PermissionModeRegistry(
            createEmptyToolPermissionContext(),
          ),
          ...(options.mcpManager !== undefined
            ? { mcpManager: options.mcpManager }
            : {}),
        },
        abortController,
        abortTerminal: (reason?: unknown) => {
          if (!abortController.signal.aborted) abortController.abort(reason);
        },
        flushEventLog: () => {},
        emit: () => {},
        nextInternalSubId: () => "daemon-test-sub",
        listMcpClients: () => [],
      },
      model: "grok-4.3",
      workspaceRoot: params.cwd,
    };
  });
  const ensureDaemonReady = vi.fn(() => vi.fn().mockResolvedValue(undefined));
  __setDaemonCliDepsForTest({
    startPromptAgent: startPromptAgent as never,
    stopPromptAgent: stopPromptAgent as never,
    createConnectedTuiClient: createConnectedTuiClient as never,
    findAgentBySessionId: findAgentBySessionId as never,
    createTuiContext: createTuiContext as never,
    ensureDaemonReady: ensureDaemonReady as never,
  });
  return {
    agentId,
    sessionId,
    runtimeSessionId,
    requests,
    client,
    startPromptAgent,
    stopPromptAgent,
    createConnectedTuiClient,
    findAgentBySessionId,
    createTuiContext,
    ensureDaemonReady,
  };
}

describe("buildDelegateTool — system.agent.delegate", () => {
  const LIVE = {
    agentId: "thread-1",
    agentPath: "/root/alpha",
    nickname: "alpha",
    role: { name: "default" },
  };

  it("exposes the T9 input schema", () => {
    const tool = buildDelegateTool({
      getSession: () => null,
      delegateFn: vi.fn(),
    });
    expect(tool.name).toBe("system.agent.delegate");
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "taskPrompt",
        "role",
        "isolation",
        "worktreeSlug",
        "runInBackground",
      ]),
    );
    const roleSchema = props.role as { type: string; enum?: string[] };
    expect(roleSchema.type).toBe("string");
    expect(roleSchema.enum).toBeUndefined();
  });

  it("rejects invocation with missing taskPrompt", async () => {
    const delegateSpy = vi.fn();
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(delegateSpy).not.toHaveBeenCalled();
    expect(result.content).toContain("taskPrompt");
  });

  it("rejects invocation before session is wired", async () => {
    const delegateSpy = vi.fn();
    const tool = buildDelegateTool({
      getSession: () => null,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({ taskPrompt: "x" });
    expect(result.isError).toBe(true);
    expect(delegateSpy).not.toHaveBeenCalled();
  });

  it("sync_completed maps to a tool result with finalMessage + toolCallCount", async () => {
    const delegateSpy = vi.fn().mockResolvedValue({
      kind: "sync_completed",
      thread: {
        threadId: "thread-1",
        live: LIVE,
      },
      result: {
        threadId: "thread-1",
        finalMessage: "done",
        durationMs: 42,
        outcome: "completed",
        toolCallCount: 3,
      },
    });
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({
      taskPrompt: "scan the repo",
      role: "scanner",
    });
    expect(delegateSpy).toHaveBeenCalledTimes(1);
    const args = delegateSpy.mock.calls[0]![0];
    expect(args.role).toBe("explorer");
    expect(args.taskPrompt).toBe("scan the repo");
    expect(args.parentPath).toBe("/root");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.kind).toBe("sync_completed");
    expect(parsed.finalMessage).toBe("done");
    expect(parsed.toolCallCount).toBe(3);
    expect(parsed.agentPath).toBe("/root/alpha");
  });

  it("async_launched maps to a tool result carrying threadId + agentPath", async () => {
    const delegateSpy = vi.fn().mockResolvedValue({
      kind: "async_launched",
      thread: { threadId: "thread-2", live: { ...LIVE, agentId: "thread-2" } },
    });
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({
      taskPrompt: "long running",
      runInBackground: true,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.kind).toBe("async_launched");
    expect(parsed.threadId).toBe("thread-2");
    expect(parsed.agentPath).toBe("/root/alpha");
    const args = delegateSpy.mock.calls[0]![0];
    expect(args.runInBackground).toBe(true);
  });

  it("rejected maps to isError=true tool result with reason", async () => {
    const delegateSpy = vi.fn().mockResolvedValue({
      kind: "rejected",
      reason: "worktree setup failed: not a git repo",
    });
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({
      taskPrompt: "do work",
      isolation: "worktree",
      worktreeSlug: "feat-x",
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.kind).toBe("rejected");
    expect(parsed.error).toContain("worktree");
    const args = delegateSpy.mock.calls[0]![0];
    expect(args.isolation).toBe("worktree");
    expect(args.worktreeSlug).toBe("feat-x");
  });

  it("thrown errors are caught and surfaced as isError=true results", async () => {
    const delegateSpy = vi.fn().mockRejectedValue(new Error("boom"));
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({ taskPrompt: "x" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe("boom");
  });
});

describe("initializeCliRuntime", () => {
  it("enables config reads before the CLI routes into turn logic", () => {
    const enableSpy = vi
      .spyOn(configUtils, "enableConfigs")
      .mockImplementation(() => undefined);

    try {
      initializeCliRuntime();
      expect(enableSpy).toHaveBeenCalledTimes(1);
    } finally {
      enableSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — integration tests
// ─────────────────────────────────────────────────────────────────────

describe("PROVIDER_MODEL_CATALOG", () => {
  it("advertises grok models including the default grok-4.3", () => {
    // The grok catalog is now derived from REGISTERED_MODEL_CATALOG; the new
    // grok-build-0.1 entry leads ahead of the previously hand-listed models.
    expect(PROVIDER_MODEL_CATALOG.grok).toEqual([
      "grok-build-0.1",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ]);
  });
});

describe("I-60: resolveModelOrThrow hard-fail", () => {
  it("returns {provider, model} for an unambiguous bare slug", () => {
    const result = resolveModelOrThrow("grok-4.3", PROVIDER_MODEL_CATALOG);
    expect(result.provider).toBe("grok");
    expect(result.model).toBe("grok-4.3");
  });

  it("accepts explicit provider:model form", () => {
    const result = resolveModelOrThrow(
      "grok:grok-4.20-0309-reasoning",
      PROVIDER_MODEL_CATALOG,
    );
    expect(result.provider).toBe("grok");
    expect(result.model).toBe("grok-4.20-0309-reasoning");
  });

  it("THROWS a catchable AmbiguousModelError on an ambiguous bare slug (no process.exit)", () => {
    const catalog = {
      grok: ["shared-model", "grok-4"] as readonly string[],
      openai: ["shared-model", "gpt-4"] as readonly string[],
    };
    // Spy on process.exit so a regression to the old exit-based code is caught:
    // shared selection code must never hard-kill the process — it must throw so
    // daemon/TUI and CLI callers can intercept via their own try/catch.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      let captured: unknown;
      try {
        resolveModelOrThrow("shared-model", catalog);
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(AmbiguousModelError);
      const message = (captured as Error).message;
      expect(message).toMatch(/ambiguous/i);
      expect(message).toMatch(/grok:shared-model/);
      expect(message).toMatch(/openai:shared-model/);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("THROWS a catchable UnknownModelError on an unknown model slug (no process.exit)", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      let captured: unknown;
      try {
        resolveModelOrThrow("nope-unknown", PROVIDER_MODEL_CATALOG);
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(UnknownModelError);
      expect((captured as Error).message).toMatch(/unknown model/i);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("sessionConfigurationFromAgenCConfig", () => {
  it("maps AgenCConfig approval_policy + sandbox_mode enums", () => {
    const cfg = {
      ...defaultConfig(),
      approval_policy: "never" as const,
      sandbox_mode: "read-only" as const,
    };
    const sc = sessionConfigurationFromAgenCConfig({
      config: cfg,
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
    });
    expect(sc.approvalPolicy.value).toBe("never");
    expect(sc.sandboxPolicy.value).toBe("read_only");
    expect(sc.cwd).toBe("/tmp/ws");
    expect(sc.collaborationMode.model).toBe("grok-4.3");
    expect(sc.sessionSource).toBe("cli_main");
    expect(sc.networkSandboxPolicy.enabled).toBe(false);
  });

  it("defaults to on_request + workspace_write when policy fields absent", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: undefined },
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
    });
    // defaultConfig provides "on-request" → "on_request"
    expect(sc.approvalPolicy.value).toBe("on_request");
    expect(sc.sandboxPolicy.value).toBe("workspace_write");
    expect(sc.fileSystemSandboxPolicy.allowWrite).toEqual(["/tmp/ws"]);
    expect(sc.networkSandboxPolicy.enabled).toBe(false);
  });

  it("enables network by default only for danger-full-access sessions", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: {
        ...defaultConfig(),
        sandbox_mode: "danger-full-access" as const,
      },
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
    });
    expect(sc.sandboxPolicy.value).toBe("danger_full_access");
    expect(sc.networkSandboxPolicy.enabled).toBe(true);
  });

  it("on-failure → on_failure mapping", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: "on-failure" as const },
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
    });
    expect(sc.approvalPolicy.value).toBe("on_failure");
  });

  it("untrusted project trust overrides permissive approval config", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: "never" as const },
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
      projectTrust: "untrusted",
    });
    expect(sc.approvalPolicy.value).toBe("untrusted");
  });

  it("trusted project trust preserves explicit approval config", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: "never" as const },
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
      projectTrust: "trusted",
    });
    expect(sc.approvalPolicy.value).toBe("never");
  });

  it("propagates personality, reasoning_summary, and compact_prompt", () => {
    const cfg = {
      ...defaultConfig(),
      personality: "friendly" as const,
      reasoning_summary: "detailed" as const,
      compact_prompt: "COMPACT: keep only the durable facts.",
    };
    const sc = sessionConfigurationFromAgenCConfig({
      config: cfg,
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
    });
    expect(sc.personality).toBe("friendly");
    expect(sc.modelReasoningSummary).toBe("detailed");
    expect(sc.compactPrompt).toBe("COMPACT: keep only the durable facts.");
  });

  it("leaves propagated fields undefined when config omits them", () => {
    const cfg = { ...defaultConfig() };
    // Confirm the bridge skips absent personality fields entirely.
    const override = {
      ...cfg,
      personality: undefined,
      reasoning_summary: undefined,
      compact_prompt: undefined,
    } as typeof cfg;
    const sc = sessionConfigurationFromAgenCConfig({
      config: override,
      workspaceRoot: "/tmp/ws",
      model: "grok-4.3",
    });
    expect(sc.personality).toBeUndefined();
    expect(sc.modelReasoningSummary).toBeUndefined();
    expect(sc.compactPrompt).toBeUndefined();
  });
});

describe("I-47: maybeReloadConfigBetweenTurns", () => {
  it("no-ops when the latch is not set", async () => {
    const store = new ConfigStore({ env: {} });
    const latch: ConfigReloadLatch = { requested: false };
    const clearCache = vi.fn();
    const result = await maybeReloadConfigBetweenTurns({
      latch,
      store,
      session: null,
      clearCache,
    });
    expect(result.reloaded).toBe(false);
    expect(clearCache).not.toHaveBeenCalled();
  });

  it("reloads + wipes section cache + clears latch when requested", async () => {
    const base = defaultConfig();
    const nextCfg = { ...base, model: "grok-4" };
    const loader = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(nextCfg);
    const store = new ConfigStore({
      env: {},
      loader: (opts) => loader(opts),
    });
    await store.reload(); // snapshot#1 = base
    const latch: ConfigReloadLatch = { requested: true };
    const clearCache = vi.fn();
    const result = await maybeReloadConfigBetweenTurns({
      latch,
      store,
      session: null,
      clearCache,
    });
    expect(result.reloaded).toBe(true);
    if (result.reloaded) {
      expect(result.previous.model).toBe("grok-4.3");
      expect(result.next.model).toBe("grok-4");
    }
    expect(latch.requested).toBe(false);
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it("emits a session warning documenting the model transition", async () => {
    const base = defaultConfig();
    const nextCfg = { ...base, model: "grok-4" };
    const loader = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(nextCfg);
    const store = new ConfigStore({
      env: {},
      loader: (opts) => loader(opts),
    });
    await store.reload();
    const latch: ConfigReloadLatch = { requested: true };
    const emit = vi.fn();
    const sessionStub = {
      emit,
      nextInternalSubId: () => "sub-x",
    } as unknown as Parameters<typeof maybeReloadConfigBetweenTurns>[0]["session"];
    await maybeReloadConfigBetweenTurns({
      latch,
      store,
      session: sessionStub,
      clearCache: () => {},
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0];
    expect(arg.msg.type).toBe("warning");
    expect(arg.msg.payload.cause).toBe("config_reloaded");
    expect(arg.msg.payload.message).toMatch(/grok-4.3/);
    expect(arg.msg.payload.message).toMatch(/grok-4/);
  });

  it("refreshes MCP before emitting the reload warning", async () => {
    const base = defaultConfig();
    const nextCfg = { ...base, model: "grok-4" };
    const loader = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(nextCfg);
    const store = new ConfigStore({
      env: {},
      loader: (opts) => loader(opts),
    });
    await store.reload();
    const latch: ConfigReloadLatch = { requested: true };
    const emit = vi.fn();
    const refreshFromConfig = vi.fn().mockResolvedValue({
      configuredServers: ["github"],
      requiredServers: ["github"],
    });
    const sessionStub = {
      emit,
      nextInternalSubId: () => "sub-x",
      services: { mcpManager: { refreshFromConfig } },
    } as unknown as Parameters<typeof maybeReloadConfigBetweenTurns>[0]["session"];

    await maybeReloadConfigBetweenTurns({
      latch,
      store,
      session: sessionStub,
      clearCache: () => {},
    });

    expect(refreshFromConfig).toHaveBeenCalledWith(nextCfg);
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0];
    expect(arg.msg.type).toBe("warning");
    expect(arg.msg.payload.message).toContain(
      "MCP refreshed (1 configured, 1 required)",
    );
  });

  it("emits and propagates MCP refresh failures", async () => {
    const base = defaultConfig();
    const nextCfg = { ...base, model: "grok-4" };
    const loader = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(nextCfg);
    const store = new ConfigStore({
      env: {},
      loader: (opts) => loader(opts),
    });
    await store.reload();
    const latch: ConfigReloadLatch = { requested: true };
    const emit = vi.fn();
    const refreshFromConfig = vi
      .fn()
      .mockRejectedValue(new Error("required server missing"));
    const sessionStub = {
      emit,
      nextInternalSubId: () => "sub-x",
      services: { mcpManager: { refreshFromConfig } },
    } as unknown as Parameters<typeof maybeReloadConfigBetweenTurns>[0]["session"];

    await expect(
      maybeReloadConfigBetweenTurns({
        latch,
        store,
        session: sessionStub,
        clearCache: () => {},
      }),
    ).rejects.toThrow(/required server missing/);

    expect(latch.requested).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0];
    expect(arg.msg.type).toBe("error");
    expect(arg.msg.payload.cause).toBe("mcp_config_refresh_failed");
  });

  it("uses clearSystemPromptSections by default", async () => {
    // Seed the module cache, then verify reload drains it.
    const base = defaultConfig();
    const store = new ConfigStore({
      env: {},
      loader: async () => base,
    });
    await store.reload();
    await assembleSystemPrompt({
      session: {} as never,
      ctx: {
        config: base,
        configSnapshot: base,
        cwd: "/tmp",
        modelInfo: { slug: "grok-4.3" },
      } as never,
    });
    expect(__systemPromptSectionCacheSize()).toBeGreaterThan(0);
    const latch: ConfigReloadLatch = { requested: true };
    await maybeReloadConfigBetweenTurns({
      latch,
      store,
      session: null,
    });
    expect(__systemPromptSectionCacheSize()).toBe(0);
    clearSystemPromptSections();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Memory + system-prompt integration
// ─────────────────────────────────────────────────────────────────────

afterEach(async () => {
  __setDaemonCliDepsForTest(null);
  vi.restoreAllMocks();
  __resetActiveInkUnmountForTest();
  clearSystemPromptSections();
});

describe("validateAgencHome", () => {
  it("prefers a non-empty AGENC_HOME and creates the directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "agenc-home-explicit-"));
    const explicitHome = join(base, "custom-home");
    try {
      expect(
        validateAgencHome({
          AGENC_HOME: explicitHome,
          HOME: "/ignored",
        } as NodeJS.ProcessEnv),
      ).toBe(explicitHome);
      await writeFile(join(explicitHome, "probe.txt"), "ok", "utf8");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("falls back to $HOME/.agenc when AGENC_HOME is unset or empty", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "agenc-home-fallback-"));
    const expectedHome = join(homeRoot, ".agenc");
    try {
      expect(
        validateAgencHome({ HOME: homeRoot } as NodeJS.ProcessEnv),
      ).toBe(expectedHome);
      expect(
        validateAgencHome({
          AGENC_HOME: "",
          HOME: homeRoot,
        } as NodeJS.ProcessEnv),
      ).toBe(expectedHome);
      await writeFile(join(expectedHome, "probe.txt"), "ok", "utf8");
    } finally {
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  it("throws a clear error when HOME and AGENC_HOME are both unset", () => {
    expect(() => validateAgencHome({})).toThrow(
      /HOME unset and AGENC_HOME unset/,
    );
  });

  it("wraps EACCES and EROFS as actionable writable-dir failures", () => {
    for (const code of ["EACCES", "EROFS"] as const) {
      expect(() =>
        validateAgencHome(
          { AGENC_HOME: "/tmp/agenc-home" } as NodeJS.ProcessEnv,
          (() => {
            const err = new Error(`${code} failure`) as NodeJS.ErrnoException;
            err.code = code;
            throw err;
          }) as typeof import("node:fs").mkdirSync,
        ),
      ).toThrow(new RegExp(`not writable \\(${code}\\)`));
    }
  });
});

describe("resolveCliCwdForStartup", () => {
  it("uses AGENC_WORKSPACE when the shell directory is unavailable", () => {
    const result = resolveCliCwdForStartup(
      { AGENC_WORKSPACE: "/tmp/agenc-workspace" },
      {
        cwdFn: () => {
          throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
            syscall: "uv_cwd",
          });
        },
      },
    );

    expect(result).toEqual({ ok: true, cwd: "/tmp/agenc-workspace" });
  });

  it("returns the concise deleted-directory message when no workspace is configured", () => {
    const result = resolveCliCwdForStartup(
      {},
      {
        cwdFn: () => {
          throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
            syscall: "uv_cwd",
          });
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      message: formatUnavailableCliCwdMessage(),
    });
  });

  it("recognizes raw Node uv_cwd errors for the direct-invocation fallback", () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, uv_cwd"),
      { syscall: "uv_cwd" },
    );

    expect(isUnavailableCliCwdError(error)).toBe(true);
  });
});

describe("installInitSignalHandlers", () => {
  it("maps init signals to abort reasons and unregisters the same handlers", () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const { proc, onceHandlers, removeListener } = createMockSignalProcess();
      const abort = new AbortController();
      const uninstall = installInitSignalHandlers(abort, proc);

      expect(onceHandlers.has(signal)).toBe(true);
      onceHandlers.get(signal)!();
      expect(abort.signal.aborted).toBe(true);
      expect(abort.signal.reason).toBe(`${signal} during init`);

      uninstall();
      expect(removeListener).toHaveBeenCalledWith(
        signal,
        onceHandlers.get(signal),
      );
    }
  });
});

describe("installSignalHandlers", () => {
  it("SIGTERM unmounts Ink before aborting the terminal", () => {
    const { proc, onceHandlers } = createMockSignalProcess();
    const abortTerminal = vi.fn();
    const unmount = vi.fn();
    __setActiveInkUnmountForTest(unmount);

    installSignalHandlers(
      () =>
        ({
          abortTerminal,
        }) as never,
      { requested: false },
      proc,
    );

    onceHandlers.get("SIGTERM")!();
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(abortTerminal).toHaveBeenCalledWith("signal_received");
    expect(unmount.mock.invocationCallOrder[0]).toBeLessThan(
      abortTerminal.mock.invocationCallOrder[0]!,
    );
  });

  it("SIGHUP unmounts Ink before marking stdin_lost", () => {
    const { proc, onceHandlers } = createMockSignalProcess();
    const abortTerminal = vi.fn();
    const unmount = vi.fn();
    __setActiveInkUnmountForTest(unmount);

    installSignalHandlers(
      () =>
        ({
          abortTerminal,
        }) as never,
      { requested: false },
      proc,
    );

    onceHandlers.get("SIGHUP")!();
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(abortTerminal).toHaveBeenCalledWith("stdin_lost");
    expect(unmount.mock.invocationCallOrder[0]).toBeLessThan(
      abortTerminal.mock.invocationCallOrder[0]!,
    );
  });

  it("SIGUSR1 latches config reload and emits the documented warning", () => {
    const { proc, onHandlers } = createMockSignalProcess();
    const emit = vi.fn();
    const latch: ConfigReloadLatch = { requested: false };

    installSignalHandlers(
      () =>
        ({
          emit,
        }) as never,
      latch,
      proc,
    );

    onHandlers.get("SIGUSR1")!();
    expect(latch.requested).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      id: "startup",
      msg: {
        type: "warning",
        payload: {
          cause: "config_reload_requested",
          message: "config reload will take effect at next turn (I-30)",
        },
      },
    });
  });

  it("SIGUSR2 emits the documented state-dump warning", () => {
    const { proc, onHandlers } = createMockSignalProcess();
    const emit = vi.fn();

    installSignalHandlers(
      () =>
        ({
          emit,
        }) as never,
      { requested: false },
      proc,
    );

    onHandlers.get("SIGUSR2")!();
    expect(emit).toHaveBeenCalledWith({
      id: "startup",
      msg: {
        type: "warning",
        payload: {
          cause: "state_dump_requested",
          message: "state dump requested (T-future)",
        },
      },
    });
  });
});

describe("system-prompt assembly: project instructions + memory", () => {
  it("includes project instructions + memory in the assembled dynamic tail", async () => {
    const cfg = defaultConfig();
    const assembled = await assembleSystemPrompt({
      session: {} as never,
      ctx: {
        config: cfg,
        configSnapshot: cfg,
        cwd: "/tmp",
        modelInfo: { slug: "grok-4.3" },
      } as never,
      projectInstructions: "## project\n\nFollow repo AGENC.md guidance.",
      memoryPrompt: "# Memory\n\nCurrent memory guidance.",
    });
    expect(assembled.text).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(assembled.text).toMatch(/project/);
    expect(assembled.text).toMatch(/Current memory guidance/);
  });
});

describe("ConfigStore integration shape", () => {
  it("constructs from empty env + defaults and current() is frozen", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-config-empty-"));
    try {
      const store = new ConfigStore({ home, env: {} });
      await store.reload();
      const cur = store.current();
      expect(cur.model).toBe("grok-4.3");
      // AgenCConfig is deep-frozen — direct writes should throw in strict.
      expect(Object.isFrozen(cur)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("applyEnvOverrides promotes AGENC_MODEL over TOML", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-config-env-"));
    try {
      const store = new ConfigStore({
        home,
        env: { AGENC_MODEL: "grok-4" } as NodeJS.ProcessEnv,
      });
      await store.reload();
      expect(store.current().model).toBe("grok-4");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("prepareTurnRuntimeInputs", () => {
  it("reloads project instructions and MCP instructions on each call", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agenc-turn-inputs-"));
    const nested = join(repoRoot, "pkg");
    const memoryDir = join(repoRoot, ".agenc-memory");
    const memoryMdPath = join(memoryDir, "MEMORY.md");
    await mkdir(nested, { recursive: true });
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), "{}", "utf8");
    await writeFile(join(repoRoot, "AGENC.md"), "PROJECT-ONE", "utf8");
    await writeFile(memoryMdPath, "MEMORY-ONE\n", "utf8");

    let instructionText = "MCP-ONE";
    const session = {
      services: {
        mcpManager: {
          effectiveServers: vi.fn(async () =>
            new Map([
              [
                "alpha",
                { enabled: true, instructions: instructionText } as unknown,
              ],
            ]),
          ),
        },
      },
    } as unknown as Session;
    const store = new ConfigStore({ env: {} });
    await store.reload();

    const first = await prepareTurnRuntimeInputs({
      session,
      configStore: store,
      workspaceRoot: nested,
      memoryDir,
      memoryMdPath,
      registry: { tools: [{ name: "bash" }] },
    });
    expect(first.projectInstructions).toContain("PROJECT-ONE");
    expect(first.memoryPromptText).toBe("");
    expect(first.mcpServers).toEqual([
      { name: "alpha", instructions: "MCP-ONE" },
    ]);

    await writeFile(join(repoRoot, "AGENC.md"), "PROJECT-TWO", "utf8");
    await writeFile(memoryMdPath, "MEMORY-TWO\n", "utf8");
    instructionText = "MCP-TWO";

    const second = await prepareTurnRuntimeInputs({
      session,
      configStore: store,
      workspaceRoot: nested,
      memoryDir,
      memoryMdPath,
      registry: { tools: [{ name: "bash" }] },
    });
    expect(second.projectInstructions).toContain("PROJECT-TWO");
    expect(second.projectInstructions).not.toContain("PROJECT-ONE");
    expect(second.memoryPromptText).toBe("");
    expect(second.mcpServers).toEqual([
      { name: "alpha", instructions: "MCP-TWO" },
    ]);

    await writeFile(
      join(repoRoot, "AGENC.md"),
      "PROJECT-THREE\n@include ../missing-secret.md",
      "utf8",
    );
    await prepareTurnRuntimeInputs({
      session,
      configStore: store,
      workspaceRoot: nested,
      memoryDir,
      memoryMdPath,
      registry: { tools: [{ name: "bash" }] },
    });
    expect(
      (session as unknown as { projectMemoryWarnings?: readonly string[] })
        .projectMemoryWarnings?.[0],
    ).toContain("AGENC.md include dropped");

    await rm(repoRoot, { recursive: true, force: true });
  });
});

describe("runSingleTurn seam (R1 multi-turn future-proofing)", () => {
  it("invokes maybeReloadConfigBetweenTurns exactly once per call", async () => {
    const reloadConfigFn = vi
      .fn()
      .mockResolvedValue({ reloaded: false });
    const assembleSystemPromptFn = vi
      .fn()
      .mockResolvedValue({ text: "SYS" });
    async function* fakeRunTurn(): AsyncGenerator<unknown, unknown> {
      // empty — terminate immediately
      return { reason: "completed" };
    }
    const runTurnFn = vi.fn(fakeRunTurn);

    const store = new ConfigStore({ env: {} });
    await store.reload();
    const latch: ConfigReloadLatch = { requested: false };
    const session = { emit: vi.fn() } as never;
    const ctx = {} as never;

    const iter = runSingleTurn({
      session,
      ctx,
      input: "hi",
      configStore: store,
      configReloadLatch: latch,
      projectInstructions: "",
      memoryPromptText: "",
      allMemories: [],
      enabledToolNames: new Set<string>(),
      mcpServers: [],
      provider: "grok",
      reloadConfigFn: reloadConfigFn as never,
      assembleSystemPromptFn: assembleSystemPromptFn as never,
      runTurnFn: runTurnFn as never,
    });
    // Drain the generator.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const step = await iter.next();
      if (step.done) break;
    }
    expect(reloadConfigFn).toHaveBeenCalledTimes(1);
    expect(assembleSystemPromptFn).toHaveBeenCalledTimes(1);
    expect(runTurnFn).toHaveBeenCalledTimes(1);
    // runTurn must receive the assembled system prompt through opts.
    const rtCall = runTurnFn.mock.calls[0]!;
    expect(rtCall[3]!.systemPrompt.length).toBeGreaterThan(0);
  });

  it("calls reload again when invoked a second time (multi-turn loop compat)", async () => {
    const reloadConfigFn = vi
      .fn()
      .mockResolvedValue({ reloaded: false });
    const assembleSystemPromptFn = vi
      .fn()
      .mockResolvedValue({ text: "SYS" });
    async function* fakeRunTurn(): AsyncGenerator<unknown, unknown> {
      return { reason: "completed" };
    }
    const runTurnFn = vi.fn(fakeRunTurn);
    const store = new ConfigStore({ env: {} });
    await store.reload();
    const latch: ConfigReloadLatch = { requested: false };

    for (let i = 0; i < 3; i++) {
      const iter = runSingleTurn({
        session: { emit: vi.fn() } as never,
        ctx: {} as never,
        input: `t${i}`,
        configStore: store,
        configReloadLatch: latch,
        projectInstructions: "",
        memoryPromptText: "",
        allMemories: [],
        enabledToolNames: new Set<string>(),
        mcpServers: [],
        provider: "grok",
        reloadConfigFn: reloadConfigFn as never,
        assembleSystemPromptFn: assembleSystemPromptFn as never,
        runTurnFn: runTurnFn as never,
      });
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const step = await iter.next();
        if (step.done) break;
      }
    }
    expect(reloadConfigFn).toHaveBeenCalledTimes(3);
    expect(runTurnFn).toHaveBeenCalledTimes(3);
  });

  it("reloads prompt inputs on each call so later turns see updated instructions", async () => {
    const loadTurnInputsFn = vi
      .fn()
      .mockResolvedValueOnce({
        projectInstructions: "PROJECT-ONE",
        memoryPromptText: "MEMORY-ONE",
        allMemories: [],
        enabledToolNames: new Set<string>(),
        mcpServers: [{ name: "alpha", instructions: "ALPHA" }],
      })
      .mockResolvedValueOnce({
        projectInstructions: "PROJECT-TWO",
        memoryPromptText: "MEMORY-TWO",
        allMemories: [],
        enabledToolNames: new Set<string>(),
        mcpServers: [{ name: "beta", instructions: "BETA" }],
      });
    const prompts: string[] = [];
    async function* fakeRunTurn(
      _session: unknown,
      _ctx: unknown,
      _input: unknown,
      opts: { readonly systemPrompt: string },
    ): AsyncGenerator<unknown, unknown> {
      prompts.push(opts.systemPrompt);
      return { reason: "completed" };
    }

    const store = new ConfigStore({ env: {} });
    await store.reload();
    const cfg = defaultConfig();
    const ctx = {
      config: cfg,
      configSnapshot: cfg,
      cwd: "/tmp",
      modelInfo: { slug: cfg.model },
    } as never;

    for (let i = 0; i < 2; i++) {
      const iter = runSingleTurn({
        session: { emit: vi.fn() } as never,
        ctx,
        input: `t${i}`,
        configStore: store,
        configReloadLatch: { requested: false },
        loadTurnInputsFn: loadTurnInputsFn as never,
        provider: "grok",
        reloadConfigFn: (async () => ({ reloaded: false })) as never,
        runTurnFn: fakeRunTurn as never,
      });
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const step = await iter.next();
        if (step.done) break;
      }
    }

    expect(loadTurnInputsFn).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain("PROJECT-ONE");
    expect(prompts[0]).toContain("MEMORY-ONE");
    expect(prompts[0]).toContain('<mcp_server_instructions server="alpha"');
    expect(prompts[1]).toContain("PROJECT-TWO");
    expect(prompts[1]).toContain("MEMORY-TWO");
    expect(prompts[1]).toContain('<mcp_server_instructions server="beta"');
    expect(prompts[1]).not.toContain("PROJECT-ONE");
    expect(prompts[1]).not.toContain("MEMORY-ONE");
    expect(prompts[1]).not.toContain("## alpha");
  });

  it("forwards every event yielded by runTurn", async () => {
    const events = [
      { type: "turn_start", turnIndex: 0 },
      { type: "assistant_text", content: "hello" },
    ];
    async function* fakeRunTurn(): AsyncGenerator<unknown, unknown> {
      for (const e of events) yield e;
      return { reason: "completed" };
    }
    const runTurnFn = vi.fn(fakeRunTurn);
    const store = new ConfigStore({ env: {} });
    await store.reload();
    const latch: ConfigReloadLatch = { requested: false };
    const collected: unknown[] = [];
    const iter = runSingleTurn({
      session: { emit: vi.fn() } as never,
      ctx: {} as never,
      input: "hi",
      configStore: store,
      configReloadLatch: latch,
      projectInstructions: "",
      memoryPromptText: "",
      allMemories: [],
      enabledToolNames: new Set<string>(),
      mcpServers: [],
      provider: "grok",
      reloadConfigFn: (async () => ({ reloaded: false })) as never,
      assembleSystemPromptFn: (async () => ({ text: "SYS" })) as never,
      runTurnFn: runTurnFn as never,
    });
    for await (const ev of iter) collected.push(ev);
    expect(collected).toEqual(events);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T10 A+ Fix-alpha - main() smoke test
// ─────────────────────────────────────────────────────────────────────

describe("main() smoke", () => {
  it("loads mcp serve config only when the route needs configured defaults", () => {
    expect(shouldLoadMcpCliConfig(["mcp"])).toBe(false);
    expect(shouldLoadMcpCliConfig(["mcp", "list"])).toBe(false);
    expect(shouldLoadMcpCliConfig(["mcp", "serve", "--help"])).toBe(false);
    expect(shouldLoadMcpCliConfig(["mcp", "serve"])).toBe(true);
    expect(shouldLoadMcpCliConfig(["mcp", "serve", "--transport", "sse"])).toBe(
      true,
    );
    expect(shouldLoadMcpCliConfig(["mcp", "serve", "--transport=sse"])).toBe(
      true,
    );
    expect(
      shouldLoadMcpCliConfig(["mcp", "serve", "--transport", "stdio"]),
    ).toBe(false);
    expect(shouldLoadMcpCliConfig(["mcp", "serve", "--transport=stdio"])).toBe(
      false,
    );
    expect(
      shouldLoadMcpCliConfig([
        "mcp",
        "serve",
        "--transport",
        "sse",
        "--transport",
        "stdio",
      ]),
    ).toBe(false);
    expect(
      shouldLoadMcpCliConfig([
        "mcp",
        "serve",
        "--transport",
        "sse",
        "--bad-arg",
      ]),
    ).toBe(false);
    expect(shouldLoadMcpCliConfig(["mcp", "serve", "--bad-arg"])).toBe(false);
  });

  it("main() short-circuits --help before TUI/CLI routing", async () => {
    const prevArgv = [...process.argv];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    process.argv = ["/usr/bin/node", "/opt/agenc/bin/agenc.js", "--help"];

    try {
      const code = await main();
      expect(code).toBe(0);
      expect(
        stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain(formatCliHelpText());
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = prevArgv;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("main() short-circuits --version before TUI/CLI routing", async () => {
    const prevArgv = [...process.argv];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    process.argv = ["/usr/bin/node", "/opt/agenc/bin/agenc.js", "--version"];

    try {
      const code = await main();
      expect(code).toBe(0);
      expect(
        stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain("agenc 0.2.0");
    } finally {
      process.argv = prevArgv;
      stdoutSpy.mockRestore();
    }
  });

  it("startup --image no longer short-circuits before routing", () => {
    expect(
      detectStartupShortCircuit(["--image", "/tmp/example.png", "describe"]),
    ).toBeNull();
  });

  it("oneShotCLI starts a daemon prompt agent for slash-looking input", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-slash-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-slash-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_slash",
      sessionId: "session_slash",
      cwd: tmpCwd,
      oneShotEvents: [
        [],
        { method: "event.message_chunk", params: [] },
        {
          method: "event.message_chunk",
          params: {
            sessionId: "session_slash",
            eventId: "delta_test",
            agentId: "agent_slash",
            delta: "daemon answer",
          },
        },
        {
          method: "event.agent_status",
          params: {
            sessionId: "session_slash",
            eventId: "complete_test",
            agentId: "agent_slash",
            status: "idle",
            runStatus: "completed",
          },
        },
      ],
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const code = await oneShotCLI("/help\nextra");
      expect(code).toBe(0);
      expect(daemon.requests[0]).toEqual({
        method: "agent.create",
        params: expect.objectContaining({
          objective: "/help\nextra",
          instructions: "/help\nextra",
          cwd: tmpCwd,
          metadata: { source: "agenc.prompt", mode: "one-shot" },
        }),
      });
      expect(daemon.requests[1]).toEqual(
        expect.objectContaining({
          method: "agent.attach",
          params: expect.objectContaining({ agentId: "agent_slash" }),
        }),
      );
      expect(daemon.startPromptAgent).not.toHaveBeenCalled();
      expect(
        stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toBe("daemon answer\n");
    } finally {
      stdoutSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("oneShotCLI DENIES an unanswerable permission request and terminates instead of hanging", async () => {
    // Regression for the non-interactive one-shot deadlock: the daemon forces
    // --autonomous, so any tool the model invokes that is not on the (empty by
    // default) unattended allowlist becomes an unanswerable "ask". With no
    // human attached the run used to hang in `running` forever until SIGTERM.
    // The one-shot client must answer with tool.deny (never tool.approve) so
    // the agent continues and produces a terminal status.
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-deny-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-deny-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    const agentId = "agent_deny";
    const sessionId = "session_deny";
    const permissionRequestId = "req-deny-1";
    const daemon = installDaemonCliDepsForTest({
      agentId,
      sessionId,
      cwd: tmpCwd,
      // Only the permission request is delivered up front. The terminal status
      // is withheld until the client answers the tool decision, faithfully
      // modelling the daemon (which keeps the turn suspended while a decision
      // is pending). Without the client-side deny, no terminal status ever
      // arrives and the run hangs — exactly the bug under test.
      oneShotEvents: [
        {
          method: "event.permission_request",
          params: {
            sessionId,
            eventId: "perm_evt",
            agentId,
            requestId: permissionRequestId,
            toolName: "system.bash",
            permissions: ["tool.use"],
          },
        },
      ],
      onToolDecision: ({ method, requestId, emit }) => {
        // The agent resumes only once the tool call is resolved; the daemon
        // then surfaces a terminal status. A real deny lets the agent answer.
        if (method === "tool.deny" && requestId === permissionRequestId) {
          emit({
            method: "event.agent_status",
            params: {
              sessionId,
              eventId: "complete_after_deny",
              agentId,
              status: "idle",
              runStatus: "completed",
              message: "done after denial",
            },
          });
        }
      },
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      // Bound the run so a regression (hang) fails as a timeout rather than
      // stalling the suite.
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 4000),
      );
      const result = await Promise.race([oneShotCLI("run a command"), timeout]);
      // The run must TERMINATE (not hang as a timeout) — the original fix. With
      // PART B the deny-then-gave-up run now also surfaces a NON-ZERO exit so a
      // tool-blocked giveup is distinguishable from a real answer.
      expect(result).not.toBe("timeout");
      expect(result).not.toBe(0);

      const denyCall = daemon.requests.find((r) => r.method === "tool.deny");
      expect(denyCall).toBeDefined();
      expect(denyCall?.params).toEqual(
        expect.objectContaining({
          sessionId,
          requestId: permissionRequestId,
        }),
      );
      // Must DENY, never grant.
      expect(
        daemon.requests.some((r) => r.method === "tool.approve"),
      ).toBe(false);
    } finally {
      stdoutSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("oneShotCLI exits NON-ZERO with a marker after a tool-blocked giveup", async () => {
    // PART B regression: in headless --print mode a task that needs even a
    // read-only tool dead-ends — the daemon forces --autonomous, so the model's
    // tool call resolves to an unanswerable "ask" that the one-shot client must
    // auto-DENY (so the run terminates instead of hanging). The model then gives
    // up and the turn "completes". Before the fix the process exited 0 as if it
    // produced a real answer, so callers could not tell a giveup from a real
    // answer. A run that auto-denied a permission request and then completed
    // must exit NON-ZERO and emit a clear stderr marker.
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-giveup-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-giveup-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    const agentId = "agent_giveup";
    const sessionId = "session_giveup";
    const permissionRequestId = "req-giveup-1";
    installDaemonCliDepsForTest({
      agentId,
      sessionId,
      cwd: tmpCwd,
      // Deliver a permission request up front; the terminal "completed" status
      // is withheld until the client answers — modelling the daemon, which keeps
      // the turn suspended while a decision is pending. The deny resumes the
      // turn, the model gives up, and the daemon reports completed.
      oneShotEvents: [
        {
          method: "event.permission_request",
          params: {
            sessionId,
            eventId: "perm_evt",
            agentId,
            requestId: permissionRequestId,
            toolName: "FileRead",
            permissions: ["tool.use"],
          },
        },
      ],
      onToolDecision: ({ method, requestId, emit }) => {
        if (method === "tool.deny" && requestId === permissionRequestId) {
          emit({
            method: "event.agent_status",
            params: {
              sessionId,
              eventId: "complete_after_deny",
              agentId,
              status: "idle",
              runStatus: "completed",
              message: "I could not read the file.",
            },
          });
        }
      },
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 4000),
      );
      const result = await Promise.race([
        oneShotCLI("read the file and summarize it"),
        timeout,
      ]);
      // The tool-blocked giveup must surface as a non-zero exit, NOT 0.
      expect(result).not.toBe(0);
      expect(result).not.toBe("timeout");
      // And a clear stderr marker tells the human how to grant tools.
      const stderrText = stderrSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(stderrText).toContain("tool denied in non-interactive mode");
      expect(stderrText).toContain("--permission-mode");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("oneShotCLI still exits 0 when no permission request was denied", async () => {
    // PART B guard: a normal run that never auto-denied a tool must keep its
    // success exit code. Only a denied-then-gave-up run signals failure.
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-nodeny-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-nodeny-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    const agentId = "agent_nodeny";
    const sessionId = "session_nodeny";
    const daemon = installDaemonCliDepsForTest({
      agentId,
      sessionId,
      cwd: tmpCwd,
      // No permission request — just an answer + completed status.
      oneShotEvents: [
        {
          method: "event.message_chunk",
          params: {
            sessionId,
            eventId: "delta_ok",
            agentId,
            delta: "here is your answer",
          },
        },
        {
          method: "event.agent_status",
          params: {
            sessionId,
            eventId: "complete_ok",
            agentId,
            status: "idle",
            runStatus: "completed",
          },
        },
      ],
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 4000),
      );
      const result = await Promise.race([
        oneShotCLI("just answer this"),
        timeout,
      ]);
      expect(result).toBe(0);
      // No deny was ever sent.
      expect(
        daemon.requests.some((r) => r.method === "tool.deny"),
      ).toBe(false);
    } finally {
      stdoutSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("oneShotCLI forwards --permission-mode acceptEdits to agent.create", async () => {
    // PART A regression: the print path previously forwarded only --yolo/bypass
    // and silently dropped --permission-mode acceptEdits/plan/default. The
    // validated mode must reach agent.create so the daemon honors it (the
    // unattended policy preserves acceptEdits/plan rather than forcing
    // unattended — see applyUnattendedPermissionPolicyToContext).
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-permmode-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-permmode-cwd-"));
    const prevEnv = { ...process.env };
    const prevArgv = [...process.argv];

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    process.argv = [
      "/usr/bin/node",
      "/opt/agenc/bin/agenc.js",
      "--print",
      "--permission-mode",
      "acceptEdits",
      "do a thing",
    ];

    const agentId = "agent_permmode";
    const sessionId = "session_permmode";
    const daemon = installDaemonCliDepsForTest({
      agentId,
      sessionId,
      cwd: tmpCwd,
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 4000),
      );
      const result = await Promise.race([
        oneShotCLI("do a thing"),
        timeout,
      ]);
      expect(result).toBe(0);
      const createCall = daemon.requests.find(
        (r) => r.method === "agent.create",
      );
      expect(createCall).toBeDefined();
      expect(
        (createCall?.params as { permissionMode?: string } | undefined)
          ?.permissionMode,
      ).toBe("acceptEdits");
    } finally {
      process.argv = prevArgv;
      stdoutSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("oneShotCLI keeps bypassPermissions precedence over --permission-mode", async () => {
    // --yolo must still win: when both --yolo and --permission-mode acceptEdits
    // are present, the forwarded mode is bypassPermissions (no posture
    // weakening of the existing yolo path).
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-yolo-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-yolo-cwd-"));
    const prevEnv = { ...process.env };
    const prevArgv = [...process.argv];

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    process.argv = [
      "/usr/bin/node",
      "/opt/agenc/bin/agenc.js",
      "--print",
      "--yolo",
      "--permission-mode",
      "acceptEdits",
      "do a thing",
    ];

    const agentId = "agent_yolo";
    const sessionId = "session_yolo";
    const daemon = installDaemonCliDepsForTest({
      agentId,
      sessionId,
      cwd: tmpCwd,
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 4000),
      );
      const result = await Promise.race([
        oneShotCLI("do a thing"),
        timeout,
      ]);
      expect(result).toBe(0);
      const createCall = daemon.requests.find(
        (r) => r.method === "agent.create",
      );
      expect(
        (createCall?.params as { permissionMode?: string } | undefined)
          ?.permissionMode,
      ).toBe("bypassPermissions");
    } finally {
      process.argv = prevArgv;
      stdoutSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry streams startup prompt and images as one daemon message", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-image-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-image-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_image",
      sessionId: "session_image",
      cwd: tmpCwd,
    });

    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const unmount = vi.fn();
    const bootTUISpy = vi.fn(async () => ({ unmount, waitUntilExit }));
    vi.doMock("../tui/main.js", () => ({
      bootTUI: bootTUISpy,
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const code = await bootTUIEntry({
        initialPrompt: "describe this",
        startupImages: ["http://127.0.0.1/cat.png"],
      });
      expect(code).toBe(0);
      expect(daemon.startPromptAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "describe this",
          cwd: tmpCwd,
          initialContent: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: "http://127.0.0.1/cat.png" },
            },
          ],
        }),
      );
      expect(bootTUISpy).toHaveBeenCalledWith(
        expect.not.objectContaining({
          initialPrompt: expect.anything(),
          initialUserMessages: expect.anything(),
        }),
      );
      expect(daemon.requests.map((request) => request.method)).toEqual([
        "agent.list",
        "agent.attach",
      ]);
    } finally {
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("oneShotCLI treats slash-prefixed filesystem paths as normal prompt input", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-slash-path-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-slash-path-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    await writeFile(join(tmpCwd, "notes.txt"), "hello\n", "utf8");
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_slash_path",
      sessionId: "session_slash_path",
      cwd: tmpCwd,
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const code = await oneShotCLI("/notes.txt");
      expect(code).toBe(0);
      expect(daemon.requests[0]).toEqual({
        method: "agent.create",
        params: expect.objectContaining({
          objective: "/notes.txt",
          instructions: "/notes.txt",
          cwd: tmpCwd,
          metadata: { source: "agenc.prompt", mode: "one-shot" },
        }),
      });
      expect(daemon.requests[1]).toEqual(
        expect.objectContaining({
          method: "agent.attach",
          params: expect.objectContaining({ agentId: "agent_slash_path" }),
        }),
      );
    } finally {
      stdoutSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("oneShotCLI streams startup prompt and images to the daemon session", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-image-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-image-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_one_shot_image",
      sessionId: "session_one_shot_image",
      cwd: tmpCwd,
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const code = await oneShotCLI("describe this", [
        "http://127.0.0.1/cat.png",
      ]);
      expect(code).toBe(0);
      expect(daemon.requests[0]).toEqual({
        method: "agent.create",
        params: expect.objectContaining({
          objective: "describe this",
          instructions: "describe this",
          cwd: tmpCwd,
          initialContent: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: "http://127.0.0.1/cat.png" },
            },
          ],
          metadata: { source: "agenc.prompt", mode: "one-shot" },
        }),
      });
      expect(daemon.requests[1]).toEqual(
        expect.objectContaining({ method: "agent.attach" }),
      );
    } finally {
      stdoutSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry opens an idle daemon-backed TUI without starting a prompt agent", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-idle-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-idle-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_tui_idle",
      sessionId: "session_tui_idle",
      cwd: tmpCwd,
    });

    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const unmount = vi.fn();
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async () => ({ unmount, waitUntilExit })),
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const code = await bootTUIEntry({});
      expect(code).toBe(0);
      expect(daemon.startPromptAgent).not.toHaveBeenCalled();
      expect(daemon.createConnectedTuiClient).not.toHaveBeenCalled();
      expect(daemon.requests).toEqual([]);
      expect(waitUntilExit).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry starts a daemon prompt agent on first ordinary TUI input", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-slash-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-slash-cwd-"));
    const prevArgv = process.argv;
    const prevEnv = { ...process.env };

    process.argv = ["node", "agenc", "--provider", "grok", "--model", "grok-4.3"];
    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_tui_slash",
      sessionId: "session_tui_slash",
      cwd: tmpCwd,
    });

    let resolveExit: (() => void) | null = null;
    const waitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
    );
    const unmount = vi.fn();
    let capturedSession: {
      submit?: (message: string) => Promise<void>;
      subscribeToEvents?: (cb: (event: { type: string }) => void) => () => void;
    } | null = null;
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async (opts: { session: typeof capturedSession }) => {
        capturedSession = opts.session as typeof capturedSession;
        return { unmount, waitUntilExit };
      }),
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const pending = bootTUIEntry({});
      const session = await waitForValue(
        "deferred TUI session",
        () => capturedSession,
      );

      await session.submit?.("hello daemon");

      resolveExit?.();
      const code = await pending;
      expect(code).toBe(0);
      expect(daemon.startPromptAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "hello daemon",
          cwd: tmpCwd,
          provider: "grok",
          model: "grok-4.3",
          initialContent: "hello daemon",
        }),
      );
      expect(daemon.requests.map((request) => request.method)).toEqual([
        "agent.attach",
      ]);
    } finally {
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      process.argv = prevArgv;
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry carries pre-start /mcp additions into the daemon prompt agent", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-mcp-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-mcp-cwd-"));
    const prevArgv = process.argv;
    const prevEnv = { ...process.env };

    process.argv = ["node", "agenc", "--provider", "grok", "--model", "grok-4.3"];
    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const mcpConfig = {
      name: "audit-ping",
      transport: "stdio",
      command: "node",
      args: [join(tmpCwd, ".agenc/mcp/audit-ping.mjs")],
      enabled: true,
    };
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_tui_mcp",
      sessionId: "session_tui_mcp",
      cwd: tmpCwd,
      mcpManager: {
        getConfiguredServers: () => [mcpConfig],
      },
    });

    let resolveExit: (() => void) | null = null;
    const waitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
    );
    const unmount = vi.fn();
    let capturedSession: {
      submit?: (message: string) => Promise<void>;
    } | null = null;
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async (opts: { session: typeof capturedSession }) => {
        capturedSession = opts.session as typeof capturedSession;
        return { unmount, waitUntilExit };
      }),
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const pending = bootTUIEntry({});
      const session = await waitForValue(
        "deferred TUI session",
        () => capturedSession,
      );

      await session.submit?.("use the audit MCP tool");

      resolveExit?.();
      const code = await pending;
      expect(code).toBe(0);
      const env = daemon.startPromptAgent.mock.calls[0]?.[0].env as
        | NodeJS.ProcessEnv
        | undefined;
      expect(env?.AGENC_MCP_SERVERS).toBe(JSON.stringify([mcpConfig]));
    } finally {
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      process.argv = prevArgv;
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry publishes deferred local transcript events before daemon startup", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-local-emit-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-local-emit-cwd-"));
    const prevArgv = process.argv;
    const prevEnv = { ...process.env };

    process.argv = ["node", "agenc", "--provider", "grok", "--model", "grok-4.3"];
    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_tui_local_emit",
      sessionId: "session_tui_local_emit",
      cwd: tmpCwd,
    });

    let resolveExit: (() => void) | null = null;
    const waitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
    );
    const unmount = vi.fn();
    let capturedSession: {
      emit?: (event: unknown) => void;
      subscribeToEvents?: (cb: (event: unknown) => void) => () => void;
    } | null = null;
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async (opts: { session: typeof capturedSession }) => {
        capturedSession = opts.session as typeof capturedSession;
        return { unmount, waitUntilExit };
      }),
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const pending = bootTUIEntry({});
      const session = await waitForValue(
        "deferred TUI session",
        () => capturedSession,
      );
      const localEvents: unknown[] = [];
      const unsubscribe = session.subscribeToEvents?.((event) => {
        localEvents.push(event);
      });
      const event = {
        id: "local-bash-output",
        msg: {
          type: "user_message",
          payload: {
            message: "<bash-stdout>WBANCHOR-001</bash-stdout>",
            displayText: "<bash-stdout>WBANCHOR-001</bash-stdout>",
          },
        },
      };

      session.emit?.(event);
      unsubscribe?.();

      resolveExit?.();
      const code = await pending;
      expect(code).toBe(0);
      expect(daemon.startPromptAgent).not.toHaveBeenCalled();
      expect(localEvents).toEqual([event]);
    } finally {
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      process.argv = prevArgv;
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it.each(["/help", "/permissions"])(
    "bootTUIEntry does not send first %s input as a daemon prompt",
    async (slashInput) => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-permissions-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-permissions-cwd-"));
    const prevArgv = process.argv;
    const prevEnv = { ...process.env };
    process.argv = ["node", "agenc", "--provider", "xai"];
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "test-key";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_permissions",
      sessionId: "session_permissions",
      cwd: tmpCwd,
    });

    let resolveExit: (() => void) | null = null;
    const waitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
    );
    const unmount = vi.fn();
    let capturedSession: {
      submit?: (message: string) => Promise<void>;
      subscribeToEvents?: (
        cb: (event: { type: string; [key: string]: unknown }) => void,
      ) => () => void;
    } | null = null;
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async (opts: { session: typeof capturedSession }) => {
        capturedSession = opts.session as typeof capturedSession;
        return { unmount, waitUntilExit };
      }),
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const pending = bootTUIEntry({});
      const session = await waitForValue(
        "deferred TUI session",
        () => capturedSession,
      );
      const localEvents: Array<{
        readonly type?: string;
        readonly input?: string;
        readonly result?: { readonly kind?: string };
      }> = [];
      const unsubscribe = session.subscribeToEvents?.((event) => {
        localEvents.push(event);
      });

      await session.submit?.(slashInput);
      unsubscribe?.();

      resolveExit?.();
      const code = await pending;
      expect(code).toBe(0);
      expect(daemon.startPromptAgent).not.toHaveBeenCalled();
      expect(daemon.requests).toEqual([]);
      expect(localEvents).toEqual([
        expect.objectContaining({
          type: "slash_result",
          input: slashInput,
          result: expect.objectContaining({ kind: "text" }),
        }),
      ]);
    } finally {
      process.argv = prevArgv;
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
    },
  );

  it("stops the daemon agent when deferred TUI client connection fails", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-connect-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-connect-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_connect_failure",
      sessionId: "session_connect_failure",
      cwd: tmpCwd,
      createConnectedTuiClientError: new Error("connect failed"),
    });

    let resolveExit: (() => void) | null = null;
    const waitUntilExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
    );
    let capturedSession: { submit?: (message: string) => Promise<void> } | null =
      null;
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async (opts: { session: typeof capturedSession }) => {
        capturedSession = opts.session as typeof capturedSession;
        return { unmount: vi.fn(), waitUntilExit };
      }),
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      const pending = bootTUIEntry({});
      const session = await waitForValue(
        "deferred TUI session",
        () => capturedSession,
      );
      await expect(session.submit?.("hello daemon")).rejects.toThrow(
        "connect failed",
      );
      resolveExit?.();
      await expect(pending).resolves.toBe(0);
      expect(daemon.stopPromptAgent).toHaveBeenCalledWith({
        agentId: "agent_connect_failure",
        reason: "tui_startup_failed",
        env: process.env,
      });
    } finally {
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("stops the daemon agent when eager TUI attach fails", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-attach-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-attach-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_attach_failure",
      sessionId: "session_attach_failure",
      cwd: tmpCwd,
      requestErrors: { "agent.attach": new Error("attach failed") },
    });

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      await expect(bootTUIEntry({ initialPrompt: "queue this" })).rejects.toThrow(
        "attach failed",
      );
      expect(daemon.stopPromptAgent).toHaveBeenCalledWith({
        agentId: "agent_attach_failure",
        reason: "tui_startup_failed",
        env: process.env,
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("stops the daemon agent when eager TUI boot fails after attach", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-boot-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-boot-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_boot_failure",
      sessionId: "session_boot_failure",
      cwd: tmpCwd,
    });
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async () => {
        throw new Error("boot failed");
      }),
    }));

    try {
      trustWorkspaceForTest(tmpHome, tmpCwd);
      await expect(bootTUIEntry({ initialPrompt: "queue this" })).rejects.toThrow(
        "boot failed",
      );
      expect(daemon.stopPromptAgent).toHaveBeenCalledWith({
        agentId: "agent_boot_failure",
        reason: "tui_startup_failed",
        env: process.env,
      });
    } finally {
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("runs the full main() path through daemon-backed one-shot and exits 0", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-main-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-cwd-"));

    const prevArgv = process.argv;
    const prevEnv = { ...process.env };
    const prevStdinIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    process.argv = [
      process.argv[0] ?? "node",
      "agenc-test-entry",
      "--provider",
      "grok",
      "--model",
      "grok-4.3",
      "hi",
    ];
    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    process.env.AGENC_DAEMON_AUTOSTART = "0";
    trustWorkspaceForTest(tmpHome, tmpCwd);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    const daemon = installDaemonCliDepsForTest({
      agentId: "agent_main",
      sessionId: "session_main",
      cwd: tmpCwd,
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);

    try {
      const code = await main();
      expect(code).toBe(0);
      expect(daemon.requests[0]).toEqual({
        method: "agent.create",
        params: expect.objectContaining({
          objective: "hi",
          instructions: "hi",
          cwd: tmpCwd,
          provider: "grok",
          model: "grok-4.3",
          metadata: { source: "agenc.prompt", mode: "one-shot" },
        }),
      });
      expect(daemon.requests[1]).toEqual(
        expect.objectContaining({
          method: "agent.attach",
          params: expect.objectContaining({ agentId: "agent_main" }),
        }),
      );
      expect(
        stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toBe("daemon answer\n");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      stdoutSpy.mockRestore();
      process.argv = prevArgv;
      if (prevStdinIsTTY === undefined) {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(process.stdin, "isTTY", prevStdinIsTTY);
      }
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
    expect(rejections).toEqual([]);
  });
});
