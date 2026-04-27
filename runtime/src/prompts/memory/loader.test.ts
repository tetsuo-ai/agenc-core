import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _clearMemoryWriteLocksForTest,
  _memoryWriteLocksForTest,
  getMemoryWriteLock,
  loadMemoryPrompt,
} from "./loader.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  _clearMemoryWriteLocksForTest();
});

async function makeTempMemdir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "agenc-loader-"));
  return tempDir;
}

describe("loadMemoryPrompt", () => {
  test("returns policy text without injecting index or topic files", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(
      mdPath,
      "# My Memories\n- [Topic A](a.md) — first\n- [Topic B](b.md) — second\n",
    );
    await writeFile(
      join(dir, "a.md"),
      "---\nname: A\ntype: user\n---\nbody A\n",
    );
    await writeFile(
      join(dir, "b.md"),
      "---\nname: B\ntype: feedback\n---\nbody B\n",
    );

    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
    });
    expect(result.entries).toEqual([]);
    expect(result.text).toContain("# Memory");
    expect(result.text).toContain(dir);
    expect(result.text).not.toContain("body A");
    expect(result.text).not.toContain("body B");
    expect(result.text).not.toContain("# MEMORY.md");
    expect(result.truncated).toBe(false);
  });

  test("returns empty when MEMORY.md is missing", async () => {
    const dir = await makeTempMemdir();
    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: join(dir, "MEMORY.md"),
    });
    expect(result.text).toBe("");
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("does not inject memory_summary.md or MEMORY.md content", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(join(dir, "memory_summary.md"), "summary first\n");
    await writeFile(mdPath, "index second\n");

    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
    });
    expect(result.text).toContain("durable memory");
    expect(result.text).not.toContain("summary first");
    expect(result.text).not.toContain("index second");
  });

  test("respects maxLines cap", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(mdPath, "# idx\n- [T](t.md)\n");

    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
      maxLines: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.lineCount).toBeLessThanOrEqual(1);
    expect(result.entries).toEqual([]);
  });

  test("respects maxBytes cap", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(mdPath, "# idx\n- [A](a.md)\n- [B](b.md)\n");
    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
      maxBytes: 20,
    });
    expect(result.truncated).toBe(true);
    expect(result.byteCount).toBeLessThanOrEqual(20);
  });

  test("does not dereference topic files", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(mdPath, "# idx\n- [Bad](bad.md)\n- [Good](good.md)\n");
    await writeFile(join(dir, "bad.md"), "no fence here at all");
    await writeFile(
      join(dir, "good.md"),
      "---\nname: Good\ntype: user\n---\ngood body\n",
    );
    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
    });
    expect(result.entries).toEqual([]);
    expect(result.text).not.toContain("good body");
  });
});

describe("I-29 memory write lock registry", () => {
  test("getMemoryWriteLock returns the same instance per path", () => {
    const a1 = getMemoryWriteLock("/tmp/a.md");
    const a2 = getMemoryWriteLock("/tmp/a.md");
    const b = getMemoryWriteLock("/tmp/b.md");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  test("registry grows as new paths are locked", () => {
    _clearMemoryWriteLocksForTest();
    expect(_memoryWriteLocksForTest().size).toBe(0);
    getMemoryWriteLock("/tmp/x.md");
    getMemoryWriteLock("/tmp/y.md");
    expect(_memoryWriteLocksForTest().size).toBe(2);
  });

  test("lock serializes concurrent writers to the same path", async () => {
    const lock = getMemoryWriteLock("/tmp/serialize.md");
    const order: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) =>
      lock.with(async () => {
        // Later tasks complete their "work" quickly, but the lock
        // forces earlier acquirers to complete first.
        await new Promise((r) => setTimeout(r, 5));
        order.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("getMemoryWriteLock normalizes equivalent-but-differently-spelled paths", () => {
    _clearMemoryWriteLocksForTest();
    // All three resolve to /tmp/memdir/x.md — they must share one lock
    // instance so two callers cannot race on the same physical file.
    const canonical = getMemoryWriteLock("/tmp/memdir/x.md");
    const dotdot = getMemoryWriteLock("/tmp/memdir/../memdir/x.md");
    const doubled = getMemoryWriteLock("/tmp//memdir/./x.md");
    expect(dotdot).toBe(canonical);
    expect(doubled).toBe(canonical);
    // Registry size reflects normalization: only one key is stored.
    expect(_memoryWriteLocksForTest().size).toBe(1);
  });
});

describe("loadMemoryPrompt cap precision", () => {
  test("maxLines cap counts actual newlines, not split-piece over-count", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(mdPath, "# idx\n- [A](a.md)\n");
    const baseline = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
    });
    const exactLineCount = baseline.lineCount;

    const ok = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
      maxLines: exactLineCount,
    });
    expect(ok.truncated).toBe(false);
    expect(ok.entries.length).toBe(0);
    expect(ok.lineCount).toBe(exactLineCount);

    const capped = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
      maxLines: exactLineCount - 1,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.entries.length).toBe(0);
  });

  test("maxBytes cap counts UTF-8 bytes, not code units (multi-byte safe)", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(mdPath, "# idx\n- [A](a.md)\n");
    // Multi-byte path confirms Buffer.byteLength is used.
    const emoji = "\u{1F600}";
    const emojiDir = `${dir}${emoji}`;
    const result = await loadMemoryPrompt({
      memoryDir: emojiDir,
      memoryMdPath: mdPath,
      maxBytes: 1_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.entries.length).toBe(0);
    expect(result.byteCount).toBeGreaterThan(result.text.length);
  });
});
