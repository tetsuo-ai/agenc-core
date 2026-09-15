import { afterEach, describe, expect, test, vi } from "vitest";
import { watchExecutionSkillRoots } from "../../src/skills/execution-watcher.js";
import { createSkillChangeDetector } from "../../src/skills/change-detector.js";
import { ExecutionEnvironmentError } from "../../src/execution/types.js";
import { TaskFiles } from "./task-files-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

describe("protected skill watch", () => {
  test("detects creation, replacement, deletion and dynamic roots without overlapping polls", async () => {
    vi.useFakeTimers();
    const files = new TaskFiles(); files.put("/app", "", true);
    const roots = ["/app/.agenc/skills"], changed = vi.fn(), failed = vi.fn();
    const watcher = await watchExecutionSkillRoots({ environment: files.environment(), getRoots: () => roots, changed, failed, intervalMs: 10 });
    cleanups.push(() => watcher.close());
    files.put("/app/.agenc/skills/one/SKILL.md", "one");
    await vi.advanceTimersByTimeAsync(10);
    expect(changed.mock.lastCall?.[0]).toContain("/app/.agenc/skills/one/SKILL.md");
    files.put("/app/.agenc/skills/one/SKILL.md", "new");
    await vi.advanceTimersByTimeAsync(10);
    expect(changed.mock.lastCall?.[0]).toContain("/app/.agenc/skills/one/SKILL.md");
    files.entries.delete("/app/.agenc/skills/one/SKILL.md");
    await vi.advanceTimersByTimeAsync(10);
    expect(changed.mock.lastCall?.[0]).toContain("/app/.agenc/skills/one/SKILL.md");
    roots.push("/app/nested/.agents/skills"); files.put(roots[1] + "/two/SKILL.md", "two");
    await vi.advanceTimersByTimeAsync(10);
    expect(changed.mock.lastCall?.[0]).toContain(roots[1] + "/two/SKILL.md");
    await watcher.close();
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });

  test("retries a parent swap without publishing a partial snapshot, then reports death once", async () => {
    vi.useFakeTimers();
    const files = new TaskFiles(); files.put("/app/SKILL.md", "one");
    const changed = vi.fn(), failed = vi.fn();
    const watcher = await watchExecutionSkillRoots({ environment: files.environment(), getRoots: () => ["/app"], changed, failed, intervalMs: 10 });
    cleanups.push(() => watcher.close());
    files.beforeDirectoryBind = (path) => files.put(path, "", true);
    await vi.advanceTimersByTimeAsync(20);
    expect(changed).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    files.beforeDirectoryBind = undefined;
    await vi.advanceTimersByTimeAsync(10);
    expect(changed).toHaveBeenCalledOnce();
    files.unavailable = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "environment_dead" }));
  });

  test("retains a throwing failure reporter without an unhandled background rejection", async () => {
    vi.useFakeTimers();
    const files = new TaskFiles(); files.put("/app", "", true);
    const reportError = new Error("reporter failed");
    const watcher = await watchExecutionSkillRoots({ environment: files.environment(), getRoots: () => ["/app"], changed: () => {},
      failed: () => { throw reportError; }, intervalMs: 10 });
    files.unavailable = true;
    await vi.advanceTimersByTimeAsync(20);
    await expect(watcher.close()).rejects.toMatchObject({ errors: [expect.objectContaining({ code: "environment_dead" }), reportError] });
  });
});

describe("skill subscription lifecycle", () => {
  test("disposal fences pending setup and waits for its returned subscription to close", async () => {
    vi.useFakeTimers();
    const detector = createSkillChangeDetector(), closeGate = Promise.withResolvers<void>();
    const subscription = Promise.withResolvers<{ close(): Promise<void> }>();
    let changed!: (paths: readonly string[]) => void;
    const onReload = vi.fn(), closed = vi.fn(async () => closeGate.promise);
    const starting = detector.initialize({ getWatchRoots: async () => [], runConfigChangeHooks: false, clearRuntimeCaches: false,
      onReload, subscribeChanges: async (emit) => { changed = emit; return subscription.promise; } });
    await Promise.resolve();
    let stopped = false;
    const stopping = detector.dispose().then(() => { stopped = true; });
    subscription.resolve({ close: closed });
    await vi.advanceTimersByTimeAsync(10);
    expect(closed).toHaveBeenCalledOnce(); expect(stopped).toBe(false);
    changed(["/app/SKILL.md"]);
    closeGate.resolve();
    await Promise.all([starting, stopping]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onReload).not.toHaveBeenCalled(); expect(stopped).toBe(true);
  });

  test("retries rejected subscription setup and ignores events from an old generation", async () => {
    vi.useFakeTimers();
    const detector = createSkillChangeDetector(), onReload = vi.fn();
    cleanups.push(() => detector.dispose());
    const callbacks: ((paths: readonly string[]) => void)[] = [];
    const subscribeChanges = vi.fn(async (emit: (paths: readonly string[]) => void) => {
      callbacks.push(emit);
      if (callbacks.length === 1) throw new Error("subscription failed");
      return { close: async () => {} };
    });
    const options = { getWatchRoots: async () => [], runConfigChangeHooks: false, clearRuntimeCaches: false,
      onReload, subscribeChanges, debounceMs: 1 };
    await expect(detector.initialize(options)).rejects.toThrow("subscription failed");
    callbacks[0](["/failed-setup/SKILL.md"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(onReload).not.toHaveBeenCalled();
    await detector.initialize(options);
    callbacks[0](["/old/SKILL.md"]); callbacks[1](["/new/SKILL.md"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(onReload).toHaveBeenCalledExactlyOnceWith({ changedPaths: ["/new/SKILL.md"] });
    await detector.dispose();
    await detector.initialize(options);
    callbacks[1](["/stale/SKILL.md"]); callbacks[2](["/current/SKILL.md"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(onReload.mock.lastCall?.[0]).toEqual({ changedPaths: ["/current/SKILL.md"] });
  });

  test("records hook authority failure and fences completion after disposal", async () => {
    vi.useFakeTimers();
    const detector = createSkillChangeDetector(), hooks = Promise.withResolvers<readonly unknown[]>();
    cleanups.push(() => detector.dispose());
    let changed!: (paths: readonly string[]) => void;
    const onReload = vi.fn(), listener = vi.fn(), failure = new ExecutionEnvironmentError("authority_revoked", "Revoked", false);
    const base = { getWatchRoots: async () => [], clearRuntimeCaches: false, onReload, debounceMs: 1,
      subscribeChanges: async (emit: (paths: readonly string[]) => void) => { changed = emit; return { close() {} }; },
      hasBlockingResult: () => false };
    await detector.initialize({ ...base, executeConfigChangeHooks: async () => { throw failure; } });
    changed(["/app/SKILL.md"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(detector.getFailure?.()).toBe(failure); expect(onReload).not.toHaveBeenCalled();
    await detector.dispose();
    await detector.initialize({ ...base, executeConfigChangeHooks: () => hooks.promise });
    detector.subscribe(listener);
    changed(["/app/SKILL.md"]);
    await vi.advanceTimersByTimeAsync(10);
    await detector.dispose();
    hooks.resolve([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(listener).not.toHaveBeenCalled(); expect(onReload).not.toHaveBeenCalled();
  });
});
