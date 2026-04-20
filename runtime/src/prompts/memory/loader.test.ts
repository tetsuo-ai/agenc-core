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
  test("happy path: returns index header + each topic file", async () => {
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
    expect(result.entries.length).toBe(2);
    expect(result.text).toContain("body A");
    expect(result.text).toContain("body B");
    expect(result.text).toContain("# MEMORY.md");
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

  test("respects maxLines cap", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    // Many pointers → many topic files → lots of lines.
    let indexLines = "# idx\n";
    for (let i = 0; i < 20; i++) {
      indexLines += `- [T${i}](t${i}.md)\n`;
      await writeFile(
        join(dir, `t${i}.md`),
        `---\nname: T${i}\ntype: user\n---\n${"line\n".repeat(20)}`,
      );
    }
    await writeFile(mdPath, indexLines);

    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
      maxLines: 50,
    });
    expect(result.truncated).toBe(true);
    expect(result.lineCount).toBeLessThanOrEqual(50);
    expect(result.entries.length).toBeLessThan(20);
  });

  test("respects maxBytes cap", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    const big = "x".repeat(5_000);
    await writeFile(mdPath, "# idx\n- [A](a.md)\n- [B](b.md)\n");
    await writeFile(
      join(dir, "a.md"),
      `---\nname: A\ntype: user\n---\n${big}\n`,
    );
    await writeFile(
      join(dir, "b.md"),
      `---\nname: B\ntype: user\n---\n${big}\n`,
    );
    const result = await loadMemoryPrompt({
      memoryDir: dir,
      memoryMdPath: mdPath,
      maxBytes: 6_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.byteCount).toBeLessThanOrEqual(6_000);
  });

  test("skips topic files with malformed frontmatter", async () => {
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
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].frontmatter.name).toBe("Good");
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
});
