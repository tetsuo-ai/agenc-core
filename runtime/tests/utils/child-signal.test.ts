import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

import {
  isSignalablePid,
  stopChildOnAbort,
} from "../../src/utils/child-signal.js";
import { createFailedSpawnChild } from "../helpers/failed-spawn-child.js";

// Node's own spawn `signal` handler calls child.kill() on abort, even while a
// failed spawn is still waiting to report: that pid-less handle sends the
// kill to pid 0, the caller's whole process group. stopChildOnAbort replaces
// it. The children here are stand-ins; nothing is ever signalled.

/** A started child: a real-looking pid and a kill() spy. */
function startedChild(pid = 424_242): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

describe("isSignalablePid", () => {
  test.each([
    [424_242, true],
    [2, true],
    [1, false],
    [0, false],
    [-1, false],
    [-424_242, false],
    [2.5, false],
    [Number.NaN, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    [undefined, false],
    ["424242", false],
  ])("%s -> %s", (pid, expected) => {
    expect(isSignalablePid(pid)).toBe(expected);
  });
});

describe("stopChildOnAbort", () => {
  test("an abort in the same tick as a failed spawn signals nothing", async () => {
    const failed = createFailedSpawnChild({ code: "EAGAIN" });
    const errors: unknown[] = [];
    failed.on("error", (error) => errors.push(error));
    const controller = new AbortController();

    stopChildOnAbort(failed, controller.signal);
    controller.abort();
    await failed.reported;

    expect(failed.groupSignals).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "EAGAIN" });
  });

  test("an abort stops a started child and reports an AbortError", () => {
    const child = startedChild();
    const errors: unknown[] = [];
    child.on("error", (error) => errors.push(error));
    const controller = new AbortController();

    stopChildOnAbort(child, controller.signal);
    controller.abort("user stopped");

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith();
    expect(errors).toEqual([
      expect.objectContaining({
        name: "AbortError",
        code: "ABORT_ERR",
        cause: "user stopped",
      }),
    ]);
  });

  test.each([0, 1, -1])("never signals a child whose pid is %s", (pid) => {
    const child = startedChild(pid);
    child.on("error", () => {});
    const controller = new AbortController();

    stopChildOnAbort(child, controller.signal);
    controller.abort();

    expect(child.kill).not.toHaveBeenCalled();
  });

  test("the listener goes away when the child exits", () => {
    const child = startedChild();
    const controller = new AbortController();

    stopChildOnAbort(child, controller.signal);
    child.emit("exit", 0, null);
    controller.abort();

    expect(child.kill).not.toHaveBeenCalled();
  });
});
