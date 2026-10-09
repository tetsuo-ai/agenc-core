import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { closeFullCorpusMemoryIndexes, findRelevantMemories } from "../../src/memory/find-relevant.js";
import * as scan from "../../src/memory/scan.js";

afterEach(() => { closeFullCorpusMemoryIndexes(); vi.restoreAllMocks(); });

test("fast recall reuses only the current empty snapshot and observes a new memory immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-empty-memory-"));
  try {
    const memory = join(root, "memory");
    const options = { query: "browser", memoryDirs: [memory], signal: new AbortController().signal,
      memoryIndexDatabasePath: join(root, "memory.sqlite") };
    const scanRoots = vi.spyOn(scan, "scanMemoryRoots");
    const recall = () => withOneShotFastMode(() => findRelevantMemories(options));
    expect(await recall()).toEqual([]);
    await mkdir(memory);
    await mkdir(join(memory, "nested"));
    await writeFile(join(memory, "MEMORY.md"), "# Index");
    await writeFile(join(memory, "browser.txt"), "---\nname: Browser\ndescription: Browser notes\ntype: project\n---\nBrowser notes");
    expect(await recall()).toEqual([]);
    expect(scanRoots).not.toHaveBeenCalled();
    await rename(join(memory, "browser.txt"), join(memory, "browser.md"));
    expect((await recall()).map(item => item.path)).toContain(join(memory, "browser.md"));
    expect(await recall()).toEqual(await findRelevantMemories(options));
    await rm(join(memory, "browser.md"));
    expect(await recall()).toEqual([]);
  } finally { closeFullCorpusMemoryIndexes(); await rm(root, { recursive: true, force: true }); }
});

test("uncertain root identity keeps the verified scan fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-memory-symlink-"));
  try {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    const options = { query: "browser", memoryDirs: [join(root, "link")], signal: new AbortController().signal,
      memoryIndexDatabasePath: join(root, "memory.sqlite") };
    const scanRoots = vi.spyOn(scan, "scanMemoryRoots");
    const result = await withOneShotFastMode(() => findRelevantMemories(options));
    expect(scanRoots).toHaveBeenCalled();
    expect(result).toEqual(await findRelevantMemories(options));
  } finally { closeFullCorpusMemoryIndexes(); await rm(root, { recursive: true, force: true }); }
});

test("a missing root below a file becomes visible after the parent is replaced by a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-memory-nondirectory-"));
  try {
    const parent = join(root, "parent");
    const memory = join(parent, "memory");
    await writeFile(parent, "not a directory");
    const options = { query: "browser", memoryDirs: [memory], signal: new AbortController().signal,
      memoryIndexDatabasePath: join(root, "memory.sqlite") };
    const recall = () => withOneShotFastMode(() => findRelevantMemories(options));
    expect(await recall()).toEqual(await findRelevantMemories(options));
    await rm(parent);
    await mkdir(memory, { recursive: true });
    await writeFile(join(memory, "browser.md"), "---\nname: Browser\ndescription: Browser notes\ntype: project\n---\nBrowser notes");
    expect((await recall()).map(item => item.path)).toContain(join(memory, "browser.md"));
    expect(await recall()).toEqual(await findRelevantMemories(options));
  } finally { closeFullCorpusMemoryIndexes(); await rm(root, { recursive: true, force: true }); }
});
