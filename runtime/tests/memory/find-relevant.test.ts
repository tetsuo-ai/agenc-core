import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const frozenMemoryStat = vi.hoisted(() => ({
  path: "",
  value: undefined as import("node:fs").BigIntStats | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) =>
      args[0] === frozenMemoryStat.path && frozenMemoryStat.value !== undefined
        ? frozenMemoryStat.value
        : Reflect.apply(actual.lstatSync, actual, args),
  };
});

import {
  closeFullCorpusMemoryIndexes,
  findRelevantMemories,
} from "../../src/memory/find-relevant.js";
import { PersistentMemoryIndex } from "../../src/memory/full-corpus-index.js";
import { MemoryQueryProcessPool } from "../../src/memory/memory-query-pool.js";
import type {
  AdmittedMemorySelector,
  MemorySelectorRequest,
} from "../../src/memory/recall-contract.js";

let temporaryRoot = "";

afterEach(async () => {
  closeFullCorpusMemoryIndexes();
  vi.restoreAllMocks();
  frozenMemoryStat.path = "";
  frozenMemoryStat.value = undefined;
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  }
});

/**
 * Enough extra matches to exceed MAX_RELEVANT_MEMORIES, so the selector is
 * consulted; below that bound recall stays lexical.
 */
async function fillerMemories(
  root: string,
  term: string,
  count = 5,
): Promise<string[]> {
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    paths.push(
      await memory(
        root,
        `filler-${index}.md`,
        `Filler ${index}`,
        `${term} filler ${index}`,
      ),
    );
  }
  return paths;
}

async function memory(
  root: string,
  name: string,
  title: string,
  description: string,
): Promise<string> {
  const path = join(root, name);
  await writeFile(
    path,
    [
      "---",
      `name: ${title}`,
      `description: ${description}`,
      "type: user",
      "---",
      "body",
    ].join("\n"),
    "utf8",
  );
  return path;
}

describe("C3a relevant memory selection", () => {
  it("restores production lexical recall without sideQuery authority", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const matching = await memory(
      temporaryRoot,
      "browser.md",
      "Browser automation",
      "Known browser launch gotchas",
    );
    await memory(temporaryRoot, "cooking.md", "Braising", "Cooking notes");

    const result = await findRelevantMemories(
      "browser automation",
      temporaryRoot,
      new AbortController().signal,
    );

    expect(result.map((entry) => entry.path)).toEqual([matching]);
  });

  it("skips the selector when the lexical ranking already fits the attachment limit", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const alpha = await memory(temporaryRoot, "alpha.md", "Alpha browser", "Browser notes");
    const beta = await memory(temporaryRoot, "beta.md", "Beta browser", "Browser warning");
    const select = vi.fn(async () => ({
      kind: "selected" as const,
      candidateIds: ["candidate-2"],
    }));

    const result = await findRelevantMemories({
      query: "browser",
      memoryDirs: [temporaryRoot],
      signal: new AbortController().signal,
      admittedMemorySelector: { select },
    });

    // Two candidates cannot be narrowed below the five-memory limit, so the
    // main-model round trip is skipped and both stay in lexical order.
    expect(select).not.toHaveBeenCalled();
    expect(new Set(result.map((entry) => entry.path))).toEqual(new Set([alpha, beta]));
    expect(result.every((entry) => entry.selectionSource === "lexical")).toBe(true);
  });

  it("passes only opaque candidates and accepts a validated selector subset", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    await memory(temporaryRoot, "alpha.md", "Alpha browser", "Browser notes");
    const beta = await memory(
      temporaryRoot,
      "beta.md",
      "Beta browser",
      "Browser warning",
    );
    await fillerMemories(temporaryRoot, "browser");
    let observed: MemorySelectorRequest | undefined;
    const selector: AdmittedMemorySelector = {
      select: vi.fn(async (request) => {
        observed = request;
        const betaCandidate = request.candidates.find(
          (candidate) => candidate.title === "Beta browser",
        );
        if (betaCandidate === undefined) {
          throw new Error("expected the beta memory in the admitted candidates");
        }
        return { kind: "selected", candidateIds: [betaCandidate.id] };
      }),
    };

    const result = await findRelevantMemories({
      query: "browser",
      memoryDirs: [temporaryRoot],
      signal: new AbortController().signal,
      admittedMemorySelector: selector,
    });

    expect(result.map((entry) => entry.path)).toEqual([beta]);
    expect(observed?.policy).toBe("agenc.memory-selector.v1");
    expect(
      observed?.candidates.map((candidate) => candidate.id).sort(),
    ).toEqual(Array.from({ length: 7 }, (_, index) => `candidate-${index + 1}`));
    expect(JSON.stringify(observed)).not.toContain(temporaryRoot);
  });

  it("uses lexical fallback for invented, duplicate, failed, or malformed selection", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const lexical = await memory(
      temporaryRoot,
      "exact.md",
      "exact browser automation",
      "Preferred",
    );
    await memory(temporaryRoot, "other.md", "browser", "Secondary");
    await fillerMemories(temporaryRoot, "browser");
    const outcomes = [
      { kind: "selected", candidateIds: ["invented"] } as const,
      { kind: "selected", candidateIds: ["candidate-1", "candidate-1"] } as const,
      { kind: "malformed" } as const,
      { kind: "timeout" } as const,
      { kind: "unavailable" } as const,
    ];

    for (const outcome of outcomes) {
      const result = await findRelevantMemories({
        query: "browser automation",
        memoryDirs: [temporaryRoot],
        signal: new AbortController().signal,
        admittedMemorySelector: { select: async () => outcome },
      });
      expect(result[0]?.path).toBe(lexical);
    }
  });

  it("honors a valid empty selection but never invokes the selector at session start", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    await mkdir(join(temporaryRoot, "nested"));
    const recent = await memory(
      temporaryRoot,
      "recent.md",
      "Recent",
      "Session context",
    );
    // Session-start recall is recency ranked: age the fillers so `recent`
    // stays inside the five-memory window while six candidates exist.
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    for (const filler of await fillerMemories(temporaryRoot, "session")) {
      await utimes(filler, oldTime, oldTime);
    }
    const select = vi.fn(async () => ({
      kind: "selected" as const,
      candidateIds: [],
    }));
    const selector: AdmittedMemorySelector = { select };

    await expect(
      findRelevantMemories({
        query: "session",
        memoryDirs: [temporaryRoot],
        signal: new AbortController().signal,
        admittedMemorySelector: selector,
      }),
    ).resolves.toEqual([]);
    const sessionStart = await findRelevantMemories({
      query: "",
      mode: "session_start",
      memoryDirs: [temporaryRoot],
      signal: new AbortController().signal,
      admittedMemorySelector: selector,
    });
    expect(sessionStart).toHaveLength(5);
    expect(sessionStart.map((entry) => entry.path)).toContain(recent);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("propagates the original abort reason across the selector layer", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    await memory(temporaryRoot, "browser.md", "Browser", "Browser notes");
    await fillerMemories(temporaryRoot, "browser");
    const controller = new AbortController();
    const reason = new Error("stop selector");
    const selector: AdmittedMemorySelector = {
      select: async () => {
        controller.abort(reason);
        throw reason;
      },
    };

    await expect(
      findRelevantMemories({
        query: "browser",
        memoryDirs: [temporaryRoot],
        signal: controller.signal,
        admittedMemorySelector: selector,
      }),
    ).rejects.toBe(reason);
  });

  it("does not open the full-corpus index when no memory directory exists", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const databasePath = join(temporaryRoot, "state", "memory-v1.sqlite");
    await mkdir(join(temporaryRoot, "state"));

    const result = await findRelevantMemories({
      query: "browser",
      memoryDirs: [join(temporaryRoot, "missing-global"), join(temporaryRoot, "missing-project")],
      signal: new AbortController().signal,
      memoryIndexDatabasePath: databasePath,
    });

    expect(result).toEqual([]);
    expect(existsSync(databasePath)).toBe(false);
  });

  /** A fresh root with an index path and the given memory directories. */
  async function emptyMemoryRoots(dirs: readonly string[]): Promise<{
    readonly databasePath: string;
    readonly memoryDirs: string[];
    recall(): ReturnType<typeof findRelevantMemories>;
  }> {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const databasePath = join(temporaryRoot, "state", "memory-v1.sqlite");
    await mkdir(join(temporaryRoot, "state"));
    const memoryDirs = dirs.map((dir) => join(temporaryRoot!, dir));
    for (const dir of memoryDirs) await mkdir(dir, { recursive: true });
    const signal = new AbortController().signal;
    return {
      databasePath,
      memoryDirs,
      recall: () =>
        findRelevantMemories({
          query: "browser",
          memoryDirs: memoryDirs.filter((dir) => !dir.endsWith("/logs")),
          signal,
          memoryIndexDatabasePath: databasePath,
        }),
    };
  }

  it("does not open the full-corpus index while every memory directory is empty", async () => {
    // Session startup creates both memory directories so the model can write
    // into them. Empty directories hold no memory, so recall must not pay for
    // the index refresh and its contained query helper process.
    const roots = await emptyMemoryRoots(["global", "project"]);

    expect(await roots.recall()).toEqual([]);
    expect(existsSync(roots.databasePath)).toBe(false);
  });

  it("uses the full-corpus index as soon as a memory directory has content", async () => {
    const roots = await emptyMemoryRoots(["global", "project"]);
    expect(await roots.recall()).toEqual([]);
    expect(existsSync(roots.databasePath)).toBe(false);

    const matching = await memory(
      roots.memoryDirs[1]!,
      "browser.md",
      "Browser automation",
      "Known browser launch gotchas",
    );
    const result = await roots.recall();

    expect(existsSync(roots.databasePath)).toBe(true);
    expect(result.map((entry) => entry.path)).toEqual([matching]);
  });

  it("skips the index for MEMORY.md and empty nested folders", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    const logs = join(roots.memoryDirs[0]!, "logs");
    await mkdir(logs);
    await writeFile(join(roots.memoryDirs[0]!, "MEMORY.md"), "# Index\n");

    expect(await roots.recall()).toEqual([]);
    expect(existsSync(roots.databasePath)).toBe(false);

    const matching = await memory(logs, "browser.md", "Browser", "Browser notes");
    expect((await roots.recall()).map((entry) => entry.path)).toEqual([
      matching,
    ]);
    expect(existsSync(roots.databasePath)).toBe(true);
  });

  it("reuses the exact ranked result for an unchanged tree and query", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    await memory(roots.memoryDirs[0]!, "browser.md", "Browser", "Browser notes");
    const refresh = vi.spyOn(PersistentMemoryIndex.prototype, "refresh");
    const helper = vi.spyOn(MemoryQueryProcessPool.prototype, "query");

    const first = await roots.recall();
    const refreshes = refresh.mock.calls.length;
    const queries = helper.mock.calls.length;
    const second = await roots.recall();
    const bytes = (value: unknown) =>
      JSON.stringify(
        value,
        (_key, item: unknown) =>
          typeof item === "bigint" ? item.toString() : item,
      );
    expect(bytes(second)).toBe(bytes(first));
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    expect(helper).toHaveBeenCalledTimes(queries);

    await findRelevantMemories({
      query: "notes",
      memoryDirs: roots.memoryDirs,
      signal: new AbortController().signal,
      memoryIndexDatabasePath: roots.databasePath,
    });
    expect(refresh).toHaveBeenCalledTimes(refreshes);

    expect(await findRelevantMemories({
      query: "browser",
      memoryDirs: roots.memoryDirs,
      signal: new AbortController().signal,
      memoryIndexDatabasePath: roots.databasePath,
      alreadySurfaced: new Set([first[0]!.path]),
    })).toEqual([]);

    closeFullCorpusMemoryIndexes();
    expect(bytes(await roots.recall())).toBe(bytes(first));
  });

  it("does not explicitly rebuild for a new query against a known unchanged tree", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    await memory(roots.memoryDirs[0]!, "browser.md", "Browser", "Browser notes");
    const refresh = vi.spyOn(PersistentMemoryIndex.prototype, "refresh");
    await roots.recall();
    const before = refresh.mock.calls.length;

    const result = await findRelevantMemories({
      query: "notes",
      memoryDirs: roots.memoryDirs,
      signal: new AbortController().signal,
      memoryIndexDatabasePath: roots.databasePath,
    });

    expect(result).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(before);
  });

  it("refreshes a known tree when a file appears before the skipped query returns", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    const root = roots.memoryDirs[0]!;
    await memory(root, "browser.md", "Browser", "Browser notes");
    await roots.recall(); // Prove this tree fresh for the next, distinct query.

    const actualQuery = PersistentMemoryIndex.prototype.query;
    let added = "";
    const query = vi.spyOn(PersistentMemoryIndex.prototype, "query")
      .mockImplementationOnce(async function (...args) {
        const result = await actualQuery.apply(this, args);
        added = await memory(root, "added.md", "Added", "Added notes");
        return result;
      });
    const refresh = vi.spyOn(PersistentMemoryIndex.prototype, "refresh");

    const result = await findRelevantMemories({
      query: "notes",
      memoryDirs: roots.memoryDirs,
      signal: new AbortController().signal,
      memoryIndexDatabasePath: roots.databasePath,
    });

    expect(existsSync(added)).toBe(true);
    expect(result.map((entry) => entry.path)).toContain(added);
    expect(query).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]?.[2]?.explicit).toBe(true);
  });

  it("does not trust a resumed staging generation that missed a new file", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    const root = roots.memoryDirs[0]!;
    await memory(root, "cooking.md", "Cooking", "Cooking notes");
    const seeded = new PersistentMemoryIndex({
      databasePath: roots.databasePath,
      backgroundRefresh: false,
      buildPolicyForTesting: { maxEntriesPerSlice: 1 },
    });
    const specs = [{ path: root, role: "global" as const }];
    let enumerated = false;
    let staging = false;
    for (let attempt = 0; attempt < 10 && !enumerated; attempt += 1) {
      await seeded.refresh(specs, new AbortController().signal);
      const db = new Database(roots.databasePath, { readonly: true });
      try {
        enumerated = (db.prepare(
          "SELECT COUNT(*) AS count FROM memory_index_directory_work WHERE relative_path = '' AND state = 'complete'",
        ).get() as { count: number }).count > 0;
        staging = (db.prepare(
          "SELECT COUNT(*) AS count FROM memory_index_generations WHERE state = 'staging'",
        ).get() as { count: number }).count > 0;
      } finally {
        db.close();
      }
    }
    expect(enumerated).toBe(true);
    expect(staging).toBe(true);
    seeded.close();

    const matching = await memory(root, "browser.md", "Browser", "Browser notes");
    const actualRefresh = PersistentMemoryIndex.prototype.refresh;
    const refresh = vi.spyOn(PersistentMemoryIndex.prototype, "refresh")
      .mockImplementationOnce(async function (...args) {
        const result = await actualRefresh.apply(this, args);
        // Replay the delayed watcher event after this root was processed.
        this.recordChange({
          rootPath: root,
          relativePath: "browser.md",
          kind: "create",
        });
        return result;
      });
    // The file is present for both recall snapshots, while the persisted
    // staging generation already enumerated this directory without it.
    expect(await roots.recall()).toEqual([]);
    expect(refresh.mock.calls[0]?.[2]?.explicit).toBe(true);
    expect((await roots.recall()).map((entry) => entry.path)).toEqual([matching]);
  });

  it("refreshes a first query before caching when a watcher has not delivered an addition", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    const root = roots.memoryDirs[0]!;
    await memory(root, "cooking.md", "Cooking", "Cooking notes");
    const seeded = new PersistentMemoryIndex({ databasePath: roots.databasePath });
    const seededRefresh = await seeded.refresh(
      [{ path: root, role: "global" }],
      new AbortController().signal,
      { explicit: true },
    );
    seeded.close();

    const matching = await memory(root, "browser.md", "Browser", "Browser notes");
    const actualRefresh = PersistentMemoryIndex.prototype.refresh;
    vi.spyOn(PersistentMemoryIndex.prototype, "refresh").mockImplementationOnce(
      function (...args) {
        return args[2]?.explicit === true
          ? actualRefresh.apply(this, args)
          : Promise.resolve(seededRefresh);
      },
    );
    expect((await roots.recall()).map((entry) => entry.path)).toEqual([matching]);
    expect((await roots.recall()).map((entry) => entry.path)).toEqual([matching]);
  });

  it("invalidates a cached result when content changes under frozen file timestamps", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    const root = roots.memoryDirs[0]!;
    const path = await memory(root, "topic.md", "Browser", "Browser notes");
    expect((await roots.recall()).map((entry) => entry.path)).toEqual([path]);

    frozenMemoryStat.value = lstatSync(path, { bigint: true });
    frozenMemoryStat.path = path;
    await memory(root, "topic.md", "Cooking", "Cooking notes");
    expect(await roots.recall()).toEqual([]);
  });

  it("settles an aborted request while it waits for the index lock", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    await memory(roots.memoryDirs[0]!, "browser.md", "Browser", "Browser notes");
    const originalRefresh = PersistentMemoryIndex.prototype.refresh;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(PersistentMemoryIndex.prototype, "refresh").mockImplementationOnce(
      async function (...args) {
        entered();
        await blocked;
        return originalRefresh.apply(this, args);
      },
    );
    const first = roots.recall();
    await started;
    const controller = new AbortController();
    const reason = new Error("cancel queued recall");
    const waiting = findRelevantMemories({
      query: "browser",
      memoryDirs: roots.memoryDirs,
      signal: controller.signal,
      memoryIndexDatabasePath: roots.databasePath,
    });
    controller.abort(reason);
    const outcome = await Promise.race([
      waiting.then(() => "resolved", (error: unknown) => error),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still waiting"), 100),
      ),
    ]);
    const next = roots.recall();
    release();
    await first;
    await waiting.catch(() => undefined);
    expect(outcome).toBe(reason);
    expect(await next).toHaveLength(1);
  });

  it("evicts old root snapshots along with ranked results", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    const databasePath = join(temporaryRoot, "memory-v1.sqlite");
    const roots: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      const root = join(temporaryRoot, `root-${index}`);
      await mkdir(root);
      await memory(root, "browser.md", "Browser", "Browser notes");
      roots.push(root);
    }
    const status = (spec: { path: string; role: "global" | "project" }) => ({
      rootId: spec.path,
      canonicalRoot: spec.path,
      role: spec.role,
      generationId: 1,
      generationToken: "complete",
      state: "complete",
      ageMs: 0,
      watcherHealth: "healthy",
      auditCursor: null,
    } as const);
    const refresh = vi.spyOn(PersistentMemoryIndex.prototype, "refresh")
      .mockImplementation(async (specs) => ({
        kind: "complete",
        roots: specs.map(status),
      }));
    vi.spyOn(PersistentMemoryIndex.prototype, "query")
      .mockImplementation(async (specs) => ({
        kind: "complete",
        candidates: [],
        freshness: specs.map(status),
      }));
    const recall = (root: string) => findRelevantMemories({
      query: "browser",
      memoryDirs: [root],
      signal: new AbortController().signal,
      memoryIndexDatabasePath: databasePath,
    });
    for (const root of roots) await recall(root);
    const before = refresh.mock.calls.length;
    await recall(roots[0]!);
    expect(refresh).toHaveBeenCalledTimes(before + 1);
  });

  it("sees additions, equal-size edits, renames and deletions at the next recall", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    const root = roots.memoryDirs[0]!;
    const first = await memory(root, "first.md", "Browser", "Browser notes");
    expect((await roots.recall()).map((entry) => entry.path)).toEqual([first]);

    const added = await memory(root, "added.md", "Browser", "Browser added");
    expect((await roots.recall()).map((entry) => entry.path)).toContain(added);

    const originalMtime = (await stat(first)).mtime;
    await memory(root, "first.md", "Cooking", "Cooking notes");
    await utimes(first, originalMtime, originalMtime);
    expect((await roots.recall()).map((entry) => entry.path)).not.toContain(first);

    const renamed = join(root, "renamed.md");
    await rename(added, renamed);
    expect((await roots.recall()).map((entry) => entry.path)).toEqual([renamed]);

    await rm(renamed);
    expect(await roots.recall()).toEqual([]);
  });

  it("shares a changed root correctly across concurrent session recalls", async () => {
    const roots = await emptyMemoryRoots(["global"]);
    const root = roots.memoryDirs[0]!;
    await memory(root, "first.md", "Browser", "Browser notes");
    await roots.recall();
    const extracted = await memory(root, "extracted.md", "Browser", "Browser extracted");

    const [left, right] = await Promise.all([roots.recall(), roots.recall()]);
    expect(left.map((entry) => entry.path)).toContain(extracted);
    expect(right.map((entry) => entry.path)).toContain(extracted);
  });

  it("clamps both lexical and selector paths to five memories", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "agenc-c3a-find-"));
    for (let index = 0; index < 8; index += 1) {
      await memory(
        temporaryRoot,
        `${index}.md`,
        `Browser ${index}`,
        "Browser automation",
      );
    }
    const signal = new AbortController().signal;
    const lexical = await findRelevantMemories("browser", temporaryRoot, signal);
    expect(lexical).toHaveLength(5);

    const selected = await findRelevantMemories({
      query: "browser",
      memoryDirs: [temporaryRoot],
      signal,
      admittedMemorySelector: {
        select: async () => ({
          kind: "selected",
          candidateIds: Array.from(
            { length: 8 },
            (_, index) => `candidate-${index + 1}`,
          ),
        }),
      },
    });
    expect(selected).toHaveLength(5);
  });
});
