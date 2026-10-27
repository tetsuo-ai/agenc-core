import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartupRestoreWait } from "../../src/app-server/startup-restore-progress.js";

afterEach(() => vi.useRealTimers());

describe("startup restore progress", () => {
  it("prints a plain line once and does not extend the deadline on repeated progress", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const timedOut = vi.fn();
    const wait = createStartupRestoreWait({ write, timedOut });
    expect(wait.update(193)).toBe("started");
    vi.advanceTimersByTime(119_000);
    expect(wait.update(10)).toBeUndefined();
    vi.advanceTimersByTime(1_000);
    expect(write.mock.calls).toEqual([["Reopening 193 sessions...\n"]]);
    expect(timedOut).toHaveBeenCalledOnce();
    expect(wait.update(193)).toBeUndefined();
  });

  it.each(["complete", "disconnect"])("cleans up on %s", mode => {
    vi.useFakeTimers();
    const write = vi.fn();
    const timedOut = vi.fn();
    const wait = createStartupRestoreWait({ write, timedOut });
    wait.update(1);
    expect(write).toHaveBeenCalledWith("Reopening 1 session...\n");
    if (mode === "complete") expect(wait.update(0)).toBe("finished");
    else wait.close();
    vi.advanceTimersByTime(180_000);
    expect(timedOut).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("has no timer or output for a new session that does not wait", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const wait = createStartupRestoreWait({ write, timedOut: vi.fn() });
    wait.close();
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
