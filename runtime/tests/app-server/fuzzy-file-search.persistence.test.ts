import type { FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FuzzyIndexBuildCancelledError,
  PersistentFuzzyFileIndex,
  type FuzzyFileDiscoveryResult,
} from "../../src/app-server/fuzzy-file-index.js";
import {
  AgenCFuzzyFileSearchService,
  fuzzyAbsolutePathKey,
} from "../../src/app-server/fuzzy-file-search.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("daemon persistent fuzzy-file search", () => {
  test("deduplicates overlapping Windows roots with portable absolute bytes", () => {
    expect(
      fuzzyAbsolutePathKey(
        String.raw`C:\repo`,
        Buffer.from("sub/file.ts"),
        "win32",
      ),
    ).toBe(
      fuzzyAbsolutePathKey(
        String.raw`C:\repo\sub`,
        Buffer.from("file.ts"),
        "win32",
      ),
    );
    expect(
      fuzzyAbsolutePathKey(
        String.raw`/repo\literal`,
        Buffer.from("file.ts"),
        "linux",
      ),
    ).not.toBe(
      fuzzyAbsolutePathKey("/repo/literal", Buffer.from("file.ts"), "linux"),
    );
    expect(
      fuzzyAbsolutePathKey("/", Buffer.from("repo/file.ts"), "linux"),
    ).toBe(fuzzyAbsolutePathKey("/repo", Buffer.from("file.ts"), "linux"));
    expect(
      fuzzyAbsolutePathKey("C:\\", Buffer.from("repo/file.ts"), "win32"),
    ).toBe(
      fuzzyAbsolutePathKey(
        String.raw`C:\repo`,
        Buffer.from("file.ts"),
        "win32",
      ),
    );
  });

  test("uses a warm complete generation and atomically refreshes after a watcher event", async () => {
    const index = await temporaryIndex();
    let paths = ["src/alpha.ts"];
    const discover = vi.fn(async (): Promise<FuzzyFileDiscoveryResult> =>
      discovery(paths),
    );
    let signalChange = (): void => {};
    const watcher = { close: vi.fn() } as unknown as FSWatcher;
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover,
      watchRoot: (_root, onChange) => {
        signalChange = onChange;
        return watcher;
      },
      now: () => 2_000,
    });

    const first = await service.search({ query: "alpha", roots: ["/project"] });
    expect(first.files.map((file) => file.path)).toEqual(["src/alpha.ts"]);
    expect(first.freshness).toMatchObject({
      stale: false,
      degraded: false,
      roots: [
        expect.objectContaining({
          watcherStatus: "active",
          stale: false,
          ageMs: 0,
        }),
      ],
    });
    const firstGeneration = first.freshness?.roots[0]?.generationId;

    await service.search({ query: "alpha", roots: ["/project"] });
    expect(discover).toHaveBeenCalledTimes(1);

    paths = ["src/beta.ts"];
    signalChange();
    signalChange();
    signalChange();
    const whileDebouncing = await service.search({
      query: "alpha",
      roots: ["/project"],
    });
    expect(whileDebouncing.files.map((file) => file.path)).toEqual([
      "src/alpha.ts",
    ]);
    expect(whileDebouncing.freshness?.stale).toBe(true);
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    });
    let refreshed = await service.search({
      query: "beta",
      roots: ["/project"],
    });
    await vi.waitFor(async () => {
      refreshed = await service.search({ query: "beta", roots: ["/project"] });
      expect(refreshed.files.map((file) => file.path)).toEqual(["src/beta.ts"]);
    });
    expect(refreshed.files.map((file) => file.path)).toEqual(["src/beta.ts"]);
    expect(refreshed.freshness?.roots[0]?.generationId).toBeGreaterThan(
      firstGeneration ?? 0,
    );
    expect(discover).toHaveBeenCalledTimes(2);
    await service.close();
    expect(watcher.close).toHaveBeenCalledOnce();
    index.close();
  });

  test("reports watcher gaps as stale and refreshes only on an explicit audit", async () => {
    const database = await temporaryDatabasePath();
    const index = new PersistentFuzzyFileIndex({ databasePath: database });
    let paths = ["alpha.ts"];
    const discover = vi.fn(async () => discovery(paths));
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover,
      watchRoot: () => null,
    });

    const first = await service.search({ query: "alpha", roots: ["/project"] });
    expect(first.freshness).toMatchObject({
      stale: true,
      degraded: true,
      roots: [
        expect.objectContaining({
          watcherStatus: "unsupported",
          reason: "watcher_unavailable",
        }),
      ],
    });

    paths = ["beta.ts"];
    const stale = await service.search({ query: "beta", roots: ["/project"] });
    expect(stale.files).toEqual([]);
    expect(discover).toHaveBeenCalledTimes(1);

    const audited = await service.search({
      query: "beta",
      roots: ["/project"],
      refresh: true,
    });
    expect(audited.files.map((file) => file.path)).toEqual(["beta.ts"]);
    const generation = audited.freshness?.roots[0]?.generationId;
    expect(discover).toHaveBeenCalledTimes(2);
    await service.close();
    index.close();

    const restartedIndex = new PersistentFuzzyFileIndex({
      databasePath: database,
    });
    const restartedDiscover = vi.fn(async () => discovery(["wrong.ts"]));
    const restarted = new AgenCFuzzyFileSearchService({
      index: restartedIndex,
      discover: restartedDiscover,
      watchRoot: () => null,
    });
    const recovered = await restarted.search({
      query: "beta",
      roots: ["/project"],
    });
    expect(recovered.files.map((file) => file.path)).toEqual(["beta.ts"]);
    expect(recovered.freshness?.roots[0]?.generationId).toBe(generation);
    expect(recovered.freshness?.stale).toBe(true);
    expect(restartedDiscover).not.toHaveBeenCalled();
    await restarted.close();
    restartedIndex.close();
  });

  test("cancels a superseded build without publishing partial entries", async () => {
    const index = await temporaryIndex();
    let calls = 0;
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const discover = vi.fn(async (_root: string, signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new FuzzyIndexBuildCancelledError()),
            { once: true },
          );
        });
      }
      return discovery(["complete.ts"]);
    });
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover,
      watchRoot: () => null,
    });
    const first = service.search({
      query: "partial",
      roots: ["/project"],
      cancellationToken: "same",
    });
    await started;
    const second = service.search({
      query: "complete",
      roots: ["/project"],
      cancellationToken: "same",
    });

    await expect(first).resolves.toEqual({ files: [] });
    await expect(second).resolves.toMatchObject({
      files: [expect.objectContaining({ path: "complete.ts" })],
    });
    expect(index.readCurrent("/project")?.entries).toEqual([
      expect.objectContaining({ relativePath: "complete.ts" }),
    ]);
    await service.close();
    index.close();
  });

  test("coalesces concurrent initial builds for the same canonical root", async () => {
    const index = await temporaryIndex();
    let releaseDiscovery = (): void => {};
    const discoveryReleased = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discover = vi.fn(async () => {
      await discoveryReleased;
      return discovery(["shared.ts"]);
    });
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover,
      watchRoot: () => null,
    });

    const first = service.search({ query: "shared", roots: ["/project"] });
    const second = service.search({ query: "shared", roots: ["/project"] });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
    releaseDiscovery();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        files: [expect.objectContaining({ path: "shared.ts" })],
      }),
      expect.objectContaining({
        files: [expect.objectContaining({ path: "shared.ts" })],
      }),
    ]);
    await service.close();
    index.close();
  });

  test("maps bounded discovery refusal to a typed traversal error", async () => {
    const index = await temporaryIndex();
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover: async () => ({
        entries: [],
        truncated: true,
        directoryCoverage: "complete",
      }),
      watchRoot: () => null,
    });

    await expect(
      service.search({ query: "needle", roots: ["/project"] }),
    ).rejects.toMatchObject({ reason: "TRAVERSAL_LIMIT" });
    expect(index.readCurrent("/project")).toBeNull();
    await service.close();
    index.close();
  });

  test("aborts and settles active work before closing root watchers", async () => {
    const index = await temporaryIndex();
    let markDiscoveryStarted = (): void => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    const watcher = { close: vi.fn() } as unknown as FSWatcher;
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover: async (_root, signal) => {
        markDiscoveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new FuzzyIndexBuildCancelledError()),
            { once: true },
          );
        });
        return discovery([]);
      },
      watchRoot: () => watcher,
    });
    const search = service.search({ query: "needle", roots: ["/project"] });
    await discoveryStarted;

    const closing = service.close();
    expect(watcher.close).not.toHaveBeenCalled();
    await expect(search).resolves.toEqual({ files: [] });
    await closing;
    expect(watcher.close).toHaveBeenCalledOnce();
    await expect(
      service.search({ query: "needle", roots: ["/project"] }),
    ).rejects.toThrow("search service is closed");
    index.close();
  });

  test("bounds cached root watchers with inactive least-recently-used eviction", async () => {
    const index = await temporaryIndex();
    const watchers: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const service = new AgenCFuzzyFileSearchService({
      index,
      maximumRootStates: 2,
      discover: async () => discovery(["needle.ts"]),
      watchRoot: () => {
        const watcher = { close: vi.fn() };
        watchers.push(watcher);
        return watcher as unknown as FSWatcher;
      },
    });

    await service.search({ query: "needle", roots: ["/root-one"] });
    await service.search({ query: "needle", roots: ["/root-two"] });
    await service.search({ query: "needle", roots: ["/root-one"] });
    await service.search({ query: "needle", roots: ["/root-three"] });

    expect(watchers).toHaveLength(3);
    expect(watchers[0]?.close).not.toHaveBeenCalled();
    expect(watchers[1]?.close).toHaveBeenCalledOnce();
    expect(watchers[2]?.close).not.toHaveBeenCalled();
    await service.close();
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    expect(watchers[2]?.close).toHaveBeenCalledOnce();
    index.close();
  });

  test("evicts idle generations and closes their root watchers at the configured TTL", async () => {
    const index = await temporaryIndex();
    let nowMs = 0;
    const watchers: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const service = new AgenCFuzzyFileSearchService({
      index,
      now: () => nowMs,
      idleTtlMs: 100,
      discover: async () => discovery(["needle.ts"]),
      watchRoot: () => {
        const watcher = { close: vi.fn() };
        watchers.push(watcher);
        return watcher as unknown as FSWatcher;
      },
    });

    await service.search({ query: "needle", roots: ["/root-one"] });
    nowMs = 101;
    await service.search({ query: "needle", roots: ["/root-two"] });

    expect(watchers).toHaveLength(2);
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    expect(watchers[1]?.close).not.toHaveBeenCalled();
    await service.close();
    expect(watchers[1]?.close).toHaveBeenCalledOnce();
    index.close();
  });

  test("accounts prepared candidate bytes and evicts LRU roots before crossing the cache bound", async () => {
    const index = await temporaryIndex();
    const watchers: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const longPath = `${"a".repeat(100)}-needle.ts`;
    const service = new AgenCFuzzyFileSearchService({
      index,
      maximumCacheBytes: 5_000,
      discover: async () => discovery([longPath]),
      watchRoot: () => {
        const watcher = { close: vi.fn() };
        watchers.push(watcher);
        return watcher as unknown as FSWatcher;
      },
    });

    await service.search({ query: "needle", roots: ["/root-one"] });
    await service.search({ query: "needle", roots: ["/root-two"] });

    expect(watchers).toHaveLength(2);
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    expect(watchers[1]?.close).not.toHaveBeenCalled();
    await service.close();
    index.close();
  });

  test("rejects an unservable generation before persistent cutover", async () => {
    const index = await temporaryIndex();
    const service = new AgenCFuzzyFileSearchService({
      index,
      maximumCacheBytes: 1_000,
      discover: async () => discovery([`${"a".repeat(200)}-needle.ts`]),
      watchRoot: () => null,
    });

    await expect(
      service.search({ query: "needle", roots: ["/project"] }),
    ).rejects.toMatchObject({ reason: "CACHE_LIMIT" });
    expect(index.readCurrent("/project")).toBeNull();

    await service.close();
    index.close();
  });

  test("rejects many short candidates when retained object overhead exceeds cache", async () => {
    const index = await temporaryIndex();
    const service = new AgenCFuzzyFileSearchService({
      index,
      maximumCacheBytes: 2_500,
      discover: async () => discovery(["a.ts", "b.ts"]),
      watchRoot: () => null,
    });

    await expect(
      service.search({ query: "a", roots: ["/short-paths"] }),
    ).rejects.toMatchObject({ reason: "CACHE_LIMIT" });
    expect(index.readCurrent("/short-paths")).toBeNull();

    await service.close();
    index.close();
  });

  test("uses the daemon default limit and obeys explicit 1 and 1,000 limits", async () => {
    const index = await temporaryIndex();
    const paths = Array.from(
      { length: 1_100 },
      (_, value) => `file-${value.toString().padStart(4, "0")}.ts`,
    );
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover: async () => discovery(paths),
      watchRoot: () => null,
    });

    expect(
      (await service.search({ query: "file", roots: ["/project"] })).files,
    ).toHaveLength(50);
    expect(
      (
        await service.search({
          query: "file",
          roots: ["/project"],
          limit: 1,
        })
      ).files,
    ).toHaveLength(1);
    expect(
      (
        await service.search({
          query: "file",
          roots: ["/project"],
          limit: 1_000,
        })
      ).files,
    ).toHaveLength(1_000);

    await service.close();
    index.close();
  });

  test("reuses a complete candidate set only for a true same-generation query extension", async () => {
    const index = await temporaryIndex();
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover: async () => discovery(["ab.ts", "ac.ts", "zz.ts"]),
      watchRoot: () => null,
    });

    const broad = await service.search({ query: "a", roots: ["/project"] });
    expect(broad.matcher).toMatchObject({
      evaluatedCandidates: 3,
      totalCandidates: 3,
    });
    const extended = await service.search({
      query: "ab",
      roots: ["/project"],
    });
    expect(extended.files.map((file) => file.path)).toEqual(["ab.ts"]);
    expect(extended.matcher).toMatchObject({
      evaluatedCandidates: 2,
      totalCandidates: 3,
    });
    const changedNormalization = await service.search({
      query: "abé",
      roots: ["/project"],
    });
    expect(changedNormalization.matcher).toMatchObject({
      evaluatedCandidates: 3,
      totalCandidates: 3,
    });

    await service.close();
    index.close();
  });

  test("never evicts a root state pinned by an in-flight search", async () => {
    const index = await temporaryIndex();
    let markDiscoveryStarted = (): void => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery = (): void => {};
    const discoveryReleased = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const service = new AgenCFuzzyFileSearchService({
      index,
      maximumRootStates: 1,
      discover: async (root) => {
        if (root.endsWith("root-one")) {
          markDiscoveryStarted();
          await discoveryReleased;
        }
        return discovery(["needle.ts"]);
      },
      watchRoot: () => null,
    });
    const first = service.search({ query: "needle", roots: ["/root-one"] });
    await discoveryStarted;

    await expect(
      service.search({ query: "needle", roots: ["/root-two"] }),
    ).rejects.toThrow("active root-state limit of 1 is exhausted");
    releaseDiscovery();
    await expect(first).resolves.toMatchObject({
      files: [expect.objectContaining({ path: "needle.ts" })],
    });
    await service.close();
    index.close();
  });

  test("executes the shared create/delete/rename and watcher-loss freshness scenario", async () => {
    const scenario = JSON.parse(
      await readFile(
        new URL(
          "../fnd/fixtures/filesystem/index-freshness-scenario-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { readonly operations: readonly { readonly operation: string }[] };
    expect(scenario.operations.map((step) => step.operation)).toEqual(
      expect.arrayContaining([
        "create",
        "delete",
        "rename",
        "query_during_rebuild",
        "watcher_overflow",
        "rebuild_failure",
        "explicit_refresh_timeout",
      ]),
    );

    const index = await temporaryIndex();
    let paths = ["src/alpha.txt"];
    let pendingDiscovery: Promise<FuzzyFileDiscoveryResult> | null = null;
    const discover = vi.fn(async () =>
      pendingDiscovery === null ? discovery(paths) : await pendingDiscovery,
    );
    let signalChange = (): void => {};
    let signalWatcherLoss = (): void => {};
    const service = new AgenCFuzzyFileSearchService({
      index,
      discover,
      watchRoot: (_root, onChange, onError) => {
        signalChange = onChange;
        signalWatcherLoss = onError;
        return { close: vi.fn() } as unknown as FSWatcher;
      },
    });
    const first = await service.search({ query: "alpha", roots: ["/project"] });
    const firstGeneration = first.freshness?.roots[0]?.generationId;

    // Create, rename, and delete are coalesced into the staged generation.
    paths = ["src/renamed.txt"];
    signalChange();
    let rejectBuild = (_error: Error): void => {};
    pendingDiscovery = new Promise((_resolve, reject) => {
      rejectBuild = reject;
    });
    const failedRefresh = service.search({
      query: "renamed",
      roots: ["/project"],
      refresh: true,
    });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    signalWatcherLoss();

    const duringBuild = await service.search({
      query: "alpha",
      roots: ["/project"],
    });
    expect(duringBuild.files.map((file) => file.path)).toEqual([
      "src/alpha.txt",
    ]);
    expect(duringBuild.freshness).toMatchObject({
      stale: true,
      roots: [
        expect.objectContaining({
          generationId: firstGeneration,
          watcherStatus: "failed",
          building: true,
        }),
      ],
    });

    rejectBuild(new Error("synthetic_io_failure"));
    await expect(failedRefresh).resolves.toMatchObject({
      files: [],
      freshness: expect.objectContaining({ stale: true, degraded: true }),
    });
    expect(index.readCurrent("/project")?.generationId).toBe(firstGeneration);

    let rejectCancelled = (_error: Error): void => {};
    pendingDiscovery = new Promise((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const controller = new AbortController();
    const timedOutRefresh = service.search(
      { query: "renamed", roots: ["/project"], refresh: true },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(3));
    controller.abort(new Error("explicit refresh timeout"));
    rejectCancelled(new FuzzyIndexBuildCancelledError());
    await expect(timedOutRefresh).resolves.toEqual({ files: [] });
    expect(index.readCurrent("/project")?.generationId).toBe(firstGeneration);

    pendingDiscovery = null;
    const final = await service.search({
      query: "renamed",
      roots: ["/project"],
      refresh: true,
    });
    expect(final.files.map((file) => file.path)).toEqual(["src/renamed.txt"]);
    expect(final.files.map((file) => file.path)).not.toContain(
      "src/deleted.txt",
    );
    expect(final.freshness?.roots[0]?.generationId).toBeGreaterThan(
      firstGeneration ?? 0,
    );
    await service.close();
    index.close();
  });
});

function discovery(paths: readonly string[]): FuzzyFileDiscoveryResult {
  return {
    entries: paths.map((relativePath) => ({
      relativePath,
      pathBytes: Buffer.from(relativePath, "utf8"),
      matchType: "file" as const,
    })),
    truncated: false,
  };
}

async function temporaryIndex(): Promise<PersistentFuzzyFileIndex> {
  return new PersistentFuzzyFileIndex({
    databasePath: await temporaryDatabasePath(),
  });
}

async function temporaryDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-fuzzy-search-persistent-"));
  temporaryRoots.push(root);
  return join(root, "fuzzy.sqlite");
}
