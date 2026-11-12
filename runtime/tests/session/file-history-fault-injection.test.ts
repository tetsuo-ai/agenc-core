import { createHash, randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type ReadStream,
  type Stats,
} from "node:fs";
import { copyFile, open, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileHistory,
  FileHistorySidecar,
  sha256OfFile,
  type FileHistoryBackup,
  type FileHistoryOptions,
} from "../../src/session/file-history.js";

// Reload helpers imported by test setup so filesystem fault injection reaches them.
vi.hoisted(() => vi.resetModules());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    rmdir: vi.fn(actual.rmdir),
    stat: vi.fn(actual.stat),
    unlink: vi.fn(actual.unlink),
  };
});

const actualCreateReadStream = vi.mocked(createReadStream).getMockImplementation()!;
const actualCopyFile = vi.mocked(copyFile).getMockImplementation()!;
const actualOpen = vi.mocked(open).getMockImplementation()!;
const actualReadFile = vi.mocked(readFile).getMockImplementation()!;
const actualRename = vi.mocked(rename).getMockImplementation()!;
const actualRmdir = vi.mocked(rmdir).getMockImplementation()!;
const actualStat = vi.mocked(stat).getMockImplementation()!;
const actualUnlink = vi.mocked(unlink).getMockImplementation()!;

type Diagnostic = { cause: string; message: string };

let root: string;
let project: string;
let work: string;
let history: FileHistory;
let diagnostics: Diagnostic[];
const engines: FileHistory[] = [];

function newEngine(
  options: Pick<
    FileHistoryOptions,
    "sessionId" | "enabled" | "maxSnapshots" | "withCanonicalBackgroundWork"
  > = {},
): FileHistory {
  const engine = new FileHistory({
    projectDir: project,
    ...options,
    sessionId: options.sessionId ?? "fault-injection",
    onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  engines.push(engine);
  return engine;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-fh-faults-"));
  project = join(root, "project");
  work = join(root, "work");
  mkdirSync(work);
  diagnostics = [];
  history = newEngine();
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.restoreAllMocks();
  vi.mocked(createReadStream).mockReset().mockImplementation(actualCreateReadStream);
  vi.mocked(copyFile).mockReset().mockImplementation(actualCopyFile);
  vi.mocked(open).mockReset().mockImplementation(actualOpen);
  vi.mocked(readFile).mockReset().mockImplementation(actualReadFile);
  vi.mocked(rename).mockReset().mockImplementation(actualRename);
  vi.mocked(rmdir).mockReset().mockImplementation(actualRmdir);
  vi.mocked(stat).mockReset().mockImplementation(actualStat);
  vi.mocked(unlink).mockReset().mockImplementation(actualUnlink);
  heldReads.clear();
  rmSync(root, { recursive: true, force: true });
});

function workFile(name: string, content: string): string {
  const path = join(work, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function indexPath(engine: FileHistory = history): string {
  return join(engine.historyDir, "snapshots.json");
}

/** Message ids of the snapshots in the index on disk. */
function indexedSnapshots(engine: FileHistory = history): string[] {
  const index = JSON.parse(readFileSync(indexPath(engine), "utf8")) as {
    snapshots: Array<{ messageId: string }>;
  };
  return index.snapshots.map((snapshot) => snapshot.messageId);
}

/** Index write attempts so far: each one renames a temporary file onto the index. */
function indexWrites(engine: FileHistory = history): number {
  const target = indexPath(engine);
  return vi.mocked(rename).mock.calls.filter(([, to]) => to === target).length;
}

/** Paths opened for hashing so far. */
function hashedPaths(): string[] {
  return vi.mocked(createReadStream).mock.calls.map(([path]) => String(path));
}

function latestEntry(path: string, engine: FileHistory = history) {
  const entry = engine.getState().snapshots.at(-1)?.trackedFileBackups[path];
  if (entry === undefined) throw new Error(`no entry for ${path} in the newest snapshot`);
  return entry;
}

/** What stat reports for a FIFO, socket or device. */
function notRegularFile(size = 0): Stats {
  return { isFile: () => false, isDirectory: () => false, size } as unknown as Stats;
}

/** Report `path` as existing but not regular; every other path is real. */
function statAsNotRegular(path: string, size?: number): void {
  vi.mocked(stat).mockImplementation(async (target, options) =>
    target === path ? notRegularFile(size) : actualStat(target, options));
}

function ioError(what: string): Error {
  return Object.assign(new Error(`${what}: EIO`), { code: "EIO" });
}

/** A stream that hands over one chunk and then fails, like a read error part-way. */
function failingReadStream(reads = { count: 0 }): ReadStream {
  return new Readable({
    read() {
      reads.count += 1;
      if (reads.count === 1) this.push(Buffer.from("first chunk"));
      else this.destroy(ioError("read"));
    },
  }) as unknown as ReadStream;
}

function snapshotIds(engine: FileHistory = history): string[] {
  return engine.getState().snapshots.map((snapshot) => snapshot.messageId);
}

function causes(): string[] {
  return diagnostics.map((diagnostic) => diagnostic.cause);
}

/** One step of the engine that a test holds in place and lets go by hand. */
interface Hold {
  /** Resolves when the engine reaches the held step. */
  readonly entered: Promise<void>;
  /** Lets the held step, and every later one like it, proceed. */
  release(): void;
}

function hold(): Hold & { reach(): Promise<void> } {
  let release!: () => void;
  let enter!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let reached = false;
  return {
    entered,
    release,
    // Only the first arrival waits; the held step may be repeated later.
    reach: async () => {
      if (reached) return;
      reached = true;
      enter();
      await released;
    },
  };
}

const heldReads = new Map<string, ReturnType<typeof hold>>();

/** Hold the next `readFile` of `path`; reads of other paths are not delayed. */
function holdNextReadOf(path: string): Hold {
  const held = hold();
  heldReads.set(path, held);
  vi.mocked(readFile).mockImplementation(async (target, options) => {
    await heldReads.get(String(target))?.reach();
    return actualReadFile(target, options);
  });
  return held;
}

/** Hold the next `copyFile` from `source`, which is a backup being taken. */
function holdNextCopyOf(source: string): Hold {
  const held = hold();
  vi.mocked(copyFile).mockImplementation(async (from, to, mode) => {
    if (from === source) await held.reach();
    return actualCopyFile(from, to, mode);
  });
  return held;
}

/** Make the next index write fail at `step`; the ones after it work again. */
function failNextIndexWrite(step: string, error: Error): void {
  if (step === "rename") {
    vi.mocked(rename).mockRejectedValueOnce(error);
    return;
  }
  let failures = 1;
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (flags !== "r" || failures === 0) return actualOpen(path, flags, mode);
    failures -= 1;
    return {
      sync: async () => { throw error; },
      close: async () => {},
    } as unknown as Awaited<ReturnType<typeof open>>;
  });
}

/**
 * An engine capped at two snapshots that holds `m0` and `m1` for one file
 * with different content in each. The next snapshot evicts `m0`, the only
 * snapshot that names the backup `evicted`; `m1` names `kept`. A second
 * tracked path never exists, so every snapshot also has an entry without a
 * backup.
 */
async function engineAtTheCap(
  sessionId: string,
  options: Pick<FileHistoryOptions, "withCanonicalBackgroundWork"> = {},
): Promise<{ engine: FileHistory; file: string; evicted: string; kept: string }> {
  const engine = newEngine({ ...options, sessionId, maxSnapshots: 2 });
  const file = workFile(`${sessionId}.txt`, "one\n");
  await engine.trackEdits([file, join(work, `${sessionId}-never-created.txt`)], "m0");
  const evicted = latestEntry(file, engine).backupFileName!;
  writeFileSync(file, "two\n", "utf8");
  await engine.makeSnapshot("m1");
  const kept = latestEntry(file, engine).backupFileName!;
  expect(snapshotIds(engine)).toEqual(["m0", "m1"]);
  return { engine, file, evicted, kept };
}

/** Change the file and take the snapshot that evicts the oldest one. */
async function evictOldest(engine: FileHistory, file: string, messageId: string): Promise<void> {
  writeFileSync(file, `content at ${messageId}\n`, "utf8");
  await engine.makeSnapshot(messageId);
}

describe("sha256OfFile", () => {
  test("hashes a file larger than one stream chunk", async () => {
    const bytes = Buffer.alloc(3 * 64 * 1024 + 123);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + (i >>> 8)) & 0xff;
    const path = join(work, "several-chunks.bin");
    writeFileSync(path, bytes);
    let chunkBytes = Number.POSITIVE_INFINITY;
    vi.mocked(createReadStream).mockImplementationOnce((target, options) => {
      const stream = actualCreateReadStream(target, options);
      chunkBytes = stream.readableHighWaterMark;
      return stream;
    });

    await expect(sha256OfFile(path)).resolves.toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(bytes.length).toBeGreaterThan(2 * chunkBytes);
  });

  test("hashes an empty file", async () => {
    await expect(sha256OfFile(workFile("empty.bin", ""))).resolves.toBe(
      createHash("sha256").digest("hex"),
    );
  });

  test("returns null when a read fails part-way", async () => {
    const path = workFile("unreadable.bin", "never read");
    const reads = { count: 0 };
    vi.mocked(createReadStream).mockImplementationOnce(() => failingReadStream(reads));

    await expect(sha256OfFile(path)).resolves.toBeNull();
    expect(reads.count).toBe(2);
  });

  test("returns null for a file that cannot be opened", async () => {
    await expect(sha256OfFile(join(work, "missing.bin"))).resolves.toBeNull();
  });
});

describe("file-history sources that are not regular files", () => {
  test("trackEdit reports the path, opens nothing and leaves the queue usable", async () => {
    // A real FIFO would block the open forever; the stat result is what the
    // engine has to go by, so a mocked one stands in for mkfifo.
    const pipe = workFile("build.pipe", "must never be opened\n");
    const plain = workFile("plain.txt", "plain\n");
    statAsNotRegular(pipe);

    await history.trackEdit(pipe, "m1");

    expect(diagnostics).toEqual([{
      cause: "file_history_track_failed",
      message: `trackEdit ${pipe}: not a regular file`,
    }]);
    expect(copyFile).not.toHaveBeenCalled();
    expect(hashedPaths()).toEqual([]);
    expect(history.getState().trackedFiles.has(pipe)).toBe(false);
    expect(existsSync(history.historyDir)).toBe(false);

    await expect(history.trackEdit(plain, "m1")).resolves.toBeUndefined();
    expect(history.getState().trackedFiles.has(plain)).toBe(true);
    expect(copyFile).toHaveBeenCalledOnce();
    expect(readFileSync(latestEntry(plain).backupFileName!, "utf8")).toBe("plain\n");
    expect(diagnostics).toHaveLength(1);
  });

  test("a snapshot never opens a tracked path that stopped being a regular file", async () => {
    const swapped = workFile("swapped", "regular when it was tracked\n");
    const plain = workFile("plain.txt", "plain\n");
    await history.trackEdits([swapped, plain], "m1");
    // Same size as its backup, so only the file type can stop the hash.
    statAsNotRegular(swapped, statSync(swapped).size);
    vi.mocked(copyFile).mockClear();
    vi.mocked(createReadStream).mockClear();

    await history.makeSnapshot("m2");

    expect(diagnostics).toEqual([{
      cause: "file_history_snapshot_failed",
      message: `snapshot ${swapped}: not a regular file`,
    }]);
    expect(copyFile).not.toHaveBeenCalled();
    expect(hashedPaths()).toEqual([plain]);
    expect(Object.keys(history.getState().snapshots.at(-1)!.trackedFileBackups)).toEqual([plain]);

    await expect(history.makeSnapshot("m3")).resolves.toBeUndefined();
    expect(history.getState().snapshots.at(-1)!.messageId).toBe("m3");
  });
});

describe("file-history backup digests", () => {
  test("a snapshot of an unchanged file reads the file once and copies nothing", async () => {
    const file = workFile("steady.txt", "steady\n");
    await history.trackEdit(file, "m1");
    const origin = latestEntry(file);
    // The copy was hashed when it was made.
    expect(hashedPaths()).toEqual([origin.backupFileName]);
    vi.mocked(copyFile).mockClear();
    vi.mocked(createReadStream).mockClear();

    await history.makeSnapshot("m2");
    await history.makeSnapshot("m3");

    expect(copyFile).not.toHaveBeenCalled();
    expect(hashedPaths()).toEqual([file, file]);
    expect(latestEntry(file)).toEqual(origin);
    expect(diagnostics).toEqual([]);
  });

  test("a reloaded engine hashes a backup once to rebuild its digest", async () => {
    const file = workFile("steady.txt", "steady\n");
    await history.trackEdit(file, "m1");
    const origin = latestEntry(file);
    const resumed = newEngine();
    await resumed.loadFromDisk();
    expect(resumed["backupDigests"].size).toBe(0);
    vi.mocked(copyFile).mockClear();
    vi.mocked(createReadStream).mockClear();

    await resumed.makeSnapshot("m2");
    await resumed.makeSnapshot("m3");

    expect(hashedPaths()).toEqual([origin.backupFileName, file, file]);
    expect(copyFile).not.toHaveBeenCalled();
    expect(latestEntry(file, resumed)).toEqual(origin);
    expect(diagnostics).toEqual([]);
  });

  test("a file whose size changed is copied without being hashed first", async () => {
    const file = workFile("grown.txt", "short\n");
    await history.trackEdit(file, "m1");
    writeFileSync(file, "a longer body\n", "utf8");
    vi.mocked(createReadStream).mockClear();

    await history.makeSnapshot("m2");

    const second = latestEntry(file);
    expect(second.version).toBe(2);
    // Only the new copy was read, to remember its digest.
    expect(hashedPaths()).toEqual([second.backupFileName]);
  });

  test.each(["stat", "hash"])(
    "a failed %s of a new backup keeps the backup and stores no digest",
    async (step) => {
      const file = workFile("kept.txt", "content\n");
      const inHistory = (path: unknown): boolean =>
        String(path).startsWith(history.historyDir);
      if (step === "stat") {
        vi.mocked(stat).mockImplementation(async (target, options) => {
          if (inHistory(target)) throw ioError("stat");
          return actualStat(target, options);
        });
      } else {
        vi.mocked(createReadStream).mockImplementation((target, options) =>
          inHistory(target) ? failingReadStream() : actualCreateReadStream(target, options));
      }

      await history.trackEdit(file, "m1");

      const origin = latestEntry(file);
      expect(origin.version).toBe(1);
      expect(readFileSync(origin.backupFileName!, "utf8")).toBe("content\n");
      expect(history["backupDigests"].size).toBe(0);
      expect(diagnostics).toEqual([]);

      // Without a digest the file cannot be shown to be unchanged: copy it.
      await history.makeSnapshot("m2");
      const second = latestEntry(file);
      expect(second.version).toBe(2);
      expect(second.backupFileName).not.toBe(origin.backupFileName);
      expect(history["backupDigests"].size).toBe(0);

      // Once backups can be read again, the newest one is shared.
      vi.mocked(stat).mockImplementation(actualStat);
      vi.mocked(createReadStream).mockImplementation(actualCreateReadStream);
      await history.makeSnapshot("m3");
      expect(latestEntry(file)).toEqual({
        backupFileName: second.backupFileName,
        version: 2,
        backupTimeMs: second.backupTimeMs,
      });
      expect(copyFile).toHaveBeenCalledTimes(2);
      expect(diagnostics).toEqual([]);
    },
  );

  test("a file that cannot be read for hashing counts as changed", async () => {
    const file = workFile("flaky.txt", "content\n");
    await history.trackEdit(file, "m1");
    const origin = latestEntry(file);
    vi.mocked(createReadStream).mockImplementation((target, options) =>
      target === file ? failingReadStream() : actualCreateReadStream(target, options));

    await history.makeSnapshot("m2");

    const second = latestEntry(file);
    expect(second.version).toBe(2);
    expect(second.backupFileName).not.toBe(origin.backupFileName);
    expect(readFileSync(second.backupFileName!, "utf8")).toBe("content\n");
    expect(diagnostics).toEqual([]);
  });

  test("a backup that is not a regular file is never opened", async () => {
    const file = workFile("steady.txt", "steady\n");
    await history.trackEdit(file, "m1");
    const origin = latestEntry(file);
    // A new engine has no digest for the backup and must look at the file.
    const resumed = newEngine();
    await resumed.loadFromDisk();
    statAsNotRegular(origin.backupFileName!, statSync(origin.backupFileName!).size);
    vi.mocked(createReadStream).mockClear();

    await resumed.makeSnapshot("m2");

    const second = latestEntry(file, resumed);
    expect(second.version).toBe(2);
    expect(second.backupFileName).not.toBe(origin.backupFileName);
    expect(hashedPaths()).toEqual([second.backupFileName]);
    expect(diagnostics).toEqual([]);
  });
});

describe("file-history index writes", () => {
  test("trackEdits writes the index once for several new paths and not at all for a no-op", async () => {
    const files = ["a.txt", "b.txt", "c.txt"].map((name) => workFile(name, `${name}\n`));

    await history.trackEdits(files, "m1");

    expect(indexWrites()).toBe(1);
    expect(copyFile).toHaveBeenCalledTimes(3);
    expect(indexedSnapshots()).toEqual(["m1"]);
    expect(Object.keys(history.getState().snapshots[0]!.trackedFileBackups)).toEqual(files);

    await history.trackEdit(files[0]!, "m2");
    await history.trackEdits(files, "m2");
    await history.trackEdits([], "m2");

    expect(indexWrites()).toBe(1);
    expect(copyFile).toHaveBeenCalledTimes(3);
    expect(diagnostics).toEqual([]);
  });

  test("a trackEdit whose backup fails writes no index", async () => {
    // Backing up a directory fails in copyFile, as it always has.
    await history.trackEdit(work, "m1");

    expect(diagnostics.map((diagnostic) => diagnostic.cause)).toEqual(["file_history_track_failed"]);
    expect(indexWrites()).toBe(0);
    expect(existsSync(indexPath())).toBe(false);
  });

  test("a disabled engine tracks nothing and writes no index for trackEdits", async () => {
    const file = workFile("a.txt", "a\n");
    const disabled = newEngine({ sessionId: "disabled", enabled: false });

    await disabled.trackEdits([file], "m1");

    expect(disabled.getState().trackedFiles.size).toBe(0);
    expect(copyFile).not.toHaveBeenCalled();
    expect(indexWrites(disabled)).toBe(0);
    expect(existsSync(disabled.historyDir)).toBe(false);
  });

  test.each(["rename", "directory sync"])(
    "a no-op trackEdit retries an index write that failed at the %s",
    async (step) => {
      const file = workFile("a.txt", "a\n");
      await history.trackEdit(file, "m1");
      expect(indexWrites()).toBe(1);

      const error = ioError(`index ${step}`);
      if (step === "rename") {
        vi.mocked(rename).mockRejectedValueOnce(error);
      } else {
        let failures = 1;
        vi.mocked(open).mockImplementation(async (path, flags, mode) => {
          if (flags !== "r" || failures === 0) return actualOpen(path, flags, mode);
          failures -= 1;
          return {
            sync: async () => { throw error; },
            close: async () => {},
          } as unknown as Awaited<ReturnType<typeof open>>;
        });
      }
      await history.makeSnapshot("barrier");

      expect(diagnostics).toEqual([{ cause: "file_history_save_failed", message: String(error) }]);
      expect(history.getState().snapshots.map((snapshot) => snapshot.messageId))
        .toEqual(["m1", "barrier"]);
      // Until the rename the index on disk does not know the barrier at all.
      if (step === "rename") expect(indexedSnapshots()).toEqual(["m1"]);
      const attempts = indexWrites();
      expect(attempts).toBe(2);

      // Changes nothing, but the failed write is still owed.
      await history.trackEdit(file, "m2");
      expect(indexWrites()).toBe(attempts + 1);
      expect(indexedSnapshots()).toEqual(["m1", "barrier"]);

      // Nothing is owed any more.
      await history.trackEdit(file, "m3");
      expect(indexWrites()).toBe(attempts + 1);
      expect(diagnostics).toHaveLength(1);
    },
  );

  test("a failed index write is owed even when the state did not change", async () => {
    const file = workFile("a.txt", "a\n");
    await history.trackEdit(file, "m1");
    const error = ioError("index rename");
    vi.mocked(rename).mockRejectedValueOnce(error);
    await expect(history["persistState"]()).rejects.toBe(error);
    const attempts = indexWrites();

    await history.trackEdit(file, "m2");

    expect(indexWrites()).toBe(attempts + 1);
    await history.trackEdit(file, "m3");
    expect(indexWrites()).toBe(attempts + 1);
    expect(diagnostics).toEqual([]);
  });
});

describe("file-history eviction and the index on disk", () => {
  test.each(["rename", "directory sync"])(
    "an index write that fails at the %s keeps the evicted backups until a later write succeeds",
    async (step) => {
      const { engine, file, evicted } = await engineAtTheCap("owed");
      const error = ioError(`index ${step}`);
      failNextIndexWrite(step, error);

      await evictOldest(engine, file, "m2");

      expect(diagnostics).toEqual([
        { cause: "file_history_cap_reached", message: expect.any(String) },
        { cause: "file_history_save_failed", message: String(error) },
      ]);
      expect(snapshotIds(engine)).toEqual(["m1", "m2"]);
      expect(existsSync(evicted)).toBe(true);
      // It waits for the index, and it is the only thing that does.
      expect([...engine["awaitingDurableIndex"]]).toEqual([evicted]);
      expect(engine["deletable"].size).toBe(0);

      // A reader that ends is no reason to delete either.
      await expect(engine.previewRewind("m1")).resolves.toMatchObject({ filesChanged: [file] });
      await engine.flush();
      expect(existsSync(evicted)).toBe(true);

      if (step === "rename") {
        // The index on disk still lists m0. After a restart m0 is a rewind
        // target again, and its backup is what restores the file.
        expect(indexedSnapshots(engine)).toEqual(["m0", "m1"]);
        const restarted = newEngine({ sessionId: "owed", maxSnapshots: 2 });
        await restarted.loadFromDisk();
        expect(snapshotIds(restarted)).toEqual(["m0", "m1"]);
        await expect(restarted.rewindToMessage("m0")).resolves.toEqual([file]);
        expect(readFileSync(file, "utf8")).toBe("one\n");
      }

      // The next queued operation changes nothing but still owes the index
      // write. Once that write is on disk the backup goes.
      const writes = indexWrites(engine);
      await engine.trackEdit(file, "m3");
      expect(indexWrites(engine)).toBe(writes + 1);
      expect(indexedSnapshots(engine)).toEqual(["m1", "m2"]);
      expect(existsSync(evicted)).toBe(false);
      expect(diagnostics).toHaveLength(2);

      // Nothing is owed any more.
      await engine.trackEdit(file, "m4");
      expect(indexWrites(engine)).toBe(writes + 1);
    },
  );

  test("any index write that succeeds releases the evicted backups to the next deletion pass", async () => {
    const { engine, file, evicted } = await engineAtTheCap("released");
    failNextIndexWrite("rename", ioError("index rename"));
    await evictOldest(engine, file, "m2");
    expect(existsSync(evicted)).toBe(true);

    // Not a queued operation: the index is on disk, but no pass has run.
    await expect(engine["persistState"]()).resolves.toBeUndefined();
    expect(indexedSnapshots(engine)).toEqual(["m1", "m2"]);
    expect(existsSync(evicted)).toBe(true);

    // The end of the next reader runs one.
    await expect(engine.previewRewind("m2")).resolves.toMatchObject({ filesChanged: [] });
    await engine.flush();
    expect(existsSync(evicted)).toBe(false);
  });

  test("a deleted backup leaves no digest behind", async () => {
    const { engine, file, evicted, kept } = await engineAtTheCap("digests");
    expect([...engine["backupDigests"].keys()]).toEqual([evicted, kept]);

    await evictOldest(engine, file, "m2");

    expect(existsSync(evicted)).toBe(false);
    expect([...engine["backupDigests"].keys()]).toEqual([
      kept,
      latestEntry(file, engine).backupFileName,
    ]);
    expect(causes()).toEqual(["file_history_cap_reached"]);
  });

  test("a disabled engine takes no snapshot and evicts nothing", async () => {
    const file = workFile("a.txt", "a\n");
    const disabled = newEngine({ sessionId: "disabled", enabled: false, maxSnapshots: 1 });

    await disabled.trackEdit(file, "m0");
    await disabled.makeSnapshot("m1");
    await disabled.makeSnapshot("m2");

    expect(disabled.getState()).toMatchObject({ snapshots: [], evictedCount: 0 });
    expect(copyFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });
});

describe("file-history eviction while a rewind or preview is reading", () => {
  test.each(["previewRewind", "rewindToMessage"] as const)(
    "%s in flight keeps the backups it may read until it finishes",
    async (reader) => {
      const { engine, file, evicted } = await engineAtTheCap("in-flight");
      const reading = holdNextReadOf(evicted);
      const result = engine[reader]("m0");
      await reading.entered;

      // m0 is evicted while the reader still works from the state that names it.
      await evictOldest(engine, file, "m2");

      expect(snapshotIds(engine)).toEqual(["m1", "m2"]);
      expect(indexedSnapshots(engine)).toEqual(["m1", "m2"]);
      expect(existsSync(evicted)).toBe(true);

      reading.release();
      if (reader === "previewRewind") {
        // Read before the eviction ("two") against the backup that outlived it ("one").
        await expect(result).resolves.toEqual({
          filesChanged: [file],
          insertions: 1,
          deletions: 1,
          perFile: { [file]: { insertions: 1, deletions: 1 } },
        });
      } else {
        await expect(result).resolves.toEqual([file]);
        expect(readFileSync(file, "utf8")).toBe("one\n");
      }
      await engine.flush();
      expect(existsSync(evicted)).toBe(false);
      expect(causes()).toEqual(["file_history_cap_reached"]);
    },
  );

  test("deletion waits for the last of several readers", async () => {
    const { engine, file, evicted, kept } = await engineAtTheCap("overlap");
    const readingEvicted = holdNextReadOf(evicted);
    const readingKept = holdNextReadOf(kept);
    const older = engine.previewRewind("m0");
    await readingEvicted.entered;
    const newer = engine.previewRewind("m1");
    await readingKept.entered;

    await evictOldest(engine, file, "m2");
    expect(existsSync(evicted)).toBe(true);

    // One reader ends; the other still works from the state that names m0.
    readingKept.release();
    await expect(newer).resolves.toMatchObject({ filesChanged: [] });
    await engine.flush();
    expect(existsSync(evicted)).toBe(true);

    readingEvicted.release();
    await expect(older).resolves.toMatchObject({
      filesChanged: [file],
      insertions: 1,
      deletions: 1,
    });
    await engine.flush();
    expect(existsSync(evicted)).toBe(false);
  });

  test.each(["previewRewind", "rewindToMessage"] as const)(
    "%s still waiting for the queue does not hold deletions back",
    async (reader) => {
      const { engine, file, evicted } = await engineAtTheCap("queued");
      // Same size as the content at m1 ("two"), so that a rewind has to read
      // the file to compare it.
      writeFileSync(file, "2+1\n", "utf8");
      const copying = holdNextCopyOf(file);
      const snapshot = engine.makeSnapshot("m2");
      await copying.entered;
      // Asked for while the evicting snapshot runs: it waits in flush() and
      // reads the state only after the eviction.
      const reading = holdNextReadOf(file);
      const result = engine[reader]("m1");

      copying.release();
      await snapshot;
      await reading.entered;

      // The reader is active now, and the snapshot did not wait for it.
      expect(existsSync(evicted)).toBe(false);
      reading.release();
      if (reader === "previewRewind") {
        await expect(result).resolves.toMatchObject({ filesChanged: [file] });
      } else {
        await expect(result).resolves.toEqual([file]);
        expect(readFileSync(file, "utf8")).toBe("two\n");
      }
    },
  );

  test("a deletion pass queued by one reader's end leaves what a newer reader holds", async () => {
    let diagnosticDelivery: Promise<void> = Promise.resolve();
    const { engine, file, evicted, kept } = await engineAtTheCap("interleaved", {
      withCanonicalBackgroundWork: async (work) => {
        await diagnosticDelivery;
        return work();
      },
    });

    // The first reader works from [m0, m1]; m0 is evicted under it.
    const readingEvicted = holdNextReadOf(evicted);
    const first = engine.previewRewind("m0");
    await readingEvicted.entered;
    await evictOldest(engine, file, "m2");
    expect(existsSync(evicted)).toBe(true);

    // The second reader is asked for now but stays in flush(): a diagnostic
    // is still being delivered.
    const delivery = hold();
    diagnosticDelivery = delivery.reach();
    await engine.trackEdit(work, "not-a-file");
    const readingKept = holdNextReadOf(kept);
    const second = engine.previewRewind("m1");

    // The next snapshot stops while it copies, before it changes the state.
    const copying = holdNextCopyOf(file);
    const snapshot = evictOldest(engine, file, "m3");
    await copying.entered;

    // The first reader ends. No reader is counted, so a pass is queued; it
    // has to wait for the snapshot.
    readingEvicted.release();
    await first;
    // The second reader leaves flush() and reads [m1, m2], and only then
    // does the snapshot evict m1.
    delivery.release();
    await readingKept.entered;
    copying.release();
    await snapshot;
    await engine.flush();

    // The snapshot's own pass and the queued one both found a reader.
    expect(snapshotIds(engine)).toEqual(["m2", "m3"]);
    expect(existsSync(evicted)).toBe(true);
    expect(existsSync(kept)).toBe(true);

    readingKept.release();
    await expect(second).resolves.toMatchObject({
      filesChanged: [file],
      insertions: 1,
      deletions: 1,
    });
    await engine.flush();
    expect(existsSync(evicted)).toBe(false);
    expect(existsSync(kept)).toBe(false);
    expect(causes()).toEqual(["file_history_cap_reached", "file_history_track_failed"]);
  });

  test("a preview finishes on the state it started with", async () => {
    const engine = newEngine({ sessionId: "captured", maxSnapshots: 2 });
    const early = workFile("early.txt", "early\n");
    const late = workFile("late.txt", "late origin\n");
    await engine.trackEdit(early, "m0");
    await engine.makeSnapshot("m1");
    // First tracked after m0: a rewind to m0 restores it from this origin.
    await engine.trackEdit(late, "late-edit");
    const lateOrigin = latestEntry(late, engine).backupFileName!;
    const reading = holdNextReadOf(latestEntry(early, engine).backupFileName!);
    const preview = engine.previewRewind("m0");
    await reading.entered;

    // Two snapshots on, no retained snapshot holds an origin for `late`.
    await evictOldest(engine, late, "m2");
    await evictOldest(engine, late, "m3");
    expect(snapshotIds(engine)).toEqual(["m2", "m3"]);
    expect(existsSync(lateOrigin)).toBe(true);

    reading.release();
    await expect(preview).resolves.toEqual({
      filesChanged: [late],
      insertions: 1,
      deletions: 1,
      perFile: { [late]: { insertions: 1, deletions: 1 } },
    });
    await engine.flush();
    expect(existsSync(lateOrigin)).toBe(false);
  });

  test("a reader that fails or finds no snapshot still lets deletions proceed", async () => {
    const { engine, file, evicted } = await engineAtTheCap("ended");

    await expect(engine.rewindToMessage("no-such-message")).rejects.toThrow(
      "Snapshot for messageId=no-such-message not found",
    );
    await expect(engine.previewRewind("no-such-message")).resolves.toBeNull();

    // Neither left a reader counted: the eviction deletes at once.
    await evictOldest(engine, file, "m2");
    expect(existsSync(evicted)).toBe(false);
    expect(causes()).toEqual(["file_history_restore_failed", "file_history_cap_reached"]);
  });
});

describe("file-history deletion passes", () => {
  test("a pass unlinks nothing but the engine's own backup files", async () => {
    const { engine, file, evicted, kept } = await engineAtTheCap("shapes");
    const neighbour = newEngine({ sessionId: "shapes-neighbour" });
    const neighbourFile = workFile("neighbour.txt", "neighbour\n");
    await neighbour.trackEdit(neighbourFile, "m0");
    const backupDir = dirname(evicted);
    const backupName = `v1-${randomUUID()}`;
    // Paths a damaged index could name. All of them exist.
    const strays: Record<string, string> = {
      "the index": indexPath(engine),
      "a backup directory": backupDir,
      "a file directly in the history directory": join(engine.historyDir, backupName),
      "a file one level too deep": join(backupDir, "nested", backupName),
      "another file in a backup directory": join(backupDir, "notes.txt"),
      "a backup name with a suffix": join(backupDir, `${backupName}.bak`),
      "a backup name without a version": join(backupDir, backupName.replace("v1-", "v-")),
      "a backup of another session": latestEntry(neighbourFile, neighbour).backupFileName!,
      "a file outside the history": join(work, backupName),
      "a path that only looks two levels deep": `${engine.historyDir}${sep}..${sep}${backupName}`,
    };
    for (const [label, path] of Object.entries(strays)) {
      if (existsSync(path)) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${label}\n`, "utf8");
    }
    // The oldest snapshot is the only one that names them.
    const state = engine.getState();
    const [oldest, newest] = state.snapshots;
    engine["state"] = {
      ...state,
      snapshots: [
        {
          ...oldest!,
          trackedFileBackups: {
            ...oldest!.trackedFileBackups,
            ...Object.fromEntries(Object.entries(strays).map(([label, backupFileName]) => [
              join(work, label),
              { backupFileName, version: 1, backupTimeMs: 0 },
            ])),
          },
        },
        newest!,
      ],
    };

    await evictOldest(engine, file, "m2");

    // The pass ran: the one real backup among them is gone.
    expect(existsSync(evicted)).toBe(false);
    expect(vi.mocked(unlink).mock.calls).toEqual([[evicted]]);
    expect(vi.mocked(rmdir).mock.calls).toEqual([[backupDir]]);
    for (const [label, path] of Object.entries(strays)) {
      expect(existsSync(path), label).toBe(true);
    }
    expect(indexedSnapshots(engine)).toEqual(["m1", "m2"]);
    expect(readFileSync(kept, "utf8")).toBe("two\n");
    expect(readFileSync(strays["a backup of another session"]!, "utf8")).toBe("neighbour\n");
    // Dropped for good, without a word: the next pass does not see them.
    expect(engine["deletable"].size).toBe(0);
    expect(engine["awaitingDurableIndex"].size).toBe(0);
    await evictOldest(engine, file, "m3");
    expect(vi.mocked(unlink).mock.calls).toEqual([[evicted], [kept]]);
    expect(causes()).toEqual(["file_history_cap_reached"]);
  });

  test("a backup stays while any retained snapshot names it, wherever that snapshot is", async () => {
    const engine = newEngine({ sessionId: "anywhere", maxSnapshots: 3 });
    const file = workFile("a.txt", "a at m0\n");
    await engine.trackEdit(file, "m0");
    const origin = latestEntry(file, engine).backupFileName!;
    writeFileSync(file, "a at m1\n", "utf8");
    await engine.makeSnapshot("m1");
    writeFileSync(file, "a at m2\n", "utf8");
    await engine.makeSnapshot("m2");
    // An index from disk is not bound to name a backup in neighbouring
    // snapshots only. Here m0 and m2 name the origin and m1 does not.
    const state = engine.getState();
    const [m0, m1, m2] = state.snapshots;
    engine["state"] = {
      ...state,
      snapshots: [
        m0!,
        m1!,
        {
          ...m2!,
          trackedFileBackups: {
            ...m2!.trackedFileBackups,
            [join(work, "restored.txt")]: { backupFileName: origin, version: 1, backupTimeMs: 0 },
          },
        },
      ],
    };

    await evictOldest(engine, file, "m3");

    expect(snapshotIds(engine)).toEqual(["m1", "m2", "m3"]);
    expect(readFileSync(origin, "utf8")).toBe("a at m0\n");
    expect(unlink).not.toHaveBeenCalled();

    // It goes when the last snapshot that names it does.
    await evictOldest(engine, file, "m4");
    expect(existsSync(origin)).toBe(true);
    await evictOldest(engine, file, "m5");
    expect(existsSync(origin)).toBe(false);
  });

  test("failed unlinks are reported once per engine and not retried", async () => {
    const engine = newEngine({ sessionId: "unlink", maxSnapshots: 2 });
    const a = workFile("a.txt", "a at m0\n");
    const b = workFile("b.txt", "b at m0\n");
    await engine.trackEdits([a, b], "m0");
    const firstA = latestEntry(a, engine).backupFileName!;
    const firstB = latestEntry(b, engine).backupFileName!;
    writeFileSync(a, "a at m1\n", "utf8");
    writeFileSync(b, "b at m1\n", "utf8");
    await engine.makeSnapshot("m1");
    const secondA = latestEntry(a, engine).backupFileName!;
    const secondB = latestEntry(b, engine).backupFileName!;
    const denied = (path: unknown): Error => Object.assign(
      new Error(`EACCES: permission denied, unlink '${String(path)}'`),
      { code: "EACCES" },
    );
    vi.mocked(unlink).mockImplementation(async (path) => { throw denied(path); });

    // Evicts m0: two backups to delete in one pass, and both unlinks fail.
    await evictOldest(engine, a, "m2");
    expect(vi.mocked(unlink).mock.calls).toEqual([[firstA], [firstB]]);
    expect(diagnostics).toEqual([
      { cause: "file_history_cap_reached", message: expect.any(String) },
      { cause: "file_history_prune_failed", message: `prune ${firstA}: ${denied(firstA).message}` },
    ]);

    // Evicts m1 and with it the second backup of `a`: a third failure, in a
    // later pass, and still the one report.
    await evictOldest(engine, b, "m3");
    expect(vi.mocked(unlink).mock.calls).toEqual([[firstA], [firstB], [secondA]]);
    expect(diagnostics).toHaveLength(2);
    for (const backup of [firstA, firstB, secondA]) expect(existsSync(backup)).toBe(true);
    // A backup that could not be unlinked still sits in its directory.
    expect(rmdir).not.toHaveBeenCalled();
    expect(engine["deletable"].size).toBe(0);

    // Unlinking works again. Later evictions delete as usual; the three that
    // failed are not tried again and stay where they are.
    vi.mocked(unlink).mockImplementation(actualUnlink);
    await evictOldest(engine, a, "m4");
    expect(vi.mocked(unlink).mock.calls).toEqual([[firstA], [firstB], [secondA], [secondB]]);
    expect(existsSync(secondB)).toBe(false);
    for (const backup of [firstA, firstB, secondA]) expect(existsSync(backup)).toBe(true);
    expect(diagnostics).toHaveLength(2);
  });

  test("a backup that is already gone needs no deleting", async () => {
    const { engine, file, evicted } = await engineAtTheCap("gone");
    rmSync(evicted);

    await evictOldest(engine, file, "m2");

    expect(unlink).toHaveBeenCalledExactlyOnceWith(evicted);
    // Its directory is still looked after.
    expect(rmdir).toHaveBeenCalledExactlyOnceWith(dirname(evicted));
    expect(engine["backupDigests"].has(evicted)).toBe(false);
    expect(causes()).toEqual(["file_history_cap_reached"]);
  });

  test.each([
    ["ENOTEMPTY", []],
    ["ENOENT", []],
    ["EACCES", ["file_history_prune_failed"]],
  ])("a backup directory that cannot be removed with %s reports %j", async (code, reported) => {
    const { engine, file, evicted } = await engineAtTheCap("rmdir");
    const error = Object.assign(new Error(`${code}: rmdir '${dirname(evicted)}'`), { code });
    vi.mocked(rmdir).mockRejectedValue(error);

    await evictOldest(engine, file, "m2");
    await evictOldest(engine, file, "m3");

    // The backups themselves are gone either way.
    expect(vi.mocked(unlink).mock.calls).toHaveLength(2);
    expect(existsSync(evicted)).toBe(false);
    expect(rmdir).toHaveBeenCalledTimes(2);
    expect(diagnostics.slice(1)).toEqual(reported.map((cause) => ({
      cause,
      message: `prune ${dirname(evicted)}: ${error.message}`,
    })));
  });
});

describe("file-history capture before a tool call (#3436)", () => {
  type SidecarEvent = Parameters<FileHistorySidecar["onEvent"]>[0];

  function newSidecar(
    engine: FileHistory = history,
    captureTimeoutMs?: number,
  ): FileHistorySidecar {
    return new FileHistorySidecar({
      fileHistory: engine,
      workspaceRoot: work,
      ...(captureTimeoutMs !== undefined ? { captureTimeoutMs } : {}),
    });
  }

  function started(id: string, toolName: string, args: Record<string, unknown>): SidecarEvent {
    return {
      id,
      msg: {
        type: "tool_call_started",
        payload: { callId: id, toolName, args: JSON.stringify(args) },
      },
    } as SidecarEvent;
  }

  function completed(id: string): SidecarEvent {
    return {
      id,
      msg: { type: "tool_call_completed", payload: { callId: id, result: "", isError: false } },
    } as SidecarEvent;
  }

  function userMessage(id: string): SidecarEvent {
    return {
      id,
      msg: { type: "user_message", payload: { message: "next prompt" } },
    } as SidecarEvent;
  }

  /** The first state on record for `path`: what a rewind falls back to. */
  function firstStateOf(path: string, engine: FileHistory = history): FileHistoryBackup {
    for (const snapshot of engine.getState().snapshots) {
      const entry = snapshot.trackedFileBackups[path];
      if (entry !== undefined) return entry;
    }
    throw new Error(`nothing on record for ${path}`);
  }

  /** Whether `promise` has settled once the event loop has had time to turn. */
  async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    const mark = (): void => { settled = true; };
    void promise.then(mark, mark);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    return settled;
  }

  /**
   * Wait for what a start event set in motion: the sidecar looks at a shell
   * call's targets first and queues their backup afterwards.
   */
  async function startEventsHandled(engine: FileHistory = history): Promise<void> {
    let seen = -1;
    while (seen !== vi.mocked(stat).mock.results.length) {
      seen = vi.mocked(stat).mock.results.length;
      await Promise.allSettled(vi.mocked(stat).mock.results.map((result) => result.value));
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      await engine.flush();
    }
  }

  /**
   * A file that an earlier tool call changed, and the snapshot of that
   * call's completion held in place while it copies the file.
   */
  async function snapshotStillRunning(
    sidecar: FileHistorySidecar,
    engine: FileHistory = history,
  ): Promise<{ copying: Hold; earlier: string }> {
    const earlier = workFile("earlier.txt", "one\n");
    sidecar.onEvent(started("ev-0", "Write", { file_path: earlier, content: "two\n" }));
    await engine.flush();
    writeFileSync(earlier, "two\n", "utf8");
    const copying = holdNextCopyOf(earlier);
    sidecar.onEvent(completed("ev-0-done"));
    await copying.entered;
    return { copying, earlier };
  }

  /** The timers a capture with this timeout started, in order. */
  function captureTimers(
    setTimer: { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } },
    timeoutMs: number,
  ): NodeJS.Timeout[] {
    return setTimer.mock.calls.flatMap(([, delay], index) =>
      delay === timeoutMs ? [setTimer.mock.results[index]!.value as NodeJS.Timeout] : []);
  }

  test.each([
    ["creates", null],
    ["overwrites", "BEFORE\n"],
  ])(
    "a file the tool %s keeps its pre-edit state as origin when the call starts while a snapshot is running",
    async (_verb, before) => {
      const sidecar = newSidecar();
      const { copying, earlier } = await snapshotStillRunning(sidecar);
      const target = join(work, "target.txt");
      if (before !== null) writeFileSync(target, before, "utf8");

      // The next call starts and is dispatched: the event, then the capture.
      const args = { file_path: target, content: "NEW\n" };
      sidecar.onEvent(started("ev-1", "Write", args));
      const capture = sidecar.captureBeforeToolCall("Write", args);
      expect(capture).toBeInstanceOf(Promise);
      // The tool may not run yet: its backup waits behind the snapshot.
      expect(await settlesSoon(capture!)).toBe(false);
      expect(history.getState().trackedFiles.has(target)).toBe(false);

      copying.release();
      await capture;
      // On record before the tool has written a byte.
      const origin = firstStateOf(target);
      expect(origin.version).toBe(1);
      if (before === null) expect(origin.backupFileName).toBeNull();
      else expect(readFileSync(origin.backupFileName!, "utf8")).toBe(before);

      writeFileSync(target, "NEW\n", "utf8");
      sidecar.onEvent(completed("ev-1-done"));
      await history.flush();

      expect(firstStateOf(target)).toEqual(origin);
      expect(snapshotIds()).toEqual(["ev-0", "ev-0-done", "ev-1-done"]);
      await expect(history.rewindToMessage("ev-0-done")).resolves.toEqual([target]);
      if (before === null) expect(existsSync(target)).toBe(false);
      else expect(readFileSync(target, "utf8")).toBe(before);
      expect(readFileSync(earlier, "utf8")).toBe("two\n");
      expect(diagnostics).toEqual([]);
    },
  );

  test("a barrier snapshot that is still running holds back a call without targets", async () => {
    const sidecar = newSidecar();
    const notes = workFile("notes.txt", "FIRST TURN\n");
    await history.trackEdit(notes, "turn-1-edit");
    writeFileSync(notes, "USER EDIT\n", "utf8");
    const copying = holdNextCopyOf(notes);
    sidecar.onEvent(userMessage("user-2"));
    await copying.entered;

    const capture = sidecar.captureBeforeToolCall("exec_command", {
      cmd: "git checkout -- notes.txt",
      workdir: work,
    });
    expect(capture).toBeInstanceOf(Promise);
    expect(await settlesSoon(capture!)).toBe(false);
    expect(history.hasSnapshotFor("user-2")).toBe(false);

    copying.release();
    await capture;
    expect(history.hasSnapshotFor("user-2")).toBe(true);
    // The command runs now, and the barrier already holds what it destroys.
    writeFileSync(notes, "FIRST TURN\n", "utf8");
    expect(readFileSync(latestEntry(notes).backupFileName!, "utf8")).toBe("USER EDIT\n");
    // Nothing of its own to back up: the queue was only waited for.
    expect(snapshotIds()).toEqual(["turn-1-edit", "user-2"]);
    expect(indexWrites()).toBe(2);
  });

  test("all targets of one call are backed up by one queued operation with one index write", async () => {
    const sidecar = newSidecar();
    const files = ["a.txt", "b.txt", "c.txt"].map((name) => workFile(name, `${name}\n`));
    const input = [
      "*** Begin Patch",
      ...files.flatMap((file) => [`*** Update File: ${file}`, "@@", "-old", "+new"]),
      "*** End Patch",
    ].join("\n");

    await sidecar.captureBeforeToolCall("apply_patch", { input });

    expect(indexWrites()).toBe(1);
    expect(copyFile).toHaveBeenCalledTimes(3);
    expect(Object.keys(history.getState().snapshots[0]!.trackedFileBackups)).toEqual(files);
    expect(indexedSnapshots()).toHaveLength(1);
  });

  test("the start event and the capture of one call write the index once between them", async () => {
    const sidecar = newSidecar();
    const files = ["a.txt", "b.txt", "c.txt"].map((name) => workFile(name, `${name}\n`));
    const input = [
      "*** Begin Patch",
      ...files.flatMap((file) => [`*** Update File: ${file}`, "@@", "-old", "+new"]),
      "*** End Patch",
    ].join("\n");

    sidecar.onEvent(started("ev-patch", "apply_patch", { input }));
    await sidecar.captureBeforeToolCall("apply_patch", { input });

    expect(indexWrites()).toBe(1);
    expect(copyFile).toHaveBeenCalledTimes(3);

    // The same for a shell call, whichever of the two gets to the queue first.
    const doomed = ["d.txt", "e.txt"].map((name) => workFile(name, `${name}\n`));
    const call = { cmd: "rm d.txt e.txt", workdir: work };
    sidecar.onEvent(started("ev-rm", "exec_command", call));
    await sidecar.captureBeforeToolCall("exec_command", call);
    await startEventsHandled();

    expect(indexWrites()).toBe(2);
    expect(copyFile).toHaveBeenCalledTimes(5);
    expect([...history.getState().trackedFiles]).toEqual([...files, ...doomed]);
    expect(snapshotIds()).toEqual(["ev-patch"]);
    expect(diagnostics).toEqual([]);
  });

  test.each(["the start event", "the capture"])(
    "%s leaves out a shell target that exists and is not a regular file",
    async (route) => {
      // What stat reports is all the sidecar has to go by, so a mocked
      // result stands in for a FIFO, which must never be opened.
      const sidecar = newSidecar();
      const pipe = workFile("build.pipe", "must never be opened\n");
      const plain = workFile("plain.txt", "plain\n");
      const created = join(work, "created.txt");
      statAsNotRegular(pipe);
      const call = { cmd: "rm build.pipe plain.txt && echo hi > created.txt", workdir: work };

      if (route === "the start event") {
        sidecar.onEvent(started("ev-rm", "exec_command", call));
        await startEventsHandled();
      } else {
        await sidecar.captureBeforeToolCall("exec_command", call);
      }

      expect([...history.getState().trackedFiles].sort()).toEqual([created, plain].sort());
      expect(firstStateOf(created)).toMatchObject({ backupFileName: null, version: 1 });
      expect(vi.mocked(copyFile).mock.calls.map(([from]) => from)).toEqual([plain]);
      expect(hashedPaths()).toEqual([latestEntry(plain).backupFileName]);
      // Never handed to the engine, so there is no failed backup to report.
      expect(diagnostics).toEqual([]);
    },
  );

  test("a start event whose shell targets are all left out queues nothing", async () => {
    const sidecar = newSidecar();
    const scratch = join(work, "scratch");
    mkdirSync(scratch);
    const queue = history["pending"];

    sidecar.onEvent(started("ev-rm", "exec_command", { cmd: "rm -r scratch", workdir: work }));
    await startEventsHandled();

    expect(vi.mocked(stat).mock.calls.map(([path]) => path)).toEqual([scratch]);
    expect(history["pending"]).toBe(queue);
    expect(history.getState().trackedFiles.size).toBe(0);
  });

  test("an edit tool's target is handed to the engine whatever it is", async () => {
    const sidecar = newSidecar();
    const pipe = workFile("build.pipe", "must never be opened\n");
    statAsNotRegular(pipe);

    await sidecar.captureBeforeToolCall("Write", { file_path: pipe, content: "x\n" });

    // The engine refuses it, as it does for a start event.
    expect(diagnostics).toEqual([{
      cause: "file_history_track_failed",
      message: `trackEdit ${pipe}: not a regular file`,
    }]);
    expect(copyFile).not.toHaveBeenCalled();
    expect(history.getState().trackedFiles.size).toBe(0);
  });

  test("a capture that outlasts the timeout resolves, reports it once and lets the tool proceed", async () => {
    const sidecar = newSidecar(history, 40);
    const { copying } = await snapshotStillRunning(sidecar);
    const controller = new AbortController();
    const created = join(work, "created.txt");
    const other = join(work, "other.txt");

    const capture = sidecar.captureBeforeToolCall(
      "Write",
      { file_path: created, content: "NEW\n" },
      controller.signal,
    );
    // It waits first: half the timeout has passed and nothing is reported.
    expect(await settlesSoon(capture!)).toBe(false);
    expect(diagnostics).toEqual([]);
    await expect(capture).resolves.toBeUndefined();

    expect(diagnostics).toEqual([{
      cause: "file_history_capture_timeout",
      message:
        "capture before Write did not finish within 40 ms: " +
        "the tool ran anyway, so a rewind may not undo its file changes",
    }]);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    // The queue has not moved: the snapshot is still running.
    expect(snapshotIds()).toEqual(["ev-0"]);
    expect(history.getState().trackedFiles.has(created)).toBe(false);

    // A later call that times out too is not reported again.
    await sidecar.captureBeforeToolCall("Edit", { file_path: other, old_string: "a", new_string: "b" });
    expect(diagnostics).toHaveLength(1);

    // The queue is not damaged by any of it.
    copying.release();
    await history.flush();
    expect(snapshotIds()).toEqual(["ev-0", "ev-0-done"]);
    expect(history.getState().trackedFiles.has(created)).toBe(true);
    expect(history.getState().trackedFiles.has(other)).toBe(true);
    expect(diagnostics).toHaveLength(1);
  });

  test("the timeout is reported once per engine, whichever sidecar hits it", async () => {
    const first = newSidecar(history, 20);
    const second = newSidecar(history, 30);
    const { copying } = await snapshotStillRunning(first);

    await first.captureBeforeToolCall("Write", { file_path: "a.txt", content: "a\n" });
    await second.captureBeforeToolCall("Write", { file_path: "b.txt", content: "b\n" });

    expect(causes()).toEqual(["file_history_capture_timeout"]);
    expect(diagnostics[0]!.message).toContain("within 20 ms");
    copying.release();
    await history.flush();

    // Another engine reports its own.
    const otherEngine = newEngine({ sessionId: "other-engine" });
    const otherSidecar = newSidecar(otherEngine, 20);
    const held = await snapshotStillRunning(otherSidecar, otherEngine);
    await otherSidecar.captureBeforeToolCall("Write", { file_path: "c.txt", content: "c\n" });
    expect(causes()).toEqual(["file_history_capture_timeout", "file_history_capture_timeout"]);
    held.copying.release();
    await otherEngine.flush();
  });

  test("a timeout whose report cannot be delivered still ends the wait", async () => {
    const engine = new FileHistory({
      projectDir: project,
      sessionId: "closed-sink",
      onDiagnostic: () => { throw new Error("diagnostic sink is closed"); },
    });
    engines.push(engine);
    const sidecar = newSidecar(engine, 20);
    const { copying } = await snapshotStillRunning(sidecar, engine);

    await expect(
      sidecar.captureBeforeToolCall("Write", { file_path: "a.txt", content: "a\n" }),
    ).resolves.toBeUndefined();

    expect(snapshotIds(engine)).toEqual(["ev-0"]);
    copying.release();
    await engine.flush();
    expect(snapshotIds(engine)).toEqual(["ev-0", "ev-0-done"]);
  });

  test("a capture that finishes in time clears its timer and reports nothing", async () => {
    const timeoutMs = 4321;
    const sidecar = newSidecar(history, timeoutMs);
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");

    const capture = sidecar.captureBeforeToolCall("Write", { file_path: "new.txt", content: "x\n" });
    const [timer, ...more] = captureTimers(setTimer, timeoutMs);
    expect(timer).toBeDefined();
    expect(more).toEqual([]);
    // A pending capture alone does not keep the process alive.
    expect(timer!.hasRef()).toBe(false);
    expect(clearTimer).not.toHaveBeenCalledWith(timer);
    await capture;

    expect(clearTimer).toHaveBeenCalledWith(timer);
    expect(history.getState().trackedFiles.has(join(work, "new.txt"))).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  test("an abort ends a capture that waits behind a running snapshot, and clears its timer", async () => {
    const timeoutMs = 4321;
    const sidecar = newSidecar(history, timeoutMs);
    const { copying } = await snapshotStillRunning(sidecar);
    const controller = new AbortController();
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");

    const capture = sidecar.captureBeforeToolCall(
      "Write",
      { file_path: "new.txt", content: "x\n" },
      controller.signal,
    );
    const [timer] = captureTimers(setTimer, timeoutMs);
    expect(await settlesSoon(capture!)).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    controller.abort("permission mode changed to plan");
    await expect(capture).resolves.toBeUndefined();

    expect(snapshotIds()).toEqual(["ev-0"]);
    expect(clearTimer).toHaveBeenCalledWith(timer);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    copying.release();
    await history.flush();
    expect(diagnostics).toEqual([]);
  });

  test("a capture does not wait for diagnostics that canonical background work holds back", async () => {
    const delivery = hold();
    const engine = newEngine({
      sessionId: "compacting",
      withCanonicalBackgroundWork: async (run) => {
        await delivery.reach();
        return run();
      },
    });
    const sidecar = newSidecar(engine);
    // A failed backup: its diagnostic now waits for the journal's owner.
    await engine.trackEdit(work, "not-a-file");
    await delivery.entered;
    let flushed = false;
    const drain = engine.flush().then(() => { flushed = true; });
    const created = join(work, "created.txt");

    sidecar.onEvent(userMessage("user-1"));
    await sidecar.captureBeforeToolCall("Write", { file_path: created, content: "NEW\n" });

    // Both things the call waits for are done; the diagnostic is not.
    expect(engine.hasSnapshotFor("user-1")).toBe(true);
    expect(firstStateOf(created, engine)).toMatchObject({ backupFileName: null, version: 1 });
    expect(flushed).toBe(false);
    expect(diagnostics).toEqual([]);

    delivery.release();
    await drain;
    expect(causes()).toEqual(["file_history_track_failed"]);
  });
});

describe("file history of a system.move whose source cannot be backed up (#3437)", () => {
  type SidecarEvent = Parameters<FileHistorySidecar["onEvent"]>[0];
  const patiently = { timeout: 10_000, interval: 5 };

  function event(id: string, type: string, payload: Record<string, unknown>): SidecarEvent {
    return { id, msg: { type, payload } } as SidecarEvent;
  }

  function moveStarted(args: Record<string, unknown>): SidecarEvent {
    return event("move-started", "tool_call_started", {
      callId: "move",
      toolName: "system.move",
      args: JSON.stringify(args),
    });
  }

  /** Make every backup of `source` fail in copyFile; other files are copied. */
  function failCopiesOf(source: string, error: Error): void {
    vi.mocked(copyFile).mockImplementation(async (from, to, mode) => {
      if (from === source) throw error;
      return actualCopyFile(from, to, mode);
    });
  }

  /** The files handed to copyFile so far, in order. */
  function copiedFrom(): string[] {
    return vi.mocked(copyFile).mock.calls.map(([from]) => String(from));
  }

  /**
   * Wait for what a start event set in motion: the sidecar looks at the two
   * paths first and queues their backup afterwards, if it queues one.
   */
  async function startEventHandled(): Promise<void> {
    let seen = -1;
    while (seen !== vi.mocked(stat).mock.results.length) {
      seen = vi.mocked(stat).mock.results.length;
      await Promise.allSettled(vi.mocked(stat).mock.results.map((result) => result.value));
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      await history.flush();
    }
  }

  test.each([
    ["the disk is full", "ENOSPC", "file_history_degraded"],
    ["the copy fails for a reason that is not retried", "EMFILE", "file_history_track_failed"],
  ])(
    "when %s the move is not recorded, and a rewind leaves the file at its destination",
    async (_why, code, cause) => {
      const sidecar = new FileHistorySidecar({ fileHistory: history, workspaceRoot: work });
      const source = workFile("report.txt", "ONLY COPY\n");
      const destination = join(work, "final.txt");
      const args = { source, destination };
      failCopiesOf(source, Object.assign(new Error(`${code}: copyfile`), { code }));

      // The order the router keeps: the message, the start event, the wait
      // for file history, the tool, the completion event.
      sidecar.onEvent(event("user-1", "user_message", { message: "next prompt" }));
      sidecar.onEvent(moveStarted(args));
      // The start event's attempt comes first, so both are over when the
      // tool runs.
      await vi.waitFor(() => expect(copiedFrom()).toEqual([source]), patiently);
      await sidecar.captureBeforeToolCall("system.move", args);
      expect(copiedFrom()).toEqual([source, source]);
      // Neither attempt got as far as the destination. On record as "did
      // not exist", it would be removed by a rewind that has no source to
      // put back.
      expect(history.getState().trackedFiles.size).toBe(0);
      renameSync(source, destination);
      sidecar.onEvent(event("move-done", "tool_call_completed", {
        callId: "move",
        result: "",
        isError: false,
      }));
      await history.flush();

      expect(snapshotIds()).toEqual(["user-1", "move-done"]);
      expect(history.getState().trackedFiles.size).toBe(0);
      await expect(history.previewRewind("user-1")).resolves.toMatchObject({ filesChanged: [] });
      await expect(history.rewindToMessage("user-1")).resolves.toEqual([]);

      // Not undone, and not destroyed: the only copy is where the tool put it.
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(destination, "utf8")).toBe("ONLY COPY\n");
      expect(causes()).toEqual([cause, cause]);
    },
  );

  test.each(["the start event", "the capture"])(
    "%s records nothing of a move whose source stopped being a regular file",
    async (route) => {
      // The resolver saw a regular file there. What stat reports when the
      // sidecar looks again is all it has to go by, so a mocked result
      // stands in for a FIFO that took the file's place.
      const sidecar = new FileHistorySidecar({ fileHistory: history, workspaceRoot: work });
      const source = workFile("events.pipe", "must never be opened\n");
      const destination = join(work, "moved.pipe");
      const args = { source, destination };
      statAsNotRegular(source);
      const queue = history["pending"];

      if (route === "the start event") {
        sidecar.onEvent(moveStarted(args));
        await startEventHandled();
      } else {
        await sidecar.captureBeforeToolCall("system.move", args);
      }

      expect(vi.mocked(stat).mock.calls.map(([path]) => path)).toEqual([source, destination]);
      // Without its source the destination is left out as well: nothing was
      // queued, so it is not on record as a file that "did not exist".
      expect(history["pending"]).toBe(queue);
      expect(history.getState().trackedFiles.size).toBe(0);
      expect(copyFile).not.toHaveBeenCalled();
      expect(diagnostics).toEqual([]);
    },
  );

  test.each(["the start event", "the capture"])(
    "%s still backs up the other files of a shell command when one backup fails",
    async (route) => {
      // Only the two sides of a move stand or fall together.
      const sidecar = new FileHistorySidecar({ fileHistory: history, workspaceRoot: work });
      const failing = workFile("a.txt", "a\n");
      const plain = workFile("b.txt", "b\n");
      const call = { cmd: "rm a.txt b.txt", workdir: work };
      failCopiesOf(failing, ioError("copy"));

      if (route === "the start event") {
        sidecar.onEvent(event("rm-started", "tool_call_started", {
          callId: "rm",
          toolName: "exec_command",
          args: JSON.stringify(call),
        }));
        await startEventHandled();
      } else {
        await sidecar.captureBeforeToolCall("exec_command", call);
      }

      expect(copiedFrom()).toEqual([failing, plain]);
      expect([...history.getState().trackedFiles]).toEqual([plain]);
      expect(causes()).toEqual(["file_history_degraded"]);
    },
  );

  test("a system.move that the edit tool list names is an edit tool, and its files are backed up one by one", async () => {
    const sidecar = new FileHistorySidecar({
      fileHistory: history,
      workspaceRoot: work,
      editToolNames: ["system.move"],
    });
    const failing = workFile("a.txt", "a\n");
    const plain = workFile("b.txt", "b\n");
    const input = [
      "*** Begin Patch",
      ...[failing, plain].flatMap((file) => [`*** Update File: ${file}`, "@@", "-old", "+new"]),
      "*** End Patch",
    ].join("\n");
    failCopiesOf(failing, ioError("copy"));

    await sidecar.captureBeforeToolCall("system.move", { input });

    expect(copiedFrom()).toEqual([failing, plain]);
    expect([...history.getState().trackedFiles]).toEqual([plain]);
    expect(causes()).toEqual(["file_history_degraded"]);
  });

  test("trackEdits with stopAtFirstUnrecorded ends at the first path that is not on record", async () => {
    const failing = workFile("failing.txt", "failing\n");
    const plain = workFile("plain.txt", "plain\n");
    const other = workFile("other.txt", "other\n");
    const absent = join(work, "absent.txt");
    const late = join(work, "late.txt");
    const chained = { stopAtFirstUnrecorded: true };
    failCopiesOf(failing, ioError("copy"));

    // The first path fails: the ones behind it are not attempted, and with
    // nothing on record there is no snapshot and no index to write.
    await history.trackEdits([failing, plain, absent], "m1", chained);
    expect(history.getState().snapshots).toEqual([]);
    expect(copiedFrom()).toEqual([failing]);
    expect(indexWrites()).toBe(0);

    // What comes before the failed path stays on record, a path that does
    // not exist included. What comes after it is not attempted.
    await history.trackEdits([absent, plain, failing, other], "m2", chained);
    expect([...history.getState().trackedFiles]).toEqual([absent, plain]);
    expect(latestEntry(absent)).toMatchObject({ backupFileName: null, version: 1 });
    expect(copiedFrom()).toEqual([failing, plain, failing]);
    expect(indexWrites()).toBe(1);

    // A path that is on record from an earlier call does not end the operation.
    await history.trackEdits([absent, plain, other], "m3", chained);
    expect([...history.getState().trackedFiles]).toEqual([absent, plain, other]);
    expect(copiedFrom()).toEqual([failing, plain, failing, other]);

    // Without the option every path has its turn, whatever became of the
    // one before it.
    await history.trackEdits([failing, late], "m4");
    expect([...history.getState().trackedFiles]).toEqual([absent, plain, other, late]);
    expect(causes()).toEqual([
      "file_history_degraded",
      "file_history_degraded",
      "file_history_degraded",
    ]);
  });
});
