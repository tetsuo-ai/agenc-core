import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { __workspaceBoundHelperLaunchPlanForTests } from "../../src/workspace/file-mutation-transaction.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("reads and validates held-cwd basenames without starting a traversal worker", async () => {
  root = await mkdtemp(join(tmpdir(), "bound-root-read-"));
  await writeFile(join(root, "file.txt"), "alpha\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/file.txt"), "nested\n");
  // A correctly authenticated worker that always refuses a command. A
  // basename must succeed without executing it; descendants must reach it.
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
  const source = child.stdio[3] as Writable;
  const worker = child.stdio[4] as Writable;
  source.end(plan.directorySource); worker.end(plan.workerSource);
  const next = async () => JSON.parse((await lines.next()).value!);
  const request = async (operation: string, relativeSegments: string[], extra = {}) => {
    child.stdin!.write(JSON.stringify({ type: "mutate", operation,
      name: relativeSegments.at(-1), relativeSegments, parentSegments: [],
      expectedKind: "file", expectedIdentity: null, maxBytes: 100, ...extra }) + "\n");
    return next();
  };
  try {
    expect(await next()).toMatchObject({ type: "ready" });
    expect(await request("read_regular_file", ["missing"], { allowMissing: true }))
      .toMatchObject({ ok: true, missing: true });
    expect(await request("read_regular_file", ["file.txt"]))
      .toMatchObject({ ok: true, contentBase64: Buffer.from("alpha\n").toString("base64") });
    expect(await request("validate_regular_file", ["file.txt"]))
      .toMatchObject({ ok: true, stats: { size: 6 } });
    expect(await request("read_regular_file", ["file.txt"], { maxBytes: 2 }))
      .toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
    expect(await request("read_regular_file", ["file.txt"], { maxBytes: 2, truncate: true }))
      .toMatchObject({ ok: true, contentBase64: Buffer.from("al").toString("base64") });
    // On Linux the helper walks descendants through held descriptors itself;
    // elsewhere, and for text windows everywhere, they reach the worker.
    expect(await request("read_regular_file", ["nested", "file.txt"])).toMatchObject(process.platform === "linux"
      ? { ok: true, contentBase64: Buffer.from("nested\n").toString("base64") }
      : { ok: false, code: "WORKER_CALLED" });
    expect(await request("read_text_window", ["nested", "file.txt"], { offset: 0, limit: 1, expectedIdentity: null }))
      .toMatchObject({ ok: false, code: "WORKER_CALLED" });
    const identity = await stat(join(root, "file.txt"), { bigint: true });
    await rename(join(root, "file.txt"), join(root, "original.txt"));
    await writeFile(join(root, "file.txt"), "replacement\n");
    expect(await request("read_regular_file", ["file.txt"], { expectedIdentity: {
      dev: String(identity.dev), ino: String(identity.ino), mode: String(identity.mode),
    } })).toMatchObject({ ok: false, code: "PATH_IDENTITY_CHANGED" });
    if (process.platform !== "win32") {
      await symlink("original.txt", join(root, "link.txt"));
      expect(await request("read_regular_file", ["link.txt"]))
        .toMatchObject({ ok: false, code: "PATH_IDENTITY_CHANGED" });
    }
    // The helper still holds its cwd after a pathname exchange.
    await rename(root, root + "-moved");
    await mkdir(root); await writeFile(join(root, "original.txt"), "outside\n");
    expect(await request("read_regular_file", ["original.txt"]))
      .toMatchObject({ ok: true, contentBase64: Buffer.from("alpha\n").toString("base64") });
  } finally {
    child.stdin!.end(JSON.stringify({ type: "close" }) + "\n");
    await closed;
    await rm(root + "-moved", { recursive: true, force: true });
  }
});
