import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";
import { assembleSystemPrompt } from "../../src/prompts/system-prompt.js";
import { clearSystemPromptSections } from "../../src/prompts/sections.js";
import { getOrCreateWorktree as getOrCreateAgentWorktree } from "../../src/agents/worktree.js";
import { CodeIntelManager } from "../../src/tools/system/code-intel.js";
import { createGitAndRepoTools } from "../../src/tools/system/git-tools.js";
import {
  __resetWorktreeSessionsForTesting,
  createEnterWorktreeTool,
} from "../../src/tools/system/worktree.js";
import { EnterWorktreeTool } from "../../src/tools/EnterWorktreeTool/EnterWorktreeTool.js";
import { ExitWorktreeTool } from "../../src/tools/ExitWorktreeTool/ExitWorktreeTool.js";
import { runWithCwdOverride } from "../../src/utils/cwd.js";
import { restoreWorktreeSession } from "../../src/utils/worktree.js";

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function unavailableBroker(cwd: string): SandboxExecutionBroker {
  return new SandboxExecutionBroker({
    mode: "workspace_write",
    cwd,
    probe: () => ({
      kind: "unavailable",
      mode: "workspace_write",
      platform: process.platform,
      reason: "probe: injected git boundary failure",
      remediation: "repair sandbox support",
    }),
  });
}

function installGitShim(root: string, marker: string): string {
  const bin = join(root, "bin");
  const git = join(bin, process.platform === "win32" ? "git.cmd" : "git");
  const body = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); console.log(${JSON.stringify(root)})"\r\n`
    : `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");\nconsole.log(${JSON.stringify(root)});\n`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(git, body, "utf8");
  chmodSync(git, 0o755);
  return bin;
}

function toolByName(
  tools: ReturnType<typeof createGitAndRepoTools>,
  name: string,
) {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearSystemPromptSections();
  __resetWorktreeSessionsForTesting();
  restoreWorktreeSession(null);
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe.sequential("git process sandbox boundaries", () => {
  it("blocks deferred repo tools before a PATH-resolved git process starts", async () => {
    const root = tempRoot("agenc-git-tool-boundary-");
    const marker = join(root, "git-tool-escaped");
    const bin = installGitShim(root, marker);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const args: Record<string, unknown> = { path: root };
    attachSandboxExecutionBroker(args, unavailableBroker(root), "tool");

    await expect(
      toolByName(
        createGitAndRepoTools({
          allowedPaths: [root],
          persistenceRootDir: root,
        }),
        "system.gitStatus",
      ).execute(args),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "tool",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks native code-intel indexing before PATH-resolved git starts", async () => {
    const root = tempRoot("agenc-code-intel-boundary-");
    const marker = join(root, "code-intel-escaped");
    const bin = installGitShim(root, marker);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const args: Record<string, unknown> = {};
    attachSandboxExecutionBroker(args, unavailableBroker(root), "tool");

    await expect(
      new CodeIntelManager({ persistenceRootDir: root }).searchSymbols({
        workspaceRoot: root,
        toolArgs: args,
      }),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "tool",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks legacy EnterWorktree before a PATH-resolved git process starts", async () => {
    const root = tempRoot("agenc-legacy-worktree-boundary-");
    const marker = join(root, "legacy-worktree-escaped");
    const bin = installGitShim(root, marker);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const args: Record<string, unknown> = {
      name: "sandbox-boundary",
      __agencSessionId: "git-boundary-test",
    };
    attachSandboxExecutionBroker(args, unavailableBroker(root), "tool");

    await expect(createEnterWorktreeTool({ cwd: root }).execute(args)).rejects
      .toMatchObject({
        code: "sandbox_probe_failed",
        surface: "tool",
      });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks canonical EnterWorktree through its ToolUseContext broker", async () => {
    const root = tempRoot("agenc-canonical-enter-boundary-");
    mkdirSync(join(root, ".git"), { recursive: true });
    const marker = join(root, "canonical-enter-escaped");
    const bin = installGitShim(root, marker);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);

    await expect(
      runWithCwdOverride(root, () =>
        EnterWorktreeTool.call(
          { name: "sandbox-boundary" },
          {
            abortController: new AbortController(),
            services: { sandboxExecutionBroker: unavailableBroker(root) },
          } as never,
          undefined,
          undefined,
        )
      ),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "tool",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks canonical ExitWorktree validation before git inspection", async () => {
    const root = tempRoot("agenc-canonical-exit-boundary-");
    const marker = join(root, "canonical-exit-escaped");
    const bin = installGitShim(root, marker);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    restoreWorktreeSession({
      originalCwd: root,
      worktreePath: root,
      worktreeName: "sandbox-boundary",
      worktreeBranch: "sandbox-boundary",
      originalHeadCommit: "deadbeef",
      sessionId: "canonical-exit-boundary",
    });

    await expect(
      ExitWorktreeTool.validateInput!(
        { action: "remove" },
        {
          abortController: new AbortController(),
          services: { sandboxExecutionBroker: unavailableBroker(root) },
        } as never,
      ),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "tool",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks subagent worktree setup before child publication", async () => {
    const root = tempRoot("agenc-agent-worktree-boundary-");
    mkdirSync(join(root, ".git"), { recursive: true });
    const marker = join(root, "agent-worktree-escaped");
    const bin = installGitShim(root, marker);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);

    await expect(
      getOrCreateAgentWorktree({
        gitRoot: root,
        slug: "sandbox-boundary",
        workspaceRoot: join(root, ".agenc-worktrees"),
        sandboxExecutionBroker: unavailableBroker(root),
      }),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "child_agent",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("blocks prompt git probing through the live session broker", async () => {
    const root = tempRoot("agenc-prompt-git-boundary-");
    const marker = join(root, "prompt-git-escaped");
    const bin = installGitShim(root, marker);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);

    await expect(
      assembleSystemPrompt({
        session: {
          services: { sandboxExecutionBroker: unavailableBroker(root) },
        } as never,
        ctx: {
          cwd: root,
          config: { model: "grok-4.5" },
          configSnapshot: { model: "grok-4.5" },
        } as never,
        envForSimpleMode: {},
      }),
    ).rejects.toMatchObject({
      code: "sandbox_probe_failed",
      surface: "tool",
    });
    expect(existsSync(marker)).toBe(false);
  });
});
