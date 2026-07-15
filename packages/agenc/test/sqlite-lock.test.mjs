import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  acquireLocalSqliteLock,
  acquireLocalSqliteLocks,
  configureLocalSqliteLockConnection,
  isSqliteBusyError,
  LocalSqliteLockTimeoutError,
} from "../lib/sqlite-lock.mjs";

const LOCK_APPLICATION_ID = 0x41474e43;
const LOCK_MODULE_URL = new URL("../lib/sqlite-lock.mjs", import.meta.url).href;
const HOLDER_SOURCE = String.raw`
const [moduleUrl, lockPath] = process.argv.slice(1);
try {
  const { acquireLocalSqliteLock } = await import(moduleUrl);
  const release = await acquireLocalSqliteLock(lockPath, {
    label: "child holder",
    timeoutMs: 5_000,
  });
  process.stdout.write("READY\n");
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
    process.exit(0);
  };
  process.stdin.once("data", finish);
  process.stdin.once("end", finish);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  process.exit(2);
}
`;
const HOT_JOURNAL_SOURCE = String.raw`
import { DatabaseSync } from "node:sqlite";
const lockPath = process.argv[1];
try {
  const database = new DatabaseSync(lockPath, { allowExtension: false, timeout: 0 });
  database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA cache_size=2; BEGIN IMMEDIATE");
  database.exec("UPDATE agenc_local_process_lock SET format_version = 2 WHERE singleton = 1");
  database.exec("CREATE TABLE crash_spill (id INTEGER PRIMARY KEY, payload BLOB NOT NULL) STRICT");
  const insert = database.prepare("INSERT INTO crash_spill(payload) VALUES (?)");
  for (let index = 0; index < 128; index += 1) insert.run(Buffer.alloc(4096, index));
  process.stdout.write("READY\n");
  process.stdin.resume();
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  process.exit(2);
}
`;
const STRESS_WORKER_SOURCE = String.raw`
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
const [moduleUrl, lockPath, counterPath, ownerPath, iterationText] = process.argv.slice(1);
const { acquireLocalSqliteLock } = await import(moduleUrl);
const iterations = Number(iterationText);
process.stdout.write("READY\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
process.stdin.pause();
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const release = await acquireLocalSqliteLock(lockPath, {
    label: "stress worker",
    timeoutMs: 15_000,
  });
  let ownerCreated = false;
  try {
    writeFileSync(ownerPath, String(process.pid), { flag: "wx", mode: 0o600 });
    ownerCreated = true;
    const current = Number(readFileSync(counterPath, "utf8"));
    if (!Number.isSafeInteger(current) || current < 0) throw new Error("invalid counter state");
    await new Promise((resolve) => setTimeout(resolve, 2));
    writeFileSync(counterPath, String(current + 1));
  } finally {
    if (ownerCreated && existsSync(ownerPath)) unlinkSync(ownerPath);
    release();
  }
}
process.stdout.write("DONE\n");
process.exit(0);
`;
const MULTI_LOCK_WORKER_SOURCE = String.raw`
const [moduleUrl, firstPath, secondPath] = process.argv.slice(1);
try {
  const { acquireLocalSqliteLocks } = await import(moduleUrl);
  process.stdout.write("READY\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  process.stdin.pause();
  const release = await acquireLocalSqliteLocks([firstPath, secondPath], {
    label: "reverse-order worker",
    timeoutMs: 3_000,
  });
  release();
  process.stdout.write("DONE\n");
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  process.exit(2);
}
`;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const testChildren = new WeakMap();

function makeRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  const children = [];
  testChildren.set(t, children);
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map(waitForExit));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function waitForHolder(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child lock holder did not become ready: ${stderr || stdout}`));
    }, 5_000);
    const inspect = () => {
      if (!stdout.includes("READY\n")) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code, signal) => {
      if (stdout.includes("READY\n")) return;
      clearTimeout(timer);
      reject(new Error(
        `child lock holder exited before ready (${code ?? signal}): ${stderr || stdout}`,
      ));
    });
    inspect();
  });
}

async function startHolder(t, lockPath) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", HOLDER_SOURCE, LOCK_MODULE_URL, lockPath],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  testChildren.get(t)?.push(child);
  await waitForHolder(child);
  return child;
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

function createDatabase(path, sql) {
  const database = new DatabaseSync(path);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

test("same-process contenders queue without blocking the event loop", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-same-process-");
  const lockPath = join(root, "operation.sqlite");
  const releaseFirst = await acquireLocalSqliteLock(lockPath, {
    label: "first operation",
    timeoutMs: 2_000,
  });
  let releaseSecond;
  let settled = false;
  const secondAttempt = acquireLocalSqliteLock(lockPath, {
    label: "second operation",
    timeoutMs: 2_000,
  }).then((release) => {
    settled = true;
    releaseSecond = release;
    return release;
  });
  secondAttempt.catch(() => {});

  try {
    await delay(50);
    assert.equal(settled, false, "a second critical section entered before release");
    releaseFirst();
    await secondAttempt;
    assert.equal(settled, true);
    releaseSecond();
    releaseSecond();

    const releaseThird = await acquireLocalSqliteLock(lockPath, { timeoutMs: 1_000 });
    releaseThird();
  } finally {
    releaseFirst();
    if (releaseSecond === undefined) {
      try {
        releaseSecond = await secondAttempt;
      } catch {
        // The assertion above will retain the useful failure.
      }
    }
    releaseSecond?.();
  }
});

test("large waiter budgets do not overflow Node's timer range", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-long-timeout-");
  const lockPath = join(root, "operation.sqlite");
  const releaseFirst = await acquireLocalSqliteLock(lockPath, { timeoutMs: 2_000 });
  let settled = false;
  let releaseSecond;
  const second = acquireLocalSqliteLock(lockPath, {
    label: "long waiter",
    timeoutMs: 3_000_000_000,
  }).then((release) => {
    settled = true;
    releaseSecond = release;
    return release;
  });
  second.catch(() => {});
  try {
    await delay(30);
    assert.equal(settled, false, "overflowed timer rejected or entered early");
    releaseFirst();
    await second;
  } finally {
    releaseFirst();
    releaseSecond?.();
  }
});

test("large command budgets do not overflow platform-helper timers", {
  skip: process.platform === "win32",
}, (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-long-helper-timeout-");
  const lockPath = join(root, "operation.sqlite");
  const source = String.raw`
Object.defineProperty(process, "platform", { value: "darwin" });
const [moduleUrl, path] = process.argv.slice(1);
try {
  const { readFile } = await import("node:fs/promises");
  const original = await readFile(new URL(moduleUrl), "utf8");
  const mountPatched = original.replace(
    'execFileUtf8("/sbin/mount", []',
    'execFileUtf8(process.execPath, ["--eval", "process.stdout.write(\'overlay on / (overlay, local)\')"]',
  );
  const patched = mountPatched.replace(
    "async function assertDarwinPathSecurity(path, role, context) {",
    "async function assertDarwinPathSecurity() { return; }\n" +
      "async function unusedAssertDarwinPathSecurity(path, role, context) {",
  );
  if (mountPatched === original || patched === mountPatched) {
    throw new Error("Darwin platform-helper test seams did not apply");
  }
  const patchedUrl = "data:text/javascript;base64," + Buffer.from(patched).toString("base64");
  const { acquireLocalSqliteLock } = await import(patchedUrl);
  const release = await acquireLocalSqliteLock(path, { timeoutMs: 3_000_000_000 });
  release();
  process.stdout.write("OK\n");
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  process.exitCode = 1;
}
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source, LOCK_MODULE_URL, lockPath],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "OK\n");
  assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
});

test("Windows ACL validation resolves PowerShell through the true OS namespace", async () => {
  const original = readFileSync(new URL(LOCK_MODULE_URL), "utf8");
  const exposed = original.replace(
    "function trustedWindowsPowerShellPath() {",
    "export function trustedWindowsPowerShellPath() {",
  ).replace(
    "function windowsPowerShellEnvironment(paths) {",
    "export function windowsPowerShellEnvironment(paths) {",
  ).replace(
    "function identityFromStats(stats, path) {",
    "export function identityFromStats(stats, path) {",
  );
  assert.notEqual(exposed, original, "Windows helper test seam did not apply");
  assert.doesNotMatch(original, /process\.env|env\.(?:SystemRoot|WINDIR)/);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(exposed).toString("base64")}`;
  const {
    identityFromStats,
    trustedWindowsPowerShellPath,
    windowsPowerShellEnvironment,
  } =
    await import(moduleUrl);
  assert.deepEqual(trustedWindowsPowerShellPath(), {
    systemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`,
    workingDirectory: String.raw`\\?\GLOBALROOT\SystemRoot\System32`,
    executable: String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
  });
  const environment = windowsPowerShellEnvironment([{
    path: String.raw`C:\Users\AgenC\lock.sqlite`,
    role: "file",
  }]);
  assert.deepEqual(Object.keys(environment).sort(), [
    "AGENC_LOCK_PATHS_JSON",
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "LOGONSERVER",
    "PATH",
    "PATHEXT",
    "PSMODULEPATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
  ]);
  assert.equal(environment.SYSTEMROOT, String.raw`\\?\GLOBALROOT\SystemRoot`);
  assert.equal(environment.WINDIR, environment.SYSTEMROOT);
  assert.equal(environment.PATH, String.raw`\\?\GLOBALROOT\SystemRoot\System32`);
  assert.equal(environment.TEMP, environment.PATH);
  assert.equal(environment.USERPROFILE, environment.PATH);
  assert.equal(
    environment.AGENC_LOCK_PATHS_JSON,
    '[{"path":"C:\\\\Users\\\\AgenC\\\\lock.sqlite","role":"file"}]',
  );
  assert.match(original, /\$drive\.DriveFormat -ne 'NTFS'/);
  assert.doesNotMatch(original, /'ReFS'/);
  assert.match(original, /\$leafMutationMask = \[int64\]852310/);
  assert.match(original, /\$ancestorMutationMask = \[int64\]852306/);
  assert.match(
    original,
    /S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464/,
  );
  for (const stats of [
    { dev: 0n, ino: 1n },
    { dev: 1n, ino: 0n },
    { dev: 1n, ino: -1n },
    { dev: 1n, ino: 0xffff_ffff_ffff_ffffn },
  ]) {
    assert.throws(
      () => identityFromStats(stats, "sentinel.sqlite"),
      /no stable filesystem identity/,
    );
  }
  assert.equal(identityFromStats({ dev: 2n, ino: 3n }, "valid.sqlite"), "2:3");
});

test("Darwin ACL listing parser accepts deny/read ACEs and rejects mutation or ambiguity", async () => {
  const original = readFileSync(new URL(LOCK_MODULE_URL), "utf8");
  const exposed = original.replace(
    "function validateDarwinAclListing(stdout, path, role) {",
    "export function validateDarwinAclListing(stdout, path, role) {",
  );
  assert.notEqual(exposed, original, "Darwin ACL parser test seam did not apply");
  const { validateDarwinAclListing } = await import(
    `data:text/javascript;base64,${Buffer.from(exposed).toString("base64")}`
  );
  const metadata = "drwx------+ 1 owner group 0 Jan 1 00:00 protected";
  assert.doesNotThrow(() => validateDarwinAclListing(`${metadata}\n`, "/protected", "leaf"));
  assert.doesNotThrow(() => validateDarwinAclListing(
    `${metadata}\n 0: group:everyone deny delete\n`,
    "/protected",
    "leaf",
  ));
  assert.doesNotThrow(() => validateDarwinAclListing(
    `${metadata}\n owner: owner\n 0: user:reader inherited allow ` +
      "read,list,search,readattr,readextattr,readsecurity,file_inherit,only_inherit\n",
    "/protected",
    "leaf",
  ));
  for (const right of [
    "write", "append", "add_file", "add_subdirectory", "delete", "delete_child",
    "writeattr", "writeextattr", "writesecurity", "chown",
  ]) {
    assert.throws(
      () => validateDarwinAclListing(
        `${metadata}\n 0: group:everyone allow ${right}\n`,
        "/protected",
        "leaf",
      ),
      /mutation-capable Darwin ACL/,
      right,
    );
  }
  for (const listing of [
    `${metadata}\n 0: group:everyone allow future_right\n`,
    `${metadata}\n 1: group:everyone deny delete\n 1: user:reader allow read\n`,
    `${metadata}\n unexpected continuation\n`,
    `${metadata}\r\n`,
  ]) {
    assert.throws(
      () => validateDarwinAclListing(listing, "/protected", "leaf"),
      /Darwin ACL helper returned|unknown right/,
    );
  }
});

test("a timed-out FIFO waiter is removed before its successor runs", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-waiter-cleanup-");
  const lockPath = join(root, "operation.sqlite");
  const releaseFirst = await acquireLocalSqliteLock(lockPath, { timeoutMs: 2_000 });
  const timedOut = acquireLocalSqliteLock(lockPath, {
    label: "expiring waiter",
    timeoutMs: 40,
  });
  const successor = acquireLocalSqliteLock(lockPath, {
    label: "successor",
    timeoutMs: 2_000,
  });
  await assert.rejects(timedOut, /expiring waiter timed out/);
  releaseFirst();
  const releaseSuccessor = await successor;
  releaseSuccessor();
});

test("duplicate ESM instances share the process-wide FIFO registry", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-duplicate-module-");
  const lockPath = join(root, "operation.sqlite");
  const duplicate = await import(`${LOCK_MODULE_URL}?duplicate-registry=1`);
  const releaseFirst = await acquireLocalSqliteLock(lockPath, { timeoutMs: 2_000 });
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
    releaseFirst();
  }, 50);
  try {
    const releaseSecond = await duplicate.acquireLocalSqliteLock(lockPath, {
      label: "duplicate module",
      timeoutMs: 2_000,
    });
    assert.equal(timerFired, true, "duplicate module blocked the timer that releases its predecessor");
    releaseSecond();
  } finally {
    clearTimeout(timer);
    releaseFirst();
  }
});

test("a child process owns the lock and SIGKILL releases it without reaping files", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-sigkill-");
  const lockPath = join(root, "operation.sqlite");
  const child = await startHolder(t, lockPath);

  const started = performance.now();
  let timerTicks = 0;
  const ticker = setInterval(() => {
    timerTicks += 1;
  }, 10);
  try {
    await assert.rejects(
      acquireLocalSqliteLock(lockPath, {
        label: "parent contention",
        timeoutMs: 400,
      }),
      (error) => {
        assert.match(error.message, /parent contention timed out/);
        assert.match(error.message, /operation\.sqlite/);
        assert.equal(error.code, "AGENC_LOCK_TIMEOUT");
        assert.equal(error.path, lockPath);
        return true;
      },
    );
  } finally {
    clearInterval(ticker);
  }
  assert.ok(timerTicks >= 10, `SQLite contention starved the event loop (${timerTicks} ticks)`);
  assert.ok(performance.now() - started < 2_000, "lock timeout ignored its budget");
  assert.equal(child.exitCode, null, "holder exited while its lock was contended");

  child.kill("SIGKILL");
  await waitForExit(child);
  assert.equal(existsSync(lockPath), true, "SQLite lock identity must remain durable");

  const release = await acquireLocalSqliteLock(lockPath, {
    label: "post-kill recovery",
    timeoutMs: 2_000,
  });
  release();
  assert.deepEqual(
    readdirSync(root).filter((name) => /-(?:journal|wal|shm)$/.test(name)),
    [],
    "a killed owner left SQLite recovery sidecars behind",
  );
});

test("a real hot rollback journal is recovered after SIGKILL", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-hot-journal-");
  const lockPath = join(root, "operation.sqlite");
  const initialize = await acquireLocalSqliteLock(lockPath, { timeoutMs: 2_000 });
  initialize();

  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", HOT_JOURNAL_SOURCE, lockPath],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  testChildren.get(t)?.push(child);
  await waitForHolder(child);
  const journalPath = `${lockPath}-journal`;
  assert.equal(existsSync(journalPath), true, "crash fixture did not create a rollback journal");
  const journal = readFileSync(journalPath);
  assert.ok(journal.length >= 512, `rollback journal was unexpectedly small (${journal.length})`);
  assert.equal(journal.subarray(0, 8).toString("hex"), "d9d505f920a163d7");

  child.kill("SIGKILL");
  await waitForExit(child);
  const release = await acquireLocalSqliteLock(lockPath, {
    label: "hot journal recovery",
    timeoutMs: 2_000,
  });
  release();

  const recovered = new DatabaseSync(lockPath, { readOnly: true });
  try {
    assert.equal(
      recovered.prepare(
        "SELECT format_version FROM agenc_local_process_lock WHERE singleton = 1",
      ).get().format_version,
      1,
    );
    assert.equal(
      recovered.prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'crash_spill'",
      ).get().count,
      0,
    );
    assert.equal(recovered.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    recovered.close();
  }
  assert.equal(existsSync(journalPath), false, "hot journal remained after recovery");
});

test("an expired deadline has no filesystem side effects and retains stable metadata", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-expired-");
  const missingParent = join(root, "must-not-exist");
  const lockPath = join(missingParent, "operation.sqlite");
  await assert.rejects(
    acquireLocalSqliteLock(lockPath, {
      deadline: performance.now() - 1,
      label: "already expired",
      timeoutMs: 9_999,
    }),
    (error) => {
      assert.ok(error instanceof LocalSqliteLockTimeoutError);
      assert.equal(error.code, "AGENC_LOCK_TIMEOUT");
      assert.equal(error.path, lockPath);
      assert.equal(error.label, "already expired");
      assert.equal(error.timeoutMs, 9_999);
      return true;
    },
  );
  assert.equal(existsSync(missingParent), false);
});

test("connection hardening and extended SQLITE_BUSY classification are explicit", () => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, timeout: 0 });
  try {
    configureLocalSqliteLockConnection(database);
    assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 0);
    assert.equal(database.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
    assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 3);
  } finally {
    database.close();
  }
  for (const errcode of [5, 261, 517, 773]) {
    assert.equal(isSqliteBusyError({ errcode }), true, String(errcode));
  }
  assert.equal(isSqliteBusyError({ errcode: 6 }), false, "SQLITE_LOCKED is not SQLITE_BUSY");
});

test("release attempts every rollback, close, and in-process release and preserves fault order", async () => {
  const original = readFileSync(new URL(LOCK_MODULE_URL), "utf8");
  const exposed = original.replace(
    "function releaseAcquired(acquired, label) {",
    "export function releaseAcquired(acquired, label) {",
  );
  assert.notEqual(exposed, original, "release aggregation test seam did not apply");
  const { releaseAcquired } = await import(
    `data:text/javascript;base64,${Buffer.from(exposed).toString("base64")}`
  );
  const calls = [];
  const item = (name) => {
    const database = {
      isOpen: true,
      isTransaction: true,
      exec() {
        calls.push(`${name}:rollback`);
        throw new Error(`${name}:rollback-fault`);
      },
      close() {
        calls.push(`${name}:close`);
        this.isOpen = false;
        throw new Error(`${name}:close-fault`);
      },
    };
    return {
      database,
      inProcessReleased: false,
      releaseInProcess() {
        calls.push(`${name}:release`);
        throw new Error(`${name}:release-fault`);
      },
    };
  };
  const first = item("first");
  const second = item("second");
  assert.throws(
    () => releaseAcquired([first, second], "fault injection"),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /fault injection lock release failed/);
      assert.equal(error.errors.length, 4);
      for (const [index, name] of ["second", "first"].entries()) {
        const closeError = error.errors[index * 2];
        assert.ok(closeError instanceof AggregateError);
        assert.deepEqual(
          closeError.errors.map((nested) => nested.message),
          [`${name}:rollback-fault`, `${name}:close-fault`],
        );
        assert.equal(error.errors[index * 2 + 1].message, `${name}:release-fault`);
      }
      return true;
    },
  );
  assert.deepEqual(calls, [
    "second:rollback",
    "second:close",
    "second:release",
    "first:rollback",
    "first:close",
    "first:release",
  ]);
});

test("eight barrier-started processes complete without overlap or lost increments", {
  timeout: 30_000,
}, async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-stress-");
  const lockPath = join(root, "operation.sqlite");
  const counterPath = join(root, "counter.txt");
  const ownerPath = join(root, "critical-section-owner");
  const workerCount = 8;
  const iterations = 4;
  writeFileSync(counterPath, "0", { mode: 0o600 });
  const workers = [];
  const stderrByWorker = new Map();
  for (let index = 0; index < workerCount; index += 1) {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        STRESS_WORKER_SOURCE,
        LOCK_MODULE_URL,
        lockPath,
        counterPath,
        ownerPath,
        String(iterations),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    workers.push(child);
    testChildren.get(t)?.push(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      stderrByWorker.set(child, stderr);
    });
  }
  await Promise.all(workers.map(waitForHolder));
  for (const worker of workers) worker.stdin.write("START\n");
  await Promise.all(workers.map(waitForExit));
  for (const worker of workers) {
    assert.equal(
      worker.exitCode,
      0,
      `stress worker failed: ${stderrByWorker.get(worker) ?? "no stderr"}`,
    );
  }
  assert.equal(Number(readFileSync(counterPath, "utf8")), workerCount * iterations);
  assert.equal(existsSync(ownerPath), false, "critical-section owner marker leaked");
});

test("independent processes acquire the same lock set in reverse request order without deadlock", {
  timeout: 10_000,
}, async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-reverse-order-");
  const firstPath = join(root, "first.sqlite");
  const secondPath = join(root, "second.sqlite");

  // Widen the interval after the first database acquisition. With canonical
  // identity ordering both workers queue on the same first lock; without that
  // ordering they deterministically hold opposite locks and time out.
  const original = readFileSync(new URL(LOCK_MODULE_URL), "utf8");
  const patched = original.replace(
    "item.database = await acquireSqliteDatabase(DatabaseSync, prepared, context);",
    "item.database = await acquireSqliteDatabase(DatabaseSync, prepared, context);\n" +
      "      if (acquired.length === 1) await delay(250);",
  );
  assert.notEqual(patched, original, "multi-lock delay test seam did not apply");
  const patchedPath = join(root, "sqlite-lock-delayed.mjs");
  writeFileSync(patchedPath, patched, { mode: 0o600 });
  const moduleUrl = pathToFileURL(patchedPath).href;

  // Establish both durable file identities before the barrier.
  const initialize = await acquireLocalSqliteLocks([firstPath, secondPath], {
    timeoutMs: 2_000,
  });
  initialize();

  const spawnWorker = (paths) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", MULTI_LOCK_WORKER_SOURCE, moduleUrl, ...paths],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    testChildren.get(t)?.push(child);
    return child;
  };
  const forward = spawnWorker([firstPath, secondPath]);
  const reverse = spawnWorker([secondPath, firstPath]);
  await Promise.all([waitForHolder(forward), waitForHolder(reverse)]);
  forward.stdin.write("START\n");
  reverse.stdin.write("START\n");
  await Promise.all([waitForExit(forward), waitForExit(reverse)]);
  assert.equal(forward.exitCode, 0, "forward-order worker deadlocked or failed");
  assert.equal(reverse.exitCode, 0, "reverse-order worker deadlocked or failed");
});

test("a private lock directory beneath a replaceable ancestor is rejected before creation", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-ancestor-");
  const unsafeAncestor = join(root, "replaceable");
  const privateParent = join(unsafeAncestor, "private");
  mkdirSync(privateParent, { recursive: true, mode: 0o700 });
  chmodSync(privateParent, 0o700);
  chmodSync(unsafeAncestor, 0o777);
  const lockPath = join(privateParent, "operation.sqlite");
  try {
    await assert.rejects(
      acquireLocalSqliteLock(lockPath, { timeoutMs: 1_000 }),
      /directory chain permits untrusted mutation/,
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    chmodSync(unsafeAncestor, 0o700);
  }
});

test("canonical parent aliases deduplicate to one in-process lock", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-alias-");
  const realParent = join(root, "real");
  const aliasParent = join(root, "alias");
  mkdirSync(realParent, { mode: 0o700 });
  symlinkSync(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  const realPath = join(realParent, "operation.sqlite");
  const aliasPath = join(aliasParent, "operation.sqlite");

  const releaseBoth = await acquireLocalSqliteLocks([aliasPath, realPath], {
    label: "alias set",
    timeoutMs: 1_000,
  });
  releaseBoth();

  const releaseFirst = await acquireLocalSqliteLock(realPath, { timeoutMs: 1_000 });
  let aliasEntered = false;
  let releaseAlias;
  const aliasAttempt = acquireLocalSqliteLock(aliasPath, { timeoutMs: 2_000 }).then((release) => {
    aliasEntered = true;
    releaseAlias = release;
    return release;
  });
  aliasAttempt.catch(() => {});
  try {
    await delay(50);
    assert.equal(aliasEntered, false);
    releaseFirst();
    await aliasAttempt;
    assert.equal(aliasEntered, true);
  } finally {
    releaseFirst();
    if (releaseAlias === undefined) {
      try {
        releaseAlias = await aliasAttempt;
      } catch {
        // Preserve the original assertion/acquisition failure.
      }
    }
    releaseAlias?.();
  }
});

test("unsafe symlink and hard-link lock identities are rejected", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-link-rejection-");

  const symlinkTarget = join(root, "symlink-target");
  const symlinkPath = join(root, "symlink.sqlite");
  if (process.platform === "win32") {
    mkdirSync(symlinkTarget, { mode: 0o700 });
    symlinkSync(symlinkTarget, symlinkPath, "junction");
  } else {
    writeFileSync(symlinkTarget, "not a lock database");
    symlinkSync(symlinkTarget, symlinkPath);
  }
  await assert.rejects(
    acquireLocalSqliteLock(symlinkPath, { timeoutMs: 1_000 }),
    /lock database is not a regular file/,
  );

  const hardLinkTarget = join(root, "hard-link-target.sqlite");
  const hardLinkPath = join(root, "hard-link.sqlite");
  writeFileSync(hardLinkTarget, "");
  linkSync(hardLinkTarget, hardLinkPath);
  await assert.rejects(
    acquireLocalSqliteLock(hardLinkPath, { timeoutMs: 1_000 }),
    /must not have hard-link aliases/,
  );
});

test("unrelated and incompatible SQLite databases are never repurposed", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-incompatible-");
  const unrelated = join(root, "unrelated.sqlite");
  createDatabase(unrelated, "CREATE TABLE user_data (value TEXT);");
  await assert.rejects(
    acquireLocalSqliteLock(unrelated, { timeoutMs: 1_000 }),
    /refusing to reuse an unrelated SQLite database/,
  );
  const preserved = new DatabaseSync(unrelated, { readOnly: true });
  try {
    assert.equal(
      preserved.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'user_data'")
        .get().count,
      1,
    );
  } finally {
    preserved.close();
  }

  const wrongApplication = join(root, "wrong-application.sqlite");
  createDatabase(wrongApplication, "PRAGMA application_id = 7;");
  await assert.rejects(
    acquireLocalSqliteLock(wrongApplication, { timeoutMs: 1_000 }),
    /incompatible application id/,
  );

  const wrongFormat = join(root, "wrong-format.sqlite");
  createDatabase(wrongFormat, `
    PRAGMA application_id = ${LOCK_APPLICATION_ID};
    CREATE TABLE agenc_local_process_lock (
      singleton INTEGER PRIMARY KEY,
      format_version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO agenc_local_process_lock VALUES (1, 2);
  `);
  await assert.rejects(
    acquireLocalSqliteLock(wrongFormat, { timeoutMs: 1_000 }),
    /incompatible format/,
  );

  const weakSchema = join(root, "weak-schema.sqlite");
  createDatabase(weakSchema, `
    PRAGMA application_id = ${LOCK_APPLICATION_ID};
    CREATE TABLE agenc_local_process_lock (
      singleton INTEGER,
      format_version INTEGER
    ) STRICT;
    INSERT INTO agenc_local_process_lock VALUES (1, 1);
  `);
  await assert.rejects(
    acquireLocalSqliteLock(weakSchema, { timeoutMs: 1_000 }),
    /incompatible format/,
  );
});

test("a valid WAL lock converts to DELETE while an unrelated WAL database is byte-preserved", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-wal-transition-");
  const valid = join(root, "valid.sqlite");
  const initialize = await acquireLocalSqliteLock(valid, { timeoutMs: 2_000 });
  initialize();
  const validWal = new DatabaseSync(valid);
  try {
    assert.equal(validWal.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal");
    validWal.exec(`
      BEGIN IMMEDIATE;
      UPDATE agenc_local_process_lock SET format_version = 1 WHERE singleton = 1;
      COMMIT;
    `);
  } finally {
    validWal.close();
  }
  const release = await acquireLocalSqliteLock(valid, { timeoutMs: 2_000 });
  release();
  const validAfter = new DatabaseSync(valid, { readOnly: true });
  try {
    assert.equal(validAfter.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  } finally {
    validAfter.close();
  }
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith("valid.sqlite-")),
    [],
  );

  const unrelated = join(root, "unrelated-wal.sqlite");
  const unrelatedWal = new DatabaseSync(unrelated);
  try {
    assert.equal(unrelatedWal.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal");
    unrelatedWal.exec("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES ('keep');");
  } finally {
    unrelatedWal.close();
  }
  if (process.platform !== "win32") chmodSync(unrelated, 0o600);
  const before = readFileSync(unrelated);
  const beforeSidecars = readdirSync(root).filter((name) => name.startsWith("unrelated-wal.sqlite-"));
  await assert.rejects(
    acquireLocalSqliteLock(unrelated, { timeoutMs: 1_000 }),
    /refusing to reuse an unrelated SQLite database/,
  );
  assert.deepEqual(readFileSync(unrelated), before);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith("unrelated-wal.sqlite-")),
    beforeSidecars,
  );
  const unrelatedAfter = new DatabaseSync(unrelated, { readOnly: true });
  try {
    assert.equal(unrelatedAfter.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(unrelatedAfter.prepare("SELECT value FROM user_data").get().value, "keep");
  } finally {
    unrelatedAfter.close();
  }
});

test("one supplied monotonic deadline covers every lock and rolls back partial acquisition", async (t) => {
  const root = makeRoot(t, "agenc-package-sqlite-deadline-");
  const firstPath = join(root, "00-first.sqlite");
  const blockedPath = join(root, "99-blocked.sqlite");
  const child = await startHolder(t, blockedPath);
  const deadline = performance.now() + 700;
  await delay(150);

  const started = performance.now();
  await assert.rejects(
    acquireLocalSqliteLocks([blockedPath, firstPath], {
      deadline,
      label: "shared deadline",
      timeoutMs: 3_000,
    }),
    /shared deadline timed out/,
  );
  assert.ok(
    performance.now() - started < 2_200,
    "the final lock received a fresh timeout instead of the shared deadline",
  );

  const releaseFirst = await acquireLocalSqliteLock(firstPath, {
    label: "partial rollback proof",
    timeoutMs: 2_000,
  });
  releaseFirst();
  assert.equal(child.exitCode, null, "partial rollback test accidentally released the blocked lock");
});
