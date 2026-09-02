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
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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
  MEMORY_INDEX_SCHEMA_VERSION,
  MAX_MEMORY_FILES_PER_ROOT,
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
  it.skipIf(process.platform === "win32")(
    "preserves a POSIX backslash filename through helper validation and header materialization",
    async () => {
      const fixture = await createFixture();
      const relativePath = "folder\\note.md";
      const memoryPath = join(fixture.globalRoot, relativePath);
      await writeMemory(
        memoryPath,
        "Backslash filename",
        "posixbackslashterm",
      );
      await index!.refresh(
        fixture.rootSpecs,
        new AbortController().signal,
        { explicit: true },
      );

      const result = await index!.query(
        fixture.rootSpecs,
        ["posixbackslashterm"],
        new AbortController().signal,
      );
      expect(result).toMatchObject({ kind: "complete" });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ canonicalPath: memoryPath });
      expect(index!.readHeader(result.candidates[0]!)).toMatchObject({
        relativePath,
        filePath: memoryPath,
        root: { canonicalPath: fixture.globalRoot },
      });
    },
  );

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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-build-race-"));
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

    const refreshController = new AbortController();
    const refreshPromise = index.refresh(
      [{ path: memoryRoot, role: "project" }],
      refreshController.signal,
      { explicit: true },
    );
    try {
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
        }, 120_000);
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
    } finally {
      refreshController.abort(
        new DOMException("Initial build test cleanup", "AbortError"),
      );
      await refreshPromise.catch(() => undefined);
    }
  }, 6 * 60_000);

  it("uses indexed pending order without repeated discovered-file counts", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-counts-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 64 }, (_, ordinal) =>
        writeMemory(
          join(memoryRoot, `${ordinal.toString().padStart(3, "0")}.md`),
          `Memory ${ordinal}`,
          "bounded count term",
        ),
      ),
    );

    const originalPrepare = Database.prototype.prepare;
    let discoveredFileCountReads = 0;
    const prepareSpy = vi
      .spyOn(Database.prototype, "prepare")
      .mockImplementation(function (this: Database.Database, source: string) {
        const normalized = source.replace(/\s+/g, " ").trim();
        if (
          normalized ===
          "SELECT COUNT(*) AS count FROM memory_index_discovered_files WHERE root_id = ? AND generation_id = ?"
        ) {
          discoveredFileCountReads += 1;
        }
        return originalPrepare.call(this, source);
      });
    try {
      index = new PersistentMemoryIndex({
        databasePath: join(stateRoot, "memory.sqlite"),
        backgroundRefresh: false,
        queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      });
      await expect(
        index.refresh(
          [{ path: memoryRoot, role: "global" }],
          new AbortController().signal,
          { explicit: true },
        ),
      ).resolves.toMatchObject({ kind: "complete" });
    } finally {
      prepareSpy.mockRestore();
    }
    expect(discoveredFileCountReads).toBe(1);

    const inspection = new Database(index!.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const plan = inspection
        .prepare<[string, number], { detail: string }>(
          `EXPLAIN QUERY PLAN
           SELECT relative_path FROM memory_index_discovered_files
            WHERE root_id = ? AND generation_id = ? AND state = 'pending'
            ORDER BY CAST(relative_path AS BLOB)
            LIMIT 1`,
        )
        .all("root", 1)
        .map(({ detail }) => detail);
      expect(plan).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "USING COVERING INDEX memory_discovered_pending_order",
          ),
        ]),
      );
      expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(
        false,
      );
    } finally {
      inspection.close();
    }
  });

  it("enforces the discovered-file boundary for replayed watcher changes", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-replay-limit-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const roots = [{ path: memoryRoot, role: "global" as const }];
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_001);
    try {
      await expect(
        index.refresh(roots, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "refresh_pending" });
    } finally {
      clock.mockRestore();
    }

    const fixture = new Database(databasePath);
    try {
      fixture
        .prepare(
          "UPDATE memory_index_directory_work SET state = 'complete'",
        )
        .run();
      fixture
        .prepare(
          "UPDATE memory_index_generations SET discovered_file_count = ? WHERE state = 'staging'",
        )
        .run(MAX_MEMORY_FILES_PER_ROOT);
    } finally {
      fixture.close();
    }
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "replayed.md",
      kind: "create",
    });
    const result = await index.refresh(
      roots,
      new AbortController().signal,
    );
    expect(result.kind).toBe("degraded");
    expect(result.roots[0]).toMatchObject({
      state: "failed",
      reason: "memory file count per root exceeds limit",
    });
  });

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

  it("updates one file with bounded SQLite maintenance headroom and rolls back growth without advancing its cursor", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-page-cap-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const targetPath = join(memoryRoot, "target.md");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(targetPath, "Page cap", "pagecapterm alpha");
    await Promise.all(
      Array.from({ length: 128 }, (_, ordinal) =>
        writeMemory(
          join(memoryRoot, `filler-${ordinal.toString().padStart(3, "0")}.md`),
          `Filler ${ordinal}`,
          `unrelated filler ${ordinal}`,
        ),
      ),
    );
    const roots = [{ path: memoryRoot, role: "global" as const }];
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const generationId = readCurrentGenerationId(databasePath);
    const before = readCurrentGenerationProgress(databasePath);
    index.close();
    index = undefined;

    const ceilingDatabase = new Database(databasePath);
    let compactedPageCount = 0;
    let pageCeiling = 0;
    let byteCeiling = 0;
    try {
      ceilingDatabase.pragma("wal_checkpoint(TRUNCATE)");
      ceilingDatabase.exec("VACUUM");
      expect(
        ceilingDatabase.pragma("freelist_count", { simple: true }),
      ).toBe(0);
      compactedPageCount = Number(
        ceilingDatabase.pragma("page_count", { simple: true }),
      );
      // FTS5 may append one maintenance page when replacing terms even when
      // the indexed header has the same logical size. Keep that bounded
      // storage headroom while still exercising rollback at the hard limit.
      pageCeiling = compactedPageCount + 1;
      byteCeiling =
        pageCeiling *
        Number(ceilingDatabase.pragma("page_size", { simple: true }));
    } finally {
      ceilingDatabase.close();
    }

    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      resourceLimitsForTesting: { maxDatabaseBytes: byteCeiling },
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    await writeMemory(targetPath, "Page cap", "pagecapterm bravo");
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "target.md",
      kind: "update",
    });
    await expect(
      index.refresh(roots, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "complete" });
    expect(readCurrentGenerationId(databasePath)).toBe(generationId);
    const after = readCurrentGenerationProgress(databasePath);
    expect(after).toMatchObject({
      entryCount: before.entryCount,
      indexedBytes: before.indexedBytes,
      discoveryOperations: before.discoveryOperations,
    });
    expect(after.digest).not.toBe(before.digest);

    let committedPageCount = 0;
    const inspection = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      committedPageCount = Number(
        inspection.pragma("page_count", { simple: true }),
      );
      expect(committedPageCount).toBeGreaterThanOrEqual(compactedPageCount);
      expect(committedPageCount).toBeLessThanOrEqual(pageCeiling);
      expect(
        (
          inspection
            .prepare(
              `SELECT COUNT(*) AS count FROM memory_index_generations
                WHERE state IN ('staging', 'superseded')`,
            )
            .get() as { count: number }
        ).count,
      ).toBe(0);
    } finally {
      inspection.close();
    }

    const committedState = readGenerationChangeState(
      databasePath,
      generationId,
    );
    await writeMemory(targetPath, "Page cap", `pagecapterm ${"x".repeat(50_000)}`);
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "target.md",
      kind: "update",
    });
    await expect(
      index.refresh(roots, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: "degraded",
      roots: [{ state: "failed" }],
    });
    expect(readCurrentGenerationProgress(databasePath)).toEqual(after);
    const rejectedState = readGenerationChangeState(
      databasePath,
      generationId,
    );
    expect(rejectedState.changeCursor).toBe(committedState.changeCursor);
    expect(rejectedState.pendingChanges).toBeGreaterThan(0);
    expect(readDatabasePageCount(databasePath)).toBe(committedPageCount);
  });

  it("rejects the exact 512-to-513 incremental create and recovers after a deletion", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-file-cap-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const roots = [{ path: memoryRoot, role: "global" as const }];
    const fileLimit = 512;
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    for (let start = 0; start < fileLimit; start += 128) {
      await Promise.all(
        Array.from(
          { length: Math.min(128, fileLimit - start) },
          (_, offset) => {
            const ordinal = start + offset;
            return writeMemory(
              join(
                memoryRoot,
                `existing-${ordinal.toString().padStart(3, "0")}.md`,
              ),
              `Existing ${ordinal}`,
              `bounded existing ${ordinal}`,
            );
          },
        ),
      );
    }
    const options = {
      databasePath,
      backgroundRefresh: false,
      resourceLimitsForTesting: { maxFilesPerRoot: fileLimit },
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    } as const;
    index = new PersistentMemoryIndex(options);
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const generationId = readCurrentGenerationId(databasePath);
    expect(readIndexedEntryCounts(databasePath, generationId)).toEqual({
      entries: fileLimit,
      ftsEntries: fileLimit,
    });
    const initialState = readGenerationChangeState(
      databasePath,
      generationId,
    );
    index.close();
    index = undefined;

    const createdPath = join(memoryRoot, "created-at-cap.md");
    await writeMemory(createdPath, "Created at cap", "filecapterm");
    index = new PersistentMemoryIndex(options);
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "created-at-cap.md",
      kind: "create",
    });
    await expect(
      index.refresh(roots, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: "degraded",
      roots: [
        {
          state: "failed",
          reason: "memory file count per root exceeds limit",
        },
      ],
    });
    expect(readCurrentGenerationId(databasePath)).toBe(generationId);
    expect(readIndexedEntryCounts(databasePath, generationId)).toEqual({
      entries: fileLimit,
      ftsEntries: fileLimit,
    });
    expect(readGenerationChangeState(databasePath, generationId)).toEqual({
      changeCursor: initialState.changeCursor,
      pendingChanges: 1,
    });
    index.close();
    index = undefined;

    await unlink(join(memoryRoot, "existing-000.md"));
    index = new PersistentMemoryIndex(options);
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "existing-000.md",
      kind: "delete",
    });
    await expect(
      index.refresh(roots, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "complete" });
    expect(readCurrentGenerationId(databasePath)).toBe(generationId);
    expect(readIndexedEntryCounts(databasePath, generationId)).toEqual({
      entries: fileLimit,
      ftsEntries: fileLimit,
    });
    expect(readGenerationChangeState(databasePath, generationId)).toMatchObject(
      { pendingChanges: 0 },
    );
    const recovered = await index.query(
      roots,
      ["filecapterm"],
      new AbortController().signal,
    );
    expect(recovered.candidates).toHaveLength(1);
    expect(recovered.candidates[0]?.canonicalPath).toBe(createdPath);
  });

  it("garbage-collects idle roots once per index instance, not on every refresh", async () => {
    const fixture = await createFixture();
    await writeMemory(join(fixture.globalRoot, "note.md"), "Note", "cleanup_once_term");
    const cleanup = vi.spyOn(index!, "cleanupUnusedRoots");

    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });
    await index!.refresh(fixture.rootSpecs, new AbortController().signal);
    await index!.refresh(fixture.rootSpecs, new AbortController().signal, {
      explicit: true,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-schema-"));
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-corrupt-"));
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-signature-"));
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(stateRoot, { recursive: true });
    const incomplete = new Database(databasePath);
    incomplete.exec("CREATE TABLE unrelated(value TEXT)");
    incomplete.pragma(`user_version = ${MEMORY_INDEX_SCHEMA_VERSION}`);
    incomplete.close();

    index = new PersistentMemoryIndex({ databasePath });
    expect(index.ftsAvailable).toBe(true);
    expect(
      (await readdir(stateRoot)).some((name) =>
        name.includes(`.schema-${MEMORY_INDEX_SCHEMA_VERSION}-`),
      ),
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-writers-"));
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-root-cap-"));
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-root-ttl-"));
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-owner-lease-"));
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-query-owner-"));
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

  it("fails closed without leaking its reader heartbeat when close races an awaiting helper", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-query-close-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(
      join(memoryRoot, "query.md"),
      "Closing query",
      "querycloseterm",
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
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool,
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const generationId = readCurrentGenerationId(databasePath);
    const inFlight = index.query(
      roots,
      ["querycloseterm"],
      new AbortController().signal,
    );
    await started;
    expect(readReaderPinState(databasePath, generationId).pinCount).toBe(1);

    const clearCallsBeforeClose = clearIntervalSpy.mock.calls.length;
    index.close();
    index = undefined;
    expect(clearIntervalSpy.mock.calls).toHaveLength(clearCallsBeforeClose + 1);
    expect(readReaderPinState(databasePath, generationId).pinCount).toBe(0);
    releaseQuery();
    await expect(inFlight).resolves.toMatchObject({
      kind: "unavailable",
      candidates: [],
      reason: "memory index closed while query was in progress",
    });
    clearIntervalSpy.mockRestore();
  });

  it("returns a degraded result when close races a foreground refresh", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-refresh-close-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const memoryPath = join(memoryRoot, "refresh.md");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(memoryPath, "Closing refresh", "refreshcloseterm alpha");
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      beforeIncrementalReadForTesting: async () => {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      },
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    await writeMemory(memoryPath, "Closing refresh", "refreshcloseterm bravo");
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "refresh.md",
      kind: "update",
    });
    const inFlight = index.refresh(roots, new AbortController().signal);
    try {
      await refreshStarted.promise;
      expect(
        readCurrentGenerationLease(databasePath).builderOwner,
      ).not.toBeNull();
      index.close();
      expect(readCurrentGenerationLease(databasePath)).toEqual({
        builderOwner: null,
        leaseExpiresAtMs: null,
      });
      releaseRefresh.resolve();
      await expect(inFlight).resolves.toMatchObject({
        kind: "degraded",
        roots: [
          {
            canonicalRoot: memoryRoot,
            role: "project",
            state: "unavailable",
            reason: "memory index is closed",
          },
        ],
      });
      await expect(
        index.refresh(roots, new AbortController().signal),
      ).resolves.toMatchObject({
        kind: "degraded",
        roots: [{ reason: "memory index is closed" }],
      });
      index = new PersistentMemoryIndex({
        databasePath,
        backgroundRefresh: false,
        queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      });
      await expect(
        index.refresh(roots, new AbortController().signal, { explicit: true }),
      ).resolves.toMatchObject({ kind: "complete" });
      await expect(
        index.query(roots, ["bravo"], new AbortController().signal),
      ).resolves.toMatchObject({
        kind: "complete",
        candidates: [{ canonicalPath: memoryPath }],
      });
    } finally {
      releaseRefresh.resolve();
      await inFlight.catch(() => undefined);
      index?.close();
      index = undefined;
    }
  });

  it("preserves caller cancellation when close races a foreground refresh", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-refresh-abort-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const memoryPath = join(memoryRoot, "refresh.md");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(memoryPath, "Aborting refresh", "refreshabort alpha");
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      beforeIncrementalReadForTesting: async () => {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      },
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    await writeMemory(memoryPath, "Aborting refresh", "refreshabort bravo");
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "refresh.md",
      kind: "update",
    });
    const callerController = new AbortController();
    const callerReason = new Error("caller cancelled the refresh");
    const inFlight = index.refresh(roots, callerController.signal);
    try {
      await refreshStarted.promise;
      callerController.abort(callerReason);
      index.close();
      index = undefined;
      releaseRefresh.resolve();
      await expect(inFlight).rejects.toBe(callerReason);
    } finally {
      releaseRefresh.resolve();
      await inFlight.catch(() => undefined);
      index?.close();
      index = undefined;
    }
  });

  it("does not cancel a staging refresh through a closed SQLite handle", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-cancel-close-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_001);
    const firstSlice = await index
      .refresh(roots, new AbortController().signal)
      .finally(() => clock.mockRestore());
    expect(firstSlice.kind).toBe("refresh_pending");
    const generationToken = firstSlice.roots[0]?.generationToken;
    expect(generationToken).toBeTypeOf("string");

    const closingIndex = index;
    const cancellation = closingIndex.cancelRefresh(generationToken!);
    closingIndex.close();
    index = undefined;
    await expect(cancellation).resolves.toBe(false);
    await expect(closingIndex.cancelRefresh(generationToken!)).resolves.toBe(
      false,
    );

    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    await expect(
      index.refresh(roots, new AbortController().signal, { explicit: true }),
    ).resolves.toMatchObject({ kind: "complete" });
  });

  it("cancels an in-flight audit before closing SQLite", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-audit-close-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(
      join(memoryRoot, "audit.md"),
      "Closing audit",
      "auditcloseterm",
    );
    const auditStarted = Promise.withResolvers<void>();
    const releaseAudit = Promise.withResolvers<void>();
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      beforeAuditReadForTesting: async () => {
        auditStarted.resolve();
        await releaseAudit.promise;
      },
    });
    const root = { path: memoryRoot, role: "project" as const };
    await index.refresh([root], new AbortController().signal, {
      explicit: true,
    });
    const closingIndex = index;
    const inFlight = closingIndex.auditSlice(
      root,
      new AbortController().signal,
    );
    try {
      await auditStarted.promise;
      closingIndex.close();
      index = undefined;
      releaseAudit.resolve();
      await expect(inFlight).resolves.toMatchObject({
        canonicalRoot: memoryRoot,
        role: "project",
        state: "unavailable",
        reason: "memory index is closed",
      });
      await expect(
        closingIndex.auditSlice(root, new AbortController().signal),
      ).resolves.toMatchObject({
        state: "unavailable",
        reason: "memory index is closed",
      });
    } finally {
      releaseAudit.resolve();
      await inFlight.catch(() => undefined);
      index?.close();
      index = undefined;
    }
  });

  it("returns refresh pending when a reader outlives the incremental drain bound", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-query-race-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const memoryPath = join(memoryRoot, "query.md");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(memoryPath, "Query race", "querygenerationterm alpha");

    const queryPool = new MemoryQueryProcessPool({ helperEntrypoint });
    const runQuery = queryPool.query.bind(queryPool);
    let markStarted!: () => void;
    let releaseQuery!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    let queryCalls = 0;
    vi.spyOn(queryPool, "query").mockImplementation(
      async (request, signal) => {
        queryCalls += 1;
        if (queryCalls === 1) {
          markStarted();
          await blocked;
        }
        return await runQuery(request, signal);
      },
    );
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool,
    });
    const writer = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      resourceLimitsForTesting: { incrementalReaderDrainMs: 50 },
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const selectedGeneration = readCurrentGenerationId(databasePath);

    const inFlight = index.query(
      roots,
      ["querygenerationterm"],
      new AbortController().signal,
    );
    await started;
    try {
      expect(readReaderPinState(databasePath, selectedGeneration)).toEqual({
        generationPresent: true,
        pinCount: 1,
      });
      await writeMemory(
        memoryPath,
        "Query race updated",
        "querygenerationterm bravo",
      );
      writer.recordChange({
        rootPath: memoryRoot,
        relativePath: "query.md",
        kind: "update",
      });
      await expect(
        writer.refresh(roots, new AbortController().signal),
      ).resolves.toMatchObject({
        kind: "refresh_pending",
        roots: [
          {
            reason:
              "memory index update is waiting for an active reader or writer",
          },
        ],
      });
      expect(readCurrentGenerationId(databasePath)).toBe(selectedGeneration);
      expect(readReaderPinState(databasePath, selectedGeneration)).toEqual({
        generationPresent: true,
        pinCount: 1,
      });
      releaseQuery();
      const result = await inFlight;
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        canonicalPath: memoryPath,
        description: "querygenerationterm alpha",
        generationId: selectedGeneration,
      });
      expect(index.readHeader(result.candidates[0]!)).toMatchObject({
        title: "Query race",
        description: "querygenerationterm alpha",
      });
      expect(queryCalls).toBe(1);
      expect(readReaderPinState(databasePath, selectedGeneration)).toEqual({
        generationPresent: true,
        pinCount: 0,
      });

      await expectEventually(async () => {
        const postPinRefresh = await writer.refresh(
          roots,
          new AbortController().signal,
        );
        if (postPinRefresh.kind === "complete") return true;
        expect(postPinRefresh.kind).toBe("refresh_pending");
        expect(postPinRefresh.roots[0]).toMatchObject({
          generationId: selectedGeneration,
          state: "refresh_pending",
        });
        expect([
          undefined,
          "memory index build slice is already active",
          "memory index update is waiting for an active reader or writer",
        ]).toContain(postPinRefresh.roots[0]?.reason);
        expect(readCurrentGenerationId(databasePath)).toBe(selectedGeneration);
        return false;
      });
      expect(readCurrentGenerationId(databasePath)).toBe(selectedGeneration);
      const updated = await writer.query(
        roots,
        ["querygenerationterm"],
        new AbortController().signal,
      );
      expect(updated.candidates[0]).toMatchObject({
        description: "querygenerationterm bravo",
        generationId: selectedGeneration,
      });
    } finally {
      releaseQuery();
      writer.close();
    }
  });

  it("lands an incremental update after overlapping readers outlive the prior drain bound", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-reader-stream-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const memoryPath = join(memoryRoot, "streamed.md");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(
      memoryPath,
      "Reader stream",
      "readerstreamterm alpha",
    );

    const queryPool = new MemoryQueryProcessPool({ helperEntrypoint });
    const runQuery = queryPool.query.bind(queryPool);
    const releaseReaders = Promise.withResolvers<void>();
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(queryPool, "query").mockImplementation(
      async (request, signal) => {
        await releaseReaders.promise;
        return await runQuery(request, signal);
      },
    );
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool,
    });
    const writer = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      beforeIncrementalReadForTesting: () => {
        releaseTimer = setTimeout(() => releaseReaders.resolve(), 1_100);
      },
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const generationId = readCurrentGenerationId(databasePath);

    const readers: Promise<unknown>[] = [];
    let streaming = true;
    const stream = (async () => {
      while (streaming) {
        readers.push(
          index!.query(
            roots,
            ["readerstreamterm"],
            new AbortController().signal,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    try {
      await expectEventually(async () =>
        readReaderPinState(databasePath, generationId).pinCount >= 2,
      );
      await writeMemory(
        memoryPath,
        "Reader stream",
        "readerstreamterm bravo",
      );
      writer.recordChange({
        rootPath: memoryRoot,
        relativePath: "streamed.md",
        kind: "update",
      });
      await expect(
        writer.refresh(roots, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "complete" });
      expect(readCurrentGenerationId(databasePath)).toBe(generationId);
    } finally {
      streaming = false;
      if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      releaseReaders.resolve();
      await stream;
      await Promise.allSettled(readers);
      writer.close();
    }

    const refreshed = await index.query(
      roots,
      ["readerstreamterm"],
      new AbortController().signal,
    );
    expect(refreshed.candidates).toHaveLength(1);
    expect(refreshed.candidates[0]).toMatchObject({
      description: "readerstreamterm bravo",
    });
  });

  it("renews an expired builder lease after reader drain before incremental preparation", async () => {
    temporaryRoot = await mkdtemp(
      join(realpathSync(tmpdir()), "agenc-c3b-lease-renewal-"),
    );
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const memoryPath = join(memoryRoot, "renewed.md");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(memoryPath, "Lease renewal", "leaserenewalterm alpha");

    let now = 1_000;
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const writer = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      beforeIncrementalReadForTesting: () => {
        now += MEMORY_INDEX_BUILD_LEASE_MS;
      },
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const generationId = readCurrentGenerationId(databasePath);

    try {
      await writeMemory(
        memoryPath,
        "Lease renewal",
        "leaserenewalterm bravo",
      );
      writer.recordChange({
        rootPath: memoryRoot,
        relativePath: "renewed.md",
        kind: "update",
      });
      await expect(
        writer.refresh(roots, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "complete" });
      expect(readCurrentGenerationId(databasePath)).toBe(generationId);

      const refreshed = await writer.query(
        roots,
        ["leaserenewalterm"],
        new AbortController().signal,
      );
      expect(refreshed.candidates[0]).toMatchObject({
        description: "leaserenewalterm bravo",
        generationId,
      });
    } finally {
      writer.close();
    }
  });

  it("atomically refuses every requested root while one current generation has a writer lease", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-writer-race-"));
    const stateRoot = join(temporaryRoot, "state");
    const globalRoot = join(temporaryRoot, "global-memory");
    const projectRoot = join(temporaryRoot, "project-memory");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(stateRoot, { recursive: true });
    await mkdir(globalRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeMemory(
      join(globalRoot, "global.md"),
      "Leased global",
      "writerfirstterm",
    );
    await writeMemory(
      join(projectRoot, "project.md"),
      "Available project",
      "writerfirstterm",
    );
    const roots = [
      { path: globalRoot, role: "global" as const },
      { path: projectRoot, role: "project" as const },
    ];
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const leasedGeneration = readGenerationIdForRoot(
      databasePath,
      globalRoot,
    );
    const otherGeneration = readGenerationIdForRoot(
      databasePath,
      projectRoot,
    );
    let markWriterStarted!: () => void;
    let releaseWriter!: () => void;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const writerBlocked = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      beforeIncrementalReadForTesting: async () => {
        markWriterStarted();
        await writerBlocked;
      },
    });
    await writeMemory(
      join(globalRoot, "global.md"),
      "Leased global updated",
      "writerfirstterm updated",
    );
    writer.recordChange({
      rootPath: globalRoot,
      relativePath: "global.md",
      kind: "update",
    });
    const writerRefresh = writer.refresh(
      roots,
      new AbortController().signal,
    );
    await writerStarted;
    try {
      const refused = await index.query(
        roots,
        ["writerfirstterm"],
        new AbortController().signal,
      );
      expect(refused).toMatchObject({
        kind: "unavailable",
        candidates: [],
        reason: "memory index update is in progress; retry the query",
      });
      expect(readReaderPinState(databasePath, leasedGeneration).pinCount).toBe(
        0,
      );
      expect(readReaderPinState(databasePath, otherGeneration).pinCount).toBe(
        0,
      );

      releaseWriter();
      await expect(writerRefresh).resolves.toMatchObject({ kind: "complete" });
      expect(readGenerationIdForRoot(databasePath, globalRoot)).toBe(
        leasedGeneration,
      );
      expect(readGenerationIdForRoot(databasePath, projectRoot)).toBe(
        otherGeneration,
      );

      const expiryDatabase = new Database(databasePath);
      try {
        expiryDatabase
          .prepare(
            `UPDATE memory_index_generations
                SET builder_owner = ?, builder_lease_expires_at_ms = 0
              WHERE id = ?`,
          )
          .run("expired-cross-instance-writer", leasedGeneration);
      } finally {
        expiryDatabase.close();
      }
      const afterExpiry = await index.query(
        roots,
        ["writerfirstterm"],
        new AbortController().signal,
      );
      expect(afterExpiry).toMatchObject({ kind: "complete" });
      expect(afterExpiry.candidates).toHaveLength(2);
    } finally {
      releaseWriter();
      await writerRefresh.catch(() => undefined);
      writer.close();
    }
  });

  it("discards helper output when an expired reader pin is reclaimed by an incremental writer", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-pin-loss-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    const memoryPath = join(memoryRoot, "query.md");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(memoryPath, "Pin loss", "pinlossterm alpha");
    let now = 1_000;
    const queryPool = new MemoryQueryProcessPool({ helperEntrypoint });
    const runQuery = queryPool.query.bind(queryPool);
    let markStarted!: () => void;
    let releaseQuery!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    vi.spyOn(queryPool, "query").mockImplementation(
      async (request, signal) => {
        markStarted();
        await blocked;
        return await runQuery(request, signal);
      },
    );
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool,
    });
    const writer = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const generationId = readCurrentGenerationId(databasePath);
    const inFlight = index.query(
      roots,
      ["pinlossterm"],
      new AbortController().signal,
    );
    await started;
    try {
      now = readReaderPinExpiry(databasePath, generationId);
      await writeMemory(memoryPath, "Pin loss updated", "pinlossterm bravo");
      writer.recordChange({
        rootPath: memoryRoot,
        relativePath: "query.md",
        kind: "update",
      });
      await expect(
        writer.refresh(roots, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "complete" });
      expect(readCurrentGenerationId(databasePath)).toBe(generationId);
      expect(readReaderPinState(databasePath, generationId).pinCount).toBe(0);
      releaseQuery();
      await expect(inFlight).resolves.toMatchObject({
        kind: "query_resource_limited",
        candidates: [],
        reason: "memory query reader snapshot lease expired before completion",
      });
    } finally {
      releaseQuery();
      writer.close();
    }
  });

  it("protects root cleanup with a live crash pin and reclaims it after expiry", async () => {
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-pin-expiry-"));
    const memoryRoot = join(temporaryRoot, "memory");
    const stateRoot = join(temporaryRoot, "state");
    const databasePath = join(stateRoot, "memory.sqlite");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeMemory(
      join(memoryRoot, "pinned.md"),
      "Pinned root",
      "pinnedrootterm",
    );
    let now = 1_000;
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    const roots = [{ path: memoryRoot, role: "project" as const }];
    await index.refresh(roots, new AbortController().signal, {
      explicit: true,
    });
    const generationId = readCurrentGenerationId(databasePath);
    const crashedReader = new Database(databasePath);
    try {
      crashedReader
        .prepare(
          `INSERT INTO memory_index_reader_pins(
             pin_id, generation_id, lease_expires_at_ms
           ) VALUES (?, ?, ?)`,
        )
        .run(
          "crashed-reader",
          generationId,
          now + MEMORY_INDEX_ROOT_IDLE_TTL_MS + 1,
        );
    } finally {
      crashedReader.close();
    }
    index.close();
    index = undefined;

    now += MEMORY_INDEX_ROOT_IDLE_TTL_MS;
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    expect(index.cleanupUnusedRoots()).toBe(0);
    index.close();
    index = undefined;

    const expiry = new Database(databasePath);
    try {
      expiry
        .prepare(
          "UPDATE memory_index_reader_pins SET lease_expires_at_ms = ? WHERE pin_id = ?",
        )
        .run(now - 1, "crashed-reader");
    } finally {
      expiry.close();
    }
    index = new PersistentMemoryIndex({
      databasePath,
      backgroundRefresh: false,
      now: () => now,
      queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
    });
    expect(readReaderPinState(databasePath, generationId).pinCount).toBe(0);
    expect(index.cleanupUnusedRoots()).toBe(1);
  });

  it("observes an external update through the debounced watcher and refreshes atomically", async () => {
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

  it("applies rename and delete changes through the incremental writer exclusion", async () => {
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
    temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-resume-"));
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
    const discoveryBeforeRestart = readGenerationDiscoveryState(
      databasePath,
      generationToken!,
    );
    expect(discoveryBeforeRestart.persistedCount).toBe(
      discoveryBeforeRestart.rowCount,
    );
    expect(discoveryBeforeRestart.persistedCount).toBeGreaterThan(0);
    index.recordChange({
      rootPath: memoryRoot,
      relativePath: "replayed-missing.md",
      kind: "create",
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
    const discoveryAfterRestart = readGenerationDiscoveryState(
      databasePath,
      generationToken!,
    );
    expect(discoveryAfterRestart.persistedCount).toBe(
      discoveryAfterRestart.rowCount,
    );
    for (
      let slice = 0;
      slice < 4 && refresh.kind === "refresh_pending";
      slice += 1
    ) {
      index.close();
      index = new PersistentMemoryIndex({
        databasePath,
        backgroundRefresh: false,
        queryPool: new MemoryQueryProcessPool({ helperEntrypoint }),
      });
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
    expect(readGenerationDiscoveryState(databasePath, generationToken!)).toEqual(
      { persistedCount: 0, rowCount: 0 },
    );
  }, 5 * 60_000);
});

async function createFixture(): Promise<{
  readonly globalRoot: string;
  readonly projectRoot: string;
  readonly rootSpecs: readonly MemoryIndexRootSpec[];
}> {
  temporaryRoot = await mkdtemp(join(realpathSync(tmpdir()), "agenc-c3b-index-"));
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

function readCurrentGenerationId(databasePath: string): number {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare<[], { current_generation_id: number }>(
        `SELECT current_generation_id
           FROM memory_index_roots
          WHERE current_generation_id IS NOT NULL
          ORDER BY root_id
          LIMIT 1`,
      )
      .get()!.current_generation_id;
  } finally {
    database.close();
  }
}

function readCurrentGenerationLease(databasePath: string): {
  readonly builderOwner: string | null;
  readonly leaseExpiresAtMs: number | null;
} {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare<
        [],
        {
          builderOwner: string | null;
          leaseExpiresAtMs: number | null;
        }
      >(
        `SELECT g.builder_owner AS builderOwner,
                g.builder_lease_expires_at_ms AS leaseExpiresAtMs
           FROM memory_index_roots r
           JOIN memory_index_generations g ON g.id = r.current_generation_id
          WHERE r.current_generation_id IS NOT NULL
          ORDER BY r.root_id
          LIMIT 1`,
      )
      .get()!;
  } finally {
    database.close();
  }
}

function readGenerationIdForRoot(
  databasePath: string,
  canonicalRoot: string,
): number {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare<[string], { current_generation_id: number }>(
        `SELECT current_generation_id
           FROM memory_index_roots
          WHERE canonical_path = ? AND current_generation_id IS NOT NULL`,
      )
      .get(canonicalRoot)!.current_generation_id;
  } finally {
    database.close();
  }
}

function readReaderPinState(
  databasePath: string,
  generationId: number,
): { readonly generationPresent: boolean; readonly pinCount: number } {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const generationPresent =
      database
        .prepare<[number], { present: number }>(
          "SELECT 1 AS present FROM memory_index_generations WHERE id = ?",
        )
        .get(generationId) !== undefined;
    const pinCount = database
      .prepare<[number], { count: number }>(
        `SELECT COUNT(*) AS count FROM memory_index_reader_pins
          WHERE generation_id = ?`,
      )
      .get(generationId)!.count;
    return { generationPresent, pinCount };
  } finally {
    database.close();
  }
}

function readReaderPinExpiry(
  databasePath: string,
  generationId: number,
): number {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare<[number], { lease_expires_at_ms: number }>(
        `SELECT lease_expires_at_ms FROM memory_index_reader_pins
          WHERE generation_id = ?`,
      )
      .get(generationId)!.lease_expires_at_ms;
  } finally {
    database.close();
  }
}

function readGenerationChangeState(
  databasePath: string,
  generationId: number,
): { readonly changeCursor: number; readonly pendingChanges: number } {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare<[number], { changeCursor: number; pendingChanges: number }>(
        `SELECT g.change_cursor AS changeCursor,
                (
                  SELECT COUNT(*) FROM memory_index_change_log c
                   WHERE c.root_id = g.root_id
                     AND c.sequence > g.change_cursor
                ) AS pendingChanges
           FROM memory_index_generations g
          WHERE g.id = ?`,
      )
      .get(generationId)!;
  } finally {
    database.close();
  }
}

function readDatabasePageCount(databasePath: string): number {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return Number(database.pragma("page_count", { simple: true }));
  } finally {
    database.close();
  }
}

function readIndexedEntryCounts(
  databasePath: string,
  generationId: number,
): { readonly entries: number; readonly ftsEntries: number } {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const entries = database
      .prepare<[number], { count: number }>(
        "SELECT COUNT(*) AS count FROM memory_index_entries WHERE generation_id = ?",
      )
      .get(generationId)!.count;
    const ftsEntries = database
      .prepare<[number], { count: number }>(
        "SELECT COUNT(*) AS count FROM memory_fts WHERE generation_id = ?",
      )
      .get(generationId)!.count;
    return { entries, ftsEntries };
  } finally {
    database.close();
  }
}

function readGenerationDiscoveryState(
  databasePath: string,
  generationToken: string,
): { readonly persistedCount: number; readonly rowCount: number } {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare<
        [string],
        { persistedCount: number; rowCount: number }
      >(
        `SELECT g.discovered_file_count AS persistedCount,
                COUNT(d.relative_path) AS rowCount
           FROM memory_index_generations g
           LEFT JOIN memory_index_discovered_files d
             ON d.generation_id = g.id AND d.root_id = g.root_id
          WHERE g.generation_token = ?
          GROUP BY g.id`,
      )
      .get(generationToken)!;
  } finally {
    database.close();
  }
}

async function expectEventually(
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  // Filesystem and index-state convergence are not fast operations on a loaded
  // runner. The bound still exists to catch work that never finishes; it is not
  // a performance assertion.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("memory watcher did not converge before the test deadline");
}
