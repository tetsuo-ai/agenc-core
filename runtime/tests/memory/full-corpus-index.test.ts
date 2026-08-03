import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import {
  PersistentMemoryIndex,
  type MemoryIndexRootSpec,
} from "../../src/memory/full-corpus-index.js";
import { MemoryQueryProcessPool } from "../../src/memory/memory-query-pool.js";
import {
  MEMORY_INDEX_BUILD_LEASE_MS,
  MAX_MEMORY_INDEX_ROOTS,
  MEMORY_INDEX_ROOT_IDLE_TTL_MS,
} from "../../src/memory/full-corpus-contract.js";

const helperEntrypoint = fileURLToPath(
  new URL("../../src/memory/memory-query-helper.mjs", import.meta.url),
);

let temporaryRoot = "";
let index: PersistentMemoryIndex | undefined;

afterEach(async () => {
  index?.close();
  index = undefined;
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

describe("C3b persistent full-corpus index", () => {
  it("retrieves a uniquely relevant memory older than the newest 200", async () => {
    const fixture = await createFixture();
    const oldPath = join(fixture.globalRoot, "old-browser-recovery.md");
    await writeMemory(
      oldPath,
      "Old browser recovery",
      "uniquebrowserfailure recovery sequence",
    );
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(oldPath, oldTime, oldTime);
    for (let memory = 0; memory < 220; memory += 1) {
      await writeMemory(
        join(
          fixture.globalRoot,
          `recent-${memory.toString().padStart(3, "0")}.md`,
        ),
        `Recent irrelevant ${memory}`,
        "unrelated compiler note",
      );
    }

    const refresh = await index!.refresh(
      fixture.rootSpecs,
      new AbortController().signal,
      { explicit: true },
    );
    expect(refresh.kind).toBe("complete");

    const result = await index!.query(
      fixture.rootSpecs,
      ["uniquebrowserfailure"],
      new AbortController().signal,
    );
    expect(result.kind).toBe("complete");
    expect(result.candidates[0]?.canonicalPath).toBe(oldPath);
    expect(result.candidates).toHaveLength(1);
    expect(index!.readHeader(result.candidates[0]!)).toMatchObject({
      filePath: oldPath,
      title: "Old browser recovery",
    });
  });

  it("changes results after an equal-size, equal-mtime bounded header replacement", async () => {
    const fixture = await createFixture();
    const memoryPath = join(fixture.projectRoot, "replacement.md");
    const first = memoryDocument("Replacement", "alpha_marker");
    const second = memoryDocument("Replacement", "bravo_marker");
    expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second));
    await writeFile(memoryPath, first);
    const fixedTime = new Date("2024-01-01T00:00:00.000Z");
    await utimes(memoryPath, fixedTime, fixedTime);
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    const before = await index!.query(
      fixture.rootSpecs,
      ["alpha_marker"],
      new AbortController().signal,
    );
    expect(before.candidates).toHaveLength(1);

    await writeFile(memoryPath, second);
    await utimes(memoryPath, fixedTime, fixedTime);
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    const staleTerm = await index!.query(
      fixture.rootSpecs,
      ["alpha_marker"],
      new AbortController().signal,
    );
    const replacementTerm = await index!.query(
      fixture.rootSpecs,
      ["bravo_marker"],
      new AbortController().signal,
    );
    expect(staleTerm.candidates).toHaveLength(0);
    expect(replacementTerm.candidates).toHaveLength(1);
  });

  it("reconciles an equal-size, equal-mtime replacement during the initial build", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-build-race-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    const racedPath = join(memoryRoot, "00000-raced.md");
    const first = memoryDocument("Build race", "build_race_alpha");
    const second = memoryDocument("Build race", "build_race_bravo");
    expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second));
    await writeFile(racedPath, first);
    const fixedTime = new Date("2024-01-01T00:00:00.000Z");
    await utimes(racedPath, fixedTime, fixedTime);
    for (let start = 1; start <= 10_000; start += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, 10_001 - start) }, (_, offset) => {
          const ordinal = start + offset;
          return writeMemory(
            join(memoryRoot, `${ordinal.toString().padStart(5, "0")}.md`),
            `Memory ${ordinal}`,
            "ordinary build-race filler",
          );
        }),
      );
    }
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });

    const refreshPromise = index.refresh(
      [{ path: memoryRoot, role: "project" }],
      new AbortController().signal,
      { explicit: true },
    );
    const inspection = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await expectEventually(async () => {
        const row = inspection
          .prepare(
            `SELECT f.description
               FROM memory_fts f
               JOIN memory_index_entries e
                 ON e.root_id = f.root_id
                AND e.generation_id = f.generation_id
                AND e.memory_id = f.memory_id
              WHERE e.canonical_path = ? AND f.description = ?`,
          )
          .get(racedPath, "build_race_alpha");
        return row !== undefined;
      });
    } finally {
      inspection.close();
    }
    await writeFile(racedPath, second);
    await utimes(racedPath, fixedTime, fixedTime);
    await expect(refreshPromise).resolves.toMatchObject({ kind: "complete" });

    const stale = await index.query(
      [{ path: memoryRoot, role: "project" }],
      ["build_race_alpha"],
      new AbortController().signal,
    );
    const replacement = await index.query(
      [{ path: memoryRoot, role: "project" }],
      ["build_race_bravo"],
      new AbortController().signal,
    );
    expect(stale.candidates).toHaveLength(0);
    expect(replacement.candidates).toHaveLength(1);
  }, 30_000);

  it("keeps generation counts and the commutative digest exact across incremental replacement", async () => {
    const fixture = await createFixture();
    const memoryPath = join(fixture.globalRoot, "digest.md");
    const first = memoryDocument("Digest", "digest_alpha");
    const second = memoryDocument("Digest", "digest_bravo");
    expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second));
    await writeFile(memoryPath, first);
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    const initial = readCurrentGenerationProgress(index!.databasePath);

    await writeFile(memoryPath, second);
    index!.recordChange({
      rootPath: fixture.globalRoot,
      relativePath: "digest.md",
      kind: "update",
    });
    await index!.refresh(fixture.rootSpecs, new AbortController().signal);
    const changed = readCurrentGenerationProgress(index!.databasePath);
    expect(changed).toMatchObject({
      entryCount: initial.entryCount,
      indexedBytes: initial.indexedBytes,
    });
    expect(changed.digest).not.toBe(initial.digest);

    await writeFile(memoryPath, first);
    index!.recordChange({
      rootPath: fixture.globalRoot,
      relativePath: "digest.md",
      kind: "update",
    });
    await index!.refresh(fixture.rootSpecs, new AbortController().signal);
    const restored = readCurrentGenerationProgress(index!.databasePath);
    expect(restored.digest).toBe(initial.digest);
    expect(restored.discoveryOperations).toBeGreaterThan(0);
  });

  it("repairs a missed equal-size/equal-mtime external change through the bounded audit", async () => {
    const fixture = await createFixture();
    const databasePath = join(temporaryRoot, "state", "memory.sqlite");
    const memoryPath = join(fixture.globalRoot, "missed-watch.md");
    const first = memoryDocument("Missed watch", "audit_alpha");
    const second = memoryDocument("Missed watch", "audit_bravo");
    expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second));
    const fixedTime = new Date("2024-02-02T00:00:00.000Z");
    await writeFile(memoryPath, first);
    await utimes(memoryPath, fixedTime, fixedTime);
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    index!.close();
    index = undefined;

    await writeFile(memoryPath, second);
    await utimes(memoryPath, fixedTime, fixedTime);
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    await index.auditSlice(
      { path: fixture.globalRoot, role: "global" },
      new AbortController().signal,
    );
    await index.refresh(fixture.rootSpecs, new AbortController().signal);
    const oldResult = await index.query(
      fixture.rootSpecs,
      ["audit_alpha"],
      new AbortController().signal,
    );
    const repaired = await index.query(
      fixture.rootSpecs,
      ["audit_bravo"],
      new AbortController().signal,
    );
    expect(oldResult.candidates).toHaveLength(0);
    expect(repaired.candidates).toHaveLength(1);
  });

  it("publishes project and global roots once and fuses duplicate paths deterministically", async () => {
    const fixture = await createFixture();
    await writeMemory(
      join(fixture.globalRoot, "global.md"),
      "Shared query global",
      "crossrootterm",
    );
    await writeMemory(
      join(fixture.projectRoot, "project.md"),
      "Shared query project",
      "crossrootterm",
    );
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    const result = await index!.query(
      fixture.rootSpecs,
      ["crossrootterm"],
      new AbortController().signal,
    );
    expect(result.candidates.map((candidate) => candidate.rootRole)).toEqual([
      "project",
      "global",
    ]);
    expect(
      new Set(result.candidates.map((candidate) => candidate.rootId)).size,
    ).toBe(2);
  });

  it("propagates abort instead of returning a partial or empty success", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    controller.abort(new Error("stop-memory-build"));
    await expect(
      index!.refresh(fixture.rootSpecs, controller.signal, { explicit: true }),
    ).rejects.toThrow("stop-memory-build");
  });

  it("rotates an incompatible derived schema and recreates secure state", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-schema-"));
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(stateRoot, { recursive: true });
    const incompatible = new Database(databasePath);
    incompatible.pragma("user_version = 99");
    incompatible.close();

    index = new PersistentMemoryIndex({ databasePath });
    expect(index.ftsAvailable).toBe(true);
    expect(
      (await readdir(stateRoot)).some((name) => name.includes("schema-99")),
    ).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(stateRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates a corrupt derived database without touching memory sources", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-corrupt-"));
    const sourceRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    const sourcePath = join(sourceRoot, "preserved.md");
    await writeMemory(sourcePath, "Preserved", "corruptrotationterm");
    await writeFile(databasePath, "this is not a SQLite database");

    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    expect(index.ftsAvailable).toBe(true);
    expect(
      (await readdir(stateRoot)).some((name) => name.includes(".corrupt-")),
    ).toBe(true);
    await expect(stat(sourcePath)).resolves.toMatchObject({});
  });

  it("rotates a same-version database whose schema contract is incomplete", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-signature-"));
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(stateRoot, { recursive: true });
    const incomplete = new Database(databasePath);
    incomplete.exec("CREATE TABLE unrelated(value TEXT)");
    incomplete.pragma("user_version = 1");
    incomplete.close();

    index = new PersistentMemoryIndex({ databasePath });
    expect(index.ftsAvailable).toBe(true);
    expect(
      (await readdir(stateRoot)).some((name) => name.includes(".schema-1-")),
    ).toBe(true);
  });

  it("marks a missed create stale when the bounded directory audit sees mutation", async () => {
    const fixture = await createFixture();
    await writeMemory(
      join(fixture.globalRoot, "existing.md"),
      "Existing",
      "existingterm",
    );
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    await writeMemory(
      join(fixture.globalRoot, "missed-create.md"),
      "Missed create",
      "missedcreateterm",
    );

    const status = await index!.auditSlice(
      { path: fixture.globalRoot, role: "global" },
      new AbortController().signal,
    );
    expect(status.watcherHealth).toBe("degraded");
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    const repaired = await index!.query(
      fixture.rootSpecs,
      ["missedcreateterm"],
      new AbortController().signal,
    );
    expect(repaired.candidates).toHaveLength(1);
  });

  it("serializes two daemon writers through the bounded SQLite lease", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-writers-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    for (let ordinal = 0; ordinal < 100; ordinal += 1) {
      await writeMemory(
        join(memoryRoot, `${ordinal}.md`),
        `Writer ${ordinal}`,
        "writerleaseterm",
      );
    }
    const roots = [{ path: memoryRoot, role: "global" as const }];
    const first = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const second = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    index = first;
    try {
      const outcomes = await Promise.all([
        first.refresh(roots, new AbortController().signal),
        second.refresh(roots, new AbortController().signal),
      ]);
      expect(outcomes.some((outcome) => outcome.kind === "complete")).toBe(
        true,
      );
      expect(
        outcomes.some((outcome) =>
          outcome.roots.some((root) => root.reason?.includes("writer lease")),
        ),
      ).toBe(true);
      await expect(
        second.refresh(roots, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "complete" });
    } finally {
      second.close();
    }
  });

  it("evicts the deterministic LRU root at the exact 64/65 global boundary without deleting sources", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-root-cap-"));
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(stateRoot, { recursive: true });
    let clock = 1;
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => clock++,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const sourceRoots: string[] = [];
    for (let ordinal = 0; ordinal < MAX_MEMORY_INDEX_ROOTS; ordinal += 1) {
      const sourceRoot = join(
        temporaryRoot,
        `memory-${ordinal.toString().padStart(2, "0")}`,
      );
      await mkdir(sourceRoot);
      sourceRoots.push(sourceRoot);
      await index.refresh(
        [{ path: sourceRoot, role: "project" }],
        new AbortController().signal,
        { explicit: true },
      );
    }
    const newestRoot = join(temporaryRoot, "memory-64");
    await mkdir(newestRoot);
    sourceRoots.push(newestRoot);
    const leaseDatabase = new Database(databasePath);
    try {
      leaseDatabase
        .prepare(
          `UPDATE memory_index_generations
              SET builder_owner = ?, builder_lease_expires_at_ms = ?
            WHERE id = (
              SELECT current_generation_id FROM memory_index_roots
               WHERE canonical_path = ?
            )`,
        )
        .run(
          "other-daemon",
          clock + MEMORY_INDEX_BUILD_LEASE_MS,
          sourceRoots[0],
        );
    } finally {
      leaseDatabase.close();
    }
    await expect(
      index.refresh(
        [{ path: newestRoot, role: "project" }],
        new AbortController().signal,
        { explicit: true },
      ),
    ).resolves.toMatchObject({ kind: "complete" });
    const inspection = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = inspection
        .prepare("SELECT COUNT(*) AS count FROM memory_index_roots")
        .get() as { count: number };
      expect(row.count).toBe(MAX_MEMORY_INDEX_ROOTS);
      const leased = inspection
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_index_roots WHERE canonical_path = ?",
        )
        .get(sourceRoots[0]) as { count: number };
      expect(leased.count).toBe(1);
      const evicted = inspection
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_index_roots WHERE canonical_path = ?",
        )
        .get(sourceRoots[1]) as { count: number };
      expect(evicted.count).toBe(0);
    } finally {
      inspection.close();
    }
    for (const sourceRoot of sourceRoots) {
      await expect(stat(sourceRoot)).resolves.toMatchObject({});
    }
  });

  it("honors the exact root idle-TTL boundary and preserves source memory", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-root-ttl-"));
    const sourceRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    let now = 1_000;
    index = new PersistentMemoryIndex({
      databasePath: join(stateRoot, "memory.sqlite"),
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    await index.refresh(
      [{ path: sourceRoot, role: "project" }],
      new AbortController().signal,
      { explicit: true },
    );
    now += MEMORY_INDEX_ROOT_IDLE_TTL_MS - 1;
    expect(index.cleanupUnusedRoots()).toBe(0);
    now += 1;
    expect(index.cleanupUnusedRoots()).toBe(1);
    const inspection = new Database(join(stateRoot, "memory.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const roots = inspection
        .prepare("SELECT COUNT(*) AS count FROM memory_index_roots")
        .get() as { count: number };
      const owners = inspection
        .prepare("SELECT COUNT(*) AS count FROM memory_index_owners")
        .get() as { count: number };
      expect(roots.count).toBe(0);
      expect(owners.count).toBe(0);
    } finally {
      inspection.close();
    }
    await expect(stat(sourceRoot)).resolves.toMatchObject({});
  });

  it("keeps an idle root while another daemon holds its watcher lease", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-owner-lease-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    let now = 1_000;
    const owner = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const cleaner = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    index = owner;
    await owner.refresh(
      [{ path: memoryRoot, role: "project" }],
      new AbortController().signal,
      { explicit: true },
    );
    now += MEMORY_INDEX_ROOT_IDLE_TTL_MS;
    const heartbeatDatabase = new Database(databasePath);
    try {
      heartbeatDatabase
        .prepare("UPDATE memory_index_owners SET lease_expires_at_ms = ?")
        .run(now + MEMORY_INDEX_BUILD_LEASE_MS);
    } finally {
      heartbeatDatabase.close();
    }
    expect(cleaner.cleanupUnusedRoots()).toBe(0);
    owner.close();
    index = cleaner;
    expect(cleaner.cleanupUnusedRoots()).toBe(1);
  });

  it("does not retire an idle watcher while its root has an in-flight query", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-query-owner-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(
      join(memoryRoot, "query.md"),
      "Query ownership",
      "queryownershipterm",
    );
    let now = 1_000;
    const queryPool = new MemoryQueryProcessPool({ helperEntrypoint });
    let markStarted!: () => void;
    let releaseQuery!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    vi.spyOn(queryPool, "query").mockImplementation(async () => {
      markStarted();
      await blocked;
      return [];
    });
    index = new PersistentMemoryIndex({
      databasePath: join(stateRoot, "memory.sqlite"),
      backgroundRefresh: false,
      now: () => now,
      queryPool,
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const query = index.query(
      roots,
      ["queryownershipterm"],
      new AbortController().signal,
    );
    await started;
    now += MEMORY_INDEX_ROOT_IDLE_TTL_MS;
    try {
      expect(index.cleanupUnusedRoots()).toBe(0);
    } finally {
      releaseQuery();
    }
    await query;
    expect(index.cleanupUnusedRoots()).toBe(1);
  });

  it("observes an external update through the debounced watcher and atomically replaces the generation", async () => {
    const fixture = await createFixture();
    const memoryPath = join(fixture.globalRoot, "watched.md");
    await writeMemory(memoryPath, "Watched", "watcher_alpha");
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    expect(
      (
        await index!.query(
          fixture.rootSpecs,
          ["watcher_alpha"],
          new AbortController().signal,
        )
      ).candidates,
    ).toHaveLength(1);

    await writeMemory(memoryPath, "Watched", "watcher_bravo");
    await expectEventually(async () => {
      const result = await index!.query(
        fixture.rootSpecs,
        ["watcher_bravo"],
        new AbortController().signal,
      );
      return result.candidates.length === 1;
    });
    const oldResult = await index!.query(
      fixture.rootSpecs,
      ["watcher_alpha"],
      new AbortController().signal,
    );
    expect(oldResult.candidates).toHaveLength(0);
    const audited = await index!.auditSlice(
      { path: fixture.globalRoot, role: "global" },
      new AbortController().signal,
    );
    expect(audited.watcherHealth).toBe("healthy");
  });

  it("applies rename and delete changes through an invisible incremental generation", async () => {
    const fixture = await createFixture();
    const oldPath = join(fixture.projectRoot, "old-name.md");
    const newPath = join(fixture.projectRoot, "new-name.md");
    await writeMemory(oldPath, "Rename", "atomicrenameterm");
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });

    await rename(oldPath, newPath);
    index!.recordChange({
      rootPath: fixture.projectRoot,
      relativePath: "old-name.md",
      kind: "delete",
    });
    index!.recordChange({
      rootPath: fixture.projectRoot,
      relativePath: "new-name.md",
      kind: "rename",
    });
    const renamed = await index!.refresh(
      fixture.rootSpecs,
      new AbortController().signal,
    );
    expect(renamed.kind).toBe("complete");
    const afterRename = await index!.query(
      fixture.rootSpecs,
      ["atomicrenameterm"],
      new AbortController().signal,
    );
    expect(
      afterRename.candidates.map((candidate) => candidate.canonicalPath),
    ).toEqual([newPath]);

    await unlink(newPath);
    index!.recordChange({
      rootPath: fixture.projectRoot,
      relativePath: "new-name.md",
      kind: "delete",
    });
    await index!.refresh(fixture.rootSpecs, new AbortController().signal);
    const afterDelete = await index!.query(
      fixture.rootSpecs,
      ["atomicrenameterm"],
      new AbortController().signal,
    );
    expect(afterDelete.candidates).toHaveLength(0);
  });

  it("never exposes a sliced prefix and resumes a single large directory after restart", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-resume-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    for (let start = 0; start < 10_001; start += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, 10_001 - start) }, (_, offset) => {
          const ordinal = start + offset;
          return writeMemory(
            join(memoryRoot, `${ordinal.toString().padStart(5, "0")}.md`),
            `Memory ${ordinal}`,
            ordinal === 10_000 ? "lastuniqueterm" : "ordinaryterm",
          );
        }),
      );
    }
    const roots = [{ path: memoryRoot, role: "global" as const }];
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const firstSlice = await index.refresh(roots, new AbortController().signal);
    expect(firstSlice.kind).toBe("refresh_pending");
    const generationToken = firstSlice.roots[0]?.generationToken;
    expect(generationToken).toBeTypeOf("string");
    expect(index.pollRefresh(generationToken!)).toMatchObject({
      state: "refresh_pending",
      generationToken,
    });
    const invisiblePrefix = await index.query(
      roots,
      ["ordinaryterm"],
      new AbortController().signal,
    );
    expect(invisiblePrefix.kind).toBe("unavailable");
    expect(invisiblePrefix.candidates).toEqual([]);

    index.close();
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    let refresh = await index.refresh(roots, new AbortController().signal);
    for (
      let slice = 0;
      slice < 4 && refresh.kind === "refresh_pending";
      slice += 1
    ) {
      refresh = await index.refresh(roots, new AbortController().signal);
    }
    expect(refresh.kind).toBe("complete");
    const complete = await index.query(
      roots,
      ["lastuniqueterm"],
      new AbortController().signal,
    );
    expect(complete.candidates).toHaveLength(1);
    expect(complete.candidates[0]?.canonicalPath).toBe(
      join(memoryRoot, "10000.md"),
    );
  }, 30_000);
});

async function createFixture(): Promise<{
  readonly globalRoot: string;
  readonly projectRoot: string;
  readonly rootSpecs: readonly MemoryIndexRootSpec[];
}> {
  temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3b-index-"));
  const stateRoot = join(temporaryRoot, "state");
  const globalRoot = join(temporaryRoot, "global-memory");
  const projectRoot = join(temporaryRoot, "project-memory");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(globalRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  index = new PersistentMemoryIndex({
    databasePath: join(stateRoot, "memory.sqlite"),
    queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
  });
  return {
    globalRoot,
    projectRoot,
    rootSpecs: [
      { path: globalRoot, role: "global" },
      { path: projectRoot, role: "project" },
    ],
  };
}

function writeMemory(
  path: string,
  title: string,
  description: string,
): Promise<void> {
  return writeFile(path, memoryDocument(title, description));
}

function memoryDocument(title: string, description: string): string {
  return `---\ntitle: ${title}\ndescription: ${description}\ntype: project\n---\nBody.\n`;
}

function readCurrentGenerationProgress(databasePath: string): {
  readonly entryCount: number;
  readonly indexedBytes: number;
  readonly digest: string;
  readonly discoveryOperations: number;
} {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare(
        `SELECT g.entry_count AS entryCount,
                g.indexed_bytes AS indexedBytes,
                g.digest,
                g.discovery_operations AS discoveryOperations
           FROM memory_index_roots r
           JOIN memory_index_generations g ON g.id = r.current_generation_id
          WHERE r.root_role = 'global'`,
      )
      .get() as {
      entryCount: number;
      indexedBytes: number;
      digest: string;
      discoveryOperations: number;
    };
  } finally {
    database.close();
  }
}

async function expectEventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("memory watcher did not converge before the test deadline");
}
