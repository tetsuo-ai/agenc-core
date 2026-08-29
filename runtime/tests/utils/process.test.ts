import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { registerProcessOutputErrorHandlers } from "../../src/utils/process.js";

function fakeOutputStream() {
  const stream = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
  };
  stream.destroy = vi.fn();
  return stream;
}

function brokenPipe(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EPIPE" });
}

describe("registerProcessOutputErrorHandlers", () => {
  it("shares one underlying listener and notifies each registration once", () => {
    const stdout = fakeOutputStream();
    const stderr = fakeOutputStream();
    const first = vi.fn();
    const second = vi.fn();
    const firstHandle = registerProcessOutputErrorHandlers(first, {
      stdout,
      stderr,
    });
    const secondHandle = registerProcessOutputErrorHandlers(second, {
      stdout,
      stderr,
    });

    expect(stdout.listenerCount("error")).toBe(1);
    expect(stderr.listenerCount("error")).toBe(1);

    const error = brokenPipe("stdout closed");
    stdout.emit("error", error);
    stderr.emit("error", brokenPipe("stderr also closed"));

    expect(stdout.destroy).toHaveBeenCalledOnce();
    expect(stderr.destroy).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith({ stream: "stdout", error });
    expect(second).toHaveBeenCalledOnce();

    firstHandle.dispose();
    secondHandle.dispose();
  });

  it("keeps the base listener for late EPIPE delivery after disposal", () => {
    const stdout = fakeOutputStream();
    const stderr = fakeOutputStream();
    const onBrokenPipe = vi.fn();
    const handle = registerProcessOutputErrorHandlers(onBrokenPipe, {
      stdout,
      stderr,
    });

    handle.dispose();
    expect(() => stdout.emit("error", brokenPipe("late write"))).not.toThrow();
    expect(stdout.destroy).toHaveBeenCalledOnce();
    expect(onBrokenPipe).not.toHaveBeenCalled();
    expect(stdout.listenerCount("error")).toBe(1);
  });

  it("rethrows non-EPIPE output errors", () => {
    const stdout = fakeOutputStream();
    const stderr = fakeOutputStream();
    const handle = registerProcessOutputErrorHandlers(vi.fn(), {
      stdout,
      stderr,
    });
    const error = Object.assign(new Error("unexpected stream failure"), {
      code: "EIO",
    });

    expect(() => stderr.emit("error", error)).toThrow(error);
    expect(stderr.destroy).not.toHaveBeenCalled();
    handle.dispose();
  });
});
