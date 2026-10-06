import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  bindContainedRoot,
  defaultContainedRootIo,
  inspectContainedPath,
  readContainedUtf8,
  walkContainedFiles,
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
    const read = await readContainedUtf8(root!, filePath, { io });
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

  test("refuses to bind a repository-controlled linked root", async () => {
    const rootDir = await tempRoot();
    const real = join(rootDir, "real");
    await mkdir(real);
    await writeFile(join(real, "SKILL.md"), "linked-root-secret\n", "utf8");
    const linked = join(rootDir, "linked");
    await symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
    expect(await bindContainedRoot(linked)).toBeNull();
  });

  test("stops walking once maxFiles is reached without scanning later directories", async () => {
    const rootDir = await tempRoot();
    await writeFile(join(rootDir, "a.md"), "a\n", "utf8");
    await writeFile(join(rootDir, "b.md"), "b\n", "utf8");
    const wide = join(rootDir, "wide");
    await mkdir(wide);
    for (let i = 0; i < 20; i += 1) {
      await writeFile(join(wide, `extra-${i}.md`), "x\n", "utf8");
    }
    const root = await bindContainedRoot(rootDir);
    expect(root).not.toBeNull();
    const readdirPaths: string[] = [];
    const io: ContainedRootIo = {
      ...defaultContainedRootIo,
      readdir: async (path) => {
        readdirPaths.push(resolve(path));
        return defaultContainedRootIo.readdir(path);
      },
    };
    const walked = await walkContainedFiles(
      root!,
      rootDir,
      {
        maxDepth: 8,
        maxFiles: 2,
        collectFile: (name) => name.endsWith(".md"),
      },
      io,
    );
    expect(walked.files).toHaveLength(2);
    expect(readdirPaths).not.toContain(resolve(wide));
  });

  test("returns not-found when post-open resolution fails instead of throwing", async () => {
    const rootDir = await tempRoot();
    const filePath = join(rootDir, "gone.md");
    await writeFile(filePath, "ephemeral\n", "utf8");
    const root = await bindContainedRoot(rootDir);
    expect(root).not.toBeNull();
    let opened = false;
    const io: ContainedRootIo = {
      lstat: async (path) => {
        if (opened) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return defaultContainedRootIo.lstat(path);
      },
      realpath: async (path) => {
        if (opened) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return defaultContainedRootIo.realpath(path);
      },
      open: async (path, flags) => {
        const handle = await defaultContainedRootIo.open(path, flags);
        opened = true;
        return handle;
      },
      readdir: defaultContainedRootIo.readdir,
    };
    await expect(readContainedUtf8(root!, filePath, { io })).resolves.toEqual({
      ok: false,
      code: "not-found",
      declaredPath: resolve(filePath),
    });
  });

  test("rejects a read after an ancestor directory is swapped under the declared path", async () => {
    const base = await tempRoot();
    const boundDir = join(base, "bound");
    const decoy = join(base, "decoy");
    await mkdir(boundDir);
    await mkdir(decoy);
    const filePath = join(boundDir, "skill.md");
    await writeFile(filePath, "original\n", "utf8");
    await writeFile(join(decoy, "skill.md"), "OUTSIDE_SWAP_SECRET\n", "utf8");
    const root = await bindContainedRoot(boundDir);
    expect(root).not.toBeNull();
    let swapped = false;
    const io: ContainedRootIo = {
      ...defaultContainedRootIo,
      open: async (path, flags) => {
        if (!swapped && resolve(path) === resolve(filePath)) {
          swapped = true;
          await rename(boundDir, join(base, "bound.away"));
          await rename(decoy, boundDir);
        }
        return defaultContainedRootIo.open(path, flags);
      },
    };
    const read = await readContainedUtf8(root!, filePath, { io });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(["changed", "not-found", "outside-root"]).toContain(read.code);
    expect(JSON.stringify(read)).not.toContain("OUTSIDE_SWAP_SECRET");
  });

  test("counts leftover collectable names as dropped after maxFiles without inspecting them", async () => {
    const rootDir = await tempRoot();
    await writeFile(join(rootDir, "keep-a.md"), "keep-a\n", "utf8");
    await writeFile(join(rootDir, "keep-b.md"), "keep-b\n", "utf8");
    await writeFile(join(rootDir, "drop-c.md"), "DROP_C_BODY\n", "utf8");
    await writeFile(join(rootDir, "drop-d.md"), "DROP_D_BODY\n", "utf8");
    await writeFile(join(rootDir, "notes.txt"), "ignored\n", "utf8");
    const root = await bindContainedRoot(rootDir);
    expect(root).not.toBeNull();
    const inspected: string[] = [];
    const listingOrder = ["keep-a.md", "keep-b.md", "drop-c.md", "drop-d.md", "notes.txt"];
    const io: ContainedRootIo = {
      ...defaultContainedRootIo,
      lstat: async (path) => {
        inspected.push(resolve(path));
        return defaultContainedRootIo.lstat(path);
      },
      readdir: async (path) => {
        const entries = await defaultContainedRootIo.readdir(path);
        return [...entries].sort(
          (left, right) => listingOrder.indexOf(left.name) - listingOrder.indexOf(right.name),
        );
      },
    };
    const walked = await walkContainedFiles(
      root!,
      rootDir,
      {
        maxDepth: 2,
        maxFiles: 2,
        collectFile: (name) => name.endsWith(".md"),
      },
      io,
    );
    expect(walked.files).toHaveLength(2);
    expect(walked.droppedCount).toBe(2);
    expect(inspected.some((path) => path.endsWith("drop-c.md"))).toBe(false);
    expect(inspected.some((path) => path.endsWith("drop-d.md"))).toBe(false);
  });

  test("rejects a contained read larger than maxBytes before returning the body", async () => {
    const rootDir = await tempRoot();
    const filePath = join(rootDir, "hooks.json");
    const oversized = `{"secret":"${"HOOK_OVERSIZE_SECRET".repeat(8)}"}`;
    await writeFile(filePath, oversized, "utf8");
    const root = await bindContainedRoot(rootDir);
    expect(root).not.toBeNull();
    const read = await readContainedUtf8(root!, filePath, { maxBytes: 32 });
    expect(read).toEqual({
      ok: false,
      code: "too-large",
      declaredPath: resolve(filePath),
    });
    expect(JSON.stringify(read)).not.toContain("HOOK_OVERSIZE_SECRET");
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
