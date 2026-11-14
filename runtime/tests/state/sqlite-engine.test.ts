import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isNativeSqliteLoadError,
  openSqliteDatabase,
  resetSqliteEngineForTests,
  selectedSqliteEngine,
  sqliteCodeName,
} from "./sqlite-engine.js";

const ENGINES = ["native", "node"] as const;

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agenc-sqlite-engine-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSqliteEngineForTests();
  rmSync(directory, { recursive: true, force: true });
});

function open(engine: (typeof ENGINES)[number], name = "db.sqlite", options?: Parameters<typeof openSqliteDatabase>[1]) {
  vi.stubEnv("AGENC_SQLITE_BACKEND", engine);
  return openSqliteDatabase(join(directory, name), options);
}

describe("selectedSqliteEngine", () => {
  it("uses the built-in engine on Windows and better-sqlite3 elsewhere", () => {
    expect(selectedSqliteEngine({}, "win32")).toBe("node");
    expect(selectedSqliteEngine({}, "darwin")).toBe("native");
    expect(selectedSqliteEngine({}, "linux")).toBe("native");
  });

  it("follows AGENC_SQLITE_BACKEND on every platform", () => {
    expect(selectedSqliteEngine({ AGENC_SQLITE_BACKEND: "native" }, "win32")).toBe("native");
    expect(selectedSqliteEngine({ AGENC_SQLITE_BACKEND: "node" }, "linux")).toBe("node");
    expect(selectedSqliteEngine({ AGENC_SQLITE_BACKEND: " Builtin " }, "darwin")).toBe("node");
  });

  it("recognizes a refused or missing native addon", () => {
    expect(isNativeSqliteLoadError(new Error(
      "An Application Control policy has blocked this file.\n\\\\?\\C:\\x\\better_sqlite3.node",
    ))).toBe(true);
    expect(isNativeSqliteLoadError(Object.assign(new Error("x"), { code: "ERR_DLOPEN_FAILED" }))).toBe(true);
    expect(isNativeSqliteLoadError(new Error("UNIQUE constraint failed: t.x"))).toBe(false);
  });
});

describe("sqliteCodeName", () => {
  it("names primary and extended result codes as better-sqlite3 does", () => {
    expect(sqliteCodeName(5)).toBe("SQLITE_BUSY");
    expect(sqliteCodeName(14)).toBe("SQLITE_CANTOPEN");
    expect(sqliteCodeName(2067)).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(sqliteCodeName(1555)).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(sqliteCodeName(778)).toBe("SQLITE_IOERR_WRITE");
    expect(sqliteCodeName(26)).toBe("SQLITE_NOTADB");
    expect(sqliteCodeName(99999)).toBe("UNKNOWN_SQLITE_ERROR_99999");
  });
});

describe.each(ENGINES)("the %s engine", (engine) => {
  it("keeps better-sqlite3's connection defaults", () => {
    const db = open(engine);
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(db.pragma("cache_size", { simple: true })).toBe(-16000);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
      // Switching an open connection to WAL keeps its synchronous level.
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
      db.pragma("synchronous = NORMAL");
      expect(db.pragma("synchronous", { simple: true })).toBe(1);
      expect(db.pragma("journal_mode")).toEqual([{ journal_mode: "wal" }]);
      expect(db.pragma("foreign_keys = ON")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("reopens a WAL database with synchronous NORMAL", () => {
    const first = open(engine);
    first.pragma("journal_mode = WAL");
    first.close();
    const second = open(engine);
    try {
      expect(second.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      second.close();
    }
  });

  it("binds like better-sqlite3 and returns plain rows with Buffer blobs", () => {
    const db = open(engine);
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b BLOB, n INTEGER)");
      const insert = db.prepare("INSERT INTO t (a, b, n) VALUES (@a, @b, @n)");
      expect(insert.run({ a: "x", b: Buffer.from("hi"), n: 1 })).toEqual({ changes: 1, lastInsertRowid: 1 });
      db.prepare("INSERT INTO t (a, b, n) VALUES (?, ?, ?)").run(["y", null, 2]);
      db.prepare("INSERT INTO t (a, b, n) VALUES (?, ?, ?)").run("z", null, 3);
      db.prepare("INSERT INTO t (a, n) VALUES ($a, :n)").run({ a: "w", n: 4 });
      const row = db.prepare("SELECT a, b, n FROM t WHERE id = ?").get(1) as { a: string; b: Buffer; n: number };
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Buffer.isBuffer(row.b)).toBe(true);
      expect(row.b.toString("utf8")).toBe("hi");
      expect(db.prepare("SELECT a FROM t ORDER BY id").all()).toEqual([{ a: "x" }, { a: "y" }, { a: "z" }, { a: "w" }]);
      expect(db.prepare("SELECT a FROM t WHERE id = ?").get(99)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("marks a statement busy while it is iterated", () => {
    const db = open(engine);
    try {
      db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3)");
      const statement = db.prepare("SELECT n FROM t ORDER BY n");
      expect(statement.busy).toBe(false);
      const iterator = statement.iterate();
      expect(statement.busy).toBe(true);
      expect(iterator.next().value).toEqual({ n: 1 });
      iterator.return?.();
      expect(statement.busy).toBe(false);
      expect([...statement.iterate()].map((row) => (row as { n: number }).n)).toEqual([1, 2, 3]);
      expect(statement.busy).toBe(false);
    } finally {
      db.close();
    }
  });

  it("nests transactions as savepoints and rolls back only the failed level", () => {
    const db = open(engine);
    try {
      db.exec("CREATE TABLE t (n INTEGER)");
      const insert = db.prepare("INSERT INTO t VALUES (?)");
      const inner = db.transaction((n: number) => {
        insert.run(n);
        throw new Error("inner failed");
      });
      const outer = db.transaction(() => {
        insert.run(1);
        expect(db.inTransaction).toBe(true);
        expect(() => inner(2)).toThrow("inner failed");
        insert.run(3);
        return "done";
      });
      expect(outer.immediate()).toBe("done");
      expect(db.inTransaction).toBe(false);
      expect(db.prepare("SELECT n FROM t ORDER BY n").all()).toEqual([{ n: 1 }, { n: 3 }]);
      expect(() => db.transaction(() => { insert.run(4); throw new Error("outer failed"); })()).toThrow("outer failed");
      expect(db.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 2 });
      expect(() => db.transaction(() => Promise.resolve(1))()).toThrow(/cannot return a promise/);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("reports SQLite failures with better-sqlite3's error codes", () => {
    const db = open(engine);
    try {
      db.exec("CREATE TABLE u (x UNIQUE); INSERT INTO u VALUES (1)");
      let unique: unknown;
      try {
        db.prepare("INSERT INTO u VALUES (1)").run();
      } catch (error) {
        unique = error;
      }
      expect((unique as { code?: string }).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect((unique as Error).message).toBe("UNIQUE constraint failed: u.x");
      expect(() => open(engine, "missing.sqlite", { readonly: true, fileMustExist: true }))
        .toThrow(expect.objectContaining({ code: "SQLITE_CANTOPEN" }));
      expect(() => open(engine, "missing-rw.sqlite", { fileMustExist: true }))
        .toThrow(expect.objectContaining({ code: "SQLITE_CANTOPEN" }));
    } finally {
      db.close();
    }
  });

  it("waits for a lock up to the busy timeout and then reports SQLITE_BUSY", () => {
    const writer = open(engine, "busy.sqlite");
    const other = open(engine, "busy.sqlite", { timeout: 50 });
    try {
      writer.exec("CREATE TABLE t (n INTEGER)");
      writer.exec("BEGIN IMMEDIATE");
      const started = Date.now();
      expect(() => other.exec("BEGIN IMMEDIATE")).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      writer.exec("ROLLBACK");
    } finally {
      writer.close();
      other.close();
    }
  });

  it("opens read-only connections that refuse writes", () => {
    const db = open(engine);
    db.exec("CREATE TABLE t (n INTEGER)");
    db.close();
    const reader = open(engine, "db.sqlite", { readonly: true, fileMustExist: true });
    try {
      expect(reader.readonly).toBe(true);
      expect(() => reader.exec("INSERT INTO t VALUES (1)"))
        .toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
    } finally {
      reader.close();
      expect(reader.open).toBe(false);
    }
  });

  it("rounds integers beyond 2^53 instead of failing the read", () => {
    const db = open(engine);
    try {
      db.exec("CREATE TABLE t (v INTEGER)");
      db.prepare("INSERT INTO t VALUES (?)").run(2n ** 60n);
      expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: 2 ** 60 });
    } finally {
      db.close();
    }
  });

  it("registers user-defined SQL functions with better-sqlite3's options", () => {
    const db = open(engine);
    try {
      db.function("add_one", { deterministic: true }, (value: unknown) => Number(value) + 1);
      db.function("blob_hex", (value: unknown) => (Buffer.isBuffer(value) ? value.toString("hex") : "not a buffer"));
      db.function("count_args", { varargs: true }, (...args: unknown[]) => args.length);
      expect(db.prepare("SELECT add_one(41) AS v").get()).toEqual({ v: 42 });
      expect(db.prepare("SELECT blob_hex(?) AS v").get(Buffer.from([1, 2]))).toEqual({ v: "0102" });
      expect(db.prepare("SELECT count_args(1, 2, 3) AS v").get()).toEqual({ v: 3 });
      expect(() => db.prepare("SELECT add_one(1, 2)").get()).toThrow();
      db.function("fails", () => {
        throw new Error("boom");
      });
      expect(() => db.prepare("SELECT fails()").get()).toThrow("boom");
    } finally {
      db.close();
    }
  });

  it("supports the FTS5 index the memory search uses", () => {
    const db = open(engine);
    try {
      db.exec("CREATE VIRTUAL TABLE f USING fts5(title, body)");
      db.prepare("INSERT INTO f VALUES (?, ?)").run("boot flash", "patched image");
      expect(db.prepare("SELECT title, bm25(f) AS score FROM f WHERE f MATCH ?").all("flash"))
        .toEqual([{ title: "boot flash", score: expect.any(Number) }]);
    } finally {
      db.close();
    }
  });
});
