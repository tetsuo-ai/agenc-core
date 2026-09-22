import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import {
  settlesWithin,
  spawnShellBackedPty,
  waitUntilProcessGone,
  type ShellBackedPty,
} from "../helpers/shell-backed-pty.js";

// A PTY session is stopped by signalling its whole process tree. That used
// tree-kill, which spawns pgrep (darwin) or ps (linux) through PATH with no
// error listener: without them the daemon got an uncaught exception, the
// tree kept running, and a strict quiesce hung until its timeout.

const posixOnly = process.platform === "win32" ? test.skip : test;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startPtySession(options: {
  readonly quiesceTimeoutMs?: number;
} = {}): Promise<{
  readonly manager: UnifiedExecProcessManager;
  readonly backed: ShellBackedPty;
  readonly processId: number;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "agenc-pty-tree-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const manager = new UnifiedExecProcessManager({
    cwd,
    ...(options.quiesceTimeoutMs !== undefined
      ? { sandboxAuthorityQuiesceTimeoutMs: options.quiesceTimeoutMs }
      : {}),
  });
  let backed: ShellBackedPty | undefined;
  (manager as unknown as { loadPty: () => Promise<unknown> }).loadPty =
    async () => ({
      spawn: () => {
        backed = spawnShellBackedPty();
        cleanups.push(() => backed!.cleanup());
        return backed.pty;
      },
    });
  const started = await manager.execCommand({
    cmd: "sleep 30",
    tty: true,
    yield_time_ms: 250,
  });
  if (backed === undefined || started.process_id === undefined) {
    throw new Error("PTY session did not start");
  }
  await backed.descendantPid;
  return { manager, backed, processId: started.process_id };
}

function withoutProcessTableTools(): () => void {
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agenc-test-bin";
  return () => {
    process.env.PATH = originalPath;
  };
}

describe("unified exec PTY process-tree termination", () => {
  posixOnly(
    "kill_process stops the PTY's whole tree when pgrep and ps are not on PATH",
    async () => {
      const { manager, backed, processId } = await startPtySession();
      const descendant = await backed.descendantPid;
      const restorePath = withoutProcessTableTools();
      try {
        expect(manager.terminateProcess(processId)).toEqual({ terminated: true });
        expect(await settlesWithin(backed.exited, 3_000)).toBe(true);
        expect(await waitUntilProcessGone(descendant, 3_000)).toBe(true);
      } finally {
        restorePath();
      }
      await manager.closeAll("test_cleanup");
    },
    15_000,
  );

  posixOnly(
    "a strict quiesce proves the PTY tree stopped when pgrep and ps are not on PATH",
    async () => {
      const { manager, backed } = await startPtySession({
        quiesceTimeoutMs: 3_000,
      });
      const descendant = await backed.descendantPid;
      const restorePath = withoutProcessTableTools();
      try {
        const token = manager.beginSandboxAuthorityQuiesce();
        await expect(
          manager.finishSandboxAuthorityQuiesce(token),
        ).resolves.toBeUndefined();
        manager.resumeSandboxAuthorityAfterQuiesce(token);
        expect(await settlesWithin(backed.exited, 1_000)).toBe(true);
        expect(await waitUntilProcessGone(descendant, 3_000)).toBe(true);
      } finally {
        restorePath();
      }
    },
    15_000,
  );
});
