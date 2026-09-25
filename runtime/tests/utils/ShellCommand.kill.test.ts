import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

import { wrapSpawn } from "../../src/utils/ShellCommand.js";
import { TaskOutput } from "../../src/utils/task/TaskOutput.js";

// ShellCommand.kill() used tree-kill, which spawns pgrep (darwin) or ps
// (linux) through PATH without an error listener and rethrows EPERM from any
// descendant. Either one was an uncaught exception in the daemon, and the
// tree kept running. These tests run a real detached shell with a background
// child. Only pids the test itself started are ever signalled.

const posixOnly = process.platform === "win32" ? test.skip : test;

interface ShellTree {
  readonly shell: ChildProcess;
  readonly shellPid: number;
  readonly descendantPid: number;
  readonly exited: Promise<void>;
}

const started: ShellTree[] = [];

async function startShellTree(): Promise<ShellTree> {
  // Detached like the bash provider's children, so the shell leads its own
  // process group and a group signal can never reach the test runner.
  const shell = spawn("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const shellPid = shell.pid;
  if (shellPid === undefined) throw new Error("test shell did not start");
  const exited = new Promise<void>((resolve) => {
    shell.once("exit", () => resolve());
  });
  const descendantPid = await new Promise<number>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error("test shell did not report its child")),
      5_000,
    );
    shell.stdout!.on("data", (chunk: Buffer | string) => {
      text += chunk.toString();
      const match = /^(\d+)\n/.exec(text);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  const tree = { shell, shellPid, descendantPid, exited };
  started.push(tree);
  return tree;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isRunning(pid);
}

async function exitsWithin(tree: ShellTree, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    tree.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

afterEach(() => {
  for (const tree of started.splice(0)) {
    for (const pid of [-tree.shellPid, tree.descendantPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

describe("ShellCommand kill", () => {
  posixOnly(
    "kills the whole tree when pgrep and ps are not on PATH",
    async () => {
      const tree = await startShellTree();
      const command = wrapSpawn(
        tree.shell,
        new AbortController().signal,
        undefined,
        new TaskOutput("shell-kill-no-ps", null),
      );
      const originalPath = process.env.PATH;
      // A container without procps, or the helper missing from PATH.
      process.env.PATH = "/nonexistent-agenc-test-bin";
      try {
        command.kill();
        expect(await exitsWithin(tree, 3_000)).toBe(true);
        expect(await waitUntilGone(tree.descendantPid, 3_000)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
      await expect(command.result).resolves.toMatchObject({ code: 137 });
      command.cleanup();
    },
    15_000,
  );

  posixOnly(
    "still kills the shell when one descendant refuses the signal",
    async () => {
      const tree = await startShellTree();
      const command = wrapSpawn(
        tree.shell,
        new AbortController().signal,
        undefined,
        new TaskOutput("shell-kill-eperm", null),
      );
      const realKill = process.kill.bind(process);
      // As for a root-owned descendant (sudo) or a pid another user reused.
      process.kill = ((pid: number, signal?: string | number) => {
        if (pid === tree.descendantPid && signal !== 0) {
          throw Object.assign(new Error("kill EPERM"), {
            code: "EPERM",
            syscall: "kill",
          });
        }
        return realKill(pid, signal);
      }) as typeof process.kill;
      try {
        command.kill();
        expect(await exitsWithin(tree, 3_000)).toBe(true);
      } finally {
        process.kill = realKill;
      }
      await expect(command.result).resolves.toMatchObject({ code: 137 });
      command.cleanup();
    },
    15_000,
  );
});
