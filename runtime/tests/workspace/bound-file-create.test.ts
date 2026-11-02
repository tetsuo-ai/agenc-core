import * as childProcess from "node:child_process";
import * as filesystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
const { captureWorkspaceFilePathTransactionGuard } = await import("../../src/workspace/file-mutation-transaction.js");
type Guard = Awaited<ReturnType<typeof captureWorkspaceFilePathTransactionGuard>>;
let root: string;
let guards: Guard[];
const missing = { kind: "missing" } as const;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bound-create-"));
  guards = [];
  vi.mocked(childProcess.spawn).mockClear();
});
afterEach(async () => {
  vi.mocked(filesystem.statfs).mockRestore();
  await Promise.all(guards.map(guard => guard.dispose()));
  await rm(root, { recursive: true, force: true });
});
async function prepare(path: string): Promise<Guard> {
  const guard = await captureWorkspaceFilePathTransactionGuard(path);
  guards.push(guard);
  await guard.prepareBoundMutation(missing, "write");
  return guard;
}

describe.skipIf(process.platform !== "linux")("Linux descriptor-bound file creation", () => {
  test("creates under an existing parent without starting a helper process", async () => {
    const target = join(root, "new.txt");
    const guard = await prepare(target);
    const effect = vi.fn();
    await guard.writeBoundContent(missing, Buffer.from("new bytes\n"), effect);
    expect(await readFile(target, "utf8")).toBe("new bytes\n");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test("an exchanged parent cannot redirect a create into the replacement", async () => {
    const parent = join(root, "parent"), held = join(root, "held"), outside = join(root, "outside");
    await mkdir(parent);
    await mkdir(outside);
    const guard = await prepare(join(parent, "new.txt"));
    await rename(parent, held);
    await symlink(outside, parent);
    await guard.writeBoundContent(missing, Buffer.from("held bytes"));
    expect(await readFile(join(held, "new.txt"), "utf8")).toBe("held bytes");
    await expect(readFile(join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(guard.assertState({ kind: "content", content: Buffer.from("held bytes") })).rejects.toThrow();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test("exclusive creation refuses a competing file or symlink without overwriting it", async () => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside");
    for (const kind of ["file", "symlink"]) {
      const target = join(root, kind);
      const guard = await prepare(target);
      if (kind === "file") await writeFile(target, "competitor");
      else await symlink(outside, target);
      await expect(guard.writeBoundContent(missing, Buffer.from("wrong"))).rejects.toMatchObject({
        name: "WorkspaceFileMutationPreEffectConflictError",
      });
      expect(await readFile(target, "utf8")).toBe(kind === "file" ? "competitor" : "outside");
    }
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test("a missing parent retains the authenticated helper path", async () => {
    const target = join(root, "nested", "new.txt");
    const guard = await prepare(target);
    await guard.writeBoundContent(missing, Buffer.from("nested bytes"));
    expect(await readFile(target, "utf8")).toBe("nested bytes");
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  test("unavailable or non-procfs descriptor paths retain the authenticated helper", async () => {
    for (const unavailable of [true, false]) {
      if (unavailable) vi.mocked(filesystem.statfs).mockRejectedValueOnce(new Error("procfs unavailable"));
      else vi.mocked(filesystem.statfs).mockResolvedValueOnce({ type: 0 } as Awaited<ReturnType<typeof filesystem.statfs>>);
      const target = join(root, String(unavailable));
      const guard = await prepare(target);
      await guard.writeBoundContent(missing, Buffer.from("fallback bytes"));
      expect(await readFile(target, "utf8")).toBe("fallback bytes");
    }
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
  });

  test("a replaced parent before binding is refused with no effect", async () => {
    const parent = join(root, "parent");
    await mkdir(parent);
    const guard = await captureWorkspaceFilePathTransactionGuard(join(parent, "new.txt"));
    guards.push(guard);
    await rename(parent, join(root, "held"));
    await mkdir(parent);
    await expect(guard.prepareBoundMutation(missing, "write")).rejects.toMatchObject({ name: "WorkspacePathIdentityChangedError" });
    await expect(readFile(join(parent, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("disposal waits for an accepted create before releasing its directory fd", async () => {
    const target = join(root, "new.txt");
    const guard = await prepare(target);
    const writing = guard.writeBoundContent(missing, Buffer.alloc(128 * 1024, 65));
    await Promise.all([writing, guard.dispose(), guard.dispose()]);
    expect((await readFile(target)).length).toBe(128 * 1024);
    await expect(guard.writeBoundContent(missing, Buffer.from("wrong"))).rejects.toThrow();
  });

  test("a disposed binding cannot use a descriptor later leased by another guard", async () => {
    const old = await prepare(join(root, "old.txt"));
    await old.dispose();
    const current = await prepare(join(root, "current.txt"));
    await expect(old.writeBoundContent(missing, Buffer.from("wrong"))).rejects.toThrow();
    await current.writeBoundContent(missing, Buffer.from("current"));
    await expect(readFile(join(root, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "current.txt"), "utf8")).toBe("current");
  });
});
