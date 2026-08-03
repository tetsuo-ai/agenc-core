import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  createFuzzyFileDiscoveryResult,
  entriesFromRipgrepPaths,
  canonicalizeFuzzyIndexRoot,
  discoverFuzzyFiles,
  estimateFuzzyIndexEntryStoreRetainedBytes,
  FuzzyIndexBuildCancelledError,
  FuzzyIndexSchemaError,
  FuzzyIndexSourceChangedError,
  FUZZY_FILE_INDEX_POLICY_ID,
  FUZZY_FILE_INDEX_SCHEMA_VERSION,
  fuzzyIndexRootKey,
  MAX_FUZZY_INDEXED_ROOTS,
  openPersistentFuzzyFileIndex,
  PersistentFuzzyFileIndex,
  type FuzzyIndexedEntry,
  type FuzzyIndexSnapshot,
} from "../../src/app-server/fuzzy-file-index.js";
import { gitExe } from "../../src/utils/git.js";
import {
  MAX_FUZZY_CANDIDATES,
  MAX_FUZZY_CANDIDATE_UTF8_BYTES,
  MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES,
} from "../../src/search/fuzzy-match.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const LEGACY_V2_PROJECT_DIGEST =
  "5156e229effb835a601593dc91fbdeffc50a0754db8b31915753424b126f73e1";
const LEGACY_V2_PROJECT_FINGERPRINTS = [
  "73832b0709da0bec6e72d37eafb82b8c7e262747dc0eb85bcf2e0903b86e006c",
  "41e8c5c12be30ea11c8db770e60807b749f80e63b075008f18280a01bae231a9",
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("persistent fuzzy-file generations", () => {
  test("fits the exact million-entry and byte ceilings in compact storage", () => {
    const retainedBytes = estimateFuzzyIndexEntryStoreRetainedBytes(
      MAX_FUZZY_CANDIDATES,
      MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES,
      MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES,
    );

    expect(retainedBytes).toBe(277_436_296);
    expect(retainedBytes).toBeLessThan(536_870_912);
  });

  test("uses exact unpooled backing for small and empty retained arenas", async () => {
    const small = await ownedDiscovery([entry("a.ts")]);
    const empty = await ownedDiscovery([]);

    expect(small.entryStore.pathBytes).toBeLessThan(Buffer.poolSize >>> 1);
    expect(small.entryStore.arenaBackingBytes).toBe(
      small.entryStore.pathBytes + small.entryStore.candidateBytes,
    );
    expect(empty.entryStore.arenaBackingBytes).toBe(0);
  });

  test.skipIf(process.platform !== "linux")(
    "preserves normalization-sensitive filesystem root identities",
    async () => {
      const allocation = await temporaryRoot("agenc-fuzzy-unicode-root-");
      const nfcRoot = join(allocation, "\u00e9");
      const nfdRoot = join(allocation, "e\u0301");
      await Promise.all([mkdir(nfcRoot), mkdir(nfdRoot)]);

      const canonicalNfcRoot = await canonicalizeFuzzyIndexRoot(nfcRoot);
      const canonicalNfdRoot = await canonicalizeFuzzyIndexRoot(nfdRoot);

      expect(canonicalNfcRoot).toBe(nfcRoot);
      expect(canonicalNfdRoot).toBe(nfdRoot);
      expect(canonicalNfdRoot).not.toBe(canonicalNfcRoot);
      expect(fuzzyIndexRootKey(canonicalNfdRoot)).not.toBe(
        fuzzyIndexRootKey(canonicalNfcRoot),
      );
    },
  );

  test("publishes one complete immutable generation and recovers it after restart", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/project";
    const firstEntries = [entry("src", "directory"), entry("src/alpha.ts")];
    const store = new PersistentFuzzyFileIndex({
      databasePath,
      now: () => 1_000,
    });

    const first = await store.publish(
      root,
      await ownedDiscovery(firstEntries),
      new AbortController().signal,
    );
    expect(first).toMatchObject({
      canonicalRoot: root,
      builtAtMs: 1_000,
      entryCount: 2,
      truncated: false,
    });
    // Frozen from the schema-v2 implementation at 06bd552: compact hydration
    // must not silently fork the persisted fingerprint or generation digest.
    expect(first?.digest).toBe(LEGACY_V2_PROJECT_DIGEST);
    const legacyInspection = new Database(databasePath, { readonly: true });
    expect(
      legacyInspection
        .prepare("SELECT fingerprint FROM fuzzy_index_entries ORDER BY ordinal")
        .all()
        .map((row) => (row as { readonly fingerprint: string }).fingerprint),
    ).toEqual(LEGACY_V2_PROJECT_FINGERPRINTS);
    legacyInspection.close();
    store.close();

    const restarted = new PersistentFuzzyFileIndex({ databasePath });
    const recovered = await restarted.readCurrent(root);
    expect(recovered?.generationId).toBe(first?.generationId);
    expect(entryPaths(recovered)).toEqual(["src", "src/alpha.ts"]);
    expect(Object.isFrozen(recovered?.entryStore)).toBe(true);
    expect("pathViewAt" in (recovered?.entryStore ?? {})).toBe(false);
    const mutableCopy = recovered?.entryStore.pathBytesAt(1);
    mutableCopy?.fill(0);
    expect(recovered?.entryStore.pathBytesAt(1).toString("utf8")).toBe(
      "src/alpha.ts",
    );
    restarted.close();

    if (process.platform !== "win32") {
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    }
  });

  test("retains the preceding generation when a refresh is cancelled", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/cancelled";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const first = await store.publish(
      root,
      await ownedDiscovery([entry("alpha.ts")]),
      new AbortController().signal,
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.publish(
        root,
        await ownedDiscovery([entry("beta.ts")]),
        controller.signal,
      ),
    ).rejects.toThrow(FuzzyIndexBuildCancelledError);
    expect((await store.readCurrent(root))?.generationId).toBe(
      first?.generationId,
    );
    expect(entryPaths(await store.readCurrent(root))).toEqual(["alpha.ts"]);
    store.close();
  });

  test("rejects a forged wrapper around an owned compact entry store", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/forged-discovery";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const boundedPrefix = await ownedDiscovery([entry("prefix.ts")], true);
    const forgedComplete = Object.freeze({
      ...boundedPrefix,
      truncated: false,
    });

    await expect(
      store.publish(root, forgedComplete, new AbortController().signal),
    ).rejects.toThrow(/AgenC-owned immutable storage/u);
    const database = new Database(databasePath, { readonly: true });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM fuzzy_index_generations")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
    store.close();
  });

  test("captures bounded-discovery metadata before an ownership-transfer yield", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/mutated-discovery-metadata";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const batch = {
      entries: Array.from({ length: 513 }, (_, index) =>
        entry(`entry-${index.toString().padStart(4, "0")}.ts`),
      ),
      truncated: true,
      directoryCoverage: "nonempty_only" as const,
    };
    const transfer = createFuzzyFileDiscoveryResult(
      batch,
      new AbortController().signal,
    );
    queueMicrotask(() => {
      batch.truncated = false;
    });
    const discovery = await transfer;

    expect(discovery.truncated).toBe(true);
    await expect(
      store.publish(root, discovery, new AbortController().signal),
    ).rejects.toThrow(/refusing to publish a prefix/u);
    expect(await store.readCurrent(root)).toBeNull();
    store.close();
  });

  test("cancels bounded hydration without invalidating the valid generation", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/cancelled-hydration";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const entries = Array.from({ length: 2_000 }, (_, index) =>
      entry(`entry-${index.toString().padStart(4, "0")}.ts`),
    );
    const published = await store.publish(
      root,
      await ownedDiscovery(entries),
      new AbortController().signal,
    );
    const controller = new AbortController();
    const reading = store.readCurrent(root, controller.signal);
    queueMicrotask(() => controller.abort());

    await expect(reading).rejects.toThrow(FuzzyIndexBuildCancelledError);
    expect((await store.readCurrent(root))?.generationId).toBe(
      published?.generationId,
    );
    store.close();
  });

  test("does not begin a generation when ownership transfer is cancelled", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/cancelled-preprocessing";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const controller = new AbortController();
    const transfer = createFuzzyFileDiscoveryResult(
      {
        entries: Array.from({ length: 2_000 }, (_, index) =>
          entry(`entry-${index.toString().padStart(4, "0")}.ts`),
        ),
        truncated: false,
      },
      controller.signal,
    );
    queueMicrotask(() => controller.abort());

    await expect(transfer).rejects.toThrow(FuzzyIndexBuildCancelledError);
    const database = new Database(databasePath, { readonly: true });
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM fuzzy_index_generations WHERE state = 'staging'",
        )
        .get(),
    ).toEqual({ count: 0 });
    database.close();
    expect(await store.readCurrent(root)).toBeNull();
    store.close();
  });

  test("does not retain caller-owned entry buffers after ownership transfer", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/mutated-preprocessing";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const entries = Array.from({ length: 513 }, (_, index) =>
      entry(`entry-${index.toString().padStart(4, "0")}.ts`),
    );
    const discovery = await ownedDiscovery(entries);
    entries[0]!.pathBytes.fill(0);

    await expect(
      store.publish(root, discovery, new AbortController().signal),
    ).resolves.toMatchObject({ entryCount: 513 });
    expect(entryPaths(await store.readCurrent(root))).toContain(
      "entry-0000.ts",
    );
    store.close();
  });

  test("keeps an acquired reader snapshot immutable while another connection publishes", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/concurrent";
    const writer = new PersistentFuzzyFileIndex({ databasePath });
    const reader = new PersistentFuzzyFileIndex({ databasePath });
    await writer.publish(
      root,
      await ownedDiscovery([entry("first.ts")]),
      new AbortController().signal,
    );
    const acquired = await reader.readCurrent(root);

    await writer.publish(
      root,
      await ownedDiscovery([entry("second.ts")]),
      new AbortController().signal,
    );

    expect(entryPaths(acquired)).toEqual(["first.ts"]);
    expect(entryPaths(await reader.readCurrent(root))).toEqual(["second.ts"]);
    reader.close();
    writer.close();
  });

  test("keeps the old generation queryable between bounded publication slices", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/sliced";
    const writer = new PersistentFuzzyFileIndex({ databasePath });
    const reader = new PersistentFuzzyFileIndex({ databasePath });
    await writer.publish(
      root,
      await ownedDiscovery([entry("old.ts")]),
      new AbortController().signal,
    );
    const nextEntries = Array.from({ length: 5_000 }, (_, index) =>
      entry(`generated/${index.toString().padStart(4, "0")}.ts`),
    );

    const publishing = writer.publish(
      root,
      await ownedDiscovery(nextEntries),
      new AbortController().signal,
      {
        sourceBoundary: "watch:7",
        isSourceBoundaryCurrent: () => true,
      },
    );

    expect(entryPaths(await reader.readCurrent(root))).toEqual(["old.ts"]);
    const published = await publishing;
    expect(published?.entryCount).toBe(5_000);
    expect((await reader.readCurrent(root))?.entryCount).toBe(5_000);
    reader.close();
    writer.close();
  });

  test("rejects an older writer superseded by a newer complete generation", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/superseded-writer";
    const olderWriter = new PersistentFuzzyFileIndex({ databasePath });
    const newerWriter = new PersistentFuzzyFileIndex({ databasePath });
    const olderEntries = Array.from({ length: 5_000 }, (_, index) =>
      entry(`older/${index.toString().padStart(4, "0")}.ts`),
    );

    const olderPublication = olderWriter.publish(
      root,
      await ownedDiscovery(olderEntries),
      new AbortController().signal,
    );
    const newer = await newerWriter.publish(
      root,
      await ownedDiscovery([entry("newer.ts")]),
      new AbortController().signal,
    );

    await expect(olderPublication).rejects.toThrow(
      FuzzyIndexSourceChangedError,
    );
    expect((await olderWriter.readCurrent(root))?.generationId).toBe(
      newer?.generationId,
    );
    expect(entryPaths(await olderWriter.readCurrent(root))).toEqual([
      "newer.ts",
    ]);
    newerWriter.close();
    olderWriter.close();
  });

  test("does not recover a live sliced writer whose progress heartbeat is current", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/live-writer";
    const progressHeartbeatMs = 250_000;
    const recoveryNowMs = 500_000;
    let activeBuild = false;
    let activeBuildClockReads = 0;
    const writer = new PersistentFuzzyFileIndex({
      databasePath,
      now: () => {
        if (!activeBuild) return 0;
        activeBuildClockReads += 1;
        return activeBuildClockReads === 1 ? 0 : progressHeartbeatMs;
      },
    });
    await writer.publish(
      root,
      await ownedDiscovery([entry("old.ts")]),
      new AbortController().signal,
    );
    activeBuild = true;
    const entries = Array.from({ length: 5_000 }, (_, index) =>
      entry(`live/${index}.ts`),
    );
    const publishing = writer.publish(
      root,
      await ownedDiscovery(entries),
      new AbortController().signal,
    );

    const concurrentOpener = new PersistentFuzzyFileIndex({
      databasePath,
      now: () => recoveryNowMs,
    });
    concurrentOpener.close();

    await expect(publishing).resolves.toMatchObject({ entryCount: 5_000 });
    writer.close();
  });

  test("reaps staging generations after grace during later root admission", async () => {
    const { databasePath } = await temporaryDatabase();
    const initializer = new PersistentFuzzyFileIndex({ databasePath });
    initializer.close();
    const database = new Database(databasePath);
    const insertRoot = database.prepare(
      `INSERT INTO fuzzy_index_roots
         (root_key, canonical_root, policy_id, current_generation_id,
          last_access_at_ms)
       VALUES (?, ?, ?, NULL, 0)`,
    );
    const insertGeneration = database.prepare(
      `INSERT INTO fuzzy_index_generations
         (root_key, state, started_at_ms, completed_at_ms, entry_count,
          path_bytes, digest, truncated, source_boundary, directory_coverage,
          inserted_count, inserted_path_bytes, heartbeat_at_ms, error_text)
       VALUES (?, 'staging', 0, NULL, NULL, NULL, NULL, 0, 'test',
               'nonempty_only', 0, 0, 0, '')`,
    );
    database.transaction(() => {
      for (let index = 0; index < MAX_FUZZY_INDEXED_ROOTS; index += 1) {
        const root = `/interrupted-${index}`;
        const rootKey = fuzzyIndexRootKey(root);
        insertRoot.run(rootKey, root, FUZZY_FILE_INDEX_POLICY_ID);
        insertGeneration.run(rootKey);
      }
    })();
    database.close();

    let nowMs = 100_000;
    const store = new PersistentFuzzyFileIndex({
      databasePath,
      now: () => nowMs,
    });
    nowMs = 300_001;
    await expect(
      store.publish(
        "/replacement",
        await ownedDiscovery([entry("replacement.ts")]),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ entryCount: 1 });
    store.close();

    const inspection = new Database(databasePath, { readonly: true });
    expect(
      inspection
        .prepare(
          "SELECT count(*) AS count FROM fuzzy_index_generations WHERE state = 'staging'",
        )
        .get(),
    ).toEqual({ count: 0 });
    inspection.close();
  });

  test("cancels between slices and rejects a changed source boundary without cutover", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/bounded-cancel";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const original = await store.publish(
      root,
      await ownedDiscovery([entry("original.ts")]),
      new AbortController().signal,
    );
    const entries = Array.from({ length: 5_000 }, (_, index) =>
      entry(`slice/${index}.ts`),
    );
    const controller = new AbortController();
    const cancelled = store.publish(
      root,
      await ownedDiscovery(entries),
      controller.signal,
    );
    queueMicrotask(() => controller.abort());

    await expect(cancelled).rejects.toThrow(FuzzyIndexBuildCancelledError);
    expect((await store.readCurrent(root))?.generationId).toBe(
      original?.generationId,
    );
    await expect(
      store.publish(
        root,
        await ownedDiscovery([entry("changed.ts")]),
        new AbortController().signal,
        { isSourceBoundaryCurrent: () => false },
      ),
    ).rejects.toThrow(/source changed/u);
    expect((await store.readCurrent(root))?.generationId).toBe(
      original?.generationId,
    );
    await expect(
      store.publish(
        root,
        await ownedDiscovery([entry("prefix.ts")], true),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/refusing to publish a prefix/u);

    const tamper = new Database(databasePath);
    await expect(
      store.publish(
        root,
        await ownedDiscovery([entry("progress.ts")]),
        new AbortController().signal,
        {
          isSourceBoundaryCurrent: () => {
            tamper
              .prepare(
                `UPDATE fuzzy_index_generations
                    SET inserted_count = -1
                  WHERE state = 'staging'`,
              )
              .run();
            return true;
          },
        },
      ),
    ).rejects.toThrow(/changed state before publication/u);
    tamper.close();
    expect((await store.readCurrent(root))?.generationId).toBe(
      original?.generationId,
    );
    const inspection = new Database(databasePath, { readonly: true });
    expect(
      inspection
        .prepare(
          "SELECT count(*) AS count FROM fuzzy_index_generations WHERE state != 'complete'",
        )
        .get(),
    ).toEqual({ count: 0 });
    inspection.close();
    store.close();
  });

  test("rejects a tampered generation instead of serving mixed or corrupt rows", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/tampered";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    await store.publish(
      root,
      await ownedDiscovery([entry("authentic.ts")]),
      new AbortController().signal,
    );
    store.close();

    const database = new Database(databasePath);
    database
      .prepare("UPDATE fuzzy_index_entries SET relative_path = ?")
      .run("tampered.ts");
    database.close();

    const reader = new PersistentFuzzyFileIndex({ databasePath });
    expect(await reader.readCurrent(root)).toBeNull();
    expect(await reader.readCurrent(root)).toBeNull();
    reader.close();
  });

  test("rejects an extra row beyond the declared generation count", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/extra-row";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const published = await store.publish(
      root,
      await ownedDiscovery([]),
      new AbortController().signal,
    );
    store.close();

    const database = new Database(databasePath);
    database
      .prepare(
        `INSERT INTO fuzzy_index_entries
           (generation_id, ordinal, relative_path, path_bytes, entry_type,
            fingerprint)
         VALUES (?, 0, 'extra.ts', ?, 'file', 'tampered')`,
      )
      .run(published?.generationId, Buffer.from("extra.ts"));
    database.close();

    const reader = new PersistentFuzzyFileIndex({ databasePath });
    expect(await reader.readCurrent(root)).toBeNull();
    reader.close();
  });

  test("rejects a negative ordinal outside the declared generation range", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/negative-ordinal";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    const published = await store.publish(
      root,
      await ownedDiscovery([]),
      new AbortController().signal,
    );
    store.close();

    const database = new Database(databasePath);
    database
      .prepare(
        `INSERT INTO fuzzy_index_entries
           (generation_id, ordinal, relative_path, path_bytes, entry_type,
            fingerprint)
         VALUES (?, -1, 'negative.ts', ?, 'file', 'tampered')`,
      )
      .run(published?.generationId, Buffer.from("negative.ts"));
    database.close();

    const reader = new PersistentFuzzyFileIndex({ databasePath });
    expect(await reader.readCurrent(root)).toBeNull();
    reader.close();
  });

  test("invalidates an oversized persisted candidate before hydration", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/oversized-candidate";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    await store.publish(
      root,
      await ownedDiscovery([entry("authentic.ts")]),
      new AbortController().signal,
    );
    store.close();

    const database = new Database(databasePath);
    database
      .prepare("UPDATE fuzzy_index_entries SET relative_path = ?")
      .run("x".repeat(MAX_FUZZY_CANDIDATE_UTF8_BYTES + 1));
    database.close();

    const reader = new PersistentFuzzyFileIndex({ databasePath });
    expect(await reader.readCurrent(root)).toBeNull();
    expect(await reader.readCurrent(root)).toBeNull();
    reader.close();
  });

  test("invalidates persisted text whose decoded UTF-8 exceeds its measured arena", async () => {
    const { databasePath } = await temporaryDatabase();
    const root = "/portable/invalid-utf8-text";
    const store = new PersistentFuzzyFileIndex({ databasePath });
    await store.publish(
      root,
      await ownedDiscovery([entry("authentic.ts")]),
      new AbortController().signal,
    );
    store.close();

    const database = new Database(databasePath);
    database
      .prepare(
        "UPDATE fuzzy_index_entries SET relative_path = CAST(x'80' AS TEXT)",
      )
      .run();
    database.close();

    const reader = new PersistentFuzzyFileIndex({ databasePath });
    expect(await reader.readCurrent(root)).toBeNull();
    expect(await reader.readCurrent(root)).toBeNull();
    reader.close();
  });

  test("quarantines corrupt or future derived schemas and migrates schema one", async () => {
    const unreadable = await temporaryDatabase();
    await writeFile(unreadable.databasePath, "not a sqlite database");
    const recovered = openPersistentFuzzyFileIndex({
      databasePath: unreadable.databasePath,
    });
    recovered.close();
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(unreadable.root),
    );
    expect(files.some((name) => name.startsWith("index.sqlite.corrupt-"))).toBe(
      true,
    );

    const future = await temporaryDatabase();
    const database = new Database(future.databasePath);
    database.pragma("user_version = 99");
    database.close();
    expect(
      () => new PersistentFuzzyFileIndex({ databasePath: future.databasePath }),
    ).toThrow(FuzzyIndexSchemaError);
    const rebuilt = openPersistentFuzzyFileIndex({
      databasePath: future.databasePath,
    });
    rebuilt.close();
    const rebuiltDatabase = new Database(future.databasePath);
    expect(rebuiltDatabase.pragma("user_version", { simple: true })).toBe(
      FUZZY_FILE_INDEX_SCHEMA_VERSION,
    );
    rebuiltDatabase.close();

    const legacy = await temporaryDatabase();
    const legacyDatabase = new Database(legacy.databasePath);
    legacyDatabase.exec(`
      CREATE TABLE fuzzy_index_roots (
        root_key TEXT PRIMARY KEY,
        canonical_root TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        current_generation_id INTEGER
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    legacyDatabase.close();
    const migrated = new PersistentFuzzyFileIndex({
      databasePath: legacy.databasePath,
    });
    migrated.close();
    const migratedDatabase = new Database(legacy.databasePath);
    expect(migratedDatabase.pragma("user_version", { simple: true })).toBe(
      FUZZY_FILE_INDEX_SCHEMA_VERSION,
    );
    expect(
      migratedDatabase
        .prepare("SELECT name FROM pragma_table_info('fuzzy_index_roots')")
        .all()
        .map((row) => (row as { readonly name: string }).name),
    ).toContain("last_access_at_ms");
    migratedDatabase.close();

    const partial = await temporaryDatabase();
    const partialDatabase = new Database(partial.databasePath);
    partialDatabase.exec(`
      CREATE TABLE fuzzy_index_roots (
        root_key TEXT PRIMARY KEY,
        canonical_root TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        current_generation_id INTEGER,
        last_access_at_ms INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    partialDatabase.close();

    const resumed = new PersistentFuzzyFileIndex({
      databasePath: partial.databasePath,
    });
    resumed.close();
    const reopened = new PersistentFuzzyFileIndex({
      databasePath: partial.databasePath,
    });
    reopened.close();
    const resumedDatabase = new Database(partial.databasePath);
    expect(resumedDatabase.pragma("user_version", { simple: true })).toBe(
      FUZZY_FILE_INDEX_SCHEMA_VERSION,
    );
    expect(
      resumedDatabase
        .prepare(
          "SELECT count(*) AS count FROM pragma_table_info('fuzzy_index_roots') WHERE name = 'last_access_at_ms'",
        )
        .get(),
    ).toEqual({ count: 1 });
    resumedDatabase.close();
  });

  test("bounds persistent roots with idle and least-recently-used eviction", async () => {
    const { databasePath } = await temporaryDatabase();
    let nowMs = 0;
    const store = new PersistentFuzzyFileIndex({
      databasePath,
      now: () => nowMs,
      idleTtlMs: 100,
    });
    await store.publish(
      "/idle-root",
      await ownedDiscovery([entry("idle.ts")]),
      new AbortController().signal,
    );
    nowMs = 101;
    await store.publish(
      "/replacement-root",
      await ownedDiscovery([entry("replacement.ts")]),
      new AbortController().signal,
    );
    expect(await store.readCurrent("/idle-root")).toBeNull();
    store.close();

    nowMs = 0;
    const lruDatabase = await temporaryDatabase();
    const lruStore = new PersistentFuzzyFileIndex({
      databasePath: lruDatabase.databasePath,
      now: () => nowMs,
    });
    for (let index = 0; index < MAX_FUZZY_INDEXED_ROOTS; index += 1) {
      nowMs = index;
      await lruStore.publish(
        `/root-${index}`,
        await ownedDiscovery([entry(`file-${index}.ts`)]),
        new AbortController().signal,
      );
    }
    nowMs = MAX_FUZZY_INDEXED_ROOTS + 1;
    expect(await lruStore.readCurrent("/root-0")).not.toBeNull();
    nowMs += 1;
    await lruStore.publish(
      "/root-overflow",
      await ownedDiscovery([entry("overflow.ts")]),
      new AbortController().signal,
    );
    expect(await lruStore.readCurrent("/root-0")).not.toBeNull();
    expect(await lruStore.readCurrent("/root-1")).toBeNull();
    expect(await lruStore.readCurrent("/root-overflow")).not.toBeNull();
    lruStore.close();
  });

  test("normalizes Windows separators and renders undecodable path bytes safely", () => {
    const invalidPath = Buffer.from([
      0x73, 0x72, 0x63, 0x2f, 0xff, 0x2e, 0x74, 0x73,
    ]);
    const result = entriesFromRipgrepPaths(
      [Buffer.from(String.raw`src\windows\file.ts`), invalidPath],
      "win32",
    );

    expect(result.truncated).toBe(false);
    expect(result.directoryCoverage).toBe("nonempty_only");
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "src/windows/file.ts",
          matchType: "file",
        }),
        expect.objectContaining({
          relativePath: String.raw`src/\xff.ts [path-encoding=bytes]`,
          matchType: "file",
        }),
        expect.objectContaining({
          relativePath: "src/windows",
          matchType: "directory",
        }),
      ]),
    );
  });

  test("rejects Windows drive, drive-relative, and alternate-stream records", () => {
    for (const path of [
      String.raw`C:\outside.ts`,
      "C:/outside.ts",
      "C:outside.ts",
      "inside.ts:stream",
    ]) {
      expect(() =>
        entriesFromRipgrepPaths([Buffer.from(path)], "win32"),
      ).toThrow(/outside the canonical root/u);
    }
  });

  test("stops lazily on a separator-dense candidate at the byte boundary", () => {
    const densePath = Buffer.from(
      "a/".repeat(MAX_FUZZY_CANDIDATE_UTF8_BYTES / 2),
    );

    expect(densePath.byteLength).toBe(MAX_FUZZY_CANDIDATE_UTF8_BYTES);
    expect(entriesFromRipgrepPaths([densePath], "linux")).toMatchObject({
      entries: [],
      truncated: true,
    });
  });

  test("uses Git's tracked and standard-ignore byte surface and includes empty directories", async () => {
    const root = await temporaryRoot("agenc-fuzzy-git-");
    const home = await temporaryRoot("agenc-fuzzy-git-home-");
    const globalExcludes = join(home, "global-excludes");
    const environment = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "xdg"),
    };
    const poisonedEnvironment = {
      ...environment,
      GIT_DIR: join(root, "poisoned-git-dir"),
      GIT_WORK_TREE: join(root, "poisoned-work-tree"),
    };
    await runGit(root, ["init"], environment);
    await writeFile(globalExcludes, "global-only.txt\n", "utf8");
    await runGit(
      root,
      ["config", "--global", "core.excludesFile", globalExcludes],
      environment,
    );
    await Promise.all([
      writeFile(join(root, ".gitignore"), "ignored-only.txt\nignored-dir/\n"),
      writeFile(join(root, "tracked-ignored.txt"), "tracked\n"),
      writeFile(join(root, "tracked-deleted.txt"), "deleted\n"),
      writeFile(join(root, "visible-untracked.txt"), "visible\n"),
      writeFile(join(root, "ignored-only.txt"), "ignored\n"),
      writeFile(join(root, "global-only.txt"), "global\n"),
      writeFile(join(root, "info-only.txt"), "info\n"),
      mkdir(join(root, "visible-empty")),
      mkdir(join(root, "ignored-dir")),
    ]);
    await writeFile(join(root, ".git", "info", "exclude"), "info-only.txt\n");
    await runGit(
      root,
      ["add", "--force", "tracked-ignored.txt", "tracked-deleted.txt"],
      environment,
    );
    await unlink(join(root, "tracked-deleted.txt"));

    const result = await discoverFuzzyFiles(
      root,
      new AbortController().signal,
      { gitProgram: gitExe(), environment: poisonedEnvironment },
    );
    const files = result.entries
      .filter((value) => value.matchType === "file")
      .map((value) => value.relativePath);
    const directories = result.entries
      .filter((value) => value.matchType === "directory")
      .map((value) => value.relativePath);

    expect(files).toEqual(
      expect.arrayContaining(["tracked-ignored.txt", "visible-untracked.txt"]),
    );
    expect(files).not.toEqual(
      expect.arrayContaining([
        "tracked-deleted.txt",
        "ignored-only.txt",
        "global-only.txt",
        "info-only.txt",
      ]),
    );
    expect(directories).toContain("visible-empty");
    expect(directories).not.toContain("ignored-dir");
    expect(result.truncated).toBe(false);
  });

  test("honors the common Git directory from a linked worktree", async () => {
    const allocation = await temporaryRoot("agenc-fuzzy-worktree-");
    const repository = join(allocation, "repository");
    const linked = join(allocation, "linked");
    await mkdir(repository);
    await runGit(repository, ["init"]);
    await runGit(repository, ["config", "user.name", "AgenC Test"]);
    await runGit(repository, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(repository, "seed.txt"), "seed\n");
    await runGit(repository, ["add", "seed.txt"]);
    await runGit(repository, ["commit", "-m", "seed"]);
    await writeFile(
      join(repository, ".git", "info", "exclude"),
      "common-excluded.txt\n",
    );
    await runGit(repository, ["worktree", "add", "--detach", linked]);
    await Promise.all([
      writeFile(join(linked, "common-excluded.txt"), "excluded\n"),
      writeFile(join(linked, "visible.txt"), "visible\n"),
    ]);

    const result = await discoverFuzzyFiles(
      linked,
      new AbortController().signal,
      { gitProgram: gitExe() },
    );
    const files = result.entries
      .filter((value) => value.matchType === "file")
      .map((value) => value.relativePath);

    expect(files).toEqual(expect.arrayContaining(["seed.txt", "visible.txt"]));
    expect(files).not.toContain("common-excluded.txt");
    expect(result.directoryCoverage).toBe("nonempty_only");
  });

  test("reports incomplete directory coverage after a tracked deletion", async () => {
    const root = await temporaryRoot("agenc-fuzzy-deleted-directory-");
    await runGit(root, ["init"]);
    await runGit(root, ["config", "user.name", "AgenC Test"]);
    await runGit(root, ["config", "user.email", "test@example.invalid"]);
    await mkdir(join(root, "d"));
    await writeFile(join(root, "d", "a"), "tracked\n");
    await runGit(root, ["add", "d/a"]);
    await runGit(root, ["commit", "-m", "seed tracked directory"]);
    await unlink(join(root, "d", "a"));

    const result = await discoverFuzzyFiles(
      root,
      new AbortController().signal,
      { gitProgram: gitExe() },
    );

    expect(result.entries.map((value) => value.relativePath)).not.toContain(
      "d",
    );
    expect(result.directoryCoverage).toBe("nonempty_only");
  });
});

function entry(
  relativePath: string,
  matchType: FuzzyIndexedEntry["matchType"] = "file",
): FuzzyIndexedEntry {
  return {
    relativePath,
    pathBytes: Buffer.from(relativePath, "utf8"),
    matchType,
  };
}

function ownedDiscovery(
  entries: readonly FuzzyIndexedEntry[],
  truncated = false,
  directoryCoverage?: "complete" | "nonempty_only",
) {
  return createFuzzyFileDiscoveryResult(
    { entries, truncated, directoryCoverage },
    new AbortController().signal,
  );
}

function entryPaths(
  snapshot: FuzzyIndexSnapshot | null,
): readonly string[] | null {
  if (snapshot === null) return null;
  return Array.from({ length: snapshot.entryStore.entryCount }, (_, ordinal) =>
    snapshot.entryStore.relativePathAt(ordinal),
  );
}

async function temporaryDatabase(): Promise<{
  readonly root: string;
  readonly databasePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-fuzzy-index-"));
  temporaryRoots.push(root);
  return { root, databasePath: join(root, "index.sqlite") };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await execFileAsync(gitExe(), [...args], {
    cwd,
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
  });
}
