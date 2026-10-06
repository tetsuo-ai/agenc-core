import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import {
  processIsRunning,
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

/**
 * node-pty's kill() is process.kill(this.pid, signal): pid 0 would signal
 * the daemon's own process group and -1 every process of the user. These
 * stand-ins only record the call. (pid 1 is not used here: on main it went
 * to tree-kill, which signals every child of init.)
 */
function installInvalidPidPty(
  manager: UnifiedExecProcessManager,
  pid: number,
): { readonly kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn();
  (manager as unknown as { loadPty: () => Promise<unknown> }).loadPty =
    async () => ({
      spawn: () => ({
        pid,
        write: vi.fn(),
        resize: vi.fn(),
        kill,
        onData: () => ({ dispose: vi.fn() }),
        onExit: () => ({ dispose: vi.fn() }),
      }),
    });
  return { kill };
}

describe("unified exec PTY without a valid pid", () => {
  test.each([0, -1])(
    "kill_process never signals a PTY whose pid is %s",
    async (pid) => {
      const cwd = await mkdtemp(join(tmpdir(), "agenc-pty-invalid-"));
      cleanups.push(() => rm(cwd, { recursive: true, force: true }));
      const manager = new UnifiedExecProcessManager({ cwd });
      const pty = installInvalidPidPty(manager, pid);
      const started = await manager.execCommand({
        cmd: "sleep 30",
        tty: true,
        yield_time_ms: 250,
      });

      expect(manager.terminateProcess(started.process_id!)).toEqual({
        terminated: true,
      });
      // Past the 500 ms SIGKILL escalation.
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(pty.kill).not.toHaveBeenCalled();
    },
    10_000,
  );

  test.each([0, -1])(
    "a strict quiesce never signals a PTY whose pid is %s and fails closed",
    async (pid) => {
      const cwd = await mkdtemp(join(tmpdir(), "agenc-pty-invalid-"));
      cleanups.push(() => rm(cwd, { recursive: true, force: true }));
      const manager = new UnifiedExecProcessManager({
        cwd,
        sandboxAuthorityQuiesceTimeoutMs: 200,
      });
      const pty = installInvalidPidPty(manager, pid);
      await manager.execCommand({ cmd: "sleep 30", tty: true, yield_time_ms: 250 });

      const token = manager.beginSandboxAuthorityQuiesce();
      await expect(manager.finishSandboxAuthorityQuiesce(token)).rejects.toThrow(
        /could not prove process-tree cleanup/u,
      );
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(pty.kill).not.toHaveBeenCalled();
    },
    10_000,
  );
});

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

describe("unified exec PTY after its exit", () => {
  // node-pty reports a PTY's exit after reaping the child, so its pid may
  // then belong to an unrelated process. closeAll signals every retained
  // entry, exited ones included, and used to reach that process and its
  // whole group. The "unrelated process" here is a detached shell group the
  // test owns, holding the PTY's reported pid.
  posixOnly(
    "closeAll never signals an exited PTY's pid once another process holds it",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "agenc-pty-reuse-"));
      cleanups.push(() => rm(cwd, { recursive: true, force: true }));
      const other = spawnShellBackedPty();
      cleanups.push(() => other.cleanup());
      const otherChild = await other.descendantPid;
      const manager = new UnifiedExecProcessManager({ cwd });
      let exitListener:
        | ((event: { readonly exitCode: number; readonly signal?: number }) => void)
        | undefined;
      const kill = vi.fn();
      (manager as unknown as { loadPty: () => Promise<unknown> }).loadPty =
        async () => ({
          spawn: () => ({
            pid: other.shellPid,
            write: vi.fn(),
            resize: vi.fn(),
            kill,
            onData: () => ({ dispose: vi.fn() }),
            onExit: (listener: typeof exitListener) => {
              exitListener = listener;
              return { dispose: vi.fn() };
            },
          }),
        });
      await manager.execCommand({ cmd: "sleep 30", tty: true, yield_time_ms: 250 });
      expect(exitListener).toBeDefined();

      // The PTY exits and is reaped; its pid now belongs to the other group.
      exitListener!({ exitCode: 0 });
      await manager.closeAll("test_cleanup");
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(processIsRunning(other.shellPid)).toBe(true);
      expect(processIsRunning(otherChild)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    },
    15_000,
  );
});
