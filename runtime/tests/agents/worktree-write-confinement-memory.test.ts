import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { worktreeWriteRefusal } from "../../src/agents/worktree-write-confinement.js";
import { getProjectRoot, setProjectRoot } from "../../src/bootstrap/state.js";
import { ConfigStore } from "../../src/config/store.js";
import { buildProjectMemoryDirectory, getAutoMemPath } from "../../src/memory/paths.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import type { Tool, ToolRegistry } from "../../src/tools/types.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

/**
 * A worktree child writes inside its worktree and, besides roots a trusted
 * child-tool policy signed into the call, into durable memory. That memory
 * was the process-wide directories: in a daemon, whose own working directory
 * keys the process-wide project directory, a worktree child could write the
 * daemon's project's memory and not its own session's. It now takes the
 * memory directories its session may write, and nothing broader.
 */
let root: string;
let mainRepo: string;
let worktree: string;
let home: string;
let previousAgencHome: string | undefined;
let previousProjectRoot: string;
let processAuthority: ConfigStore;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-worktree-memory-")));
  mainRepo = join(root, "main");
  worktree = join(mainRepo, ".agenc-worktrees", "m5-child");
  home = join(root, "home");
  // A linked worktree of `main`, laid out as `git worktree add` leaves it.
  const worktreeGitDir = join(mainRepo, ".git", "worktrees", "m5-child");
  mkdirSync(worktreeGitDir, { recursive: true });
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
  writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
  writeFileSync(join(worktreeGitDir, "gitdir"), `${join(worktree, ".git")}\n`);
  mkdirSync(home);
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  previousProjectRoot = getProjectRoot();
  // The daemon process starts in its own directory, not in the session's.
  const daemonDir = join(root, "daemon-home");
  mkdirSync(daemonDir);
  setProjectRoot(daemonDir);
  processAuthority = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: daemonDir });
});

afterEach(() => {
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  rmSync(root, { recursive: true, force: true });
});

/** A worktree child's session: its own cwd is the worktree. */
function childSession(runtimeOptions: Record<string, unknown> = {}, cliOverrides?: Record<string, unknown>): Session {
  const configStore = new ConfigStore({
    home, env: { AGENC_HOME: home }, cwd: worktree,
    ...(cliOverrides !== undefined ? { cliOverrides } : {}),
  });
  return {
    conversationId: "child-1",
    sessionConfiguration: { cwd: worktree, sandboxPolicy: { value: "workspace_write" } },
    permissionModeRegistry: { current: () => ({ mode: "acceptEdits", additionalWorkingDirectories: new Map() }) },
    services: {
      configStore,
      runtimeOptions: { ...resolveAgentRuntimeOptions({ AGENC_HOME: home }, { sessionTempRoot: root }), ...runtimeOptions },
    },
  } as unknown as Session;
}

/** The project memory directory of the repository: every worktree of it shares one. */
function projectMemory(): string {
  return buildProjectMemoryDirectory(home, mainRepo);
}

function globalMemory(): string {
  return join(home, "memory") + sep;
}

function inDaemon<T>(fn: () => T): T {
  return runWithCanonicalSettingsAuthority(processAuthority, fn);
}

describe("a worktree child's writes into durable memory", () => {
  it("may write the memory directories of its session", () => {
    inDaemon(() => {
      const session = childSession();
      for (const target of [
        join(projectMemory(), "project-codename.md"),
        join(projectMemory(), "MEMORY.md"),
        join(globalMemory(), "user-preferences.md"),
      ]) {
        expect(worktreeWriteRefusal("Write", { file_path: target, content: "x" }, worktree, session), target)
          .toBeUndefined();
      }
    });
  });

  it("may not write any other memory directory or the rest of the home", () => {
    inDaemon(() => {
      const session = childSession();
      // The process-wide project directory is the daemon's own project's.
      expect(getAutoMemPath()).not.toBe(projectMemory());
      for (const target of [
        join(getAutoMemPath(), "note.md"),
        join(buildProjectMemoryDirectory(home, join(root, "other-project")), "note.md"),
        join(home, "config.toml"),
        join(projectMemory(), "..", "notes.md"),
        join(mainRepo, "src", "slug.js"),
      ]) {
        expect(worktreeWriteRefusal("Write", { file_path: target, content: "x" }, worktree, session), target)
          .toContain("is outside it");
      }
    });
  });

  it("may write no memory directory when its session's auto memory is off or a cowork override moved it", async () => {
    const disabled = childSession({}, { autoMemoryEnabled: false });
    await (disabled.services as { configStore: ConfigStore }).configStore.reload();
    const override = join(root, "cowork-memory");
    inDaemon(() => {
      for (const [session, targets] of [
        [childSession({ simpleMode: true }), [projectMemory(), globalMemory()]],
        [disabled, [projectMemory(), globalMemory()]],
        [childSession({ coworkMemoryPathOverride: override }), [override, projectMemory(), globalMemory()]],
      ] as const) {
        for (const dir of targets) {
          expect(worktreeWriteRefusal("Write", { file_path: join(dir, "note.md"), content: "x" }, worktree, session), dir)
            .toContain("is outside it");
        }
      }
    });
  });

  it("is applied with the child's session when the child's Write executes", async () => {
    const seen: Record<string, unknown>[] = [];
    const write = {
      name: "Write",
      description: "test write",
      inputSchema: { type: "object", properties: {} },
      checkPermissions: async (input: Record<string, unknown>) => ({ behavior: "allow" as const, updatedInput: input }),
      async execute(args: Record<string, unknown>) {
        seen.push(args);
        return { content: "written" };
      },
    } as unknown as Tool;
    const base = {
      tools: [write],
      toLLMTools: () => [{ type: "function", function: { name: "Write", description: "test write", parameters: {} } }],
    } as unknown as ToolRegistry;
    const session = childSession();
    const child = buildFilteredRegistry(base, {
      childConversationId: "child-1",
      worktree: { path: worktree, branch: "worktree-m5-child", gitRoot: mainRepo } as never,
      getSession: () => session,
    }).tools.find((tool) => tool.name === "Write")!;
    await inDaemon(async () => {
      const saved = await child.execute({ file_path: join(projectMemory(), "project-codename.md"), content: "x" });
      expect(saved.isError ?? false, String(saved.content)).toBe(false);
      const refused = await child.execute({ file_path: join(getAutoMemPath(), "note.md"), content: "x" });
      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toContain("is outside it");
    });
    expect(seen).toHaveLength(1);
  });
});
