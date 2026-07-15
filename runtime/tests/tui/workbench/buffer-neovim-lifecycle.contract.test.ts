import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { encode } from "@msgpack/msgpack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverNeovim } from "../../../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";
import type { NeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { dirtyFlagFromRpcNotificationParams, EmbeddedNeovimSession, startEmbeddedNeovim } from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import { cleanupTrackedNeovimProcesses, getTrackedNeovimProcessCountForTesting, killNeovimChild, normalizeNeovimPid, runTrackedNeovimProcessExitCleanupForTesting, spawnNeovimProcess, waitForNeovimExit } from "../../../src/tui/workbench/buffer/neovim/NeovimProcess.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-nvim-lifecycle-"));
});

afterEach(async () => {
  cleanupTrackedNeovimProcesses("SIGKILL");
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("embedded Neovim lifecycle", () => {
  it("covers process cleanup branches without spawning real Neovim", async () => {
    mockMissingProcessGroups();
    const killedChild = fakeChild({ killed: true, pid: 111, signalCode: "SIGTERM" });
    expect(normalizeNeovimPid(123)).toBe(123);
    expect(normalizeNeovimPid(undefined)).toBe(0);
    killNeovimChild(killedChild, true, "SIGTERM");
    expect(killedChild.kill).not.toHaveBeenCalled();

    const noPidChild = fakeChild({ pid: undefined });
    killNeovimChild(noPidChild, true, "SIGTERM");
    expect(noPidChild.kill).toHaveBeenCalledWith("SIGTERM");

    const attachedChild = fakeChild({ killed: true, pid: 222 });
    killNeovimChild(attachedChild, false, "SIGKILL");
    expect(attachedChild.kill).toHaveBeenCalledWith("SIGKILL");

    const detachedChild = fakeChild({ pid: 333 });
    killNeovimChild(detachedChild, true, "SIGTERM");
    expect(detachedChild.kill).toHaveBeenCalledWith("SIGTERM");

    const exitedChild = fakeChild({ exitCode: 0, pid: 444 });
    await expect(waitForNeovimExit(exitedChild, 10)).resolves.toBeUndefined();

    const hangingChild = fakeChild({ pid: 555 });
    await expect(waitForNeovimExit(hangingChild, 1)).resolves.toBeUndefined();
    expect(hangingChild.kill).toHaveBeenCalledWith("SIGKILL");

    const delayedExitChild = fakeChild({ pid: 556 });
    const forceKillObserved = controlled<void>();
    delayedExitChild.kill = vi.fn(() => {
      delayedExitChild.killed = true;
      forceKillObserved.resolve();
      return true;
    });
    let waitResolved = false;
    const delayedExitWait = waitForNeovimExit(delayedExitChild, 1).then(() => {
      waitResolved = true;
    });
    await forceKillObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waitResolved).toBe(false);
    delayedExitChild.signalCode = "SIGKILL";
    delayedExitChild.emit("exit");
    await delayedExitWait;

    const unkillableChild = fakeChild({ pid: 557 });
    unkillableChild.kill = vi.fn(() => true);
    await expect(waitForNeovimExit(unkillableChild, 1)).rejects.toThrow(
      "Neovim process 557 did not exit after SIGKILL",
    );
  });

  it("guards closed embedded sessions and keeps cleanup idempotent", async () => {
    mockMissingProcessGroups();
    const child = fakeChild({ exitCode: 0, pid: 777 });
    const handle = {
      child,
      pid: 777,
      kill: vi.fn(),
    };
    const rpc = {
      request: vi.fn(async (method: string, args: readonly any[]) => {
        if (method === "nvim_buf_get_option") return true;
        return args[0] ?? true;
      }),
      close: vi.fn(),
    };
    const ui = {
      resize: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const session = new EmbeddedNeovimSession(handle as any, rpc as any, ui as any, 5);

    await session.input("");
    await session.input("i");
    await session.paste("");
    await session.paste("text");
    await session.resize({ rows: 2, columns: 3 });
    await session.focus(true);
    await session.click(2.9, 4.2);
    await expect(session.save(false)).resolves.toBe(true);
    await expect(session.isDirty()).resolves.toBe(true);
    await expect(session.quit(false)).resolves.toMatchObject({ closed: false });

    await Promise.all([session.cleanup(), session.cleanup()]);
    await session.input("x");
    await session.paste("x");
    await session.resize({ rows: 4, columns: 5 });
    await session.focus(false);
    await session.click(1, 1);
    await expect(session.save(true)).resolves.toBe(false);
    await expect(session.isDirty()).resolves.toBe(false);
    await expect(session.quit(true)).resolves.toEqual({ closed: true });

    expect(ui.dispose).toHaveBeenCalledTimes(1);
    expect(rpc.request).toHaveBeenCalledWith("nvim_input_mouse", ["left", "press", "", 0, 2, 4]);
    expect(rpc.request).toHaveBeenCalledWith("nvim_input_mouse", ["left", "release", "", 0, 2, 4]);
    expect(rpc.request.mock.calls.filter((call) => call[0] === "nvim_command" && call[1]?.[0] === "qa!")).toHaveLength(1);
    expect(rpc.close).toHaveBeenCalledWith("session cleanup");
    expect(handle.kill).toHaveBeenCalledWith("SIGKILL");

    const cleanChild = fakeChild({ exitCode: 0, pid: 778 });
    const cleanHandle = {
      child: cleanChild,
      pid: 778,
      kill: vi.fn(),
    };
    const cleanRpc = {
      request: vi.fn(async (method: string) => method === "nvim_buf_get_option" ? false : true),
      close: vi.fn(),
    };
    const cleanSession = new EmbeddedNeovimSession(cleanHandle as any, cleanRpc as any, ui as any, 5);
    await expect(cleanSession.quit(false)).resolves.toEqual({ closed: true });
    expect(cleanRpc.request).toHaveBeenCalledWith("nvim_command", ["quit"]);

    const racedChild = fakeChild({ pid: 783 });
    const racedHandle = {
      child: racedChild,
      pid: 783,
      kill: vi.fn(),
    };
    const racedRpc = {
      request: vi.fn(async (method: string, args: readonly any[]) => {
        if (method === "nvim_buf_get_option") return false;
        if (method === "nvim_command" && args[0] === "quit") {
          throw new Error("E37: No write since last change");
        }
        return true;
      }),
      close: vi.fn(),
    };
    const racedSession = new EmbeddedNeovimSession(racedHandle as any, racedRpc as any, ui as any, 5);
    await expect(racedSession.quit(false)).resolves.toEqual({
      closed: false,
      reason: "Unsaved Neovim edits. Save or use force quit before closing BUFFER.",
    });
    expect(racedHandle.kill).not.toHaveBeenCalled();
    expect(racedRpc.close).not.toHaveBeenCalled();
    await expect(racedSession.quit(true)).resolves.toEqual({ closed: true });

    const dirtyGate = controlled<boolean>();
    const concurrentChild = fakeChild({ exitCode: 0, pid: 780 });
    const concurrentHandle = {
      child: concurrentChild,
      pid: 780,
      kill: vi.fn(),
    };
    const concurrentRpc = {
      request: vi.fn(async (method: string) => method === "nvim_buf_get_option" ? dirtyGate.promise : true),
      close: vi.fn(),
    };
    const concurrentSession = new EmbeddedNeovimSession(concurrentHandle as any, concurrentRpc as any, ui as any, 5);
    const firstCleanClose = concurrentSession.quit(false);
    const secondCleanClose = concurrentSession.quit(false);
    expect(concurrentRpc.request).toHaveBeenCalledTimes(1);
    dirtyGate.resolve(false);
    await expect(Promise.all([firstCleanClose, secondCleanClose])).resolves.toEqual([{ closed: true }, { closed: true }]);
    expect(concurrentRpc.request.mock.calls.filter((call) => call[0] === "nvim_command" && call[1]?.[0] === "quit")).toHaveLength(1);

    const dirtyDiscardGate = controlled<boolean>();
    const dirtyDiscardChild = fakeChild({ exitCode: 0, pid: 781 });
    const dirtyDiscardHandle = {
      child: dirtyDiscardChild,
      pid: 781,
      kill: vi.fn(),
    };
    const dirtyDiscardRpc = {
      request: vi.fn(async (method: string) => method === "nvim_buf_get_option" ? dirtyDiscardGate.promise : true),
      close: vi.fn(),
    };
    const dirtyDiscardSession = new EmbeddedNeovimSession(dirtyDiscardHandle as any, dirtyDiscardRpc as any, ui as any, 5);
    const blockedDirtyClose = dirtyDiscardSession.quit(false);
    const forcedDirtyClose = dirtyDiscardSession.quit(true);
    expect(dirtyDiscardRpc.request).toHaveBeenCalledTimes(1);
    dirtyDiscardGate.resolve(true);
    await expect(Promise.all([blockedDirtyClose, forcedDirtyClose])).resolves.toEqual([
      { closed: false, reason: "Unsaved Neovim edits. Save or use force quit before closing BUFFER." },
      { closed: true },
    ]);
    expect(dirtyDiscardRpc.request.mock.calls.filter((call) => call[0] === "nvim_command" && call[1]?.[0] === "quit!")).toHaveLength(1);

    const closeChild = fakeChild({ exitCode: 0, pid: 779 });
    const closeHandle = {
      child: closeChild,
      pid: 779,
      kill: vi.fn(),
    };
    const closeRpc = {
      request: vi.fn(async () => true),
      close: vi.fn(),
    };
    const closeSession = new EmbeddedNeovimSession(closeHandle as any, closeRpc as any, ui as any, 5);
    await Promise.all([closeSession.quit(true), closeSession.quit(true)]);
    expect(closeRpc.request.mock.calls.filter((call) => call[0] === "nvim_command" && call[1]?.[0] === "quit!")).toHaveLength(1);

    const unkillableChild = fakeChild({ pid: 782 });
    unkillableChild.kill = vi.fn(() => true);
    const unkillableHandle = {
      child: unkillableChild,
      pid: 782,
      kill: vi.fn(),
    };
    const unkillableRpc = {
      request: vi.fn(async () => true),
      close: vi.fn(),
    };
    const unkillableSession = new EmbeddedNeovimSession(
      unkillableHandle as any,
      unkillableRpc as any,
      ui as any,
      1,
    );
    await expect(unkillableSession.cleanup()).rejects.toThrow(
      "Neovim process 782 did not exit after SIGKILL",
    );
    expect(unkillableRpc.close).toHaveBeenCalledWith("session cleanup");
    expect(unkillableHandle.kill).toHaveBeenCalledWith("SIGKILL");

    await expect(unkillableSession.quit(true)).rejects.toThrow(
      "Neovim process 782 did not exit after SIGKILL",
    );
    unkillableChild.exitCode = 0;
    await expect(unkillableSession.quit(true)).resolves.toEqual({ closed: true });
  });

  it("maps embedded dirty notifications to boolean dirty state", () => {
    expect(dirtyFlagFromRpcNotificationParams([true])).toBe(true);
    expect(dirtyFlagFromRpcNotificationParams([false])).toBe(false);
    expect(dirtyFlagFromRpcNotificationParams(["true"])).toBe(false);
    expect(dirtyFlagFromRpcNotificationParams([])).toBe(false);
  });

  it("reports stderr from a child that exits during startup", async () => {
    const errors: string[] = [];

    await expect(startEmbeddedNeovim({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('startup boom'); process.exit(1)"],
      filePath: join(dir, "target.txt"),
      line: 1,
      column: 0,
      size: { rows: 2, columns: 10 },
      onSnapshot: () => {},
      onError: (error) => {
        errors.push(error.message);
      },
      onExit: () => {},
    })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toContain("startup boom");
  });

  it("does not track a child whose executable fails to spawn", async () => {
    const trackedBefore = getTrackedNeovimProcessCountForTesting();
    const handle = spawnNeovimProcess({
      executable: join(dir, "guaranteed-missing-neovim"),
      args: [],
      cwd: dir,
    });
    const spawnError = new Promise<Error>((resolve) => {
      handle.child.once("error", resolve);
    });

    await expect(waitForNeovimExit(handle.child, 10)).resolves.toBeUndefined();
    await expect(spawnError).resolves.toMatchObject({ code: "ENOENT" });
    expect(handle.pid).toBe(0);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(trackedBefore);
  });

  it("kills a live child when startup setup rejects after spawn", async () => {
    const frame = Buffer.from(encode([1, 1, "attach failed", null])).toString("base64");
    const pidFile = join(dir, "child.pid");
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `process.stdout.write(Buffer.from("${frame}", "base64"));`,
      "setInterval(() => {}, 1000);",
    ].join("");

    await expect(startEmbeddedNeovim({
      executable: process.execPath,
      args: ["-e", script],
      filePath: join(dir, "target.txt"),
      line: 1,
      column: 0,
      size: { rows: 2, columns: 10 },
      cleanupTimeoutMs: 20,
      onSnapshot: () => {},
      onError: () => {},
      onExit: () => {},
    })).rejects.toThrow("attach failed");

    const pid = Number(await readFile(pidFile, "utf8"));
    await waitUntilDead(pid);
    expect(isProcessAlive(pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "preserves startup and cleanup failures in an AggregateError",
    async () => {
      const frame = Buffer.from(encode([1, 1, "attach failed", null])).toString("base64");
      const pidFile = join(dir, "aggregate-child.pid");
      const script = [
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.stdout.write(Buffer.from("${frame}", "base64"));`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const realProcessKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0 && signal === "SIGKILL") return true;
        return realProcessKill(pid, signal);
      });
      let pid = 0;

      try {
        const failure = await startEmbeddedNeovim({
          executable: process.execPath,
          args: ["-e", script],
          filePath: join(dir, "target.txt"),
          line: 1,
          column: 0,
          size: { rows: 2, columns: 10 },
          cleanupTimeoutMs: 5,
          onSnapshot: () => {},
          onError: () => {},
          onExit: () => {},
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({
          message: expect.stringContaining("Neovim startup cleanup failed"),
        });
        const errors = (failure as AggregateError).errors;
        expect(errors).toHaveLength(2);
        expect(String(errors[0])).toContain("attach failed");
        expect(errors[1]).toBeInstanceOf(Error);
        expect(String(errors[1])).toContain("did not exit after SIGKILL");
      } finally {
        killSpy.mockRestore();
        pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (pid > 0) {
          try {
            realProcessKill(-pid, "SIGKILL");
          } catch {
            // The supervised process group already exited.
          }
          await waitUntilDead(pid);
        }
      }

      expect(isProcessAlive(pid)).toBe(false);
      expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
    },
  );

  it("kills a supervised child process group during cleanup", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
    });

    handle.kill("SIGTERM");
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "cleans tracked descendants when a detached Neovim leader exits",
    async () => {
      const descendantPidFile = join(dir, "descendant.pid");
      const descendantScript = "setInterval(() => {}, 1000)";
      const leaderScript = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("");
      const handle = spawnNeovimProcess({
        executable: process.execPath,
        args: ["-e", leaderScript],
        cwd: dir,
      });

      let descendantPid = 0;
      try {
        await waitForNeovimExit(handle.child, 500);
        descendantPid = Number(await readFile(descendantPidFile, "utf8"));

        cleanupTrackedNeovimProcesses("SIGKILL");
        await waitUntilDead(descendantPid);

        expect(isProcessAlive(descendantPid)).toBe(false);
        expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
      } finally {
        try {
          process.kill(-handle.pid, "SIGKILL");
        } catch {
          // The process group is already gone after successful cleanup.
        }
      }
    },
  );

  it("parent cleanup kills tracked Neovim children when graceful paths are unavailable", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd: dir,
    });

    expect(getTrackedNeovimProcessCountForTesting()).toBeGreaterThan(0);
    cleanupTrackedNeovimProcesses("SIGTERM");
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("runs the registered process-exit cleanup path for tracked children", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd: dir,
    });

    expect(getTrackedNeovimProcessCountForTesting()).toBeGreaterThan(0);
    runTrackedNeovimProcessExitCleanupForTesting();
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("honors direct SIGKILL cleanup without a second graceful pass", async () => {
    const handle = spawnNeovimProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: dir,
    });

    expect(getTrackedNeovimProcessCountForTesting()).toBeGreaterThan(0);
    cleanupTrackedNeovimProcesses("SIGKILL");
    await waitForNeovimExit(handle.child, 500);

    expect(isProcessAlive(handle.pid)).toBe(false);
    expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
  });

  it("opens Neovim, refuses dirty quit, and force cleans the child", async () => {
    const discovery = await discoverNeovim({ timeoutMs: 1000 });
    if (!discovery.usable) {
      expect(discovery.reason).toContain("Embedded Neovim is unavailable");
      return;
    }
    const filePath = join(dir, "target.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const snapshots: string[][] = [];
    const dirtyChanges: boolean[] = [];

    const session = await startEmbeddedNeovim({
      executable: discovery.executable,
      args: discovery.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 21, columns: 116 },
      onSnapshot: (snapshot) => {
        snapshots.push([...snapshot.lines]);
      },
      onDirtyChange: (dirty) => {
        dirtyChanges.push(dirty);
      },
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    await session.input("ibeta");
    await session.paste(" gamma");
    await session.resize({ rows: 4, columns: 24 });
    await session.focus(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(session.isDirty()).resolves.toBe(true);
    const dirtyQuit = await session.quit(false);
    expect(dirtyQuit).toMatchObject({ closed: false });

    await expect(session.save(true)).resolves.toBe(true);
    await expect(session.isDirty()).resolves.toBe(false);
    expect(await readFile(filePath, "utf8")).toContain("beta gamma");
    expect(dirtyChanges).toContain(false);
    await session.input("omore");
    await session.quit(true);
    await session.cleanup();

    expect(snapshots.length).toBeGreaterThan(0);
    expect(await readFile(filePath, "utf8")).not.toContain("more");
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("reports visible grid highlight cells for visual selections", async () => {
    const discovery = await discoverNeovim({ timeoutMs: 1000, useUserInit: false });
    if (!discovery.usable) {
      expect(discovery.reason).toContain("Embedded Neovim is unavailable");
      return;
    }
    const filePath = join(dir, "target.txt");
    await writeFile(filePath, "alpha beta gamma\nsecond line\n", "utf8");
    const snapshots: NeovimRenderSnapshot[] = [];

    const session = await startEmbeddedNeovim({
      executable: discovery.executable,
      args: discovery.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 8, columns: 40 },
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });

    try {
      await session.input("gg0");
      await waitForSnapshot(snapshots, (snapshot) => snapshot.cursor.row === 0 && snapshot.cursor.column === 0);
      await session.input("v$");
      const visual = await waitForSnapshot(snapshots, (snapshot) => snapshot.mode.startsWith("visual"));
      const highlightsById = new Map(visual.highlights.map((highlight) => [highlight.id, highlight.attributes]));
      const selectedCells = visual.cells[0]?.filter((cell) => {
        const attributes = highlightsById.get(cell.highlightId);
        return attributes?.reverse === true || typeof attributes?.background === "number";
      }) ?? [];

      expect(visual.lines[0]).toContain("alpha beta gamma");
      expect(selectedCells.length).toBeGreaterThan(0);
    } finally {
      await session.quit(true);
      await session.cleanup();
    }
  });
});

function fakeChild(options: {
  readonly killed?: boolean;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}) {
  const child = new EventEmitter() as any;
  child.killed = options.killed ?? false;
  child.pid = options.pid;
  child.exitCode = options.exitCode ?? null;
  child.signalCode = options.signalCode ?? null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = true;
    child.signalCode = signal ?? "SIGTERM";
    child.emit("exit");
    return true;
  });
  child.stdin = {
    end: vi.fn(),
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controlled<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForSnapshot<T>(
  snapshots: readonly T[],
  predicate: (snapshot: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 1500;
  let last = snapshots.at(-1);
  while (Date.now() < deadline) {
    const match = snapshots.findLast(predicate);
    if (match) return match;
    last = snapshots.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for embedded Neovim snapshot; last=${JSON.stringify(last)}`);
}

function mockMissingProcessGroups(): void {
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid < 0) {
      throw Object.assign(new Error(`process group ${-pid} does not exist`), { code: "ESRCH" });
    }
    return true;
  });
}
