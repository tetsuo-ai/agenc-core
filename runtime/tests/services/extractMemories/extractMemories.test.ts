import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../../llm/types.js";
import type { Session } from "../../session/session.js";
import type { TurnContext } from "../../session/turn-context.js";
import type { CompletedToolResultRecord } from "../../session/turn-state.js";
import {
  createAutoMemoryToolPolicy,
  drainPendingExtraction,
  executeExtractMemories,
  initExtractMemories,
  type ExtractMemoriesChildRequest,
} from "./extractMemories.js";
import {
  resolveAutoMemoryDirectory,
  sanitizePathForProjectKey,
  validateAutoMemoryDirectoryPath,
} from "./memory-paths.js";
import { formatMemoryManifest, scanMemoryFiles } from "../../memory/index.js";
import { resolveAgentRuntimeOptions } from "../../session/runtime-options.js";
import { createControlledPromise } from "../../helpers/controlled-async.js";
import { AsyncLock } from "../../utils/async-lock.js";
import type { RolloutItem } from "../../session/rollout-item.js";
import { recordInitialHistoryOnResume } from "../../session/agent-task-lifecycle.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../../tools.js", () => ({}));
vi.mock("src/tools.js", () => ({}));

const defaultRuntimeOptions = resolveAgentRuntimeOptions({});
const defaultSession = {
  services: { runtimeOptions: defaultRuntimeOptions },
} as Session;

function ctx(cwd: string): TurnContext {
  return {
    cwd,
    depth: 0,
    sessionSource: "cli_main",
  } as unknown as TurnContext;
}

function extractionContext(opts: {
  readonly cwd: string;
  readonly messages: readonly LLMMessage[];
  readonly completedToolResults?: readonly CompletedToolResultRecord[];
  readonly session?: Session;
}): Parameters<typeof executeExtractMemories>[0] {
  return {
    messages: opts.messages,
    completedToolResults: opts.completedToolResults ?? [],
    ctx: ctx(opts.cwd),
    session: opts.session ?? defaultSession,
  };
}

function sessionWithBus(
  warnings: Array<{ cause: string; message: string }>,
): Session {
  let subId = 0;
  return {
    conversationId: `bus-${Math.random().toString(36).slice(2)}`,
    services: { runtimeOptions: defaultRuntimeOptions },
    nextInternalSubId: () => String(subId++),
    emit: (event: { msg: { type: string; payload: unknown } }) => {
      if (event.msg.type === "warning") {
        warnings.push(event.msg.payload as { cause: string; message: string });
      }
    },
  } as unknown as Session;
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("auto memory path resolution", () => {
  it("fails closed for unsafe explicit overrides", async () => {
    await expect(
      resolveAutoMemoryDirectory({
        env: { AGENC_COWORK_MEMORY_PATH_OVERRIDE: "/" },
        cwd: "/work/project",
        settings: {},
      }),
    ).resolves.toEqual({
      enabled: false,
      reason: "invalid_memory_path_override",
    });
  });

  it("disables remote sessions without a memory mount", async () => {
    await expect(
      resolveAutoMemoryDirectory({
        runtimeOptions: { remoteMode: true },
        cwd: "/work/project",
      }),
    ).resolves.toEqual({
      enabled: false,
      reason: "remote_without_memory_dir",
    });
  });

  it("rejects tilde settings that expand to the home directory itself", () => {
    expect(
      validateAutoMemoryDirectoryPath("~/.", {
        expandTilde: true,
        homeDir: "/home/tester",
      }),
    ).toBeUndefined();
  });

  it("uses shared project-key sanitization for automatic memory directories", async () => {
    const configHome = join(tmpdir(), "agenc-config-test");
    const longPath = `/${"deep/".repeat(50)}project`;
    const longKey = sanitizePathForProjectKey(longPath);

    expect(sanitizePathForProjectKey("/tmp/foo")).toBe("-tmp-foo");
    expect(
      longKey.startsWith(
        longPath.replace(/[^a-zA-Z0-9]/gu, "-").slice(0, 200),
      ),
    ).toBe(true);
    expect(longKey).toMatch(/-[a-z0-9]+$/u);
    await expect(
      resolveAutoMemoryDirectory({
        env: {},
        cwd: "/tmp/foo",
        configHomeDir: configHome,
        settings: {},
      }),
    ).resolves.toEqual({
      enabled: true,
      path: `${join(configHome, "projects", "-tmp-foo", "memory")}${sep}`,
    });
  });

  it("canonicalizes linked worktrees before building automatic project keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-memory-worktree-"));
    try {
      const mainRepo = join(root, "main");
      const linkedWorktree = join(root, "linked");
      const worktreeGitDir = join(mainRepo, ".git", "worktrees", "linked");
      await mkdir(worktreeGitDir, { recursive: true });
      await mkdir(linkedWorktree, { recursive: true });
      await writeFile(
        join(linkedWorktree, ".git"),
        `gitdir: ${worktreeGitDir}\n`,
      );
      await writeFile(join(worktreeGitDir, "commondir"), "../..\n");
      await writeFile(
        join(worktreeGitDir, "gitdir"),
        `${join(linkedWorktree, ".git")}\n`,
      );

      const configHome = join(root, "config");
      await expect(
        resolveAutoMemoryDirectory({
          env: {},
          cwd: linkedWorktree,
          configHomeDir: configHome,
          settings: {},
        }),
      ).resolves.toEqual({
        enabled: true,
        path: `${join(
          configHome,
          "projects",
          sanitizePathForProjectKey(mainRepo),
          "memory",
        )}${sep}`,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("auto memory child tool policy", () => {
  it("rewrites relative read paths into the memory directory and injects the root", async () => {
    const policy = createAutoMemoryToolPolicy("/tmp/memory/");
    expect(
      policy({ name: "FileRead" }, { file_path: "notes/user.md" }),
    ).toMatchObject({
      behavior: "allow",
      updatedInput: {
        file_path: "/tmp/memory/notes/user.md",
        __agencSessionAllowedRoots: ["/tmp/memory/"],
      },
    });
  });

  // Live (session 2763eb6e, 2026-09-02): the child opened the shared root the
  // main agent uses, was denied, and the run was recorded as a failed
  // extraction with its messages re-queued.
  describe("the shared memory root", () => {
    const policy = () =>
      createAutoMemoryToolPolicy("/tmp/project-memory/", ["/tmp/global-memory/"]);

    it("is readable, so the child can check what is already recorded", () => {
      expect(
        policy()({ name: "FileRead" }, { file_path: "/tmp/global-memory/MEMORY.md" }),
      ).toMatchObject({
        behavior: "allow",
        updatedInput: {
          file_path: "/tmp/global-memory/MEMORY.md",
          __agencSessionAllowedRoots: ["/tmp/project-memory/", "/tmp/global-memory/"],
        },
      });
      expect(
        policy()({ name: "Grep" }, { pattern: "style", path: "/tmp/global-memory/" }),
      ).toMatchObject({ behavior: "allow" });
      expect(
        policy()({ name: "Glob" }, { pattern: "*.md", path: "/tmp/global-memory/" }),
      ).toMatchObject({ behavior: "allow" });
    });

    it("is not writable, and says so", () => {
      // The child summarizes untrusted conversation content, and this root is
      // shared by every project on the machine.
      const denial = policy()(
        { name: "Write" },
        { file_path: "/tmp/global-memory/user.md", content: "x" },
      );
      expect(denial).toMatchObject({
        behavior: "deny",
        metadata: { reason: "write_outside_memory" },
      });
      expect((denial as { message: string }).message).toContain(
        "may only write to this session's project memory directory",
      );
    });

    it("still writes to the project root and still denies everything else", () => {
      expect(
        policy()({ name: "Write" }, { file_path: "notes.md", content: "hello" }),
      ).toMatchObject({
        behavior: "allow",
        updatedInput: {
          file_path: "/tmp/project-memory/notes.md",
          __agencSessionAllowedRoots: ["/tmp/project-memory/"],
        },
      });
      expect(
        policy()({ name: "FileRead" }, { file_path: "/tmp/elsewhere/secrets.md" }),
      ).toMatchObject({ behavior: "deny" });
    });

    it("without a shared root the policy is unchanged", () => {
      expect(
        createAutoMemoryToolPolicy("/tmp/project-memory/")(
          { name: "FileRead" },
          { file_path: "/tmp/global-memory/MEMORY.md" },
        ),
      ).toMatchObject({ behavior: "deny" });
    });
  });

  it("denies reads outside the memory directory", async () => {
    const policy = createAutoMemoryToolPolicy("/tmp/memory/");
    expect(
      policy({ name: "FileRead" }, { file_path: "/tmp/other.md" }),
    ).toMatchObject({
      behavior: "deny",
      metadata: { reason: "file_read_outside_memory" },
    });
  });

  it("defaults Grep and Glob roots to the memory directory", async () => {
    const policy = createAutoMemoryToolPolicy("/tmp/memory/");
    expect(
      policy({ name: "Grep" }, { pattern: "remember" }),
    ).toMatchObject({
      behavior: "allow",
      updatedInput: { path: "/tmp/memory/" },
    });
    expect(
      policy({ name: "Glob" }, { pattern: "**/*.md" }),
    ).toMatchObject({
      behavior: "allow",
      updatedInput: { path: "/tmp/memory/" },
    });
  });

  it("denies Glob patterns that escape the memory directory", async () => {
    const policy = createAutoMemoryToolPolicy("/tmp/memory/");
    expect(
      policy({ name: "Glob" }, { pattern: "../outside/**/*.md" }),
    ).toMatchObject({
      behavior: "deny",
      metadata: { reason: "glob_outside_memory" },
    });
    expect(
      policy({ name: "Glob" }, { pattern: "/tmp/other/**/*.md" }),
    ).toMatchObject({
      behavior: "deny",
      metadata: { reason: "glob_outside_memory" },
    });
    expect(
      policy(
        { name: "Glob" },
        { path: "notes", pattern: "../../outside/**/*.md" },
      ),
    ).toMatchObject({
      behavior: "deny",
      metadata: { reason: "glob_outside_memory" },
    });
  });

  it("denies memory writes that carry secrets and allows clean ones", async () => {
    const memoryDir = "/memory/";
    const policy = createAutoMemoryToolPolicy(memoryDir);
    const token = `ghp_${"A".repeat(36)}`;

    expect(
      policy({ name: "Write" }, { file_path: "notes.md", content: `token=${token}` }),
    ).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("GitHub PAT"),
      metadata: { reason: "secret_in_memory_write" },
    });
    expect(
      policy(
        { name: "Edit" },
        { file_path: "notes.md", old_string: "x", new_string: `key ${token}` },
      ),
    ).toMatchObject({ behavior: "deny", metadata: { reason: "secret_in_memory_write" } });
    expect(
      policy(
        { name: "MultiEdit" },
        {
          file_path: "notes.md",
          edits: [
            { old_string: "a", new_string: "safe" },
            { old_string: "b", new_string: `leak ${token}` },
          ],
        },
      ),
    ).toMatchObject({ behavior: "deny", metadata: { reason: "secret_in_memory_write" } });
    expect(
      policy(
        { name: "Write" },
        { file_path: "notes.md", content: "user prefers terse replies" },
      ),
    ).toMatchObject({ behavior: "allow" });
  });

  it("allows Glob patterns rooted inside memory subdirectories", async () => {
    const policy = createAutoMemoryToolPolicy("/tmp/memory/");
    expect(
      policy({ name: "Glob" }, { pattern: "notes/**/*.md" }),
    ).toMatchObject({
      behavior: "allow",
      updatedInput: { path: "/tmp/memory/" },
    });
    expect(
      policy({ name: "Glob" }, { path: "notes", pattern: "**/*.md" }),
    ).toMatchObject({
      behavior: "allow",
      updatedInput: { path: "/tmp/memory/notes" },
    });
  });
});

describe("extract memories service", () => {
  let root: string;
  let memoryDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-extract-memory-"));
    memoryDir = join(root, "memory");
    await mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("bypasses the child and advances when the main agent already wrote memory successfully", async () => {
    const runChild = vi.fn(
      async (_request: ExtractMemoriesChildRequest) =>
        ({ outcome: "completed" as const }),
    );
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const directWriteMessages: LLMMessage[] = [
      { role: "user", content: "remember this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "write-1",
            name: "Write",
            arguments: JSON.stringify({
              file_path: join(memoryDir, "user.md"),
            }),
          },
        ],
      },
    ];
    await executeExtractMemories(
      extractionContext({
        cwd: root,
        messages: directWriteMessages,
        completedToolResults: [
          {
            callId: "write-1",
            toolName: "Write",
            arguments: directWriteMessages[1]!.toolCalls![0]!.arguments,
            content: "ok",
            isError: false,
          },
        ],
      }),
    );
    expect(runChild).not.toHaveBeenCalled();

    await executeExtractMemories(
      extractionContext({
        cwd: root,
        messages: [
          ...directWriteMessages,
          { role: "user", content: "new durable preference" },
        ],
      }),
    );
    expect(runChild).toHaveBeenCalledOnce();
    expect(runChild.mock.calls[0]![0].prompt).toContain("~1 model-visible");
  });

  it("does not extract memories for legacy string-form subagent sessions", async () => {
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember this from a delegated task" },
      { role: "assistant", content: "ok" },
    ];
    await executeExtractMemories({
      ...extractionContext({ cwd: root, messages }),
      ctx: {
        ...ctx(root),
        sessionSource: "cli_subagent",
      } as TurnContext,
    });

    expect(runChild).not.toHaveBeenCalled();
  });

  it("keeps the child path for a failed direct write", async () => {
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "write-1",
            name: "Write",
            arguments: JSON.stringify({
              file_path: join(memoryDir, "user.md"),
            }),
          },
        ],
      },
    ];
    await executeExtractMemories(
      extractionContext({
        cwd: root,
        messages,
        completedToolResults: [
          {
            callId: "write-1",
            toolName: "Write",
            arguments: messages[1]!.toolCalls![0]!.arguments,
            content: "failed",
            isError: true,
          },
        ],
      }),
    );

    expect(runChild).toHaveBeenCalledOnce();
  });

  it("keeps the child path for a relative main-agent memory write", async () => {
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "write-1",
            name: "Write",
            arguments: JSON.stringify({ file_path: "user.md" }),
          },
        ],
      },
    ];
    await executeExtractMemories(
      extractionContext({
        cwd: root,
        messages,
        completedToolResults: [
          {
            callId: "write-1",
            toolName: "Write",
            arguments: messages[1]!.toolCalls![0]!.arguments,
            content: "ok",
            isError: false,
          },
        ],
      }),
    );

    expect(runChild).toHaveBeenCalledOnce();
  });

  it("does not advance the cursor when child policy denied a memory write", async () => {
    const runChild = vi
      .fn(
        async (_request: ExtractMemoriesChildRequest) =>
          ({ outcome: "completed" as const }),
      )
      .mockImplementationOnce(async (request) => {
        request.onProgress({
          kind: "tool_result",
          callId: "write-1",
          toolName: "Write",
          result: "{}",
          isError: true,
          metadata: { childPolicyDenied: true },
        });
        return { outcome: "completed" };
      })
      .mockResolvedValue({ outcome: "completed" });
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember this" },
      { role: "assistant", content: "ok" },
    ];
    await executeExtractMemories(extractionContext({ cwd: root, messages }));
    await executeExtractMemories(extractionContext({ cwd: root, messages }));

    expect(runChild).toHaveBeenCalledTimes(2);
    expect(runChild.mock.calls[1]![0].prompt).toContain("~2 model-visible");
  });

  it("completes and advances the cursor when only reads outside the memory directory were denied", async () => {
    // Live shape: the child probed two sibling memory directories the prompt
    // never named (both denied), then read the right one and finished with
    // "No new memory". That was recorded as a failed extraction and the
    // messages were re-queued for the next run.
    const emitted: unknown[] = [];
    const runChild = vi
      .fn(
        async (_request: ExtractMemoriesChildRequest) =>
          ({ outcome: "completed" as const }),
      )
      .mockImplementationOnce(async (request) => {
        for (const callId of ["read-1", "read-2"]) {
          request.onProgress({
            kind: "tool_result",
            callId,
            toolName: "FileRead",
            result: "{}",
            isError: true,
            metadata: { childPolicyDenied: true },
          });
        }
        return { outcome: "completed" };
      })
      .mockResolvedValue({ outcome: "completed" });
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember this" },
      { role: "assistant", content: "ok" },
    ];
    const context = extractionContext({ cwd: root, messages });
    (context.session as unknown as { emit: (event: unknown) => void }).emit = (
      event,
    ) => {
      emitted.push(event);
    };
    (context.session as unknown as { nextInternalSubId: () => string }).nextInternalSubId =
      () => "sub-test-1";
    await executeExtractMemories(context);
    await executeExtractMemories(extractionContext({ cwd: root, messages }));

    // The second run has nothing new to process: the cursor advanced.
    expect(runChild).toHaveBeenCalledOnce();
    expect(runChild.mock.calls[0]![0].prompt).toContain(memoryDir);
    const warnings = emitted
      .map((event) => (event as { msg?: { payload?: { cause?: string; message?: string } } }).msg?.payload)
      .filter((payload) => payload !== undefined);
    expect(warnings.some((payload) => payload?.cause === "memory_extraction_denied_read")).toBe(true);
    expect(warnings.some((payload) => payload?.cause === "memory_extraction_failed")).toBe(false);
  });

  it("does not advance the cursor when a tracked child write fails", async () => {
    const runChild = vi
      .fn()
      .mockImplementationOnce(async (request: ExtractMemoriesChildRequest) => {
        request.onProgress({
          kind: "tool_call",
          callId: "write-1",
          toolName: "Write",
          arguments: JSON.stringify({ file_path: "feedback.md" }),
        });
        request.onProgress({
          kind: "tool_result",
          callId: "write-1",
          toolName: "Write",
          result: "failed",
          isError: true,
        });
        return { outcome: "completed" as const };
      })
      .mockResolvedValue({ outcome: "completed" as const });
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember this" },
      { role: "assistant", content: "ok" },
    ];
    await executeExtractMemories(extractionContext({ cwd: root, messages }));
    await executeExtractMemories(extractionContext({ cwd: root, messages }));

    expect(runChild).toHaveBeenCalledTimes(2);
    expect(runChild.mock.calls[1]![0].prompt).toContain("~2 model-visible");
  });

  it("coalesces concurrent extraction requests and keeps the newest trailing context", async () => {
    let resolveFirst!: () => void;
    const runChild = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Promise<{ readonly outcome: "completed" }>((resolve) => {
            resolveFirst = () => resolve({ outcome: "completed" });
          }),
      )
      .mockResolvedValue({ outcome: "completed" as const });
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const firstMessages: LLMMessage[] = [
      { role: "user", content: "remember first context" },
      { role: "assistant", content: "ok" },
    ];
    const trailingMessages: LLMMessage[] = [
      ...firstMessages,
      { role: "user", content: "remember trailing context" },
    ];
    const first = executeExtractMemories(
      extractionContext({ cwd: root, messages: firstMessages }),
    );
    await eventually(() => expect(runChild).toHaveBeenCalledOnce());
    const second = executeExtractMemories(
      extractionContext({ cwd: root, messages: trailingMessages }),
    );
    await second;
    expect(runChild).toHaveBeenCalledOnce();

    resolveFirst();
    await first;

    expect(runChild).toHaveBeenCalledTimes(2);
    expect(runChild.mock.calls[1]![0].prompt).toContain("~1 model-visible");
  });

  it("emits saved paths and advances after successful child writes", async () => {
    const saved: string[][] = [];
    const runChild = vi.fn(async (request: ExtractMemoriesChildRequest) => {
      for (const [callId, toolName, filePath] of [
        ["write-1", "Write", "feedback.md"],
        ["write-2", "Write", "MEMORY.md"],
        ["edit-1", "Edit", "profile.md"],
        ["multi-1", "MultiEdit", "preferences.md"],
      ] as const) {
        request.onProgress({
          kind: "tool_call",
          callId,
          toolName,
          arguments: JSON.stringify({ file_path: filePath }),
        });
        request.onProgress({
          kind: "tool_result",
          callId,
          toolName,
          result: "ok",
          isError: false,
        });
      }
      return { outcome: "completed" as const };
    });
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "prefer concise replies" },
      { role: "assistant", content: "ok" },
    ];
    await executeExtractMemories(
      extractionContext({ cwd: root, messages }),
      (paths) => saved.push([...paths]),
    );
    await executeExtractMemories(extractionContext({ cwd: root, messages }));

    expect(runChild).toHaveBeenCalledOnce();
    expect(saved).toEqual([[
      join(memoryDir, "feedback.md"),
      join(memoryDir, "profile.md"),
      join(memoryDir, "preferences.md"),
    ]]);
  });

  it("launches the real child path as a full-history fork with the triggering signal", async () => {
    const abort = new AbortController();
    const delegateFn = vi.fn(async () => ({
      kind: "sync_completed" as const,
      result: {
        threadId: "child-thread",
        durationMs: 0,
        outcome: "completed" as const,
      },
      thread: {},
    }));
    const ensureAgentControl = vi.fn(() => ({
      control: {},
      registry: {},
    }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      delegateFn: delegateFn as never,
      ensureAgentControl: ensureAgentControl as never,
      maxTurns: 3,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember my release cadence" },
      { role: "assistant", content: "noted" },
    ];
    await executeExtractMemories({
      ...extractionContext({ cwd: root, messages }),
      signal: abort.signal,
    });

    expect(ensureAgentControl).toHaveBeenCalledWith(expect.any(Object));
    expect(delegateFn).toHaveBeenCalledOnce();
    const delegateCall = delegateFn.mock.calls[0]![0] as {
      readonly childToolPolicy: (
        tool: { readonly name: string },
        input: Record<string, unknown>,
      ) => unknown;
      readonly toolAllowlist?: unknown;
    };
    expect(delegateCall).toMatchObject({
      taskPrompt: expect.stringContaining("~2 model-visible"),
      forkMode: { kind: "full_history" },
      parentMessagesOverride: messages,
      externalSignal: abort.signal,
      maxTurns: 3,
      forceSynchronous: true,
      runInBackground: false,
      silent: true,
    });
    // The catalog is filtered to the file tools before the path policy runs.
    expect(delegateCall.toolAllowlist).toEqual([
      "FileRead",
      "Grep",
      "Glob",
      "Edit",
      "MultiEdit",
      "Write",
    ]);
    expect(
      delegateCall.childToolPolicy({ name: "system.bash" }, {}),
    ).toMatchObject({
      behavior: "deny",
      metadata: { reason: "tool_not_allowed" },
    });
  });

  it("runs the child on every third eligible turn by default and reports each deferral", async () => {
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    const warnings: Array<{ cause: string; message: string }> = [];
    const session = sessionWithBus(warnings);
    initExtractMemories({
      env: {},
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember the cadence" },
      { role: "assistant", content: "ok" },
    ];
    for (let turn = 0; turn < 3; turn += 1) {
      await executeExtractMemories(
        extractionContext({ cwd: root, messages, session }),
      );
    }

    expect(runChild).toHaveBeenCalledOnce();
    expect(warnings.map((warning) => warning.cause)).toEqual([
      "memory_extraction_skipped",
      "memory_extraction_skipped",
    ]);
    expect(warnings[0]?.message).toContain("deferred by eligible-turn cadence (1/3");
    expect(warnings[1]?.message).toContain("deferred by eligible-turn cadence (2/3");
  });

  it("reports why extraction was skipped or failed instead of swallowing it", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const session = sessionWithBus(warnings);
    const messages: LLMMessage[] = [
      { role: "user", content: "remember this" },
      { role: "assistant", content: "ok" },
    ];

    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({
        enabled: false,
        reason: "disabled_by_settings",
      }),
      runChild: vi.fn(async () => ({ outcome: "completed" as const })),
    });
    await executeExtractMemories(extractionContext({ cwd: root, messages, session }));
    expect(warnings.at(-1)).toEqual({
      cause: "memory_extraction_skipped",
      message: "memory directory unavailable (disabled_by_settings)",
    });

    initExtractMemories({
      env: { AGENC_DISABLE_EXTRACT_MEMORIES: "1" },
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild: vi.fn(async () => ({ outcome: "completed" as const })),
    });
    await executeExtractMemories(extractionContext({ cwd: root, messages, session }));
    expect(warnings.at(-1)).toEqual({
      cause: "memory_extraction_skipped",
      message: "AGENC_DISABLE_EXTRACT_MEMORIES is set",
    });

    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild: vi.fn(async () => ({
        outcome: "rejected" as const,
        error: "no capacity",
      })),
    });
    await executeExtractMemories(extractionContext({ cwd: root, messages, session }));
    expect(warnings.at(-1)).toEqual({
      cause: "memory_extraction_failed",
      message: "child outcome rejected: no capacity; 2 message(s) stay queued for the next run",
    });

    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild: vi.fn(async () => {
        throw new Error("delegate exploded");
      }),
    });
    await executeExtractMemories(extractionContext({ cwd: root, messages, session }));
    expect(warnings.at(-1)).toEqual({
      cause: "memory_extraction_failed",
      message: "delegate exploded",
    });
  });

  it("drains active extraction work before the caller finishes shutdown", async () => {
    const childStarted = createControlledPromise<void>(
      "extractMemories child started",
    );
    const releaseChild = createControlledPromise<void>(
      "extractMemories child release",
    );
    const runChild = vi.fn(async () => {
      childStarted.resolve(undefined);
      await releaseChild.promise;
      return { outcome: "completed" as const };
    });
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember drain behavior" },
      { role: "assistant", content: "ok" },
    ];
    const extraction = executeExtractMemories(
      extractionContext({ cwd: root, messages }),
    );

    try {
      await Promise.race([
        childStarted.promise,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                "timed out waiting for memory extraction child to start",
              ),
            );
          }, 10_000);
          timer.unref?.();
        }),
      ]);
      expect(runChild).toHaveBeenCalledOnce();

      let drained = false;
      const drain = drainPendingExtraction(1000).then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      releaseChild.assertPending();

      releaseChild.resolve(undefined);
      await extraction;
      await drain;
      expect(drained).toBe(true);
    } finally {
      if (releaseChild.state().status === "pending") {
        releaseChild.resolve(undefined);
      }
    }
  });

  it("scopes extraction cursors by session and memory directory", async () => {
    const sessionA = {
      conversationId: "session-a",
      services: { runtimeOptions: defaultRuntimeOptions },
    } as Session;
    const sessionB = {
      conversationId: "session-b",
      services: { runtimeOptions: defaultRuntimeOptions },
    } as Session;
    const memoryDirB = join(root, "memory-b");
    await mkdir(memoryDirB, { recursive: true });
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async ({ cwd }) => ({
        enabled: true,
        path: cwd.endsWith("project-b") ? memoryDirB : memoryDir,
      }),
      runChild,
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "remember scoped cursor behavior" },
      { role: "assistant", content: "ok" },
    ];
    await executeExtractMemories(
      extractionContext({
        cwd: join(root, "project-a"),
        messages,
        session: sessionA,
      }),
    );
    await executeExtractMemories(
      extractionContext({
        cwd: join(root, "project-a"),
        messages,
        session: sessionB,
      }),
    );
    await executeExtractMemories(
      extractionContext({
        cwd: join(root, "project-b"),
        messages,
        session: sessionA,
      }),
    );

    expect(runChild).toHaveBeenCalledTimes(3);
    expect(runChild.mock.calls.map((call) => call[0].prompt)).toEqual([
      expect.stringContaining("~2 model-visible"),
      expect.stringContaining("~2 model-visible"),
      expect.stringContaining("~2 model-visible"),
    ]);
  });
});

describe("memory manifest scan", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("formats frontmatter and ignores symlink escapes", async () => {
    const memoryDir = join(root, "memory");
    const outside = join(root, "outside");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(memoryDir, "feedback.md"),
      [
        "---",
        'description: "Use terse responses"',
        "type: feedback",
        "---",
        "",
        "The user prefers terse responses.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(memoryDir, "MEMORY.md"), "- index\n", "utf8");
    await writeFile(join(outside, "secret.md"), "---\ntype: user\n---\n", "utf8");
    await symlink(outside, join(memoryDir, "linked-outside"));

    const manifest = formatMemoryManifest(await scanMemoryFiles(memoryDir));

    expect(manifest).toContain("[feedback] feedback.md");
    expect(manifest).toContain("Use terse responses");
    expect(manifest).not.toContain("MEMORY.md");
    expect(manifest).not.toContain("secret.md");
  });
});

describe("extraction cadence across a daemon restart", () => {
  let root: string;
  let memoryDir: string;
  const cadenceMessages: LLMMessage[] = [
    { role: "user", content: "remember the cadence" },
    { role: "assistant", content: "ok" },
  ];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-extract-memory-restart-"));
    memoryDir = join(root, "memory");
    await mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  type Warning = { cause: string; message: string };

  /** A session whose state lock and rollout recorder outlive the process. */
  function durableSession(opts: {
    readonly conversationId: string;
    readonly rollout: RolloutItem[];
    readonly warnings?: Warning[];
    readonly record?: (item: RolloutItem) => Promise<void>;
  }): Session {
    let subId = 0;
    return {
      conversationId: opts.conversationId,
      services: {
        runtimeOptions: defaultRuntimeOptions,
        rollout: {
          record: async (item: unknown) => {
            if (opts.record) await opts.record(item as RolloutItem);
            opts.rollout.push(item as RolloutItem);
          },
        },
      },
      state: new AsyncLock<Record<string, unknown>>({}),
      nextInternalSubId: () => String(subId++),
      emit: (event: { msg: { type: string; payload: unknown } }) => {
        if (event.msg.type === "warning") {
          opts.warnings?.push(event.msg.payload as Warning);
        }
      },
    } as unknown as Session;
  }

  /**
   * The daemon restarts: the session object is rebuilt and resumed from the
   * rollout the previous process wrote (the JSONL round trip drops undefined
   * keys), and the caller starts a fresh extraction service.
   */
  async function resumedSession(opts: {
    readonly conversationId: string;
    readonly rollout: RolloutItem[];
    readonly warnings?: Warning[];
  }): Promise<Session> {
    const session = durableSession(opts);
    const replayed = opts.rollout.map(
      (item) => JSON.parse(JSON.stringify(item)) as RolloutItem,
    );
    await recordInitialHistoryOnResume(session, replayed, {
      currentModel: "test-model",
    });
    return session;
  }

  function startExtractionService(
    runChild: NonNullable<Parameters<typeof initExtractMemories>[0]["runChild"]>,
    minEligibleTurns?: number,
  ): void {
    initExtractMemories({
      env: {},
      ...(minEligibleTurns !== undefined ? { minEligibleTurns } : {}),
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
    });
  }

  function persistedCadences(rollout: readonly RolloutItem[]) {
    return rollout.map((item) =>
      item.type === "session_state" ? item.payload.memoryExtraction : item.type,
    );
  }

  it("a restart between the second and third eligible turns still extracts on the third", async () => {
    const rollout: RolloutItem[] = [];
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    const firstWarnings: Warning[] = [];
    const first = durableSession({
      conversationId: "conv-restart",
      rollout,
      warnings: firstWarnings,
    });
    startExtractionService(runChild);
    for (let turn = 0; turn < 2; turn += 1) {
      await executeExtractMemories(
        extractionContext({ cwd: root, messages: cadenceMessages, session: first }),
      );
    }
    expect(runChild).not.toHaveBeenCalled();
    expect(firstWarnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining("deferred by eligible-turn cadence (1/3"),
      expect.stringContaining("deferred by eligible-turn cadence (2/3"),
    ]);
    expect(persistedCadences(rollout)).toEqual([
      { memoryRoot: memoryDir, processedVisibleCount: 0, turnsSinceLastExtraction: 1 },
      { memoryRoot: memoryDir, processedVisibleCount: 0, turnsSinceLastExtraction: 2 },
    ]);

    const secondWarnings: Warning[] = [];
    const second = await resumedSession({
      conversationId: "conv-restart",
      rollout,
      warnings: secondWarnings,
    });
    startExtractionService(runChild);
    await executeExtractMemories(
      extractionContext({ cwd: root, messages: cadenceMessages, session: second }),
    );

    expect(runChild).toHaveBeenCalledOnce();
    expect(secondWarnings).toEqual([]);
    expect(persistedCadences(rollout).at(-1)).toEqual({
      memoryRoot: memoryDir,
      processedVisibleCount: 2,
      turnsSinceLastExtraction: 0,
    });
  });

  it("does not offer the child history the previous process already extracted", async () => {
    const rollout: RolloutItem[] = [];
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    const first = durableSession({ conversationId: "conv-cursor", rollout });
    startExtractionService(runChild, 1);
    await executeExtractMemories(
      extractionContext({ cwd: root, messages: cadenceMessages, session: first }),
    );
    expect(runChild).toHaveBeenCalledOnce();
    expect(runChild.mock.calls[0]![0].prompt).toContain("~2 model-visible");

    const second = await resumedSession({ conversationId: "conv-cursor", rollout });
    startExtractionService(runChild, 1);
    await executeExtractMemories(
      extractionContext({
        cwd: root,
        messages: [
          ...cadenceMessages,
          { role: "user", content: "one more durable fact" },
        ],
        session: second,
      }),
    );

    expect(runChild).toHaveBeenCalledTimes(2);
    expect(runChild.mock.calls[1]![0].prompt).toContain("~1 model-visible");
  });

  it("waits the full cadence for a session with nothing persisted, as before", async () => {
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    const warnings: Warning[] = [];
    const session = await resumedSession({
      conversationId: "conv-fresh",
      rollout: [],
      warnings,
    });
    startExtractionService(runChild);
    await executeExtractMemories(
      extractionContext({ cwd: root, messages: cadenceMessages, session }),
    );

    expect(runChild).not.toHaveBeenCalled();
    expect(warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining("deferred by eligible-turn cadence (1/3"),
    ]);
  });

  it("writes the cadence only when a decision changed it", async () => {
    const rollout: RolloutItem[] = [];
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    const session = durableSession({ conversationId: "conv-quiet", rollout });
    startExtractionService(runChild, 1);
    await executeExtractMemories(
      extractionContext({ cwd: root, messages: cadenceMessages, session }),
    );
    expect(runChild).toHaveBeenCalledOnce();
    expect(rollout).toHaveLength(1);

    // The same history again: no new model-visible messages, nothing to write.
    await executeExtractMemories(
      extractionContext({ cwd: root, messages: cadenceMessages, session }),
    );
    expect(runChild).toHaveBeenCalledOnce();
    expect(rollout).toHaveLength(1);
  });

  it("reports a cadence write failure without failing the extraction", async () => {
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    const warnings: Warning[] = [];
    const session = durableSession({
      conversationId: "conv-broken-rollout",
      rollout: [],
      warnings,
      record: async () => {
        throw new Error("disk full");
      },
    });
    startExtractionService(runChild, 1);
    await executeExtractMemories(
      extractionContext({ cwd: root, messages: cadenceMessages, session }),
    );

    expect(runChild).toHaveBeenCalledOnce();
    expect(warnings).toEqual([
      {
        cause: "memory_extraction_state_not_persisted",
        message: expect.stringContaining("disk full"),
      },
    ]);
  });
});

describe("skill candidates ride the extraction child", () => {
  let root: string;
  let memoryDir: string;
  let agencHome: string;

  const candidate = {
    name: "run-hermetic-vitest",
    description: "Run one runtime test file through the hermetic vitest runner.",
    whenToUse: "When a runtime change needs its tests run in isolation.",
    body: "# Purpose\n\nRun tests in isolation.\n\n## Steps\n\n1. node scripts/run-hermetic-vitest.mjs run <file>\n\n## Verification\n\nSummary line passes.\n\n## Pitfalls\n\nNever use the real AGENC_HOME.\n",
    evidence: ["Three runner invocations, each checked against the summary line."],
  };
  const replyWithCandidate = (entry: Record<string, unknown> = candidate) =>
    `Memory updated.\n\n\`\`\`skill-candidates\n${JSON.stringify({ skillCandidates: [entry] })}\n\`\`\`\n`;
  const messages: LLMMessage[] = [
    { role: "user", content: "run the runtime tests for this change" },
    { role: "assistant", content: "done, all green" },
  ];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-extract-skillcand-"));
    memoryDir = join(root, "memory");
    agencHome = join(root, "agenc-home");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(agencHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("asks the child for candidates and writes the one it returns as an inactive draft", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const session = sessionWithBus(warnings);
    const runChild = vi.fn(async (_request: ExtractMemoriesChildRequest) => ({
      outcome: "completed" as const,
      finalMessage: replyWithCandidate(),
    }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
      skillCandidatesHome: agencHome,
      listInstalledSkillNames: async () => ["verify", "already-there"],
    });

    await executeExtractMemories(extractionContext({ cwd: root, messages, session }));

    expect(runChild).toHaveBeenCalledOnce();
    const prompt = runChild.mock.calls[0]![0].prompt;
    expect(prompt).toContain("## Skill candidates (drafts for the user to review)");
    expect(prompt).toContain("at least 3 tool calls");
    expect(prompt).toContain("Installed skills: already-there, verify.");
    expect(prompt).toContain("```skill-candidates");

    const draftDir = join(agencHome, "skill-candidates", "run-hermetic-vitest");
    const skill = await readFile(join(draftDir, "SKILL.md"), "utf8");
    expect(skill).toContain('name: "run-hermetic-vitest"');
    expect(skill).toContain("## Verification");
    const record = JSON.parse(await readFile(join(draftDir, "candidate.json"), "utf8")) as {
      provenance: { sessionId?: string; createdAt: string };
      evidence: string[];
    };
    expect(record.provenance.sessionId).toBe(
      (session as unknown as { conversationId: string }).conversationId,
    );
    expect(record.provenance.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(record.evidence).toHaveLength(1);
    const ledger = (await readFile(join(agencHome, "skill-candidates", "ledger.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(ledger).toHaveLength(1);
    expect(JSON.parse(ledger[0]!)).toMatchObject({
      slug: "run-hermetic-vitest",
      action: "proposed",
    });
    // A draft is not a skill: nothing lands where the loader looks.
    await expect(stat(join(agencHome, "skills"))).rejects.toThrow();
    expect(warnings.at(-1)).toEqual({
      cause: "skill_candidate_proposed",
      message:
        "draft skill written for review: run-hermetic-vitest (agenc skills candidates list)",
    });
  });

  it("skips a candidate that duplicates an installed skill or trips validation, and says why", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const session = sessionWithBus(warnings);
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild: vi.fn(async () => ({
        outcome: "completed" as const,
        finalMessage:
          "```skill-candidates\n" +
          JSON.stringify({
            skillCandidates: [candidate, { ...candidate, name: "Not A Slug" }],
          }) +
          "\n```\n",
      })),
      skillCandidatesHome: agencHome,
      listInstalledSkillNames: async () => ["run-hermetic-vitest"],
    });

    await executeExtractMemories(extractionContext({ cwd: root, messages, session }));

    await expect(stat(join(agencHome, "skill-candidates", "run-hermetic-vitest"))).rejects.toThrow();
    const causes = warnings.map((warning) => warning.cause);
    expect(causes).not.toContain("skill_candidate_proposed");
    expect(causes.filter((cause) => cause === "skill_candidate_skipped")).toHaveLength(2);
    expect(warnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Not A Slug: name is not a kebab-case slug"),
        "run-hermetic-vitest: a skill with this name is already installed",
      ]),
    );
  });

  it("neither asks for nor writes candidates when AGENC_SKILL_CANDIDATES=0", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const session = sessionWithBus(warnings);
    const runChild = vi.fn(async () => ({
      outcome: "completed" as const,
      finalMessage: replyWithCandidate(),
    }));
    initExtractMemories({
      env: { AGENC_SKILL_CANDIDATES: "0" },
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
      skillCandidatesHome: agencHome,
      listInstalledSkillNames: async () => [],
    });

    await executeExtractMemories(extractionContext({ cwd: root, messages, session }));

    expect(runChild).toHaveBeenCalledOnce();
    expect(runChild.mock.calls[0]![0].prompt).not.toContain("Skill candidates");
    await expect(stat(join(agencHome, "skill-candidates"))).rejects.toThrow();
    expect(warnings.map((warning) => warning.cause)).not.toContain("skill_candidate_proposed");
  });

  it("stays off when an injected env names no AgenC home", async () => {
    const runChild = vi.fn(async () => ({
      outcome: "completed" as const,
      finalMessage: replyWithCandidate(),
    }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      runChild,
      listInstalledSkillNames: async () => [],
    });

    await executeExtractMemories(extractionContext({ cwd: root, messages }));

    expect(runChild).toHaveBeenCalledOnce();
    expect(runChild.mock.calls[0]![0].prompt).not.toContain("Skill candidates");
    await expect(stat(join(agencHome, "skill-candidates"))).rejects.toThrow();
  });

  it("reads the candidate block from the real delegate result", async () => {
    const delegateFn = vi.fn(async () => ({
      kind: "sync_completed" as const,
      result: {
        threadId: "child-thread",
        durationMs: 0,
        outcome: "completed" as const,
        finalMessage: replyWithCandidate(),
      },
      thread: {},
    }));
    const ensureAgentControl = vi.fn(() => ({ control: {}, registry: {} }));
    initExtractMemories({
      env: {},
      minEligibleTurns: 1,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
      delegateFn: delegateFn as never,
      ensureAgentControl: ensureAgentControl as never,
      skillCandidatesHome: agencHome,
      listInstalledSkillNames: async () => [],
    });

    await executeExtractMemories(extractionContext({ cwd: root, messages }));

    expect(delegateFn).toHaveBeenCalledOnce();
    await expect(
      stat(join(agencHome, "skill-candidates", "run-hermetic-vitest", "SKILL.md")),
    ).resolves.toBeDefined();
  });
});
