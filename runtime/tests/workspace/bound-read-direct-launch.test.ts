import { mkdtemp, realpath, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PreparedBoundReadOnlyBwrapLaunch } from "../../src/sandbox/linux-launcher/bound-bwrap.js";

const planned = vi.hoisted(() => ({ next: undefined as PreparedBoundReadOnlyBwrapLaunch | undefined }));
vi.mock("../../src/sandbox/linux-launcher/bound-bwrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox/linux-launcher/bound-bwrap.js")>();
  return { ...actual, prepareBoundReadOnlyBwrapLaunch: () => planned.next };
});
const { __disposeIdleReadHelpersForTests, bindWorkspaceDirectoryReadCapability } =
  await import("../../src/workspace/file-mutation-transaction.js");

let root = "";
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "bound-direct-launch-"))); });
afterEach(async () => {
  planned.next = undefined;
  await __disposeIdleReadHelpersForTests();
  await rm(root, { recursive: true, force: true });
});

function plan(script: string, identityOverride: Partial<Record<"size", string>> = {}) {
  const stat = statSync("/bin/sh", { bigint: true });
  const invalidate = vi.fn();
  planned.next = {
    launch: {
      program: "/bin/sh",
      programIdentity: { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mode: String(stat.mode),
        mtimeNs: String(stat.mtimeNs), ...identityOverride },
      args: ["-c", script], env: { PATH: "/usr/bin:/bin" }, seccomp: Buffer.from("SECCOMP-PROGRAM"),
      seccompFd: 3, cwdFd: 4,
    },
    invalidate,
  };
  return invalidate;
}

const search = { program: "/bin/echo", args: ["launcher ran"], env: {}, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };

test.skipIf(process.platform !== "linux")("starts the planned launch with the held directory on 4 and the seccomp program on 3", async () => {
  plan('readlink /proc/self/fd/4; cat <&3; echo; pwd');
  const capability = await bindWorkspaceDirectoryReadCapability(root);
  try {
    const result = await capability.runRipgrep(search);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${root}\nSECCOMP-PROGRAM\n${root}\n`);
  } finally { await capability.dispose(); }
});

test.skipIf(process.platform !== "linux")("runs the launcher command instead when bubblewrap refuses the planned launch", async () => {
  const invalidate = plan("echo \"bwrap: Can't mount proc on /newroot/proc: Operation not permitted\" >&2; exit 1");
  const capability = await bindWorkspaceDirectoryReadCapability(root);
  try {
    const result = await capability.runRipgrep(search);
    expect(result.stdout.toString()).toBe("launcher ran\n");
    expect(invalidate).toHaveBeenCalledOnce();
    // A search that ran and failed on its own is its own answer.
    const ownFailure = plan("echo 'rg: regex parse error' >&2; exit 2");
    const failed = await capability.runRipgrep(search);
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr.toString()).toContain("regex parse error");
    expect(ownFailure).not.toHaveBeenCalled();
  } finally { await capability.dispose(); }
});

test.skipIf(process.platform !== "linux")("refuses a planned launch whose program changed after planning", async () => {
  plan("echo should-not-run", { size: "1" });
  const capability = await bindWorkspaceDirectoryReadCapability(root);
  try {
    await expect(capability.runRipgrep(search)).rejects.toThrow(/sandbox launcher changed/u);
  } finally { await capability.dispose(); }
});
