import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
}));

import { openUrlInBrowser } from "../../src/commands/auth.js";

describe("OAuth browser opener", () => {
  let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("DISPLAY", ":99");
    child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReset().mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("waits for the launcher result instead of treating spawn as success", async () => {
    let settled = false;
    const opened = openUrlInBrowser("https://example.test/authorize").finally(() => {
      settled = true;
    });
    child.emit("spawn");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("exit", 0, null);
    await expect(opened).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("reports an early nonzero exit without including the authorization URL", async () => {
    const opened = openUrlInBrowser("https://example.test/authorize?state=private-state");
    const rejected = expect(opened).rejects.toThrow(/exit code 3/);
    child.emit("spawn");
    child.emit("exit", 3, null);
    await rejected;
    await expect(opened).rejects.not.toThrow("private-state");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("reports signal termination", async () => {
    const opened = openUrlInBrowser("https://example.test/authorize");
    const rejected = expect(opened).rejects.toThrow(/signal SIGTERM/);
    child.emit("spawn");
    child.emit("exit", null, "SIGTERM");
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  test("rejects a missing launcher", async () => {
    const opened = openUrlInBrowser("https://example.test/authorize");
    const rejected = expect(opened).rejects.toThrow(/Open the displayed sign-in URL manually/);
    child.emit("error", new Error("spawn failed"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  test("bounds waiting for a launcher that stays open", async () => {
    const opened = openUrlInBrowser("https://example.test/authorize");
    const rejected = expect(opened).rejects.toThrow(/did not confirm/);
    child.emit("spawn");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(child.unref).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("passes one local desktop environment snapshot to the launcher", async () => {
    vi.stubEnv("HOME", "/tmp/local-browser-home");
    const opened = openUrlInBrowser("https://example.test/authorize");
    vi.stubEnv("DISPLAY", ":changed");
    vi.stubEnv("HOME", "/tmp/changed-browser-home");
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ DISPLAY: ":99", HOME: "/tmp/local-browser-home" }),
      }),
    );
    child.emit("spawn");
    child.emit("exit", 0, null);
    await expect(opened).resolves.toBeUndefined();
  });

  test.runIf(process.platform === "linux")("uses manual opening when no desktop or browser is configured", async () => {
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    vi.stubEnv("BROWSER", "");
    await expect(openUrlInBrowser("https://example.test/authorize")).rejects.toThrow(/Open the displayed sign-in URL manually/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  test.runIf(process.platform === "linux")("honors an explicitly configured browser without display variables", async () => {
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    vi.stubEnv("BROWSER", "configured-browser");
    const opened = openUrlInBrowser("https://example.test/authorize");
    child.emit("spawn");
    child.emit("exit", 0, null);
    await expect(opened).resolves.toBeUndefined();
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
});
