/**
 * T9 integration seams for `bin/agenc.ts`:
 *   - slash-command handler (`parseSlashCommand` + `handleSlashCommand`)
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

import {
  handleSlashCommand,
  parseSlashCommand,
  type PendingWorktreeState,
} from "./slash.js";
import { buildDelegateTool } from "./delegate-tool.js";
import {
  PROVIDER_MODEL_CATALOG,
  buildExtractMemoriesViaSubagent,
  maybeReloadConfigBetweenTurns,
  resolveModelOrExit,
  sessionConfigurationFromAgenCConfig,
  type ConfigReloadLatch,
} from "./agenc.js";
import { ConfigStore, defaultConfig } from "../config/index.js";
import {
  assembleSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "../prompts/system-prompt.js";
import {
  clearSystemPromptSections,
  __systemPromptSectionCacheSize,
} from "../prompts/sections.js";
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

function stubSession() {
  return {
    eventLog: {},
    nextInternalSubId: () => "sub-1",
  } as unknown as Parameters<typeof handleSlashCommand>[0]["session"];
}

const HANDLE = {
  path: "/repo/.agenc-worktrees/feat-x",
  branch: "worktree-feat-x",
  gitRoot: "/repo",
  created: true,
};

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("parses /enter-worktree <slug>", () => {
    const cmd = parseSlashCommand("/enter-worktree feat-x");
    expect(cmd).toEqual({ kind: "enter_worktree", slug: "feat-x" });
  });

  it("parses /exit-worktree keep", () => {
    expect(parseSlashCommand("/exit-worktree keep")).toEqual({
      kind: "exit_worktree",
      action: "keep",
      discardChanges: false,
    });
  });

  it("parses /exit-worktree remove --discard", () => {
    expect(parseSlashCommand("/exit-worktree remove --discard")).toEqual({
      kind: "exit_worktree",
      action: "remove",
      discardChanges: true,
    });
  });

  it("rejects unknown slash commands", () => {
    expect(parseSlashCommand("/unknown foo")).toBeNull();
    expect(parseSlashCommand("/enter-worktree")).toBeNull();
    expect(parseSlashCommand("/exit-worktree bogus")).toBeNull();
  });
});

describe("handleSlashCommand — enter-worktree", () => {
  it("invokes enterWorktree + returns entered pending state + new cwd", async () => {
    const enterSpy = vi.fn().mockResolvedValue({
      kind: "entered",
      handle: HANDLE,
      baseCommit: "abc123",
    });
    const exitSpy = vi.fn();
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "enter_worktree", slug: "feat-x" },
      originalCwd: "/repo",
      pendingWorktree: null,
      enterWorktreeFn: enterSpy,
      exitWorktreeFn: exitSpy,
    });
    expect(enterSpy).toHaveBeenCalledWith({
      session: expect.anything(),
      slug: "feat-x",
    });
    expect(result.matched).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(HANDLE.path);
    expect(result.pendingWorktree?.handle).toEqual(HANDLE);
    expect(result.pendingWorktree?.baseCommit).toBe("abc123");
    expect(result.pendingWorktree?.enteredFromCwd).toBe("/repo");
  });

  it("propagates rejection reason + exit code 1", async () => {
    const enterSpy = vi.fn().mockResolvedValue({
      kind: "rejected",
      reason: "not a git repo",
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "enter_worktree", slug: "feat-x" },
      originalCwd: "/repo",
      pendingWorktree: null,
      enterWorktreeFn: enterSpy,
      exitWorktreeFn: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.pendingWorktree).toBeNull();
    expect(result.message).toContain("not a git repo");
  });
});

describe("handleSlashCommand — exit-worktree", () => {
  const active: PendingWorktreeState = {
    handle: HANDLE,
    baseCommit: "abc123",
    enteredFromCwd: "/repo",
  };

  it("keep: returns kept state + stays on worktree cwd", async () => {
    const exitSpy = vi.fn().mockResolvedValue({
      kind: "kept",
      path: HANDLE.path,
      branch: HANDLE.branch,
      changedFiles: false,
      hasCommits: false,
      message: "worktree preserved",
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "exit_worktree", action: "keep", discardChanges: false },
      originalCwd: "/repo",
      pendingWorktree: active,
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: exitSpy,
    });
    expect(exitSpy).toHaveBeenCalledWith({
      session: expect.anything(),
      handle: HANDLE,
      baseCommit: "abc123",
      action: "keep",
    });
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(HANDLE.path);
    expect(result.pendingWorktree).toEqual(active);
  });

  it("remove: returns removed state + restores original cwd", async () => {
    const exitSpy = vi.fn().mockResolvedValue({
      kind: "removed",
      path: HANDLE.path,
      branch: HANDLE.branch,
      discardedFiles: false,
      discardedCommits: false,
      message: "worktree removed",
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: {
        kind: "exit_worktree",
        action: "remove",
        discardChanges: false,
      },
      originalCwd: "/home/u/project",
      pendingWorktree: {
        handle: HANDLE,
        baseCommit: "abc",
        enteredFromCwd: "/home/u/project",
      },
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: exitSpy,
    });
    expect(result.exitCode).toBe(0);
    expect(result.pendingWorktree).toBeNull();
    expect(result.cwd).toBe("/home/u/project");
  });

  it("refused: surfaces the error code", async () => {
    const exitSpy = vi.fn().mockResolvedValue({
      kind: "refused",
      reason: "has uncommitted files",
      errorCode: 2,
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: {
        kind: "exit_worktree",
        action: "remove",
        discardChanges: false,
      },
      originalCwd: "/repo",
      pendingWorktree: active,
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: exitSpy,
    });
    expect(result.exitCode).toBe(2);
    expect(result.pendingWorktree).toEqual(active);
    expect(result.cwd).toBe(HANDLE.path);
  });

  it("no active worktree: rejects with exit code 1", async () => {
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "exit_worktree", action: "keep", discardChanges: false },
      originalCwd: "/repo",
      pendingWorktree: null,
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("no active worktree");
  });
});

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
    expect(roleSchema.enum).toEqual([
      "default",
      "explorer",
      "awaiter",
      "worker",
    ]);
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
  clearSystemPromptSections();
  _clearMemoryWriteLocksForTest();
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
    const fakeSession = {} as never;
    const fn = buildExtractMemoriesViaSubagent({
      session: () => fakeSession,
      memoryDir: "/tmp/memory",
    });
    const out = await fn("transcript", {
      memoryDir: "/tmp/memory",
      memoryMdPath: "/tmp/memory/MEMORY.md",
    });
    expect(Array.isArray(out)).toBe(true);
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

    const cfg = defaultConfig();
    const assembled = await assembleSystemPrompt({
      session: {} as never,
      ctx: {
        config: cfg,
        configSnapshot: cfg,
        cwd: "/tmp",
        modelInfo: { slug: "grok-4-fast" },
      } as never,
      projectInstructions: "## project\n\nFollow repo CLAUDE.md guidance.",
      memoryPrompt: memory.text,
    });
    expect(assembled.text).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(assembled.text).toMatch(/project/);
    expect(assembled.text).toMatch(/MEMORY\.md/);
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
    const picked = selectRelevantMemoriesForTurn(entries, "foobar", session, {
      maxBytesPerFile: 50_000,
      maxBytesPerSession: 60_000,
    });
    expect(picked.length).toBe(1);
  });
});

describe("ConfigStore integration shape", () => {
  it("constructs from empty env + defaults and current() is frozen", async () => {
    const store = new ConfigStore({ env: {} });
    await store.reload();
    const cur = store.current();
    expect(cur.model).toBe("grok-4-fast");
    // AgenCConfig is deep-frozen — direct writes should throw in strict.
    expect(Object.isFrozen(cur)).toBe(true);
  });

  it("applyEnvOverrides promotes AGENC_MODEL over TOML", async () => {
    const store = new ConfigStore({
      env: { AGENC_MODEL: "grok-4" } as NodeJS.ProcessEnv,
    });
    await store.reload();
    expect(store.current().model).toBe("grok-4");
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
