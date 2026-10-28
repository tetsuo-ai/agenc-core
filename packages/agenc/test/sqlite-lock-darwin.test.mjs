import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  acquireLocalSqliteLock,
  assertLocalPrivateDirectory,
  LocalSqliteLockTimeoutError,
} from "../lib/sqlite-lock.mjs";

const LOCAL_TYPES = "apfs,bcachefs,btrfs,exfat,ext2,ext3,ext4,f2fs,hfs,hfsplus,jfs,msdos,nilfs2,ntfs,ntfs3,overlay,ramfs,reiserfs,tmpfs,ubifs,ufs,vfat,xfs,zfs";
const DF_HEADER = "Filesystem 512-blocks Used Available Capacity Mounted on\n";

// Inject at the command boundary so the public lock APIs, their deadlines,
// directory checks and SQLite transactions still run. A stuck child never
// acknowledges kill or invokes its exit callback, just like uninterruptible I/O.
function darwinCommands(t, { type = "apfs", stdout, stderr = "", error, hang } = {}) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const original = childProcess.execFile;
  const calls = [];
  const pending = new Set();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-darwin-lock-")));
  chmodSync(root, 0o700);
  childProcess.execFile = (file, args, options, callback) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const call = { file, args, options, child, signals: [], unreferenced: false };
    calls.push(call);
    child.kill = (signal) => { call.signals.push(signal); return true; };
    child.unref = () => { call.unreferenced = true; };
    const finish = (failure, output = "", diagnostics = "") => {
      pending.delete(finish);
      callback(failure, output, diagnostics);
    };
    pending.add(finish);
    if (file === "/sbin/mount" || file === hang) return child;
    queueMicrotask(() => {
      if (file === "/bin/ls") return finish(null, "directory metadata\n");
      assert.equal(file, "/bin/df", "unexpected filesystem helper");
      assert.deepEqual(args, ["-P", "-T", LOCAL_TYPES, root]);
      assert.deepEqual(options.env, { LC_ALL: "C" });
      if (!args[2].split(",").includes(type)) {
        return finish(Object.assign(new Error("df: excluded filesystem"), { code: 1 }));
      }
      finish(error ?? null, stdout ?? `${DF_HEADER}/dev/disk3s1 1000 100 900 10% /\n`, stderr);
    });
    return child;
  };
  Object.defineProperty(process, "platform", { value: "darwin" });
  syncBuiltinESMExports();
  t.after(() => {
    // Also release the old implementation's timer after a red test.
    for (const finish of pending) finish(new Error("test cleanup"));
    childProcess.execFile = original;
    Object.defineProperty(process, "platform", platform);
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, calls };
}

async function within(promise, milliseconds = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("filesystem check did not settle")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const posix = { skip: process.platform === "win32" };

test("macOS lock acquisition never enumerates mounts even when mount would hang", posix, async (t) => {
  const { root, calls } = darwinCommands(t);
  const release = await within(acquireLocalSqliteLock(join(root, "lock.sqlite"), { timeoutMs: 5_000 }));
  release();
  assert.equal(calls.some(({ file }) => file === "/sbin/mount"), false);
  assert.ok(calls.some(({ file }) => file === "/bin/df"));
});

for (const type of ["apfs", "hfs", "exfat", "msdos", "ntfs", "ufs", "zfs"]) {
  test(`macOS path-specific filesystem filter accepts existing local type ${type}`, posix, async (t) => {
    const { root } = darwinCommands(t, { type });
    assert.equal(await within(assertLocalPrivateDirectory(root)), root);
  });
}

for (const type of ["nfs", "smbfs", "webdav", "autofs", "osxfuse", "unknown"]) {
  test(`macOS path-specific filesystem filter fails closed for ${type}`, posix, async (t) => {
    const { root } = darwinCommands(t, { type });
    await assert.rejects(within(assertLocalPrivateDirectory(root)), /non-local or unknown lock filesystem/);
  });
}

for (const [description, response] of [
  ["empty response", { stdout: "" }],
  ["header only", { stdout: DF_HEADER }],
  ["multiple filesystems", { stdout: `${DF_HEADER}/dev/disk3s1 1000 100 900 10% /\n/dev/disk4s1 1000 100 900 10% /Volumes/other\n` }],
  ["malformed row", { stdout: `${DF_HEADER}unexpected output\n` }],
  ["helper diagnostics", { stderr: "df: stats possibly stale\n" }],
  ["helper failure", { error: Object.assign(new Error("df failed"), { code: 1 }) }],
]) {
  test(`macOS filesystem probe fails closed on ${description}`, posix, async (t) => {
    const { root } = darwinCommands(t, response);
    await assert.rejects(within(assertLocalPrivateDirectory(root)), /non-local or unknown lock filesystem/);
  });
}

test("macOS filesystem locality follows statfs through APFS firmlinks", posix, async (t) => {
  const { root } = darwinCommands(t, {
    stdout: `${DF_HEADER}/dev/disk3s1 1000 100 900 10% /System/Volumes/Data\n`,
  });
  assert.equal(await within(assertLocalPrivateDirectory(root)), root);
});

test("macOS filesystem probe respects an earlier supplied deadline", posix, async (t) => {
  const { root } = darwinCommands(t, { hang: "/bin/df" });
  await assert.rejects(
    within(assertLocalPrivateDirectory(root, { timeoutMs: 60_000, deadline: performance.now() + 50 })),
    (error) => error instanceof LocalSqliteLockTimeoutError && error.timeoutMs <= 50,
  );
});

test("macOS filesystem probe rejects without waiting for an unkillable child to exit", posix, async (t) => {
  const { root, calls } = darwinCommands(t, { hang: "/bin/df" });
  await assert.rejects(
    within(assertLocalPrivateDirectory(root, { timeoutMs: 40, label: "startup" })),
    (error) => error instanceof LocalSqliteLockTimeoutError &&
      error.code === "AGENC_LOCK_TIMEOUT" && /macOS lock filesystem probe/.test(error.message),
  );
  const probe = calls.find(({ file }) => file === "/bin/df");
  assert.ok(probe);
  assert.deepEqual(probe.signals, ["SIGKILL"]);
  assert.equal(probe.unreferenced, true);
  assert.equal(probe.child.stdin.destroyed, true);
  assert.equal(probe.child.stdout.destroyed, true);
  assert.equal(probe.child.stderr.destroyed, true);
});

test("macOS filesystem probe has a short cap even with a large lock budget", posix, async (t) => {
  const { root } = darwinCommands(t, { hang: "/bin/df" });
  const started = performance.now();
  await assert.rejects(
    within(assertLocalPrivateDirectory(root, { timeoutMs: 60_000 }), 3_500),
    (error) => error instanceof LocalSqliteLockTimeoutError &&
      error.timeoutMs === 2_000 && /macOS lock filesystem probe/.test(error.message),
  );
  assert.ok(performance.now() - started >= 1_900);
});
