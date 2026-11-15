/**
 * One place that opens SQLite databases, on one of two engines.
 *
 * - `native`: the better-sqlite3 addon, as before.
 * - `node`: Node's built-in `node:sqlite`, behind a thin layer that behaves
 *   like the part of better-sqlite3 AgenC uses.
 *
 * Windows defaults to `node`. Smart App Control (Windows 11) refuses to load
 * native files that have neither reputation nor a code signature, and the
 * better-sqlite3 addon is such a file, so on a machine with Smart App Control
 * on, AgenC could not open its state database at all. `node.exe` is signed, and
 * the built-in engine needs no other native file. Other platforms keep
 * better-sqlite3 unless it fails to load, and `AGENC_SQLITE_BACKEND=node` or
 * `=native` chooses explicitly.
 *
 * The `node` layer keeps better-sqlite3's defaults and contracts that callers
 * depend on: a 5 s busy timeout, a 16 MB page cache, `synchronous = NORMAL`
 * when it opens a WAL database, `pragma()`, nested transactions
 * as savepoints with `.immediate()` and friends, `open`, `inTransaction`, a
 * statement's `busy` flag while it is iterated, plain row objects with
 * `Buffer` blobs, and errors whose `code` names the SQLite result code
 * (`SQLITE_BUSY`, `SQLITE_CONSTRAINT_UNIQUE`, ...).
 */
import { existsSync } from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import BetterSqlite3Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

export type SqliteEngine = "native" | "node";

export interface OpenSqliteDatabaseOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  /** Busy timeout in milliseconds; better-sqlite3's default is 5000. */
  readonly timeout?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
/** better-sqlite3 is built with SQLITE_DEFAULT_CACHE_SIZE=-16000. */
const DEFAULT_CACHE_SIZE_KIB = 16_000;

let nativeUnavailable: Error | undefined;

/** The engine the next open uses. */
export function selectedSqliteEngine(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SqliteEngine {
  const requested = environment.AGENC_SQLITE_BACKEND?.trim().toLowerCase();
  if (requested === "node" || requested === "builtin") return "node";
  if (requested === "native" || requested === "better-sqlite3") return "native";
  if (platform === "win32") return "node";
  return nativeUnavailable === undefined ? "native" : "node";
}

/**
 * Whether an error came from loading the native addon rather than from
 * SQLite: a missing or mismatched build, or an operating system policy that
 * refused the file.
 */
export function isNativeSqliteLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ERR_DLOPEN_FAILED" || code === "MODULE_NOT_FOUND") return true;
  return /better_sqlite3\.node|Could not locate the bindings file|Application Control policy|NODE_MODULE_VERSION/.test(
    error.message,
  );
}

/** Open a database with better-sqlite3's option names and behavior. */
export function openSqliteDatabase(
  path: string,
  options: OpenSqliteDatabaseOptions = {},
): BetterSqlite3.Database {
  const explicit = process.env.AGENC_SQLITE_BACKEND !== undefined
    && process.env.AGENC_SQLITE_BACKEND.trim() !== "";
  if (selectedSqliteEngine() === "native") {
    try {
      return new BetterSqlite3Database(path, options);
    } catch (error) {
      // Without an explicit engine choice, a native addon that cannot load
      // falls back to the built-in engine for this and every later open.
      if (explicit || !isNativeSqliteLoadError(error)) throw error;
      nativeUnavailable = error as Error;
    }
  }
  return new NodeSqliteDatabase(path, options) as unknown as BetterSqlite3.Database;
}

/** Test seam: forget a recorded native load failure. */
export function resetSqliteEngineForTests(): void {
  nativeUnavailable = undefined;
}

// SQLite result code names, primary and extended, as better-sqlite3 reports
// them in `error.code`.
const PRIMARY_CODES: Readonly<Record<number, string>> = {
  1: "ERROR", 2: "INTERNAL", 3: "PERM", 4: "ABORT", 5: "BUSY", 6: "LOCKED",
  7: "NOMEM", 8: "READONLY", 9: "INTERRUPT", 10: "IOERR", 11: "CORRUPT",
  12: "NOTFOUND", 13: "FULL", 14: "CANTOPEN", 15: "PROTOCOL", 16: "EMPTY",
  17: "SCHEMA", 18: "TOOBIG", 19: "CONSTRAINT", 20: "MISMATCH", 21: "MISUSE",
  22: "NOLFS", 23: "AUTH", 24: "FORMAT", 25: "RANGE", 26: "NOTADB",
  27: "NOTICE", 28: "WARNING",
};
const EXTENDED_CODES: Readonly<Record<number, readonly string[]>> = {
  1: ["MISSING_COLLSEQ", "RETRY", "SNAPSHOT", "RESERVESIZE", "KEY", "UNABLE"],
  4: ["", "ROLLBACK"],
  5: ["RECOVERY", "SNAPSHOT", "TIMEOUT"],
  6: ["SHAREDCACHE", "VTAB"],
  8: ["RECOVERY", "CANTLOCK", "ROLLBACK", "DBMOVED", "CANTINIT", "DIRECTORY"],
  10: [
    "READ", "SHORT_READ", "WRITE", "FSYNC", "DIR_FSYNC", "TRUNCATE", "FSTAT",
    "UNLOCK", "RDLOCK", "DELETE", "BLOCKED", "NOMEM", "ACCESS",
    "CHECKRESERVEDLOCK", "LOCK", "CLOSE", "DIR_CLOSE", "SHMOPEN", "SHMSIZE",
    "SHMLOCK", "SHMMAP", "SEEK", "DELETE_NOENT", "MMAP", "GETTEMPPATH",
    "CONVPATH", "VNODE", "AUTH", "BEGIN_ATOMIC", "COMMIT_ATOMIC",
    "ROLLBACK_ATOMIC", "DATA", "CORRUPTFS", "IN_PAGE", "BADKEY", "CODEC",
  ],
  11: ["VTAB", "SEQUENCE", "INDEX"],
  14: ["NOTEMPDIR", "ISDIR", "FULLPATH", "CONVPATH", "DIRTYWAL", "SYMLINK"],
  19: [
    "CHECK", "COMMITHOOK", "FOREIGNKEY", "FUNCTION", "NOTNULL", "PRIMARYKEY",
    "TRIGGER", "UNIQUE", "VTAB", "ROWID", "PINNED", "DATATYPE",
  ],
  23: ["USER"],
  27: ["RECOVER_WAL", "RECOVER_ROLLBACK", "RBU"],
  28: ["AUTOINDEX"],
};

/** better-sqlite3's `code` for a SQLite (extended) result code. */
export function sqliteCodeName(errcode: number): string {
  const primary = errcode & 0xff;
  const primaryName = PRIMARY_CODES[primary];
  if (primaryName === undefined) return `UNKNOWN_SQLITE_ERROR_${errcode}`;
  const extended = errcode >> 8;
  if (extended === 0) return `SQLITE_${primaryName}`;
  const extendedName = EXTENDED_CODES[primary]?.[extended - 1];
  return extendedName === undefined || extendedName === ""
    ? `UNKNOWN_SQLITE_ERROR_${errcode}`
    : `SQLITE_${primaryName}_${extendedName}`;
}

/** The error the built-in engine throws, shaped like better-sqlite3's SqliteError. */
export class SqliteError extends Error {
  readonly code: string;
  readonly errcode: number;
  readonly errstr: string | undefined;

  constructor(message: string, errcode: number, errstr?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SqliteError";
    this.code = sqliteCodeName(errcode);
    this.errcode = errcode;
    this.errstr = errstr;
  }
}

function mapSqliteError(error: unknown): unknown {
  if (
    error instanceof Error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    typeof (error as { errcode?: unknown }).errcode === "number"
  ) {
    const { errcode, errstr } = error as unknown as { errcode: number; errstr?: string };
    return new SqliteError(error.message, errcode, errstr, { cause: error });
  }
  return error;
}

function rethrow(error: unknown): never {
  throw mapSqliteError(error);
}

function isNamedParameters(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer)
  );
}

/**
 * better-sqlite3 accepts anonymous values, arrays of them, and one object of
 * named values anywhere in the list. `node:sqlite` takes the named object
 * first. Booleans bind as 1 and 0 there too.
 */
function bindArguments(args: readonly unknown[]): unknown[] {
  let named: Record<string, unknown> | undefined;
  const anonymous: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isNamedParameters(value)) {
      if (named !== undefined) throw new TypeError("You cannot specify named parameters in two different objects");
      named = value;
    } else {
      anonymous.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
  };
  for (const arg of args) visit(arg);
  return named === undefined ? anonymous : [named, ...anonymous];
}

function toRow(row: unknown, bigints: boolean): unknown {
  if (row === undefined || row === null || typeof row !== "object") return row;
  const plain: Record<string, unknown> = {};
  for (const key in row as Record<string, unknown>) {
    const value = (row as Record<string, unknown>)[key];
    if (value instanceof Uint8Array) {
      plain[key] = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else if (bigints && typeof value === "bigint") {
      // better-sqlite3 without safeIntegers returns the nearest number.
      plain[key] = Number(value);
    } else {
      plain[key] = value;
    }
  }
  return plain;
}

function isOutOfRange(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "ERR_OUT_OF_RANGE";
}

class NodeSqliteStatement {
  readonly #statement: StatementSync;
  readonly #database: NodeSqliteDatabase;
  #iterating = 0;
  #bigints = false;

  constructor(database: NodeSqliteDatabase, statement: StatementSync) {
    this.#database = database;
    this.#statement = statement;
  }

  get database(): NodeSqliteDatabase {
    return this.#database;
  }

  get source(): string {
    return this.#statement.sourceSQL;
  }

  get reader(): boolean {
    return this.#statement.columns().length > 0;
  }

  get readonly(): boolean {
    return /^\s*(SELECT|WITH|EXPLAIN|VALUES)\b/i.test(this.#statement.sourceSQL);
  }

  /** True while an iterator from `iterate()` is still open. */
  get busy(): boolean {
    return this.#iterating > 0;
  }

  /** Read once; on a value beyond 2^53, read again with BigInts and round. */
  #read<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (!this.#bigints && isOutOfRange(error)) {
        this.#bigints = true;
        this.#statement.setReadBigInts(true);
        return read();
      }
      throw error;
    }
  }

  run(...args: unknown[]): BetterSqlite3.RunResult {
    try {
      const result = this.#statement.run(...(bindArguments(args) as []));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    } catch (error) {
      rethrow(error);
    }
  }

  get(...args: unknown[]): unknown {
    try {
      const bound = bindArguments(args);
      const row = this.#read(() => this.#statement.get(...(bound as [])));
      return toRow(row, this.#bigints);
    } catch (error) {
      rethrow(error);
    }
  }

  all(...args: unknown[]): unknown[] {
    try {
      const bound = bindArguments(args);
      const rows = this.#read(() => this.#statement.all(...(bound as [])));
      return rows.map((row) => toRow(row, this.#bigints));
    } catch (error) {
      rethrow(error);
    }
  }

  iterate(...args: unknown[]): IterableIterator<unknown> {
    let inner: Iterator<unknown>;
    try {
      inner = this.#statement.iterate(...(bindArguments(args) as [])) as Iterator<unknown>;
    } catch (error) {
      rethrow(error);
    }
    this.#iterating += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.#iterating -= 1;
    };
    const statement = this;
    const iterator: IterableIterator<unknown> = {
      next(): IteratorResult<unknown> {
        if (finished) return { done: true, value: undefined };
        try {
          const step = inner.next();
          if (step.done === true) {
            finish();
            return { done: true, value: undefined };
          }
          return { done: false, value: toRow(step.value, statement.#bigints) };
        } catch (error) {
          finish();
          rethrow(error);
        }
      },
      return(value?: unknown): IteratorResult<unknown> {
        if (!finished) {
          finish();
          try {
            inner.return?.();
          } catch {
            // Closing a cursor that already ended is not an error.
          }
        }
        return { done: true, value };
      },
      [Symbol.iterator]() {
        return this;
      },
    };
    return iterator;
  }

  pluck(): never {
    throw new TypeError("pluck() is not supported by the built-in SQLite engine");
  }

  raw(): never {
    throw new TypeError("raw() is not supported by the built-in SQLite engine");
  }

  expand(): never {
    throw new TypeError("expand() is not supported by the built-in SQLite engine");
  }

  bind(): never {
    throw new TypeError("bind() is not supported by the built-in SQLite engine");
  }

  safeIntegers(): never {
    throw new TypeError("safeIntegers() is not supported by the built-in SQLite engine");
  }

  columns(): BetterSqlite3.ColumnDefinition[] {
    return this.#statement.columns().map((column) => ({
      name: column.name,
      column: column.column,
      table: column.table,
      database: column.database,
      type: column.type,
    }));
  }
}

type TransactionFunction = ((...args: unknown[]) => unknown) & {
  default: (...args: unknown[]) => unknown;
  deferred: (...args: unknown[]) => unknown;
  immediate: (...args: unknown[]) => unknown;
  exclusive: (...args: unknown[]) => unknown;
  database: NodeSqliteDatabase;
};

/** better-sqlite3's savepoint name, used for every nested level. */
const SAVEPOINT = "`\t_bs3.\t`";

class NodeSqliteDatabase {
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #readonly: boolean;

  constructor(path: string, options: OpenSqliteDatabaseOptions = {}) {
    const memory = path === ":memory:" || path === "";
    this.#path = path;
    this.#readonly = options.readonly === true;
    if (options.fileMustExist === true && !memory && !existsSync(path)) {
      // SQLITE_CANTOPEN, as better-sqlite3 reports a missing file.
      throw new SqliteError("unable to open database file", 14, "unable to open database file");
    }
    try {
      this.#database = new DatabaseSync(memory ? ":memory:" : path, {
        readOnly: this.#readonly,
        timeout: options.timeout ?? DEFAULT_BUSY_TIMEOUT_MS,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowBareNamedParameters: true,
        allowUnknownNamedParameters: true,
      });
      this.#database.exec(`PRAGMA cache_size = -${DEFAULT_CACHE_SIZE_KIB}`);
      // better-sqlite3 is built with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, which
      // SQLite applies when it opens a database already in WAL mode (not when
      // an open connection switches to WAL).
      if (this.#journalMode() === "wal") this.#database.exec("PRAGMA synchronous = NORMAL");
    } catch (error) {
      rethrow(error);
    }
  }

  #journalMode(): string {
    const row = this.#database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    return String(row?.journal_mode ?? "").toLowerCase();
  }

  get open(): boolean {
    return this.#database.isOpen;
  }

  get inTransaction(): boolean {
    return this.#database.isOpen && this.#database.isTransaction;
  }

  get name(): string {
    return this.#path;
  }

  get memory(): boolean {
    return this.#path === ":memory:" || this.#path === "";
  }

  get readonly(): boolean {
    return this.#readonly;
  }

  prepare(sql: string): NodeSqliteStatement {
    try {
      return new NodeSqliteStatement(this, this.#database.prepare(sql));
    } catch (error) {
      rethrow(error);
    }
  }

  exec(sql: string): this {
    try {
      this.#database.exec(sql);
    } catch (error) {
      rethrow(error);
    }
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[];
    if (options.simple === true) {
      const first = rows[0];
      return first === undefined ? undefined : Object.values(first)[0];
    }
    return rows;
  }

  /**
   * A user-defined SQL function, with better-sqlite3's options. Blob
   * arguments arrive as Buffers, as they do there.
   */
  function(
    name: string,
    optionsOrFn: BetterSqlite3.RegistrationOptions | ((...args: unknown[]) => unknown),
    maybeFn?: (...args: unknown[]) => unknown,
  ): this {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (typeof fn !== "function") throw new TypeError("Expected last argument to be a function");
    const implementation = (...args: SQLOutputValue[]): SQLInputValue => {
      const converted = args.map((value) =>
        value instanceof Uint8Array && !Buffer.isBuffer(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : value,
      );
      const result: unknown = Reflect.apply(fn, undefined, converted);
      return (typeof result === "boolean" ? (result ? 1 : 0) : result) as SQLInputValue;
    };
    // node:sqlite takes the arity from fn.length, as better-sqlite3 does.
    Object.defineProperty(implementation, "length", { value: fn.length });
    try {
      this.#database.function(
        name,
        {
          deterministic: options.deterministic === true,
          directOnly: options.directOnly === true,
          varargs: options.varargs === true,
          useBigIntArguments: options.safeIntegers === true,
        },
        implementation,
      );
    } catch (error) {
      rethrow(error);
    }
    return this;
  }

  transaction(fn: (...args: unknown[]) => unknown): TransactionFunction {
    if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function");
    const database = this;
    const wrap = (begin: string) =>
      function sqliteTransaction(this: unknown, ...args: unknown[]): unknown {
        let before: string;
        let after: string;
        let undo: string;
        if (database.inTransaction) {
          before = `SAVEPOINT ${SAVEPOINT}`;
          after = `RELEASE ${SAVEPOINT}`;
          undo = `ROLLBACK TO ${SAVEPOINT}`;
        } else {
          before = begin;
          after = "COMMIT";
          undo = "ROLLBACK";
        }
        database.exec(before);
        try {
          const result = Reflect.apply(fn, this, args);
          if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
            throw new TypeError("Transaction function cannot return a promise");
          }
          database.exec(after);
          return result;
        } catch (error) {
          if (database.inTransaction) {
            database.exec(undo);
            if (undo !== "ROLLBACK") database.exec(after);
          }
          throw error;
        }
      };
    const transaction = wrap("BEGIN") as TransactionFunction;
    transaction.default = transaction;
    transaction.deferred = wrap("BEGIN DEFERRED");
    transaction.immediate = wrap("BEGIN IMMEDIATE");
    transaction.exclusive = wrap("BEGIN EXCLUSIVE");
    transaction.database = this;
    return transaction;
  }

  close(): this {
    if (this.#database.isOpen) {
      try {
        this.#database.close();
      } catch (error) {
        rethrow(error);
      }
    }
    return this;
  }
}

export { NodeSqliteDatabase };
