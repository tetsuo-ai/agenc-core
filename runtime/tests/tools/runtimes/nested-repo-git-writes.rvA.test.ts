import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enforceRuntimeSandboxAttempt } from "../../../src/tools/runtimes/sandboxing.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import type { Tool } from "../../../src/tools/types.js";

/**
 * A sandboxed command can plant a *nested* git repository under the workspace
 * (its own `.git/config` with core.fsmonitor / a filter / hooks) and add a
 * gitlink for it to the superproject index. The protected-metadata narrowing
 * only protects the workspace's TOP-LEVEL `.git`; a nested `<ws>/sub/.git` is
 * ordinary writable data. A later host-side `git status` (including AgenC's
 * own TUI probe, which sets core.fsmonitor=false only on the parent) descends
 * into the gitlinked nested repo and runs its config's program unsandboxed.
 */
let root: string;
let cwd: string;
let sessionTempRoot: string;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-nested-git-")));
  cwd = join(root, "project");
  sessionTempRoot = join(root, "session-tmp");
  mkdirSync(cwd);
  mkdirSync(sessionTempRoot);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd, env: GIT_ENV, stdio: "ignore" });
  // A nested repo already on disk (the sandboxed command made it with `git init sub`).
  // git init always writes HEAD and an objects directory, so this is a real
  // repository: the narrowing (and so the protection of its execution surface)
  // applies only to a real repository, never an empty .git placeholder.
  mkdirSync(join(cwd, "sub", ".git", "hooks"), { recursive: true });
  mkdirSync(join(cwd, "sub", ".git", "objects"), { recursive: true });
  writeFileSync(join(cwd, "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(cwd, "sub", ".git", "config"), "[core]\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function decide(tool: Tool, file: string): string {
  try {
    enforceRuntimeSandboxAttempt({
      tool,
      args: { file_path: file, content: "x\n" },
      context: {
        callId: "nested", toolName: tool.name, runtimeKind: "function",
        classification: { kind: "exclusive" }, supportsParallelToolCalls: false,
        source: "direct", submittedAtMs: 0, approvalPolicy: "never",
        requestedSandboxMode: "workspace_write", sandboxMode: "workspace_write",
        approvalResolved: false, rawArgs: "{}",
        invocation: {
          session: { conversationId: "nested-session",
            services: { admissionRequired: false, runtimeOptions: { sessionTempRoot } } },
          turn: { cwd },
          tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
          callId: "nested", toolName: { name: tool.name },
          payload: { kind: "function", arguments: "{}" }, source: "direct",
        },
      } as never,
    });
    return "allow";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe.skipIf(process.platform === "win32")("a native write into a nested repository's .git", () => {
  it("refuses a nested repo's config and hooks the way it refuses the top-level .git", () => {
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    // Baseline: the workspace's own .git surface is refused.
    expect(decide(write, ".git/config")).toMatch(/blocked write/);
    expect(decide(write, ".git/hooks/pre-commit")).toMatch(/blocked write/);
    // The gap: a nested repository's executable surface is NOT protected.
    expect(decide(write, "sub/.git/config"), "sub/.git/config").toMatch(/blocked write/);
    expect(decide(write, "sub/.git/hooks/pre-commit"), "sub/.git/hooks/pre-commit").toMatch(/blocked write/);
  });
});
