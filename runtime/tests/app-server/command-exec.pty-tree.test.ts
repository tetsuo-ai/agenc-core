import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/app-server/protocol/index.js";
import {
  processIsRunning,
  settlesWithin,
  spawnShellBackedPty,
  waitUntilProcessGone,
  type ShellBackedPty,
} from "../helpers/shell-backed-pty.js";

// commandExec.terminate stopped a PTY session through tree-kill, which spawns
// pgrep (darwin) or ps (linux) through PATH with no error listener. Without
// them the daemon got an uncaught exception and the session kept running.

const { ptyFactory } = vi.hoisted(() => ({
  ptyFactory: { current: undefined as (() => unknown) | undefined },
}));

vi.mock("../../src/pty/loadPty.js", () => ({
  loadPty: () => ({
    spawn: () => {
      if (ptyFactory.current === undefined) {
        throw new Error("test PTY factory is not installed");
      }
      return ptyFactory.current();
    },
  }),
}));

const { AgenCCommandExecService } = await import(
  "../../src/app-server/command-exec.js"
);

const posixOnly = process.platform === "win32" ? it.skip : it;
const trees: ShellBackedPty[] = [];

afterEach(() => {
  ptyFactory.current = undefined;
  for (const tree of trees.splice(0)) tree.cleanup();
});

describe("commandExec PTY without a valid pid", () => {
  // node-pty's kill() is process.kill(this.pid, signal): pid 0 would signal
  // the daemon's own process group and -1 every process of the user. The
  // stand-in only records the call. (pid 1 is not used: on main it went to
  // tree-kill, which signals every child of init.)
  it.each([0, -1])("terminate never signals a PTY whose pid is %s", async (pid) => {
    const kill = vi.fn();
    let spawned = false;
    ptyFactory.current = () => {
      spawned = true;
      return {
        pid,
        write: vi.fn(),
        resize: vi.fn(),
        kill,
        onData: () => ({ dispose: vi.fn() }),
        onExit: () => ({ dispose: vi.fn() }),
      };
    };
    const service = new AgenCCommandExecService();
    const context = {
      connectionId: `pty-invalid-${pid}`,
      sendNotification: () => {},
    };
    const started = service.start(
      {
        command: ["/bin/sh", "-c", "sleep 30"],
        processId: "pty-invalid-1",
        tty: true,
        disableTimeout: true,
        permissionProfile: ":danger-full-access",
      },
      context,
    );
    void started.catch(() => undefined);
    await vi.waitFor(() => expect(spawned).toBe(true));

    await service.terminate({ processId: "pty-invalid-1" }, context);
    // Past the 500 ms SIGKILL escalation.
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(kill).not.toHaveBeenCalled();
    await service.closeConnection(context.connectionId);
  }, 10_000);
});

describe("commandExec PTY termination", () => {
  posixOnly(
    "terminate stops the PTY's whole tree when pgrep and ps are not on PATH",
    async () => {
      let backed: ShellBackedPty | undefined;
      ptyFactory.current = () => {
        backed = spawnShellBackedPty();
        trees.push(backed);
        return backed.pty;
      };
      const service = new AgenCCommandExecService();
      const notifications: JsonObject[] = [];
      const context = {
        connectionId: "pty-tree",
        sendNotification: (message: JsonObject) => notifications.push(message),
      };
      const started = service.start(
        {
          command: ["/bin/sh", "-c", "sleep 30"],
          processId: "pty-tree-1",
          tty: true,
          disableTimeout: true,
          permissionProfile: ":danger-full-access",
        },
        context,
      );
      void started.catch(() => undefined);
      await vi.waitFor(() => expect(backed).toBeDefined());
      const descendant = await backed!.descendantPid;

      const originalPath = process.env.PATH;
      process.env.PATH = "/nonexistent-agenc-test-bin";
      try {
        await service.terminate({ processId: "pty-tree-1" }, context);
        expect(await settlesWithin(backed!.exited, 3_000)).toBe(true);
        expect(await settlesWithin(started, 3_000)).toBe(true);
        expect(await waitUntilProcessGone(descendant, 3_000)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    },
    15_000,
  );
});

describe("commandExec PTY after its exit", () => {
  // node-pty reports a PTY's exit after reaping the child, so its pid may
  // then belong to an unrelated process. A terminate that arrives after the
  // exit, before the session is released, used to reach that process and
  // its whole group. The "unrelated process" here is a detached shell group
  // the test owns, holding the PTY's reported pid.
  posixOnly(
    "terminate never signals an exited PTY's pid once another process holds it",
    async () => {
      const other = spawnShellBackedPty();
      trees.push(other);
      const otherChild = await other.descendantPid;
      let exitListener:
        | ((event: { readonly exitCode: number; readonly signal?: number }) => void)
        | undefined;
      const kill = vi.fn();
      ptyFactory.current = () => ({
        pid: other.shellPid,
        write: vi.fn(),
        resize: vi.fn(),
        kill,
        onData: () => ({ dispose: vi.fn() }),
        onExit: (listener: typeof exitListener) => {
          exitListener = listener;
          return { dispose: vi.fn() };
        },
      });
      const service = new AgenCCommandExecService();
      const context = {
        connectionId: "pty-reuse",
        sendNotification: () => {},
      };
      const started = service.start(
        {
          command: ["/bin/sh", "-c", "sleep 30"],
          processId: "pty-reuse-1",
          tty: true,
          disableTimeout: true,
          permissionProfile: ":danger-full-access",
        },
        context,
      );
      void started.catch(() => undefined);
      await vi.waitFor(() => expect(exitListener).toBeDefined());

      // The PTY exits and is reaped; its pid now belongs to the other group.
      exitListener!({ exitCode: 0 });
      await service.terminate({ processId: "pty-reuse-1" }, context);
      await started.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(processIsRunning(other.shellPid)).toBe(true);
      expect(processIsRunning(otherChild)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    },
    15_000,
  );
});
