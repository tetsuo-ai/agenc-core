import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  verifyAllowedRoots,
} from "../../src/agents/_deps/filesystem-args.js";
import { filesystemRootsForDispatch } from "../../src/tools/filesystem-dispatch-roots.js";

function signedRoots(args: Record<string, unknown>): string[] {
  return verifyAllowedRoots(args[SESSION_ALLOWED_ROOTS_ARG], args[SESSION_ALLOWED_ROOTS_SIG_ARG]);
}

function session(mode: string, added: readonly string[] = []) {
  return {
    permissionModeRegistry: {
      current: () => ({
        mode,
        additionalWorkingDirectories: new Map(
          added.map((path) => [path, { path, source: "cliArg" }]),
        ),
      }),
    },
  };
}

describe("filesystemRootsForDispatch", () => {
  let outside = "";

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), "agenc-dispatch-roots-"));
  });

  afterEach(async () => {
    if (outside) await rm(outside, { recursive: true, force: true });
    outside = "";
  });

  test("an approval hands the tool the file's directory, as before", () => {
    const target = join(outside, "nginx.conf");
    const args = filesystemRootsForDispatch("Edit", { file_path: target }, {
      approvalResolved: true,
      sandboxMode: "workspace_write",
      session: session("default"),
    });
    expect(signedRoots(args)).toContain(dirname(target));
  });

  test("the full bypass hands it out without a prompt", () => {
    // Under --dangerously-bypass-approvals-and-sandbox the evaluator never
    // runs, so no approval ever resolved; FileRead /build/... was refused by
    // the tool's own confinement in the Terminal-Bench runs.
    const target = join(outside, "locale_init.cc");
    const args = filesystemRootsForDispatch("FileRead", { file_path: target }, {
      approvalResolved: false,
      sandboxMode: "danger_full_access",
      session: session("bypassPermissions"),
    });
    expect(signedRoots(args)).toContain(dirname(target));
  });

  test("bypassPermissions with a sandbox still on does not widen", () => {
    const target = join(outside, "locale_init.cc");
    const input = { file_path: target };
    const args = filesystemRootsForDispatch("FileRead", input, {
      approvalResolved: false,
      sandboxMode: "workspace_write",
      session: session("bypassPermissions"),
    });
    expect(args).toBe(input);
  });

  test("a path inside a directory the user added is widened in any mode", () => {
    const target = join(outside, "deploy", "hook.sh");
    const args = filesystemRootsForDispatch("Write", { file_path: target }, {
      approvalResolved: false,
      sandboxMode: "workspace_write",
      session: session("default", [outside]),
    });
    expect(signedRoots(args)).toContain(dirname(target));
  });

  test("a prompting session without an added directory leaves the args alone", () => {
    const input = { file_path: join(outside, "x.txt") };
    const args = filesystemRootsForDispatch("Edit", input, {
      approvalResolved: false,
      sandboxMode: "danger_full_access",
      session: session("default"),
    });
    expect(args).toBe(input);
  });

  test("tools without a file_path and unknown sessions are never widened", () => {
    const shell = { cmd: "ls /etc" };
    expect(
      filesystemRootsForDispatch("exec_command", shell, {
        approvalResolved: false,
        sandboxMode: "danger_full_access",
        session: session("bypassPermissions"),
      }),
    ).toBe(shell);
    const noSession = { file_path: join(outside, "x.txt") };
    expect(
      filesystemRootsForDispatch("Edit", noSession, {
        approvalResolved: false,
        sandboxMode: "danger_full_access",
      }),
    ).toBe(noSession);
  });
});
