import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  bindContainedRoot,
  defaultContainedRootIo,
  inspectContainedPath,
  readContainedUtf8,
  type ContainedRootIo,
} from "../../src/fs/root-contained-read.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("root-contained-read", () => {
  test("reads a regular file below the bound root", async () => {
    const rootDir = await tempRoot();
    const filePath = join(rootDir, "inside.md");
    await writeFile(filePath, "inside-bytes\n", "utf8");
    const root = await bindContainedRoot(rootDir);
    expect(root).not.toBeNull();
    const read = await readContainedUtf8(root!, filePath);
    expect(read).toEqual({
      ok: true,
      declaredPath: resolve(filePath),
      text: "inside-bytes\n",
    });
  });

  test("rejects a mock symlink from lstat without opening the path", async () => {
    const rootDir = await tempRoot();
    const filePath = join(rootDir, "linked.md");
    await writeFile(filePath, "must-not-be-read\n", "utf8");
    const root = await bindContainedRoot(rootDir);
    expect(root).not.toBeNull();
    const opened: string[] = [];
    const io = symlinkLstatIo(filePath, opened);
    const read = await readContainedUtf8(root!, filePath, io);
    expect(read).toEqual({
      ok: false,
      code: "symlink",
      declaredPath: resolve(filePath),
    });
    expect(opened).toEqual([]);
  });

  test("rejects a path that is lexically outside the bound root", async () => {
    const rootDir = await tempRoot();
    const outside = join(rootDir, "..", "outside.md");
    const root = await bindContainedRoot(rootDir);
    expect(root).not.toBeNull();
    const inspected = await inspectContainedPath(root!, outside);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.code).toBe("outside-root");
    expect(inspected.declaredPath).not.toContain("must-not-be-read");
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-contained-root-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function symlinkLstatIo(linkedPath: string, opened: string[]): ContainedRootIo {
  const target = resolve(linkedPath);
  return {
    lstat: async (path) => {
      const stats = await defaultContainedRootIo.lstat(path);
      if (resolve(path) !== target) return stats;
      return Object.create(stats, {
        isSymbolicLink: { value: () => true },
        isFile: { value: () => false },
        isDirectory: { value: () => false },
      }) as typeof stats;
    },
    realpath: defaultContainedRootIo.realpath,
    open: async (path, flags) => {
      opened.push(path);
      return defaultContainedRootIo.open(path, flags);
    },
    readdir: defaultContainedRootIo.readdir,
  };
}
