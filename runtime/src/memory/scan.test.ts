import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MEMORY_FILES, scanMemoryFiles } from "./scan.js";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("scanMemoryFiles", () => {
  it("finds shallow markdown files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "note.md"), "---\nname: test\ntype: user\n---\nContent");

    const result = await scanMemoryFiles(tempDir, new AbortController().signal);

    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("note.md");
  });

  it("ignores MEMORY.md entrypoints", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "MEMORY.md"), "# index");
    await writeFile(
      join(tempDir, "user_role.md"),
      "---\nname: role\ntype: user\n---\nContent",
    );

    const result = await scanMemoryFiles(tempDir, new AbortController().signal);

    expect(result.map((entry) => entry.filename)).toEqual(["user_role.md"]);
  });

  it("does not return markdown files nested beyond max depth", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "shallow.md"), "---\nname: shallow\ntype: user\n---\nContent");
    const deepDir = join(tempDir, "d1", "d2", "d3", "d4", "d5");
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, "deep.md"), "---\nname: deep\ntype: user\n---\nContent");

    const result = await scanMemoryFiles(tempDir, new AbortController().signal);

    expect(result.map((entry) => entry.filename)).toContain("shallow.md");
    expect(result.some((entry) => entry.filename.includes("deep.md"))).toBe(false);
  });

  it("caps candidates before reading frontmatter", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_MEMORY_FILES + 25; i += 1) {
      const path = join(tempDir, `note-${String(i).padStart(3, "0")}.md`);
      await writeFile(
        path,
        `---\nname: note ${i}\ntype: user\n---\nContent`,
      );
      await utimes(path, oldTime, oldTime);
    }
    const newestPath = join(tempDir, "zz-newest.md");
    await writeFile(
      newestPath,
      "---\nname: newest\ntype: user\n---\nNewest content",
    );
    await utimes(
      newestPath,
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    const result = await scanMemoryFiles(tempDir, new AbortController().signal);

    expect(result).toHaveLength(MAX_MEMORY_FILES);
    expect(result[0]?.filename).toBe("zz-newest.md");
  });
});
