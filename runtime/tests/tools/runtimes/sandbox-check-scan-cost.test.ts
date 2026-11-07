import { execFileSync } from "node:child_process";
import fs, { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  compatibilitySandboxPolicyForPermissionProfile,
  compatibilitySandboxPolicyKindForPermissionProfile,
} from "../../../src/sandbox/engine/manager.js";
import { getWritableRootsWithCwd } from "../../../src/sandbox/engine/policy.js";
import {
  enforceRuntimeSandboxAttempt,
  permissionProfileForRuntimeContext,
} from "../../../src/tools/runtimes/sandboxing.js";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import type { Tool } from "../../../src/tools/types.js";

/**
 * The runtime sandbox check runs before every tool call. It decides on the
 * compatibility policy's kind; the whole policy, whose writable roots also
 * list each nested repository's surface, is what a refusal carries. Scanning
 * every writable root for nested repositories on each call (about half a
 * millisecond with a compile cache in /tmp, more on a node_modules tree) was
 * paid for a value only a refusal reads, so the check now scans only when it
 * raises one. These cases pin both halves: no scan on an allowed call, and a
 * refusal whose text and policy are exactly what the full computation gives.
 */
let root: string;
let cwd: string;
let sessionTempRoot: string;
let sandboxHelper: string;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-sandbox-check-scan-")));
  cwd = join(root, "project");
  sessionTempRoot = join(root, "session-tmp");
  sandboxHelper = join(root, "bin", "agenc-linux-sandbox");
  mkdirSync(cwd);
  mkdirSync(sessionTempRoot);
  mkdirSync(join(root, "bin"));
  writeFileSync(sandboxHelper, "#!/bin/sh\nexit 1\n");
  chmodSync(sandboxHelper, 0o755);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd, env: GIT_ENV, stdio: "ignore" });
  writeFileSync(join(cwd, "README.md"), "hello\n");
  // A standalone nested repository: its surface is a carve-out only the scan finds.
  mkdirSync(join(cwd, "vendor", "lib", ".git", "objects"), { recursive: true });
  writeFileSync(join(cwd, "vendor", "lib", ".git", "HEAD"), "ref: refs/heads/main\n");
  for (let i = 0; i < 50; i += 1) writeFileSync(join(sessionTempRoot, `cache-${i}`), "x\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function context(tool: Tool) {
  return {
    callId: "scan-cost", toolName: tool.name, runtimeKind: "function",
    classification: { kind: "exclusive" }, supportsParallelToolCalls: false,
    source: "direct", submittedAtMs: 0, approvalPolicy: "never",
    requestedSandboxMode: "workspace_write", sandboxMode: "workspace_write",
    approvalResolved: false, rawArgs: "{}",
    invocation: {
      session: {
        conversationId: "scan-cost-session",
        services: { admissionRequired: false, runtimeOptions: { sessionTempRoot } },
      },
      turn: { cwd, agencLinuxSandboxExe: sandboxHelper },
      tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
      callId: "scan-cost", toolName: { name: tool.name },
      payload: { kind: "function", arguments: "{}" }, source: "direct",
    },
  } as never;
}

/** exec_command as the runtime sandbox sees it (name and metadata). */
function execCommand(): Tool {
  return {
    name: "exec_command",
    description: "",
    inputSchema: { type: "object" },
    metadata: { family: "terminal", source: "builtin", mutating: true },
    isReadOnly: false,
    recoveryCategory: "side-effecting",
    execute: async () => ({ content: "not reached" }),
  };
}

/** The check as the executor runs it: "allow", or the refusal it throws. */
function decide(tool: Tool, args: Record<string, unknown>): "allow" | Error {
  try {
    enforceRuntimeSandboxAttempt({ tool, args, context: context(tool) });
    return "allow";
  } catch (error) {
    return error as Error;
  }
}

const scannedRoots = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map(([dir]) => String(dir)).filter((dir) =>
    dir === cwd || dir === sessionTempRoot || dir.startsWith(`${cwd}/`) || dir.startsWith(`${sessionTempRoot}/`));

describe("the runtime sandbox check's nested-repository scan", () => {
  it("does not scan the writable roots for an allowed read or shell call", () => {
    const readdir = vi.spyOn(fs, "readdirSync");
    expect(decide(createFileReadTool({ allowedPaths: [cwd] }), { file_path: "README.md" })).toBe("allow");
    expect(decide(execCommand(), { cmd: "cat README.md", workdir: cwd })).toBe("allow");
    expect(scannedRoots(readdir)).toEqual([]);
  });

  it("refuses with the same text and the full policy, nested surface included", () => {
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    const refusal = decide(write, { file_path: ".git/config", content: "x\n" });
    expect(refusal).toBeInstanceOf(Error);
    const error = refusal as Error & { readonly policy?: unknown; readonly target?: string };
    expect(error.message).toBe(`sandbox workspace_write blocked write outside workspace: ${join(cwd, ".git", "config")}`);
    const profile = permissionProfileForRuntimeContext(context(write), { cwd });
    const full = compatibilitySandboxPolicyForPermissionProfile(
      profile, profile.fileSystem, profile.network, cwd, sessionTempRoot,
    );
    expect(error.policy).toEqual(full);
    expect(JSON.stringify(error.policy)).toContain(join(cwd, "vendor", "lib", ".git", "hooks"));

    const shell = decide(execCommand(), { cmd: `printf x > ${join(root, "outside.txt")}`, workdir: cwd });
    expect(shell).toBeInstanceOf(Error);
    expect((shell as Error).message).toBe(`sandbox workspace_write blocked write outside workspace: ${join(root, "outside.txt")}`);
    expect((shell as Error & { readonly policy?: unknown }).policy).toEqual(full);
  });

  it("takes the policy kind from the same inputs without scanning, in every mode", () => {
    const tool = createFileReadTool({ allowedPaths: [cwd] });
    for (const mode of ["workspace_write", "read_only", "danger_full_access", "external_sandbox"] as const) {
      const attempt = context(tool) as unknown as { sandboxMode: string; requestedSandboxMode: string };
      attempt.sandboxMode = mode;
      attempt.requestedSandboxMode = mode;
      const profile = permissionProfileForRuntimeContext(attempt as never, { cwd });
      const readdir = vi.spyOn(fs, "readdirSync");
      const kind = compatibilitySandboxPolicyKindForPermissionProfile(
        profile, profile.fileSystem, profile.network, cwd, sessionTempRoot,
      );
      expect(scannedRoots(readdir), mode).toEqual([]);
      readdir.mockRestore();
      expect(kind, mode).toBe(compatibilitySandboxPolicyForPermissionProfile(
        profile, profile.fileSystem, profile.network, cwd, sessionTempRoot,
      ).kind);
    }
  });

  it("drops only the nested findings when the scan is off", () => {
    const policy = permissionProfileForRuntimeContext(context(createFileReadTool({ allowedPaths: [cwd] })), { cwd }).fileSystem;
    const full = getWritableRootsWithCwd(policy, cwd, sessionTempRoot);
    const unscanned = getWritableRootsWithCwd(policy, cwd, sessionTempRoot, { nestedRepositoryScan: false });
    expect(unscanned.map((entry) => entry.root)).toEqual(full.map((entry) => entry.root));
    for (const [index, entry] of unscanned.entries()) {
      const nested = full[index]!.nestedRepoGitDirs ?? [];
      expect(entry.nestedRepoGitDirs).toBeUndefined();
      expect(entry.protectedMetadataNames).toEqual(full[index]!.protectedMetadataNames);
      expect(entry.readOnlySubpaths).toEqual(full[index]!.readOnlySubpaths.filter((subpath) =>
        !nested.some((gitDir) => subpath === gitDir || subpath.startsWith(`${gitDir}/`))));
    }
    expect(full.find((entry) => entry.root === cwd)?.nestedRepoGitDirs)
      .toEqual([join(cwd, "vendor", "lib", ".git")]);
  });
});
