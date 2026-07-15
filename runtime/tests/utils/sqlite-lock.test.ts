import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  acquireLocalSqliteLock,
  acquireLocalSqliteLocks,
} from "../../src/utils/sqlite-lock.js";

const LOCK_APPLICATION_ID = 0x41474e43;
const PACKAGE_LOCK_MODULE_URL = new URL(
  "../../../packages/agenc/lib/sqlite-lock.mjs",
  import.meta.url,
).href;
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

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

let root: string;
const children = new Set<ChildProcessWithoutNullStreams>();

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-runtime-sqlite-lock-"));
  chmodSync(root, 0o700);
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all([...children].map(waitForExit));
  children.clear();
  rmSync(root, { recursive: true, force: true });
});

async function startHolder(lockPath: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      HOLDER_SOURCE,
      PACKAGE_LOCK_MODULE_URL,
      lockPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`child lock holder did not become ready: ${stderr || stdout}`));
    }, 5_000);
    const inspect = (): void => {
      if (!stdout.includes("READY\n")) return;
      clearTimeout(timer);
      resolveReady();
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code, signal) => {
      if (stdout.includes("READY\n")) return;
      clearTimeout(timer);
      rejectReady(new Error(
        `child lock holder exited before ready (${code ?? signal}): ${stderr || stdout}`,
      ));
    });
    inspect();
  });
  return child;
}

function createDatabase(path: string, sql: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

test("same-process contenders serialize without blocking timers", async () => {
  const lockPath = join(root, "operation.sqlite");
  const releaseFirst = await acquireLocalSqliteLock(lockPath, {
    label: "first operation",
    timeoutMs: 2_000,
  });
  let releaseSecond: (() => void) | undefined;
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
    expect(settled).toBe(false);
    releaseFirst();
    const acquiredSecond = await secondAttempt;
    expect(settled).toBe(true);
    acquiredSecond();
    acquiredSecond();

    const releaseThird = await acquireLocalSqliteLock(lockPath, { timeoutMs: 1_000 });
    releaseThird();
  } finally {
    releaseFirst();
    if (releaseSecond === undefined) {
      try {
        releaseSecond = await secondAttempt;
      } catch {
        // Preserve the original assertion/acquisition failure.
      }
    }
    releaseSecond?.();
  }
});

test("package and runtime entry points share one FIFO registry in both directions", async () => {
  const packageModule = await import(PACKAGE_LOCK_MODULE_URL) as {
    acquireLocalSqliteLock(
      path: string,
      options?: { readonly timeoutMs?: number; readonly label?: string },
    ): Promise<() => void>;
  };
  const proveDirection = async (
    holder: typeof acquireLocalSqliteLock,
    contender: typeof acquireLocalSqliteLock,
    suffix: string,
  ): Promise<void> => {
    const lockPath = join(root, `${suffix}.sqlite`);
    const releaseFirst = await holder(lockPath, { timeoutMs: 2_000 });
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
      releaseFirst();
    }, 50);
    try {
      const releaseSecond = await contender(lockPath, {
        label: suffix,
        timeoutMs: 2_000,
      });
      expect(timerFired).toBe(true);
      releaseSecond();
    } finally {
      clearTimeout(timer);
      releaseFirst();
    }
  };

  await proveDirection(
    packageModule.acquireLocalSqliteLock,
    acquireLocalSqliteLock,
    "package-holds-runtime-waits",
  );
  await proveDirection(
    acquireLocalSqliteLock,
    packageModule.acquireLocalSqliteLock,
    "runtime-holds-package-waits",
  );
});

test("the package and runtime helpers contend, and SIGKILL releases the database", async () => {
  const lockPath = join(root, "cross-entrypoint.sqlite");
  const child = await startHolder(lockPath);

  const started = performance.now();
  await expect(acquireLocalSqliteLock(lockPath, {
    label: "runtime contention",
    timeoutMs: 400,
  })).rejects.toThrow(/runtime contention timed out.*cross-entrypoint\.sqlite/);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(child.exitCode).toBeNull();

  child.kill("SIGKILL");
  await waitForExit(child);
  expect(existsSync(lockPath)).toBe(true);

  const release = await acquireLocalSqliteLock(lockPath, {
    label: "post-kill runtime recovery",
    timeoutMs: 2_000,
  });
  release();
  expect(readdirSync(root).filter((name) => /-(?:journal|wal|shm)$/.test(name))).toEqual([]);
}, 10_000);

test("canonical directory aliases deduplicate before acquiring SQLite", async () => {
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
  let releaseAlias: (() => void) | undefined;
  const aliasAttempt = acquireLocalSqliteLock(aliasPath, { timeoutMs: 2_000 }).then((release) => {
    aliasEntered = true;
    releaseAlias = release;
    return release;
  });
  aliasAttempt.catch(() => {});
  try {
    await delay(50);
    expect(aliasEntered).toBe(false);
    releaseFirst();
    await aliasAttempt;
    expect(aliasEntered).toBe(true);
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

test("unsafe symlink and hard-link lock identities are rejected", async () => {
  const symlinkTarget = join(root, "symlink-target");
  const symlinkPath = join(root, "symlink.sqlite");
  if (process.platform === "win32") {
    mkdirSync(symlinkTarget, { mode: 0o700 });
    symlinkSync(symlinkTarget, symlinkPath, "junction");
  } else {
    writeFileSync(symlinkTarget, "not a lock database");
    symlinkSync(symlinkTarget, symlinkPath);
  }
  await expect(acquireLocalSqliteLock(symlinkPath, { timeoutMs: 1_000 }))
    .rejects.toThrow(/lock database is not a regular file/);

  const hardLinkTarget = join(root, "hard-link-target.sqlite");
  const hardLinkPath = join(root, "hard-link.sqlite");
  writeFileSync(hardLinkTarget, "");
  linkSync(hardLinkTarget, hardLinkPath);
  await expect(acquireLocalSqliteLock(hardLinkPath, { timeoutMs: 1_000 }))
    .rejects.toThrow(/must not have hard-link aliases/);
});

test("unrelated and incompatible SQLite databases are preserved and rejected", async () => {
  const unrelated = join(root, "unrelated.sqlite");
  createDatabase(unrelated, "CREATE TABLE user_data (value TEXT);");
  await expect(acquireLocalSqliteLock(unrelated, { timeoutMs: 1_000 }))
    .rejects.toThrow(/refusing to reuse an unrelated SQLite database/);
  const preserved = new DatabaseSync(unrelated, { readOnly: true });
  try {
    const row = preserved.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'user_data'",
    ).get() as { readonly count: number };
    expect(row.count).toBe(1);
  } finally {
    preserved.close();
  }

  const wrongApplication = join(root, "wrong-application.sqlite");
  createDatabase(wrongApplication, "PRAGMA application_id = 7;");
  await expect(acquireLocalSqliteLock(wrongApplication, { timeoutMs: 1_000 }))
    .rejects.toThrow(/incompatible application id/);

  const wrongFormat = join(root, "wrong-format.sqlite");
  createDatabase(wrongFormat, `
    PRAGMA application_id = ${LOCK_APPLICATION_ID};
    CREATE TABLE agenc_local_process_lock (
      singleton INTEGER PRIMARY KEY,
      format_version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO agenc_local_process_lock VALUES (1, 2);
  `);
  await expect(acquireLocalSqliteLock(wrongFormat, { timeoutMs: 1_000 }))
    .rejects.toThrow(/incompatible format/);
});

test("one monotonic deadline covers a sorted lock set and partial acquisition rolls back", async () => {
  const firstPath = join(root, "00-first.sqlite");
  const blockedPath = join(root, "99-blocked.sqlite");
  const child = await startHolder(blockedPath);
  const deadline = performance.now() + 700;
  await delay(150);

  const started = performance.now();
  await expect(acquireLocalSqliteLocks([blockedPath, firstPath], {
    deadline,
    label: "shared deadline",
    timeoutMs: 3_000,
  })).rejects.toThrow(/shared deadline timed out/);
  expect(performance.now() - started).toBeLessThan(2_200);

  const releaseFirst = await acquireLocalSqliteLock(firstPath, {
    label: "partial rollback proof",
    timeoutMs: 2_000,
  });
  releaseFirst();
  expect(child.exitCode).toBeNull();
}, 10_000);
