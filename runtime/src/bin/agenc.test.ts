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
  __resetActiveInkUnmountForTest,
  __setActiveInkUnmountForTest,
  bootTUIEntry,
  detectStartupShortCircuit,
  formatCliHelpText,
  initializeCliRuntime,
  installInitSignalHandlers,
  installSignalHandlers,
  main,
  maybeReloadConfigBetweenTurns,
  oneShotCLI,
  prepareTurnRuntimeInputs,
  resolveModelOrExit,
  resumeTUIEntry,
  runSingleTurn,
  sessionConfigurationFromAgenCConfig,
  validateAgencHome,
  type ConfigReloadLatch,
} from "./agenc.js";
import { ConfigStore } from "../config/store.js";
import { defaultConfig } from "../config/schema.js";
import * as configUtils from "../config/init.js";
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
import type { Session } from "../session/session.js";
import { getCurrentRuntimeSession } from "./_deps/current-session.js";
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

  it("untrusted project trust overrides permissive approval config", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: "never" as const },
      workspaceRoot: "/tmp/ws",
      model: "grok-4-fast",
      projectTrust: "untrusted",
    });
    expect(sc.approvalPolicy.value).toBe("untrusted");
  });

  it("trusted project trust preserves explicit approval config", () => {
    const sc = sessionConfigurationFromAgenCConfig({
      config: { ...defaultConfig(), approval_policy: "never" as const },
      workspaceRoot: "/tmp/ws",
      model: "grok-4-fast",
      projectTrust: "trusted",
    });
    expect(sc.approvalPolicy.value).toBe("never");
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

afterEach(async () => {
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
        modelInfo: { slug: "grok-4-fast" },
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

  it("startup --image no longer short-circuits before routing", () => {
    expect(
      detectStartupShortCircuit(["--image", "/tmp/example.png", "describe"]),
    ).toBeNull();
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
      trustWorkspaceForTest(tmpHome, tmpCwd);
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
      trustWorkspaceForTest(tmpHome, tmpCwd);
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

  it("bootTUIEntry forwards startup image flags as initial multimodal messages", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "agenc-tui-image-home-"));
    const tmpCwd = await mkdtemp(join(tmpdir(), "agenc-tui-image-cwd-"));
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
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            }),
            chatStream: async () => ({
              content: "ok",
              toolCalls: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
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
      expect(bootTUISpy).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPrompt: "describe this",
          initialUserMessages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "http://127.0.0.1/cat.png" },
                },
              ],
            },
          ],
        }),
      );
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
      trustWorkspaceForTest(tmpHome, tmpCwd);
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
      trustWorkspaceForTest(tmpHome, tmpCwd);
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
      trustWorkspaceForTest(tmpHome, tmpCwd);
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
    process.env.AGENC_WORKSPACE = tmpCwd;
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
      trustWorkspaceForTest(tmpHome, tmpCwd);
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
    trustWorkspaceForTest(tmpHome, tmpCwd);

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
