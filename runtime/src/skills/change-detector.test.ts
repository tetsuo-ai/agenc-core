import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FileWatcher,
  type FileWatcherWatchFactory,
} from "../file-watcher/index.js";
import {
  createSkillChangeDetector,
  type SkillChangeDetector,
} from "./change-detector.js";

const runtimeCacheCalls = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock("../commands.js", () => ({
  clearCommandsCache: vi.fn(() => {
    runtimeCacheCalls.calls.push("commands");
  }),
}));

vi.mock("../utils/attachments.js", () => ({
  resetSentSkillNames: vi.fn(() => {
    runtimeCacheCalls.calls.push("attachments");
  }),
}));

const tempDirs: string[] = [];
let detector: SkillChangeDetector;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-skill-watch-"));
  tempDirs.push(dir);
  return dir;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.useFakeTimers();
  runtimeCacheCalls.calls.length = 0;
  detector = createSkillChangeDetector();
});

afterEach(async () => {
  await detector.dispose();
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe("skill change detector", () => {
  it("watches skill roots through FileWatcher and debounces reload events", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const onReload = vi.fn();
    const listener = vi.fn();
    const executeConfigChangeHooks = vi.fn(async () => []);
    const hasBlockingResult = vi.fn(() => false);
    const changedFile = join(root, "repo-docs", "SKILL.md");
    const changedCommand = join(root, "commands", "review.md");

    detector.subscribe(listener);
    await detector.initialize({
      fileWatcher: watcher,
      getWatchRoots: async () => [root],
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      executeConfigChangeHooks,
      hasBlockingResult,
    });

    expect(watcher.watchCountsForTest(root)).toMatchObject({ recursive: 1 });

    await watcher.sendPathsForTest([changedCommand, changedFile, changedFile]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledWith({
      changedPaths: [changedCommand, changedFile],
    });
    expect(listener).toHaveBeenCalledWith({
      changedPaths: [changedCommand, changedFile],
    });
  });

  it("can restart after disposal and receive fresh events", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const onReload = vi.fn();
    const changedFile = join(root, "repo-docs", "SKILL.md");
    const options = {
      fileWatcher: watcher,
      getWatchRoots: async () => [root],
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      runConfigChangeHooks: false,
    };

    await detector.initialize(options);
    expect(watcher.watchCountsForTest(root)).toMatchObject({ recursive: 1 });
    await detector.dispose();
    expect(watcher.watchCountsForTest(root)).toBeNull();

    await detector.initialize(options);
    expect(watcher.watchCountsForTest(root)).toMatchObject({ recursive: 1 });
    await watcher.sendPathsForTest([changedFile]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(onReload).toHaveBeenCalledWith({ changedPaths: [changedFile] });
  });

  it("can retry initialization after watch-root discovery fails", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const onReload = vi.fn();
    const changedFile = join(root, "repo-docs", "SKILL.md");
    const getWatchRoots = vi.fn()
      .mockRejectedValueOnce(new Error("root discovery failed"))
      .mockResolvedValueOnce([root]);
    const options = {
      fileWatcher: watcher,
      getWatchRoots,
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      runConfigChangeHooks: false,
    };

    await expect(detector.initialize(options)).rejects.toThrow(
      "root discovery failed",
    );
    expect(watcher.watchCountsForTest(root)).toBeNull();

    await detector.initialize(options);
    expect(watcher.watchCountsForTest(root)).toMatchObject({ recursive: 1 });
    await watcher.sendPathsForTest([changedFile]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(onReload).toHaveBeenCalledWith({ changedPaths: [changedFile] });
  });

  it("registers missing roots through FileWatcher ancestor fallback", async () => {
    const root = tempDir();
    const missingSkillRoot = join(root, ".agenc", "skills");
    const changedFile = join(missingSkillRoot, "late", "SKILL.md");
    const createdWatchers: FakeFsWatcher[] = [];
    const watchFactory: FileWatcherWatchFactory = (_target, _options, _listener) => {
      const watcher = new FakeFsWatcher();
      createdWatchers.push(watcher);
      return watcher as unknown as FSWatcher;
    };
    const watcher = FileWatcher.create({ watch: watchFactory });
    const onReload = vi.fn();

    await detector.initialize({
      fileWatcher: watcher,
      getWatchRoots: async () => [missingSkillRoot],
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      runConfigChangeHooks: false,
    });

    expect(watcher.watchCountsForTest(root)).toEqual({
      nonRecursive: 1,
      recursive: 0,
    });
    expect(watcher.watchCountsForTest(missingSkillRoot)).toBeNull();
    expect(createdWatchers).toHaveLength(1);

    await watcher.sendPathsForTest([changedFile]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(onReload).toHaveBeenCalledWith({ changedPaths: [changedFile] });
    watcher.close();
  });

  it("skips reload when config-change hooks block the batch", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const onReload = vi.fn();
    const listener = vi.fn();
    const changedFile = join(root, "repo-docs", "SKILL.md");
    const executeConfigChangeHooks = vi.fn(async () => [{ decision: "block" }]);
    const hasBlockingResult = vi.fn(() => true);

    detector.subscribe(listener);
    await detector.initialize({
      fileWatcher: watcher,
      getWatchRoots: async () => [root],
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      executeConfigChangeHooks,
      hasBlockingResult,
    });

    await watcher.sendPathsForTest([changedFile]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(executeConfigChangeHooks).toHaveBeenCalledWith("skills", changedFile);
    expect(onReload).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("uses the first observed changed path as the hook representative", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const onReload = vi.fn();
    const executeConfigChangeHooks = vi.fn(async () => []);
    const hasBlockingResult = vi.fn(() => false);
    const firstObserved = join(root, "z-later", "SKILL.md");
    const secondObserved = join(root, "a-earlier", "SKILL.md");

    await detector.initialize({
      fileWatcher: watcher,
      getWatchRoots: async () => [root],
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      executeConfigChangeHooks,
      hasBlockingResult,
    });

    await watcher.sendPathsForTest([firstObserved]);
    await flushPromises();
    await watcher.sendPathsForTest([secondObserved]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(executeConfigChangeHooks).toHaveBeenCalledWith(
      "skills",
      firstObserved,
    );
    expect(onReload).toHaveBeenCalledWith({
      changedPaths: [secondObserved, firstObserved],
    });
  });

  it("clears runtime caches before notifying subscribers by default", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const listener = vi.fn(() => {
      runtimeCacheCalls.calls.push("listener");
    });
    const changedFile = join(root, "repo-docs", "SKILL.md");

    detector.subscribe(listener);
    await detector.initialize({
      fileWatcher: watcher,
      getWatchRoots: async () => [root],
      onReload: () => {
        runtimeCacheCalls.calls.push("reload");
      },
      debounceMs: 10,
      runConfigChangeHooks: false,
    });

    await watcher.sendPathsForTest([changedFile]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(runtimeCacheCalls.calls).toEqual([
      "reload",
      "attachments",
      "commands",
      "listener",
    ]);
  });

  it("ignores git metadata and stops receiving after dispose", async () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"), { recursive: true });
    const watcher = FileWatcher.noop();
    const onReload = vi.fn();

    await detector.initialize({
      fileWatcher: watcher,
      getWatchRoots: async () => [root],
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      runConfigChangeHooks: false,
    });

    await watcher.sendPathsForTest([join(root, ".git", "config")]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    expect(onReload).not.toHaveBeenCalled();

    await detector.dispose();
    await watcher.sendPathsForTest([join(root, "repo-docs", "SKILL.md")]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();

    expect(onReload).not.toHaveBeenCalled();
  });

  it("does not emit when disposed during an in-flight hook", async () => {
    const root = tempDir();
    const watcher = FileWatcher.noop();
    const onReload = vi.fn();
    const listener = vi.fn();
    const changedFile = join(root, "repo-docs", "SKILL.md");
    let resolveHook: ((results: readonly unknown[]) => void) | null = null;
    const executeConfigChangeHooks = vi.fn(
      () => new Promise<readonly unknown[]>((resolve) => {
        resolveHook = resolve;
      }),
    );
    const hasBlockingResult = vi.fn(() => false);

    detector.subscribe(listener);
    await detector.initialize({
      fileWatcher: watcher,
      getWatchRoots: async () => [root],
      onReload,
      debounceMs: 10,
      clearRuntimeCaches: false,
      executeConfigChangeHooks,
      hasBlockingResult,
    });

    await watcher.sendPathsForTest([changedFile]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10);
    await flushPromises();
    expect(executeConfigChangeHooks).toHaveBeenCalledWith("skills", changedFile);

    await detector.dispose();
    resolveHook?.([]);
    await flushPromises();

    expect(onReload).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});

class FakeFsWatcher extends EventEmitter {
  close(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}
