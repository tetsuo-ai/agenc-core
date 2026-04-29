/**
 * T9 integration seams for `bin/agenc.ts`:
 *   - slash-command short-circuit through the canonical dispatcher path
 *   - `system.agent.delegate` built-in tool
 *
 * T10 Group I integration seams:
 *   - I-60 ambiguous-model hard-fail (`resolveModelOrExit`)
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
  TurnStateAccumulator,
  __resetActiveInkUnmountForTest,
  __setActiveInkUnmountForTest,
  buildExtractMemoriesViaSubagent,
  bootTUIEntry,
  formatCliHelpText,
  initializeCliRuntime,
  installInitSignalHandlers,
  installSignalHandlers,
  main,
  maybeReloadConfigBetweenTurns,
  oneShotCLI,
  parseExtractedMemoryCandidates,
  prepareTurnRuntimeInputs,
  resolveModelOrExit,
  resumeTUIEntry,
  runSingleTurn,
  sessionConfigurationFromAgenCConfig,
  validateAgencHome,
  type ConfigReloadLatch,
} from "./agenc.js";
import { ConfigStore, defaultConfig } from "../config/index.js";
import * as configUtils from "./_deps/config-init.js";
import {
  assembleSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "../prompts/system-prompt.js";
import {
  clearSystemPromptSections,
  __systemPromptSectionCacheSize,
} from "../prompts/sections.js";
import {
  buildRolloutFilename,
  getProjectDir,
} from "../session/session-store.js";
import {
  loadMemoryPrompt,
  registerAutoSaveSidecar,
  maybeAutoSaveMemory,
  selectRelevantMemoriesForTurn,
  injectAttachmentsIntoPrompt,
  _resetAutoSaveStateForTest,
  _clearMemoryWriteLocksForTest,
  type AutoSaveSession,
  type MemoryCandidate,
  type TurnState as MemoryTurnState,
} from "../prompts/memory/index.js";
import type { MemoryEntry } from "../prompts/memory/types.js";
import type { Session } from "../session/session.js";
import { getCurrentRuntimeSession } from "./_deps/current-session.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";

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

describe("buildDelegateTool — system.agent.delegate", () => {
  const LIVE = {
    agentId: "thread-1",
    agentPath: "/root/alpha",
    nickname: "alpha",
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
    const roleSchema = props.role as { enum: string[] };
    expect(roleSchema.enum).toEqual(["default", "explorer", "worker"]);
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
      role: "explorer",
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
  it("advertises grok models including the default grok-4-fast", () => {
    expect(PROVIDER_MODEL_CATALOG.grok).toContain("grok-4-fast");
    expect(PROVIDER_MODEL_CATALOG.grok).toContain("grok-4");
    expect(PROVIDER_MODEL_CATALOG.grok).toContain("grok-code-fast-1");
  });
});

describe("I-60: resolveModelOrExit hard-fail", () => {
  it("returns {provider, model} for an unambiguous bare slug", () => {
    const result = resolveModelOrExit("grok-4-fast", PROVIDER_MODEL_CATALOG);
    expect(result.provider).toBe("grok");
    expect(result.model).toBe("grok-4-fast");
  });

  it("accepts explicit provider:model form", () => {
    const result = resolveModelOrExit("grok:grok-4", PROVIDER_MODEL_CATALOG);
    expect(result.provider).toBe("grok");
    expect(result.model).toBe("grok-4");
  });

  it("hard-fails with exit(1) + clear message on ambiguous bare slug", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const err: string[] = [];
    const errSink = (line: string) => {
      err.push(line);
    };
    const catalog = {
      grok: ["shared-model", "grok-4"] as readonly string[],
      openai: ["shared-model", "gpt-4"] as readonly string[],
    };
    // `resolveModelOrExit` calls exit(1) on ambiguity; the mock doesn't
    // throw, so control falls through — guard with a try/catch.
    try {
      resolveModelOrExit("shared-model", catalog, exit, errSink);
    } catch {
      /* reachable after the unreachable-guard throw */
    }
    expect(exit).toHaveBeenCalledWith(1);
    const joined = err.join("");
    expect(joined).toMatch(/ambiguous model/);
    expect(joined).toMatch(/grok:shared-model/);
    expect(joined).toMatch(/openai:shared-model/);
  });

  it("hard-fails with exit(1) on unknown model slug", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const err: string[] = [];
    const errSink = (line: string) => {
      err.push(line);
    };
    try {
      resolveModelOrExit("nope-unknown", PROVIDER_MODEL_CATALOG, exit, errSink);
    } catch {
      /* expected unreachable guard */
    }
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.join("")).toMatch(/unknown model/);
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
      model: "grok-4-fast",
    });
    expect(sc.approvalPolicy.value).toBe("never");
    expect(sc.sandboxPolicy.value).toBe("read_only");
    expect(sc.cwd).toBe("/tmp/ws");
    expect(sc.collaborationMode.model).toBe("grok-4-fast");
    expect(sc.sessionSource).toBe("cli_main");
  });

  it("defaults to on_request + workspace_write when policy fields absent", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: undefined },
      workspaceRoot: "/tmp/ws",
      model: "grok-4-fast",
    });
    // defaultConfig provides "on-request" → "on_request"
    expect(sc.approvalPolicy.value).toBe("on_request");
    expect(sc.sandboxPolicy.value).toBe("workspace_write");
    expect(sc.fileSystemSandboxPolicy.allowWrite).toEqual(["/tmp/ws"]);
  });

  it("on-failure → on_failure mapping", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: "on-failure" as const },
      workspaceRoot: "/tmp/ws",
      model: "grok-4-fast",
    });
    expect(sc.approvalPolicy.value).toBe("on_failure");
  });

  it("propagates personality, reasoning_summary, and compact_prompt", () => {
    const cfg = {
      ...defaultConfig(),
      personality: "terse" as const,
      reasoning_summary: "detailed" as const,
      compact_prompt: "COMPACT: keep only the durable facts.",
    };
    const sc = sessionConfigurationFromAgenCConfig({
      config: cfg,
      workspaceRoot: "/tmp/ws",
      model: "grok-4-fast",
    });
    expect(sc.personality).toBe("terse");
    expect(sc.modelReasoningSummary).toBe("detailed");
    expect(sc.compactPrompt).toBe("COMPACT: keep only the durable facts.");
  });

  it("leaves propagated fields undefined when config omits them", () => {
    const cfg = { ...defaultConfig() };
    // defaultConfig() sets personality=default — override to undefined
    // to confirm the bridge skips the field entirely.
    const override = {
      ...cfg,
      personality: undefined,
      reasoning_summary: undefined,
      compact_prompt: undefined,
    } as typeof cfg;
    const sc = sessionConfigurationFromAgenCConfig({
      config: override,
      workspaceRoot: "/tmp/ws",
      model: "grok-4-fast",
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
      expect(result.previous.model).toBe("grok-4-fast");
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
    expect(arg.msg.payload.message).toMatch(/grok-4-fast/);
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
        modelInfo: { slug: "grok-4-fast" },
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

let memTmpDir: string | undefined;
afterEach(async () => {
  if (memTmpDir) {
    await rm(memTmpDir, { recursive: true, force: true });
    memTmpDir = undefined;
  }
  vi.restoreAllMocks();
  __resetActiveInkUnmountForTest();
  clearSystemPromptSections();
  _clearMemoryWriteLocksForTest();
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

async function setupMemoryDir(): Promise<{
  dir: string;
  mdPath: string;
  session: AutoSaveSession;
}> {
  memTmpDir = await mkdtemp(join(tmpdir(), "agenc-t10i-"));
  const mdPath = join(memTmpDir, "MEMORY.md");
  return {
    dir: memTmpDir,
    mdPath,
    session: { memoryDir: memTmpDir, memoryMdPath: mdPath },
  };
}

describe("memory auto-save sidecar wiring", () => {
  it("registerAutoSaveSidecar returns a Sidecar that fires on turn_complete", async () => {
    const { session } = await setupMemoryDir();
    _resetAutoSaveStateForTest(session);
    const extractor = vi.fn().mockResolvedValue([]);
    const turnState: MemoryTurnState = {
      tokensConsumed: 10_000,
      toolCallsIssued: 10,
      lastTurnHadNoTools: false,
    };
    const sidecar = registerAutoSaveSidecar({
      session,
      extractor,
      getTurnState: () => turnState,
    });
    expect(sidecar.name).toBe("memory-auto-save");
    sidecar.onEvent({
      ts: 1,
      id: "x",
      msg: {
        type: "turn_complete",
        payload: {
          turnId: "t1",
          lastAgentMessage: "",
          completedAt: 1,
          durationMs: 1,
        },
      },
    } as never);
    // Let fire-and-forget resolve.
    await new Promise((r) => setTimeout(r, 5));
    expect(extractor).toHaveBeenCalled();
  });

  it("maybeAutoSaveMemory fires when thresholds are tripped", async () => {
    const { session, dir } = await setupMemoryDir();
    _resetAutoSaveStateForTest(session);
    const candidate: MemoryCandidate = {
      filePath: join(dir, "topic.md"),
      frontmatter: {
        name: "topic-one",
        description: "a concrete topic",
        type: "feedback",
        extra: {},
      },
      body:
        "This memory body is long enough to pass isMemoryWorthy (>20 chars).",
    };
    const extractor = vi.fn().mockResolvedValue([candidate]);
    await maybeAutoSaveMemory(
      session,
      {
        tokensConsumed: 10_000,
        toolCallsIssued: 10,
        lastTurnHadNoTools: false,
      },
      extractor,
    );
    expect(extractor).toHaveBeenCalledTimes(1);
    const md = await import("node:fs/promises").then((m) =>
      m.readFile(candidate.filePath, "utf8"),
    );
    expect(md).toMatch(/topic-one/);
    const idx = await import("node:fs/promises").then((m) =>
      m.readFile(session.memoryMdPath, "utf8"),
    );
    expect(idx).toMatch(/topic.md/);
  });

  it("maybeAutoSaveMemory no-ops when thresholds not tripped", async () => {
    const { session } = await setupMemoryDir();
    _resetAutoSaveStateForTest(session);
    const extractor = vi.fn();
    await maybeAutoSaveMemory(
      session,
      {
        tokensConsumed: 100,
        toolCallsIssued: 0,
        lastTurnHadNoTools: false,
      },
      extractor,
    );
    expect(extractor).not.toHaveBeenCalled();
  });
});

describe("buildExtractMemoriesViaSubagent adapter", () => {
  it("gracefully returns [] when session is unreachable", async () => {
    const fn = buildExtractMemoriesViaSubagent({
      session: () => null,
      memoryDir: "/tmp/memory",
    });
    const out = await fn("transcript", {
      memoryDir: "/tmp/memory",
      memoryMdPath: "/tmp/memory/MEMORY.md",
    });
    expect(out).toEqual([]);
  });

  it("is shaped as ExtractMemoriesFn (async, returns readonly array)", async () => {
    const fakeSession = { emit: vi.fn(), nextInternalSubId: () => "sub" } as never;
    // Inject a delegateFn that rejects so the adapter returns [] without
    // touching the real AgentControl/registry graph.
    const delegateFn = vi.fn().mockResolvedValue({
      kind: "rejected",
      reason: "test-stub",
    });
    const fn = buildExtractMemoriesViaSubagent({
      session: () => fakeSession,
      memoryDir: "/tmp/memory",
      delegateFn: delegateFn as never,
    });
    const out = await fn("transcript", {
      memoryDir: "/tmp/memory",
      memoryMdPath: "/tmp/memory/MEMORY.md",
    });
    expect(Array.isArray(out)).toBe(true);
    expect(delegateFn).toHaveBeenCalledTimes(1);
  });

  it("spawns an explorer subagent and parses valid JSON into MemoryCandidates", async () => {
    const emit = vi.fn();
    const session = {
      emit,
      nextInternalSubId: () => "sub-a",
    } as never;
    const delegateFn = vi.fn().mockResolvedValue({
      kind: "sync_completed",
      thread: { threadId: "t1", live: { agentPath: "/root/ex" } },
      result: {
        threadId: "t1",
        outcome: "completed",
        durationMs: 5,
        finalMessage: JSON.stringify([
          {
            name: "user-fact-1",
            description: "likes dark mode",
            type: "user",
            body: "User prefers dark themes in all tools.",
          },
          {
            name: "ignored-no-body",
            description: "no body",
            type: "feedback",
            body: "",
          },
          {
            name: "ignored-bad-type",
            description: "bad",
            type: "other",
            body: "should be dropped",
          },
        ]),
        toolCallCount: 0,
      },
    });
    const fn = buildExtractMemoriesViaSubagent({
      session: () => session,
      memoryDir: "/tmp/mem",
      delegateFn: delegateFn as never,
    });
    const out = await fn("a transcript", {
      memoryDir: "/tmp/mem",
      memoryMdPath: "/tmp/mem/MEMORY.md",
    });
    expect(out.length).toBe(1);
    expect(out[0]!.frontmatter.name).toBe("user-fact-1");
    expect(out[0]!.frontmatter.type).toBe("user");
    expect(out[0]!.filePath).toBe("/tmp/mem/entries/user-fact-1.md");
    expect(delegateFn).toHaveBeenCalledTimes(1);
    const call = delegateFn.mock.calls[0]![0];
    expect(call.role).toBe("explorer");
    expect(call.parentPath).toBe("/root");
    expect(call.forkMode).toEqual({ kind: "full_history" });
    expect(call.runInBackground).toBe(false);
    expect(call.forceSynchronous).toBe(true);
    expect(call.toolAllowlist).toEqual([]);
    expect(call.taskPrompt).toMatch(/JSON array/);
    expect(call.taskPrompt).toMatch(/a transcript/);
    expect(call.taskPrompt).toMatch(/memory extraction subagent/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("forks parent history instead of relying on a raw transcript paste", async () => {
    const emit = vi.fn();
    const session = {
      emit,
      nextInternalSubId: () => "sub-h",
      snapshotHistoryMessages: () => [
        { role: "user", content: "remember that I prefer focused diffs" },
        { role: "assistant", content: "Noted." },
      ],
    } as never;
    const delegateFn = vi.fn().mockResolvedValue({
      kind: "sync_completed",
      thread: { threadId: "t1", live: { agentPath: "/root/ex" } },
      result: {
        threadId: "t1",
        outcome: "completed",
        durationMs: 5,
        finalMessage: "[]",
        toolCallCount: 0,
      },
    });
    const fn = buildExtractMemoriesViaSubagent({
      session: () => session,
      memoryDir: "/tmp/mem",
      delegateFn: delegateFn as never,
    });

    await fn("", {
      memoryDir: "/tmp/mem",
      memoryMdPath: "/tmp/mem/MEMORY.md",
    });

    const call = delegateFn.mock.calls[0]![0];
    expect(call.forkMode).toEqual({ kind: "full_history" });
    expect(call.toolAllowlist).toEqual([]);
    expect(call.taskPrompt).toContain("most recent ~2 messages above");
    expect(call.taskPrompt).not.toContain("--- TRANSCRIPT ---");
  });

  it("does not spawn the extractor when both history and transcript are empty", async () => {
    const session = {
      emit: vi.fn(),
      nextInternalSubId: () => "sub-empty",
      snapshotHistoryMessages: () => [],
    } as never;
    const delegateFn = vi.fn();
    const fn = buildExtractMemoriesViaSubagent({
      session: () => session,
      memoryDir: "/tmp/mem",
      delegateFn: delegateFn as never,
    });

    const out = await fn("", {
      memoryDir: "/tmp/mem",
      memoryMdPath: "/tmp/mem/MEMORY.md",
    });

    expect(out).toEqual([]);
    expect(delegateFn).not.toHaveBeenCalled();
  });

  it("emits memory_extract_parse_failed warning and returns [] on malformed JSON", async () => {
    const emit = vi.fn();
    const session = {
      emit,
      nextInternalSubId: () => "sub-p",
    } as never;
    const delegateFn = vi.fn().mockResolvedValue({
      kind: "sync_completed",
      thread: { threadId: "t1", live: { agentPath: "/root/ex" } },
      result: {
        threadId: "t1",
        outcome: "completed",
        durationMs: 5,
        finalMessage: "this is not json at all",
        toolCallCount: 0,
      },
    });
    const fn = buildExtractMemoriesViaSubagent({
      session: () => session,
      memoryDir: "/tmp/mem",
      delegateFn: delegateFn as never,
    });
    const out = await fn("t", {
      memoryDir: "/tmp/mem",
      memoryMdPath: "/tmp/mem/MEMORY.md",
    });
    expect(out).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]![0].msg.payload;
    expect(payload.cause).toBe("memory_extract_parse_failed");
  });

  it("emits memory_extract_failed warning when delegate throws", async () => {
    const emit = vi.fn();
    const session = {
      emit,
      nextInternalSubId: () => "sub-e",
    } as never;
    const delegateFn = vi.fn().mockRejectedValue(new Error("spawn boom"));
    const fn = buildExtractMemoriesViaSubagent({
      session: () => session,
      memoryDir: "/tmp/mem",
      delegateFn: delegateFn as never,
    });
    const out = await fn("t", {
      memoryDir: "/tmp/mem",
      memoryMdPath: "/tmp/mem/MEMORY.md",
    });
    expect(out).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]![0].msg.payload;
    expect(payload.cause).toBe("memory_extract_failed");
    expect(payload.message).toMatch(/spawn boom/);
  });

  it("emits memory_extract_failed warning on a rejected delegate outcome", async () => {
    const emit = vi.fn();
    const session = {
      emit,
      nextInternalSubId: () => "sub-r",
    } as never;
    const delegateFn = vi.fn().mockResolvedValue({
      kind: "rejected",
      reason: "max depth exceeded",
    });
    const fn = buildExtractMemoriesViaSubagent({
      session: () => session,
      memoryDir: "/tmp/mem",
      delegateFn: delegateFn as never,
    });
    const out = await fn("t", {
      memoryDir: "/tmp/mem",
      memoryMdPath: "/tmp/mem/MEMORY.md",
    });
    expect(out).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]![0].msg.payload;
    expect(payload.cause).toBe("memory_extract_failed");
    expect(payload.message).toMatch(/max depth exceeded/);
  });
});

describe("parseExtractedMemoryCandidates", () => {
  it("filters entries missing name/type/body", () => {
    const raw = JSON.stringify([
      { name: "ok", description: "d", type: "user", body: "enough body" },
      { name: "", description: "d", type: "user", body: "no name" },
      { name: "bad-type", description: "d", type: "xxx", body: "b" },
      { name: "no-body", description: "d", type: "feedback", body: "" },
      "not-an-object",
      null,
    ]);
    const out = parseExtractedMemoryCandidates(raw, "/mem");
    expect(out.length).toBe(1);
    expect(out[0]!.frontmatter.name).toBe("ok");
  });

  it("throws when top-level is not an array", () => {
    expect(() => parseExtractedMemoryCandidates("{}", "/mem")).toThrow();
  });

  it("recovers when the model appends prose after the JSON array", () => {
    // Real failure mode from the wild: position 3 (line 2 column 1) means
    // JSON.parse consumed `[]\n` and then choked on prose on line 2.
    const raw = `[{"name":"foo","description":"d","type":"user","body":"x x x"}]
These are the memories I extracted.`;
    const out = parseExtractedMemoryCandidates(raw, "/mem");
    expect(out.length).toBe(1);
    expect(out[0]!.frontmatter.name).toBe("foo");
  });

  it("recovers when the model wraps the JSON in a markdown fence", () => {
    const raw = '```json\n[{"name":"bar","description":"d","type":"feedback","body":"abc"}]\n```';
    const out = parseExtractedMemoryCandidates(raw, "/mem");
    expect(out.length).toBe(1);
    expect(out[0]!.frontmatter.name).toBe("bar");
  });

  it("ignores brackets inside string literals when locating the array", () => {
    // The fallback bracket-balance walk has to honor string literals so
    // tokens like `"]"` don't close the array prematurely.
    const raw = 'Sure, here you go:\n[{"name":"baz","description":"has ] and \\" inside","type":"project","body":"y y y"}]';
    const out = parseExtractedMemoryCandidates(raw, "/mem");
    expect(out.length).toBe(1);
    expect(out[0]!.frontmatter.name).toBe("baz");
  });

  it("throws the original error when no JSON array can be found", () => {
    expect(() => parseExtractedMemoryCandidates("totally not json", "/mem"))
      .toThrow(/JSON/);
  });
});

describe("system-prompt assembly: project instructions + memory", () => {
  it("includes project instructions + memory in the assembled dynamic tail", async () => {
    const { session, dir, mdPath } = await setupMemoryDir();
    // Seed a MEMORY.md with a short pointer line (no topic files).
    await writeFile(mdPath, "- topic: example index\n", "utf8");
    const memory = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
    });
    expect(memory.text).toMatch(/MEMORY\.md/);
    expect(memory.text).not.toContain("example index");

    const cfg = defaultConfig();
    const assembled = await assembleSystemPrompt({
      session: {} as never,
      ctx: {
        config: cfg,
        configSnapshot: cfg,
        cwd: "/tmp",
        modelInfo: { slug: "grok-4-fast" },
      } as never,
      projectInstructions: "## project\n\nFollow repo AGENC.md guidance.",
      memoryPrompt: memory.text,
    });
    expect(assembled.text).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(assembled.text).toMatch(/project/);
    expect(assembled.text).toMatch(/MEMORY\.md/);
    expect(assembled.text).not.toContain("example index");
    void session;
  });

  it("injectAttachmentsIntoPrompt appends Relevant memories section", async () => {
    const entry: MemoryEntry = {
      filePath: "/tmp/memory/foo.md",
      frontmatter: {
        name: "foo",
        description: "about foo",
        type: "reference",
        extra: {},
      },
      body: "some body",
      mtimeMs: Date.now(),
      byteLength: 42,
    };
    const out = injectAttachmentsIntoPrompt("BASE PROMPT", [entry]);
    expect(out).toMatch(/BASE PROMPT/);
    expect(out).toMatch(/Relevant memories/);
    expect(out).toMatch(/foo/);
  });

  it("selectRelevantMemoriesForTurn respects per-session byte cap", async () => {
    const entries: MemoryEntry[] = Array.from({ length: 3 }, (_, i) => ({
      filePath: `/tmp/memory/m${i}.md`,
      frontmatter: {
        name: `m${i}`,
        description: `foobar keyword ${i}`,
        type: "reference" as const,
        extra: {},
      },
      body: "body",
      mtimeMs: Date.now(),
      byteLength: 40_000, // 40KB each
    }));
    const session: object = { id: "test-session-cap" };
    // Override per-file cap to permit 40KB entries; session cap = 60KB
    // so only one should fit.
    const picked = selectRelevantMemoriesForTurn(entries, "about foobar", session, {
      maxBytesPerFile: 50_000,
      maxBytesPerSession: 60_000,
    });
    expect(picked.length).toBe(1);
  });
});

describe("ConfigStore integration shape", () => {
  it("constructs from empty env + defaults and current() is frozen", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-config-empty-"));
    try {
      const store = new ConfigStore({ home, env: {} });
      await store.reload();
      const cur = store.current();
      expect(cur.model).toBe("grok-4-fast");
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

describe("per-turn memory attachments pipeline", () => {
  it("setupMemoryDir scaffold works with zero entries", async () => {
    const { dir, mdPath } = await setupMemoryDir();
    expect(dir.length).toBeGreaterThan(0);
    await mkdir(dir, { recursive: true });
    const mem = await loadMemoryPrompt({ memoryDir: dir, memoryMdPath: mdPath });
    expect(mem.text).toBe("");
    expect(mem.entries).toEqual([]);
  });
});

describe("prepareTurnRuntimeInputs", () => {
  it("reloads project instructions, memory prompt, and MCP instructions on each call", async () => {
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
    expect(first.memoryPromptText).toContain("# Memory");
    expect(first.memoryPromptText).not.toContain("MEMORY-ONE");
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
    expect(second.memoryPromptText).toContain("# Memory");
    expect(second.memoryPromptText).not.toContain("MEMORY-TWO");
    expect(second.memoryPromptText).not.toContain("MEMORY-ONE");
    expect(second.mcpServers).toEqual([
      { name: "alpha", instructions: "MCP-TWO" },
    ]);

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
    expect(prompts[0]).toContain("## alpha");
    expect(prompts[1]).toContain("PROJECT-TWO");
    expect(prompts[1]).toContain("MEMORY-TWO");
    expect(prompts[1]).toContain("## beta");
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
// T10 A+ Fix-α — TurnStateAccumulator
// ─────────────────────────────────────────────────────────────────────

describe("TurnStateAccumulator", () => {
  it("starts with zero counters", () => {
    const acc = new TurnStateAccumulator();
    expect(acc.snapshot()).toEqual({
      tokensConsumed: 0,
      toolCallsIssued: 0,
      lastTurnHadNoTools: false,
    });
  });

  it("accumulates token_count deltas across multiple emissions", () => {
    const acc = new TurnStateAccumulator();
    acc.onEvent({
      id: "1",
      msg: { type: "token_count", payload: { totalTokens: 500 } },
    } as never);
    acc.onEvent({
      id: "2",
      msg: { type: "token_count", payload: { totalTokens: 1500 } },
    } as never);
    expect(acc.snapshot().tokensConsumed).toBe(2000);
  });

  it("increments toolCallsIssued on tool_call_completed", () => {
    const acc = new TurnStateAccumulator();
    acc.onEvent({
      id: "a",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "c1", result: "ok", isError: false },
      },
    } as never);
    acc.onEvent({
      id: "b",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "c2", result: "ok", isError: false },
      },
    } as never);
    expect(acc.snapshot().toolCallsIssued).toBe(2);
  });

  it("sets lastTurnHadNoTools=true when a turn completes with no tool calls", () => {
    const acc = new TurnStateAccumulator();
    acc.onEvent({
      id: "ts",
      msg: { type: "turn_started", payload: { turnId: "t1" } },
    } as never);
    acc.onEvent({
      id: "tc",
      msg: { type: "turn_complete", payload: { turnId: "t1" } },
    } as never);
    expect(acc.snapshot().lastTurnHadNoTools).toBe(true);
  });

  it("sets lastTurnHadNoTools=false when a turn had a tool call", () => {
    const acc = new TurnStateAccumulator();
    acc.onEvent({
      id: "ts",
      msg: { type: "turn_started", payload: { turnId: "t1" } },
    } as never);
    acc.onEvent({
      id: "tool",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "c1", result: "ok", isError: false },
      },
    } as never);
    acc.onEvent({
      id: "tc",
      msg: { type: "turn_complete", payload: { turnId: "t1" } },
    } as never);
    expect(acc.snapshot().lastTurnHadNoTools).toBe(false);
  });

  it("resets the per-turn tool flag on turn_started so stale flags don't carry across turns", () => {
    const acc = new TurnStateAccumulator();
    // Turn 1: has tool
    acc.onEvent({
      id: "s1",
      msg: { type: "turn_started", payload: { turnId: "t1" } },
    } as never);
    acc.onEvent({
      id: "t1",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "c1", result: "ok", isError: false },
      },
    } as never);
    acc.onEvent({
      id: "c1",
      msg: { type: "turn_complete", payload: { turnId: "t1" } },
    } as never);
    expect(acc.snapshot().lastTurnHadNoTools).toBe(false);
    // Turn 2: no tool — latch must flip to true.
    acc.onEvent({
      id: "s2",
      msg: { type: "turn_started", payload: { turnId: "t2" } },
    } as never);
    acc.onEvent({
      id: "c2",
      msg: { type: "turn_complete", payload: { turnId: "t2" } },
    } as never);
    expect(acc.snapshot().lastTurnHadNoTools).toBe(true);
    // Tool count is cumulative — still 1.
    expect(acc.snapshot().toolCallsIssued).toBe(1);
  });

  it("subscribe + detach plug into an EventLog without losing state", () => {
    const acc = new TurnStateAccumulator();
    type Listener = (e: unknown) => void;
    const listeners = new Set<Listener>();
    const fakeLog = {
      subscribe(fn: Listener) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    acc.subscribe(fakeLog as never);
    expect(listeners.size).toBe(1);
    // Simulate an emit.
    for (const fn of listeners)
      fn({
        id: "x",
        msg: { type: "token_count", payload: { totalTokens: 7_500 } },
      });
    expect(acc.snapshot().tokensConsumed).toBe(7_500);
    acc.detach();
    expect(listeners.size).toBe(0);
    // After detach, further emits are unhooked; counters stay put.
    expect(acc.snapshot().tokensConsumed).toBe(7_500);
  });

  it("reset() zeros all counters", () => {
    const acc = new TurnStateAccumulator();
    acc.onEvent({
      id: "a",
      msg: { type: "token_count", payload: { totalTokens: 9_999 } },
    } as never);
    acc.onEvent({
      id: "b",
      msg: {
        type: "tool_call_completed",
        payload: { callId: "c1", result: "ok", isError: false },
      },
    } as never);
    acc.reset();
    expect(acc.snapshot()).toEqual({
      tokensConsumed: 0,
      toolCallsIssued: 0,
      lastTurnHadNoTools: false,
    });
  });

  it("ignores unrelated event types (no-op fall-through)", () => {
    const acc = new TurnStateAccumulator();
    acc.onEvent({
      id: "w",
      msg: {
        type: "warning",
        payload: { cause: "unrelated", message: "noise" },
      },
    } as never);
    expect(acc.snapshot()).toEqual({
      tokensConsumed: 0,
      toolCallsIssued: 0,
      lastTurnHadNoTools: false,
    });
  });

  it("feeds shouldExtract far above the production floor when events accumulate", async () => {
    // End-to-end: drive enough token_count + tool_call_completed events
    // past the T10-C thresholds and confirm the snapshot would trip
    // `shouldExtract`. Regression guard for the prod getTurnState bug
    // where zeros kept the predicate permanently false.
    const acc = new TurnStateAccumulator();
    // 2 token_count events totalling 6_000 tokens → > 5_000 floor.
    acc.onEvent({
      id: "1",
      msg: { type: "token_count", payload: { totalTokens: 3_000 } },
    } as never);
    acc.onEvent({
      id: "2",
      msg: { type: "token_count", payload: { totalTokens: 3_000 } },
    } as never);
    // 5 tool_call_completed events → meets tool-burst floor.
    for (let i = 0; i < 5; i++) {
      acc.onEvent({
        id: `t${i}`,
        msg: {
          type: "tool_call_completed",
          payload: { callId: `c${i}`, result: "ok", isError: false },
        },
      } as never);
    }
    const { shouldExtract } = await import("../prompts/memory/auto-save.js");
    const snap = acc.snapshot();
    expect(
      shouldExtract(
        { tokensAtLastExtraction: 0, toolCallsAtLastExtraction: 0, inFlight: null },
        { ...snap, lastTurnHadNoTools: snap.lastTurnHadNoTools },
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T10 A+ Fix-α — memory_write_contention emits through session.emit
// ─────────────────────────────────────────────────────────────────────

describe("memory_write_contention routing (I-8)", () => {
  it("writeMemoryFile invokes emitWarning when FsLockTimeoutError fires", async () => {
    // Pre-create the sibling `<path>.lock` file so the fs-level
    // exclusive lock cannot be acquired; with a 50ms timeout the
    // write attempt times out and the contention path runs.
    const { writeMemoryFile } = await import(
      "../prompts/memory/auto-save.js"
    );
    const { _clearMemoryWriteLocksForTest } = await import(
      "../prompts/memory/loader.js"
    );
    const { lockfilePathFor } = await import("../prompts/memory/fs-lock.js");
    const { writeFile: fsWrite } = await import("node:fs/promises");

    const { dir, session } = await setupMemoryDir();
    _resetAutoSaveStateForTest(session);
    _clearMemoryWriteLocksForTest();

    const candidatePath = join(dir, "topic.md");
    // Seed the lockfile so `fs.open(..., 'wx')` hits EEXIST each poll.
    await fsWrite(
      lockfilePathFor(candidatePath),
      JSON.stringify({ pid: 999999, ts: Date.now() }),
      "utf8",
    );

    const warnings: string[] = [];
    const candidate: MemoryCandidate = {
      filePath: candidatePath,
      frontmatter: {
        name: "topic-one",
        description: "a concrete topic",
        type: "feedback",
        extra: {},
      },
      body:
        "This memory body is long enough to pass isMemoryWorthy (>20 chars).",
    };
    await writeMemoryFile(
      candidate,
      { timeoutMs: 50, retryMs: 10 },
      (m) => warnings.push(m),
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatch(/memory_write_contention/);
    // No file should have been written — contention path skips.
    const fs = await import("node:fs/promises");
    await expect(fs.readFile(candidatePath, "utf8")).rejects.toThrow();
  });

  it("falls back to console.warn when no emitWarning is wired (test-fixture friendly)", async () => {
    const { writeMemoryFile } = await import(
      "../prompts/memory/auto-save.js"
    );
    const { _clearMemoryWriteLocksForTest } = await import(
      "../prompts/memory/loader.js"
    );
    const { lockfilePathFor } = await import("../prompts/memory/fs-lock.js");
    const { writeFile: fsWrite } = await import("node:fs/promises");

    const { dir, session } = await setupMemoryDir();
    _resetAutoSaveStateForTest(session);
    _clearMemoryWriteLocksForTest();
    const candidatePath = join(dir, "topic.md");
    await fsWrite(
      lockfilePathFor(candidatePath),
      JSON.stringify({ pid: 999999, ts: Date.now() }),
      "utf8",
    );
    const candidate: MemoryCandidate = {
      filePath: candidatePath,
      frontmatter: {
        name: "topic-one",
        description: "fallback console test",
        type: "feedback",
        extra: {},
      },
      body:
        "Body long enough to pass isMemoryWorthy threshold — keep this.",
    };
    const originalWarn = console.warn;
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => {
      seen.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await writeMemoryFile(candidate, { timeoutMs: 50, retryMs: 10 });
    } finally {
      console.warn = originalWarn;
    }
    expect(
      seen.some((line) => line.includes("memory_write_contention")),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T10 A+ Fix-α — full-IIFE / main() smoke test
// ─────────────────────────────────────────────────────────────────────

describe("main() full-IIFE smoke", () => {
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

  it("main() fails fast on startup --image instead of drifting into normal routing", async () => {
    const prevArgv = [...process.argv];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    process.argv = [
      "/usr/bin/node",
      "/opt/agenc/bin/agenc.js",
      "--image",
      "/tmp/example.png",
      "describe this",
    ];

    try {
      const code = await main();
      expect(code).toBe(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(
        stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain("startup --image attachments are not wired");
    } finally {
      process.argv = prevArgv;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("oneShotCLI rejects malformed slash input through the canonical dispatcher path", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-slash-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-slash-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.AGENC_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "stub-openai-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    const startMcpSpy = vi
      .spyOn((await import("../session/session.js")).Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);
    const runTurnSpy = vi.spyOn(await import("../session/run-turn.js"), "runTurn");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const code = await oneShotCLI("/help\nextra");
      expect(code).toBe(1);
      expect(createProviderSpy).toHaveBeenCalledTimes(1);
      expect(createProviderSpy).toHaveBeenCalledWith(
        "openai",
        expect.objectContaining({
          apiKey: "stub-openai-key-for-test",
        }),
      );
      expect(startMcpSpy).toHaveBeenCalledTimes(1);
      expect(runTurnSpy).not.toHaveBeenCalled();
      expect(
        stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain("slash command rejected (multi-line input not allowed)");
    } finally {
      createProviderSpy.mockRestore();
      startMcpSpy.mockRestore();
      runTurnSpy.mockRestore();
      stderrSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry reuses bootstrap-owned session bring-up, shared tools, and teardown", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
            chatStream: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
              model: "grok-4-fast",
              finishReason: "stop",
            }),
          }) as never,
      );
    const startMcpSpy = vi
      .spyOn((await import("../session/session.js")).Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    const waitUntilExit = vi.fn().mockResolvedValue(undefined);
    const unmount = vi.fn();
    let capturedSession: {
      conversationId: string;
      services: { registry: { tools: Array<{ name: string }> } };
      submit?: (message: string) => Promise<void>;
      subscribeToEvents?: (cb: (event: { type: string }) => void) => () => void;
      flushEventLog?: () => Promise<void>;
    } | null = null;
    const bootTUISpy = vi.fn(async (opts: { session: typeof capturedSession }) => {
      capturedSession = opts?.session as typeof capturedSession;
      return { unmount, waitUntilExit };
    });
    vi.doMock("../tui/main.js", () => ({
      bootTUI: bootTUISpy,
    }));

    try {
      const code = await bootTUIEntry({ initialPrompt: "queue this" });
      expect(code).toBe(0);
      expect(createProviderSpy).toHaveBeenCalledTimes(1);
      expect(startMcpSpy).toHaveBeenCalledTimes(1);
      expect(bootTUISpy).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.any(Object),
          configStore: expect.any(Object),
          model: "grok-4-fast",
          initialPrompt: "queue this",
        }),
      );
      expect(capturedSession).not.toBeNull();
      expect(
        capturedSession!.services.registry.tools.some(
          (tool) => tool.name === "spawn_agent",
        ),
      ).toBe(true);
      expect(
        capturedSession!.services.registry.tools.some(
          (tool) => tool.name === "system.agent.delegate",
        ),
      ).toBe(false);
      expect(typeof capturedSession!.submit).toBe("function");
      expect(typeof capturedSession!.subscribeToEvents).toBe("function");
      expect(typeof capturedSession!.flushEventLog).toBe("function");
      expect(waitUntilExit).toHaveBeenCalledTimes(1);
      expect(getCurrentRuntimeSession()).toBeNull();
    } finally {
      createProviderSpy.mockRestore();
      startMcpSpy.mockRestore();
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("resumeTUIEntry keeps the requested session id instead of minting a fresh one", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-resume-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-resume-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";
    const sessionDir = join(getProjectDir(tmpCwd), "sessions", "resume-123");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, buildRolloutFilename(Date.now(), "resume-123")),
      JSON.stringify({
        type: "user_message",
        payload: { message: "resume fixture" },
      }) + "\n",
    );

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    const startMcpSpy = vi
      .spyOn((await import("../session/session.js")).Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let capturedConversationId: string | null = null;
    vi.doMock("../tui/main.js", () => ({
      bootTUI: vi.fn(async (opts: { session: { conversationId: string } }) => {
        capturedConversationId = opts.session.conversationId;
        return {
          unmount: vi.fn(),
          waitUntilExit: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }));

    try {
      const code = await resumeTUIEntry({ resumeId: "resume-123" });
      expect(code).toBe(0);
      expect(createProviderSpy).toHaveBeenCalledTimes(1);
      expect(startMcpSpy).toHaveBeenCalledTimes(1);
      expect(capturedConversationId).toBe("resume-123");
    } finally {
      createProviderSpy.mockRestore();
      startMcpSpy.mockRestore();
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

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    const startMcpSpy = vi
      .spyOn((await import("../session/session.js")).Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);
    const runTurnMod = await import("../session/run-turn.js");
    const runTurnSpy = vi
      .spyOn(runTurnMod, "runTurn")
      .mockImplementation(async function* (): AsyncGenerator<unknown, unknown> {
        yield {
          type: "turn_complete",
          content: "ok",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          stopReason: "completed",
        };
        return { reason: "completed" };
      } as never);

    try {
      const code = await oneShotCLI("/notes.txt");
      expect(code).toBe(0);
      expect(createProviderSpy).toHaveBeenCalledTimes(1);
      expect(startMcpSpy).toHaveBeenCalledTimes(1);
      expect(runTurnSpy).toHaveBeenCalledTimes(1);
      expect(runTurnSpy.mock.calls[0]?.[2]).toBe("/notes.txt");
    } finally {
      createProviderSpy.mockRestore();
      startMcpSpy.mockRestore();
      runTurnSpy.mockRestore();
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry executes slash commands through the TUI submit path without entering runTurn", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-slash-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-slash-cwd-"));
    const prevEnv = { ...process.env };

    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    const startMcpSpy = vi
      .spyOn((await import("../session/session.js")).Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);
    const runTurnSpy = vi.spyOn(await import("../session/run-turn.js"), "runTurn");

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
      const pending = bootTUIEntry({});
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedSession).not.toBeNull();

      const seenEvents: Array<{ type: string; [key: string]: unknown }> = [];
      const unsubscribe =
        capturedSession?.subscribeToEvents?.((event) => {
          seenEvents.push(event);
        }) ?? (() => undefined);
      await capturedSession?.submit?.("/help");
      unsubscribe();

      resolveExit?.();
      const code = await pending;
      expect(code).toBe(0);
      expect(createProviderSpy).toHaveBeenCalledTimes(1);
      expect(startMcpSpy).toHaveBeenCalledTimes(1);
      expect(runTurnSpy).not.toHaveBeenCalled();
      expect(seenEvents).toContainEqual(
        expect.objectContaining({
          type: "slash_result",
          input: "/help",
          result: expect.objectContaining({ kind: "text" }),
        }),
      );
    } finally {
      createProviderSpy.mockRestore();
      startMcpSpy.mockRestore();
      runTurnSpy.mockRestore();
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("bootTUIEntry wires /permissions through the TUI session contract", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-permissions-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-permissions-cwd-"));
    const prevArgv = process.argv;
    const prevEnv = { ...process.env };
    process.argv = ["node", "agenc", "--provider", "xai"];
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.AGENC_HOME = tmpHome;
    process.env.XAI_API_KEY = "test-key";

    const createProviderSpy = vi
      .spyOn(await import("../llm/provider.js"), "createProvider")
      .mockResolvedValue({
        provider: {
          name: "xai",
          sendMessage: vi.fn(),
          sendStreamingMessage: vi.fn(),
        } as never,
        modelInfo: { id: "grok-4-fast", displayName: "grok-4-fast" } as never,
      });
    const startMcpSpy = vi
      .spyOn((await import("../session/session.js")).Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);
    const runTurnSpy = vi.spyOn(await import("../session/run-turn.js"), "runTurn");

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
      const pending = bootTUIEntry({});
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedSession).not.toBeNull();

      const seenEvents: Array<{ type: string; [key: string]: unknown }> = [];
      const unsubscribe =
        capturedSession?.subscribeToEvents?.((event) => {
          seenEvents.push(event);
        }) ?? (() => undefined);
      await capturedSession?.submit?.("/permissions");
      unsubscribe();

      resolveExit?.();
      const code = await pending;
      expect(code).toBe(0);
      expect(createProviderSpy).toHaveBeenCalledTimes(1);
      expect(startMcpSpy).toHaveBeenCalledTimes(1);
      expect(runTurnSpy).not.toHaveBeenCalled();
      expect(seenEvents).toContainEqual(
        expect.objectContaining({
          type: "slash_result",
          input: "/permissions",
          result: expect.objectContaining({
            kind: "text",
            text: expect.stringContaining("Mode: default"),
          }),
        }),
      );
    } finally {
      process.argv = prevArgv;
      createProviderSpy.mockRestore();
      startMcpSpy.mockRestore();
      runTurnSpy.mockRestore();
      vi.doUnmock("../tui/main.js");
      for (const key of Object.keys(process.env)) {
        if (!(key in prevEnv)) delete process.env[key];
      }
      Object.assign(process.env, prevEnv);
      await rm(tmpHome, { recursive: true, force: true });
      await rm(tmpCwd, { recursive: true, force: true });
    }
  });

  it("runs the full main() path with stubbed provider + runTurn and exits 0", async () => {
    // Covers: argv resolution → HOME validation → ConfigStore boot →
    //          model resolve → provider construction → Session +
    //          sidecars → runSingleTurn → turn_complete → shutdown.
    // All externals are stubbed so no disk writes leak outside the
    // per-test AGENC_HOME and no network calls are issued.

    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-main-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-cwd-"));

    // Hijack process.argv + env for this run. Snapshot + restore.
    const prevArgv = process.argv;
    const prevEnv = { ...process.env };
    process.argv = [process.argv[0] ?? "node", "agenc-test-entry", "hi"];
    process.env.AGENC_HOME = tmpHome;
    process.env.AGENC_WORKSPACE = tmpCwd;
    process.env.XAI_API_KEY = "stub-key-for-test";
    process.env.AGENC_CLI_ENTRY_DISABLE = "1";

    // Stub createProvider via module-level mock.
    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );

    // Stub runTurn so the phase machine yields a canned turn_complete
    // and returns `{reason:'completed'}` without ever touching the
    // stubbed provider's chat method.
    const runTurnMod = await import("../session/run-turn.js");
    const runTurnSpy = vi
      .spyOn(runTurnMod, "runTurn")
      .mockImplementation(async function* (): AsyncGenerator<
        unknown,
        unknown
      > {
        yield {
          type: "turn_complete",
          content: "ok",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          stopReason: "completed",
        };
        return { reason: "completed" };
      } as never);

    // Capture unhandled promise rejections so we can fail the test if
    // anything leaked.
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);

    try {
      const code = await main();
      expect(code).toBe(0);
      expect(createProviderSpy).toHaveBeenCalledTimes(1);
      expect(runTurnSpy).toHaveBeenCalledTimes(1);
      // Provider arg should be the resolved provider name ('grok'
      // from default 'grok-4-fast'), not a stray literal.
      expect(createProviderSpy.mock.calls[0]![0]).toBe("grok");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      createProviderSpy.mockRestore();
      runTurnSpy.mockRestore();
      process.argv = prevArgv;
      // Restore env precisely so parallel tests aren't polluted.
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
