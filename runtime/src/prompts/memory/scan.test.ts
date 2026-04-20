import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanMemoryDir,
  scanMemoryIndex,
  MAX_MEMORY_FILES,
} from "./scan.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function makeTempMemdir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "agenc-memscan-"));
  return tempDir;
}

function memFile(type: string, idx: number): string {
  return `---\nname: note-${idx}\ndescription: desc ${idx}\ntype: ${type}\n---\nContent ${idx}\n`;
}

describe("scanMemoryDir", () => {
  test("returns entries sorted newest-first by mtime", async () => {
    const dir = await makeTempMemdir();
    await writeFile(join(dir, "a.md"), memFile("user", 1));
    await writeFile(join(dir, "b.md"), memFile("feedback", 2));
    await writeFile(join(dir, "c.md"), memFile("project", 3));
    // b is newest, c is middle, a is oldest.
    const base = Date.now() / 1000;
    await utimes(join(dir, "a.md"), base - 100, base - 100);
    await utimes(join(dir, "c.md"), base - 50, base - 50);
    await utimes(join(dir, "b.md"), base, base);

    const result = await scanMemoryDir(dir);
    expect(result.entries.length).toBe(3);
    expect(result.entries[0].frontmatter.name).toBe("note-2");
    expect(result.entries[1].frontmatter.name).toBe("note-3");
    expect(result.entries[2].frontmatter.name).toBe("note-1");
  });

  test("skips MEMORY.md and hidden files", async () => {
    const dir = await makeTempMemdir();
    await writeFile(join(dir, "MEMORY.md"), "# index\n- entry\n");
    await writeFile(join(dir, ".hidden.md"), memFile("user", 99));
    await writeFile(join(dir, "topic.md"), memFile("user", 1));

    const result = await scanMemoryDir(dir);
    expect(result.entries.map((e) => e.frontmatter.name)).toEqual(["note-1"]);
  });

  test("skips malformed frontmatter files silently", async () => {
    const dir = await makeTempMemdir();
    await writeFile(join(dir, "good.md"), memFile("user", 1));
    await writeFile(join(dir, "bad.md"), "no frontmatter fence at all\nbody");
    await writeFile(
      join(dir, "unclosed.md"),
      "---\nname: x\ntype: user\nno close",
    );

    const result = await scanMemoryDir(dir);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].frontmatter.name).toBe("note-1");
  });

  test("caps at maxFiles and reports filesDropped", async () => {
    const dir = await makeTempMemdir();
    for (let i = 0; i < 5; i++) {
      await writeFile(join(dir, `m${i}.md`), memFile("user", i));
    }
    const result = await scanMemoryDir(dir, { maxFiles: 3 });
    expect(result.entries.length).toBe(3);
    expect(result.filesDropped).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("caps at maxBytes and reports bytesDropped", async () => {
    const dir = await makeTempMemdir();
    // Each file is ~1KB body + small frontmatter.
    const body = "x".repeat(1200);
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, `m${i}.md`),
        `---\nname: note-${i}\ntype: user\n---\n${body}\n`,
      );
    }
    const result = await scanMemoryDir(dir, { maxBytes: 2500 });
    expect(result.bytesDropped).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
    // Accumulated bytes across kept entries must not exceed cap.
    const total = result.entries.reduce((acc, e) => acc + e.byteLength, 0);
    expect(total).toBeLessThanOrEqual(2500);
  });

  test("returns empty when dir does not exist", async () => {
    const result = await scanMemoryDir("/no/such/path/at/all");
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("respects depth cap and skips deeply nested files", async () => {
    const dir = await makeTempMemdir();
    await writeFile(join(dir, "shallow.md"), memFile("user", 1));
    const deep = join(dir, "d1", "d2", "d3", "d4");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "deep.md"), memFile("user", 99));
    const result = await scanMemoryDir(dir);
    const names = result.entries.map((e) => e.frontmatter.name);
    expect(names).toContain("note-1");
    expect(names).not.toContain("note-99");
  });

  test("MAX_MEMORY_FILES matches the TODO.MD §T10-C cap", () => {
    expect(MAX_MEMORY_FILES).toBe(200);
  });
});

describe("scanMemoryIndex", () => {
  test("parses bullet-list pointers in order", async () => {
    const dir = await makeTempMemdir();
    const mdPath = join(dir, "MEMORY.md");
    await writeFile(
      mdPath,
      "# index\n- [First](a.md) — the first\n- [Second](b.md) — the second\n\nfoot\n",
    );
    const paths = await scanMemoryIndex(mdPath);
    expect(paths).toEqual([join(dir, "a.md"), join(dir, "b.md")]);
  });

  test("returns empty when MEMORY.md is missing", async () => {
    const paths = await scanMemoryIndex("/no/such/MEMORY.md");
    expect(paths).toEqual([]);
  });
});
