import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

import { wrapSpawn } from "../../src/utils/ShellCommand.js";
import { TaskOutput } from "../../src/utils/task/TaskOutput.js";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: undefined,
    stdout: null,
    stderr: null,
  });
  return child;
}

describe("ShellCommand deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an omitted timeout does not invent a process deadline", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const command = wrapSpawn(
      child,
      new AbortController().signal,
      undefined,
      new TaskOutput("shell-no-deadline", null),
    );

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(command.status).toBe("running");

    child.emit("exit", 0, null);
    await expect(command.result).resolves.toMatchObject({
      code: 0,
      interrupted: false,
    });
    command.cleanup();
  });

  test("an explicit timeout remains opt-in and enforced", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const command = wrapSpawn(
      child,
      new AbortController().signal,
      1_000,
      new TaskOutput("shell-explicit-deadline", null),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(command.result).resolves.toMatchObject({
      code: 143,
      stderr: expect.stringContaining("Command timed out after"),
    });
    command.cleanup();
  });
});
