import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type ReadStream,
  type Stats,
} from "node:fs";
import { copyFile, open, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileHistory, sha256OfFile } from "../../src/session/file-history.js";

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
    rename: vi.fn(actual.rename),
    stat: vi.fn(actual.stat),
  };
});

const actualCreateReadStream = vi.mocked(createReadStream).getMockImplementation()!;
const actualCopyFile = vi.mocked(copyFile).getMockImplementation()!;
const actualOpen = vi.mocked(open).getMockImplementation()!;
const actualRename = vi.mocked(rename).getMockImplementation()!;
const actualStat = vi.mocked(stat).getMockImplementation()!;

type Diagnostic = { cause: string; message: string };

let root: string;
let project: string;
let work: string;
let history: FileHistory;
let diagnostics: Diagnostic[];
const engines: FileHistory[] = [];

function newEngine(options: { sessionId?: string; enabled?: boolean } = {}): FileHistory {
  const engine = new FileHistory({
    projectDir: project,
    sessionId: options.sessionId ?? "fault-injection",
    enabled: options.enabled,
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
  vi.mocked(rename).mockReset().mockImplementation(actualRename);
  vi.mocked(stat).mockReset().mockImplementation(actualStat);
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
