import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
import { formatMemoryManifest, scanMemoryFiles } from "./memory-scan.js";

const defaultSession = {} as Session;

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
      }),
    ).resolves.toEqual({
      enabled: false,
      reason: "invalid_memory_path_override",
    });
  });

  it("disables remote sessions without a memory mount", async () => {
    await expect(
      resolveAutoMemoryDirectory({
        env: { AGENC_REMOTE: "1" },
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
        readSettingsFile: async () => null,
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
          readSettingsFile: async () => null,
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

  it("does not advance the cursor when child policy denied a tool", async () => {
    const runChild = vi
      .fn(
        async (_request: ExtractMemoriesChildRequest) =>
          ({ outcome: "completed" as const }),
      )
      .mockImplementationOnce(async (request) => {
        request.onProgress({
          kind: "tool_result",
          callId: "read-1",
          toolName: "FileRead",
          result: "{}",
          isError: true,
          metadata: { childPolicyDenied: true },
        });
        return { outcome: "completed" };
      })
      .mockResolvedValue({ outcome: "completed" });
    initExtractMemories({
      env: {},
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
    expect(delegateCall.toolAllowlist).toBeUndefined();
    expect(
      delegateCall.childToolPolicy({ name: "system.bash" }, {}),
    ).toMatchObject({
      behavior: "deny",
      metadata: { reason: "tool_not_allowed" },
    });
  });

  it("drains active extraction work before the caller finishes shutdown", async () => {
    let resolveChild!: () => void;
    const runChild = vi.fn(
      async () =>
        new Promise<{ readonly outcome: "completed" }>((resolve) => {
          resolveChild = () => resolve({ outcome: "completed" });
        }),
    );
    initExtractMemories({
      env: {},
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
    await eventually(() => expect(runChild).toHaveBeenCalledOnce());

    let drained = false;
    const drain = drainPendingExtraction(1000).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveChild();
    await extraction;
    await drain;
    expect(drained).toBe(true);
  });

  it("scopes extraction cursors by session and memory directory", async () => {
    const sessionA = { conversationId: "session-a" } as Session;
    const sessionB = { conversationId: "session-b" } as Session;
    const memoryDirB = join(root, "memory-b");
    await mkdir(memoryDirB, { recursive: true });
    const runChild = vi.fn(async () => ({ outcome: "completed" as const }));
    initExtractMemories({
      env: {},
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
