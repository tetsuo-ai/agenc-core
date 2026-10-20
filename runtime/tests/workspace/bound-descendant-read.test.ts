import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { __workspaceBoundHelperLaunchPlanForTests } from "../../src/workspace/file-mutation-transaction.js";

let root = "";
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    await rm(root + "-moved", { recursive: true, force: true });
  }
});

/**
 * A raw authenticated helper whose traversal worker always refuses: on Linux
 * every descendant read and validation below is answered by the helper's own
 * descriptor walk, never by a worker, and never through a symbolic link.
 */
test.skipIf(process.platform !== "linux")("walks descendants through held descriptors without a worker or a link", async () => {
  root = await mkdtemp(join(tmpdir(), "bound-descendant-read-"));
  await mkdir(join(root, "a", "b"), { recursive: true });
  await writeFile(join(root, "a", "b", "file.txt"), "deep\n");
  await writeFile(join(root, "top.txt"), "top\n");
  await symlink(join(root, "a"), join(root, "a-link"));
  await symlink("file.txt", join(root, "a", "b", "leaf-link.txt"));
  execFileSync("mkfifo", [join(root, "a", "b", "fifo")]);
  const plan = __workspaceBoundHelperLaunchPlanForTests({
    executable: process.execPath, platform: process.platform,
    workerSource: 'process.stdout.write(JSON.stringify({type:"result",ok:false,code:"WORKER_CALLED",message:"traversal worker ran"})+"\\n");',
  });
  const child = spawn(process.execPath, [...plan.directoryArgs], {
    cwd: root, env: { ...plan.environment },
    stdio: ["pipe", "pipe", "pipe", "overlapped", "overlapped"],
  });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })[Symbol.asyncIterator]();
  (child.stdio[3] as Writable).end(plan.directorySource);
  (child.stdio[4] as Writable).end(plan.workerSource);
  const next = async () => JSON.parse((await lines.next()).value!);
  const request = async (operation: string, relativeSegments: string[], extra = {}) => {
    child.stdin!.write(JSON.stringify({ type: "mutate", operation,
      name: relativeSegments.at(-1), relativeSegments, parentSegments: [],
      expectedKind: "file", expectedIdentity: null, maxBytes: 100, ...extra }) + "\n");
    return next();
  };
  const deep = Buffer.from("deep\n").toString("base64");
  try {
    expect(await next()).toMatchObject({ type: "ready" });
    expect(await request("read_regular_file", ["a", "b", "file.txt"])).toMatchObject({ ok: true, contentBase64: deep });
    expect(await request("validate_regular_file", ["a", "b", "file.txt"])).toMatchObject({ ok: true, stats: { size: 5 } });
    expect(await request("read_regular_file", ["a", "b", "file.txt"], { maxBytes: 2 })).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
    expect(await request("read_regular_file", ["a", "missing", "file.txt"], { allowMissing: true })).toMatchObject({ ok: true, missing: true });
    // No component may be a link or a non-directory; the leaf must be a regular file.
    for (const segments of [["a-link", "b", "file.txt"], ["top.txt", "file.txt"], ["a", "b", "leaf-link.txt"], ["a", "b", "fifo"]]) {
      expect(await request("read_regular_file", segments)).toMatchObject({ ok: false, code: "PATH_IDENTITY_CHANGED" });
    }
    const identity = await stat(join(root, "a", "b", "file.txt"), { bigint: true });
    const expectedIdentity = { dev: String(identity.dev), ino: String(identity.ino), mode: String(identity.mode) };
    expect(await request("validate_regular_file", ["a", "b", "file.txt"], { expectedIdentity })).toMatchObject({ ok: true });
    // An exchanged leaf no longer matches its admitted identity.
    await rename(join(root, "a", "b", "file.txt"), join(root, "a", "b", "old.txt"));
    await writeFile(join(root, "a", "b", "file.txt"), "swapped\n");
    expect(await request("read_regular_file", ["a", "b", "file.txt"], { expectedIdentity })).toMatchObject({ ok: false, code: "PATH_IDENTITY_CHANGED" });
    // An ancestor replaced by a link to elsewhere cannot redirect the walk.
    await rename(join(root, "a"), join(root, "a-old"));
    await symlink(join(root, "a-old"), join(root, "a"));
    expect(await request("read_regular_file", ["a", "b", "old.txt"])).toMatchObject({ ok: false, code: "PATH_IDENTITY_CHANGED" });
    // The walk starts at the held directory, not at its old pathname.
    await rename(root, root + "-moved");
    await mkdir(join(root, "a-old", "b"), { recursive: true });
    await writeFile(join(root, "a-old", "b", "old.txt"), "outside\n");
    expect(await request("read_regular_file", ["a-old", "b", "old.txt"])).toMatchObject({ ok: true, contentBase64: deep });
  } finally {
    child.stdin!.end(JSON.stringify({ type: "close" }) + "\n");
    await closed;
  }
});
