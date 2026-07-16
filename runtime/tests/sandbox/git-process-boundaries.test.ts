import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
} from "../../src/sandbox/execution-broker.js";
import type { SandboxTransformRequest } from "../../src/sandbox/engine/index.js";
import { assembleSystemPrompt } from "../../src/prompts/system-prompt.js";
import { clearSystemPromptSections } from "../../src/prompts/sections.js";
import { getOrCreateWorktree as getOrCreateAgentWorktree } from "../../src/agents/worktree.js";
import { CodeIntelManager } from "../../src/tools/system/code-intel.js";
import { runSandboxedToolCommand } from "../../src/tools/system/coding-common.js";
import { createGitAndRepoTools } from "../../src/tools/system/git-tools.js";
import {
  __resetWorktreeSessionsForTesting,
  createEnterWorktreeTool,
  createExitWorktreeTool,
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

function recordingRestrictedBroker(
  cwd: string,
  requests: SandboxTransformRequest[],
  failureForRequest?: (request: SandboxTransformRequest) => string | undefined,
): SandboxExecutionBroker {
  return new SandboxExecutionBroker({
    mode: "workspace_write",
    cwd,
    probe: () => ({
      kind: "ready",
      mode: "workspace_write",
      platform: process.platform,
    }),
    sandboxManager: {
      selectInitial: () => "linux_seccomp",
      transform: (request: SandboxTransformRequest) => {
        requests.push(request);
        const failure = failureForRequest?.(request);
        if (failure !== undefined) {
          return {
            command: [
              process.execPath,
              "-e",
              `process.stderr.write(${JSON.stringify(failure)}); process.exit(1)`,
            ],
            cwd: request.command.cwd,
            env: request.command.env,
          } as never;
        }
        return {
          command: [request.command.program, ...request.command.args],
          cwd: request.command.cwd,
          env: request.command.env,
        } as never;
      },
    },
  });
}

function initGitRepo(root: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "tests@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tests"], { cwd: root });
  writeFileSync(join(root, "README.md"), "root\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: root,
    stdio: "ignore",
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
  it("separates restricted worktree metadata mutation from checkout materialization", async () => {
    const root = tempRoot("agenc-restricted-worktree-boundary-");
    initGitRepo(root);
    const requests: SandboxTransformRequest[] = [];
    const broker = recordingRestrictedBroker(root, requests);
    const sessionId = "restricted-worktree-boundary";
    const slug = "restricted-boundary";
    const worktreePath = join(root, ".agenc", "worktrees", slug);
    const hardening = [
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "diff.external=",
    ];
    const addArgs: Record<string, unknown> = {
      name: slug,
      __agencSessionId: sessionId,
    };
    attachSandboxExecutionBroker(addArgs, broker, "tool");

    const entered = await createEnterWorktreeTool({ cwd: root }).execute(
      addArgs,
    );

    expect(entered.isError).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(true);
    const addRequest = requests.find((request) =>
      request.command.args.includes("add") &&
      request.command.args.includes(worktreePath)
    );
    expect(addRequest?.command.args).toEqual([
      ...hardening,
      "-C",
      root,
      "worktree",
      "add",
      "--no-checkout",
      "-b",
      slug,
      worktreePath,
    ]);
    expect(addRequest?.command.additionalPermissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: join(root, ".git") },
            access: "write",
          },
          {
            path: { kind: "path", path: join(root, ".agenc") },
            access: "write",
          },
        ],
      },
    });
    const checkoutRequest = requests.find((request) =>
      request.command.args.includes("checkout") &&
      request.command.args.includes(worktreePath)
    );
    expect(checkoutRequest?.command.args).toEqual([
      ...hardening,
      "-C",
      worktreePath,
      "checkout",
      "HEAD",
    ]);
    const gitdirPointer = readFileSync(join(worktreePath, ".git"), "utf8")
      .trim()
      .slice("gitdir:".length)
      .trim();
    const worktreeAdminDir = realpathSync(resolve(worktreePath, gitdirPointer));
    expect(checkoutRequest?.command.additionalPermissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: worktreeAdminDir },
            access: "write",
          },
          {
            path: { kind: "path", path: worktreePath },
            access: "write",
          },
        ],
      },
    });
    expect(requests.indexOf(addRequest!)).toBeLessThan(
      requests.indexOf(checkoutRequest!),
    );

    const removeArgs: Record<string, unknown> = {
      action: "remove",
      discard_changes: true,
      __agencSessionId: sessionId,
    };
    attachSandboxExecutionBroker(removeArgs, broker, "tool");
    const exited = await createExitWorktreeTool({ cwd: root }).execute(
      removeArgs,
    );

    expect(exited.isError).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    const removeRequest = requests.find((request) =>
      request.command.args.includes("remove") &&
      request.command.args.includes(worktreePath)
    );
    expect(removeRequest?.command.args).toEqual([
      ...hardening,
      "-C",
      root,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    expect(removeRequest?.command.additionalPermissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: join(root, ".git") },
            access: "write",
          },
          {
            path: { kind: "path", path: worktreePath },
            access: "write",
          },
        ],
      },
    });
    const branchDeleteRequest = requests.find((request) =>
      request.command.args.includes("branch") &&
      request.command.args.includes("-D")
    );
    expect(branchDeleteRequest?.command.args).toEqual([
      ...hardening,
      "-C",
      root,
      "branch",
      "-D",
      slug,
    ]);
    expect(branchDeleteRequest?.command.additionalPermissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: join(root, ".git") },
            access: "write",
          },
        ],
      },
    });
  });

  it("rolls back metadata and the new branch when restricted checkout fails", async () => {
    const root = tempRoot("agenc-restricted-worktree-checkout-failure-");
    initGitRepo(root);
    const requests: SandboxTransformRequest[] = [];
    let failedWorktreeAdminDir: string | undefined;
    const broker = recordingRestrictedBroker(
      root,
      requests,
      (request) => {
        if (!request.command.args.includes("checkout")) return undefined;
        const worktreePathArg = request.command.args.at(-3);
        if (worktreePathArg === undefined) return undefined;
        const pointer = readFileSync(join(worktreePathArg, ".git"), "utf8")
          .trim()
          .slice("gitdir:".length)
          .trim();
        failedWorktreeAdminDir = realpathSync(
          resolve(worktreePathArg, pointer),
        );
        return "injected checkout failure";
      },
    );
    const slug = "checkout-failure";
    const worktreePath = join(root, ".agenc", "worktrees", slug);
    const args: Record<string, unknown> = {
      name: slug,
      __agencSessionId: "restricted-worktree-checkout-failure",
    };
    attachSandboxExecutionBroker(args, broker, "tool");

    const entered = await createEnterWorktreeTool({ cwd: root }).execute(args);

    expect(entered.isError).toBe(true);
    expect(String(entered.content)).toContain("injected checkout failure");
    expect(existsSync(worktreePath)).toBe(false);
    expect(
      execFileSync("git", ["branch", "--list", slug], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).not.toContain(worktreePath);

    const addRequest = requests.find((request) =>
      request.command.args.includes("add") &&
      request.command.args.includes(worktreePath)
    );
    const checkoutRequest = requests.find((request) =>
      request.command.args.includes("checkout") &&
      request.command.args.includes(worktreePath)
    );
    const removeRequest = requests.find((request) =>
      request.command.args.includes("remove") &&
      request.command.args.includes(worktreePath)
    );
    const branchDeleteRequest = requests.find((request) =>
      request.command.args.includes("branch") &&
      request.command.args.includes("-D") &&
      request.command.args.includes(slug)
    );
    expect(addRequest).toBeDefined();
    expect(checkoutRequest).toBeDefined();
    expect(removeRequest).toBeDefined();
    expect(branchDeleteRequest).toBeDefined();
    expect(failedWorktreeAdminDir).toBeDefined();
    expect(addRequest?.command.args).toContain("--no-checkout");
    expect(checkoutRequest?.command.args.slice(-4)).toEqual([
      "-C",
      worktreePath,
      "checkout",
      "HEAD",
    ]);
    expect(checkoutRequest?.command.additionalPermissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: {
              kind: "path",
              path: failedWorktreeAdminDir,
            },
            access: "write",
          },
          {
            path: { kind: "path", path: worktreePath },
            access: "write",
          },
        ],
      },
    });
    expect(removeRequest?.command.additionalPermissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: join(root, ".git") },
            access: "write",
          },
          {
            path: { kind: "path", path: worktreePath },
            access: "write",
          },
        ],
      },
    });
    expect(branchDeleteRequest?.command.additionalPermissions).toEqual({
      fileSystem: {
        entries: [
          {
            path: { kind: "path", path: join(root, ".git") },
            access: "write",
          },
        ],
      },
    });
    const addIndex = requests.indexOf(addRequest!);
    const checkoutIndex = requests.indexOf(checkoutRequest!);
    const removeIndex = requests.indexOf(removeRequest!);
    const branchDeleteIndex = requests.indexOf(branchDeleteRequest!);
    expect(addIndex).toBeLessThan(checkoutIndex);
    expect(checkoutIndex).toBeLessThan(removeIndex);
    expect(removeIndex).toBeLessThan(branchDeleteIndex);
  });

  it.skipIf(process.platform === "win32")(
    "escalates a TERM-resistant sandboxed tool command to SIGKILL promptly",
    async () => {
      const root = tempRoot("agenc-sandbox-force-kill-");
      const termMarker = join(root, "term-observed");
      const args: Record<string, unknown> = {};
      attachSandboxExecutionBroker(
        args,
        new SandboxExecutionBroker({ mode: "danger_full_access", cwd: root }),
        "tool",
      );
      const script = [
        `const { spawn } = require("node:child_process");`,
        `const grandchildScript = ${JSON.stringify(
          `const fs = require("node:fs");` +
            `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termMarker)}, "term"));` +
            `setTimeout(() => process.exit(88), 2500);`,
        )};`,
        `spawn(process.execPath, ["-e", grandchildScript], { stdio: ["ignore", "inherit", "inherit"] });`,
        `setTimeout(() => process.stdout.write("ready"), 100);`,
        `setTimeout(() => process.exit(88), 2500);`,
      ].join("");
      const startedAt = Date.now();

      const result = await runSandboxedToolCommand({
        toolArgs: args,
        program: process.execPath,
        args: ["-e", script],
        cwd: root,
        maxBuffer: 1,
      });

      expect(existsSync(termMarker)).toBe(true);
      expect(result).toMatchObject({
        exitCode: 1,
        stderr: "command output exceeded 1 bytes",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    },
    5_000,
  );

  it("omits representative secrets from the captured and spawned child environment", async () => {
    const root = tempRoot("agenc-sandbox-scrubbed-env-");
    const requests: SandboxTransformRequest[] = [];
    const args: Record<string, unknown> = {};
    attachSandboxExecutionBroker(
      args,
      recordingRestrictedBroker(root, requests),
      "tool",
    );
    const result = await runSandboxedToolCommand({
      toolArgs: args,
      program: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.env))",
      ],
      cwd: root,
      env: {
        PATH: process.env.PATH,
        AGENC_SAFE_TEST_VALUE: "preserved",
        XAI_API_KEY: "xai-secret",
        GITHUB_TOKEN: "github-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        CUSTOM_SERVICE_PASSWORD: "password-secret",
      },
    });

    expect(result.exitCode).toBe(0);
    const capturedEnv = requests.at(-1)?.command.env;
    expect(capturedEnv).toMatchObject({ AGENC_SAFE_TEST_VALUE: "preserved" });
    expect(capturedEnv).not.toHaveProperty("XAI_API_KEY");
    expect(capturedEnv).not.toHaveProperty("GITHUB_TOKEN");
    expect(capturedEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(capturedEnv).not.toHaveProperty("CUSTOM_SERVICE_PASSWORD");
    const spawnedEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(spawnedEnv).toMatchObject({ AGENC_SAFE_TEST_VALUE: "preserved" });
    expect(spawnedEnv).not.toHaveProperty("XAI_API_KEY");
    expect(spawnedEnv).not.toHaveProperty("GITHUB_TOKEN");
    expect(spawnedEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(spawnedEnv).not.toHaveProperty("CUSTOM_SERVICE_PASSWORD");
  });

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
