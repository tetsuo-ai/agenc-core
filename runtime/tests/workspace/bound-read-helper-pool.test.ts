import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  __boundReadHelperStartsForTests,
  __disposeIdleReadHelpersForTests,
  bindWorkspaceDirectoryReadCapability,
  bindWorkspaceFileReadCapability,
  readHelperPoolingEnabled,
} from "../../src/workspace/file-mutation-transaction.js";

let root = "";
beforeEach(async () => {
  await __disposeIdleReadHelpersForTests();
  root = await mkdtemp(join(tmpdir(), "bound-read-pool-"));
  await mkdir(join(root, "x", "deep"), { recursive: true });
  await mkdir(join(root, "y"));
  await writeFile(join(root, "x", "deep", "a.txt"), "from x\n");
  await writeFile(join(root, "y", "b.txt"), "from y\n");
});
afterEach(async () => {
  await __disposeIdleReadHelpersForTests();
  await rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("reuses an idle authenticated helper and binds each directory from its anchor", async () => {
  const starts = __boundReadHelperStartsForTests();
  const first = await bindWorkspaceDirectoryReadCapability(join(root, "x", "deep"));
  expect((await first.readRelativeFile("a.txt", 100)).content.toString()).toBe("from x\n");
  await first.dispose();
  // A disposed capability refuses: its helper may already serve another one.
  expect(() => first.readRelativeFile("a.txt", 100)).toThrow(/disposed/u);
  await first.dispose();

  const second = await bindWorkspaceDirectoryReadCapability(join(root, "y"));
  expect(__boundReadHelperStartsForTests()).toBe(starts + 1);
  expect((await second.readRelativeFile("b.txt", 100)).content.toString()).toBe("from y\n");
  // Bound from the anchor, not below the previous directory.
  await expect(second.readRelativeFile("a.txt", 100)).rejects.toMatchObject({ name: "WorkspacePathIdentityChangedError" });

  // Capabilities held at the same time never share a helper.
  const third = await bindWorkspaceFileReadCapability(join(root, "x", "deep", "a.txt"));
  expect(__boundReadHelperStartsForTests()).toBe(starts + 2);
  expect((await third.readFile(100)).content.toString()).toBe("from x\n");
  expect((await second.readRelativeFile("b.txt", 100)).content.toString()).toBe("from y\n");
  await second.dispose();
  await third.dispose();
  expect(await __disposeIdleReadHelpersForTests()).toBe(2);
});

test.skipIf(process.platform === "win32")("never reuses a helper whose search was aborted", async () => {
  const capability = await bindWorkspaceDirectoryReadCapability(join(root, "y"));
  const controller = new AbortController();
  const search = capability.runRipgrep({ program: "/bin/sleep", args: ["5"], env: {}, timeoutMs: 10_000,
    maxOutputBytes: 1024, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  expect(await search).toMatchObject({ aborted: true });
  await capability.dispose();
  expect(await __disposeIdleReadHelpersForTests()).toBe(0);
  const starts = __boundReadHelperStartsForTests();
  const next = await bindWorkspaceDirectoryReadCapability(join(root, "y"));
  expect(__boundReadHelperStartsForTests()).toBe(starts + 1);
  expect((await next.readRelativeFile("b.txt", 100)).content.toString()).toBe("from y\n");
  await next.dispose();
});

test.skipIf(process.platform === "win32")("refuses a directory whose identity changed after admission, reused or not", async () => {
  const capability = await bindWorkspaceDirectoryReadCapability(join(root, "y"));
  const admitted = await import("node:fs").then(fs => fs.statSync(join(root, "x"), { bigint: true }));
  await capability.dispose();
  await expect(bindWorkspaceDirectoryReadCapability(join(root, "y"), { expectedIdentity: {
    dev: String(admitted.dev), ino: String(admitted.ino), mode: String(admitted.mode) } }))
    .rejects.toMatchObject({ name: "WorkspacePathIdentityChangedError" });
});

// A parked helper stays in the last directory it bound. Windows keeps a
// process's working directory open, so a pooled helper would lock that folder
// against deletion and renames (seen as EBUSY in the Windows transport test).
test("does not pool read helpers on Windows", () => {
  expect(readHelperPoolingEnabled("win32")).toBe(false);
  expect(readHelperPoolingEnabled("linux")).toBe(true);
  expect(readHelperPoolingEnabled("darwin")).toBe(true);
});
