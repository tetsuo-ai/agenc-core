import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_C3A_CANDIDATE_FILES,
  MAX_C3A_HEADER_BYTES_PER_FILE,
  MAX_C3A_PATH_UTF8_BYTES,
  MAX_C3A_ROOT_PATH_UTF8_BYTES,
  MAX_C3A_TOTAL_PATH_UTF8_BYTES,
  MAX_C3A_TRAVERSAL_ENTRIES,
} from "../../src/memory/recall-contract.js";
import {
  MAX_MEMORY_FILES,
  scanMemoryRoots,
  scanMemoryFiles,
} from "../../src/memory/scan.js";

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
    await writeFile(
      join(tempDir, "note.md"),
      "---\nname: test\ndescription: test memory\ntype: user\n---\nContent",
    );

    const result = await scanMemoryFiles(tempDir, new AbortController().signal);

    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("note.md");
    expect(result[0]?.description).toBe("test memory");
    expect(result[0]?.type).toBe("user");
  });

  it("degrades gracefully for unknown frontmatter types", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(
      join(tempDir, "unknown.md"),
      "---\nname: unknown\ntype: not-a-memory-type\n---\nContent",
    );

    const result = await scanMemoryFiles(tempDir, new AbortController().signal);

    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("unknown.md");
    expect(result[0]?.type).toBeUndefined();
  });

  it("propagates the original reason when the signal is already aborted", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "note.md"), "---\nname: test\ntype: user\n---\nContent");
    const controller = new AbortController();
    const reason = new Error("cancel memory scan");
    controller.abort(reason);

    await expect(scanMemoryFiles(tempDir, controller.signal)).rejects.toBe(reason);
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

  it("rejects symlink roots and candidates instead of following them", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const realRoot = join(tempDir, "real");
    const linkedRoot = join(tempDir, "linked-root");
    await mkdir(realRoot);
    await writeFile(join(realRoot, "safe.md"), "---\nname: safe\n---\nbody");
    await symlink(realRoot, linkedRoot, "dir");
    await symlink(join(realRoot, "safe.md"), join(realRoot, "linked.md"));

    await expect(scanMemoryFiles(linkedRoot)).resolves.toEqual([]);
    const result = await scanMemoryFiles(realRoot);
    expect(result.map((entry) => entry.filename)).toEqual(["safe.md"]);
  });

  it("rejects a parent directory exchanged before descriptor open", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const root = join(tempDir, "root");
    const parent = join(root, "parent");
    const parked = join(root, "parked");
    const outside = join(tempDir, "outside");
    await mkdir(parent, { recursive: true });
    await mkdir(outside);
    await writeFile(join(parent, "safe.md"), "---\nname: safe\n---\nbody");
    await writeFile(
      join(outside, "escaped.md"),
      "---\nname: escaped\n---\nbody",
    );
    let exchanged = false;

    const result = await scanMemoryRoots(
      [root],
      new AbortController().signal,
      {
        beforeDirectoryOpen: async (path) => {
          if (path !== parent || exchanged) return;
          exchanged = true;
          await rename(parent, parked);
          await symlink(outside, parent, "dir");
        },
      },
    );

    expect(exchanged).toBe(true);
    expect(result).toMatchObject({ kind: "unavailable", headers: [] });
  });

  it("fails closed when a parent directory changes across enumeration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const root = join(tempDir, "root");
    const parent = join(root, "parent");
    const parked = join(root, "parked");
    const outside = join(tempDir, "outside");
    await mkdir(parent, { recursive: true });
    await mkdir(outside);
    await writeFile(join(parent, "safe.md"), "---\nname: safe\n---\nbody");
    await writeFile(
      join(outside, "escaped.md"),
      "---\nname: escaped\n---\nbody",
    );
    let exchanged = false;

    const result = await scanMemoryRoots(
      [root],
      new AbortController().signal,
      {
        afterDirectoryEnumeration: async (path) => {
          if (path !== parent || exchanged) return;
          exchanged = true;
          await rename(parent, parked);
          await symlink(outside, parent, "dir");
        },
      },
    );

    expect(exchanged).toBe(true);
    expect(result).toMatchObject({ kind: "unavailable", headers: [] });
  });

  it("discards a candidate whose pathname is exchanged after descriptor open", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const candidate = join(tempDir, "candidate.md");
    const replacement = join(tempDir, "replacement.tmp");
    await writeFile(candidate, "---\nname: admitted\n---\nbody");
    await writeFile(replacement, "---\nname: swapped\n---\nbody");
    let exchanged = false;

    const result = await scanMemoryRoots(
      [tempDir],
      new AbortController().signal,
      {
        afterCandidateOpen: async (path) => {
          if (path !== candidate || exchanged) return;
          exchanged = true;
          await rename(replacement, candidate);
        },
      },
    );

    expect(result).toMatchObject({ kind: "complete", headers: [] });
  });

  it("discards invalid UTF-8 headers without weakening the full scan", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "invalid.md"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(join(tempDir, "valid.md"), "---\nname: valid\n---\nbody");

    const result = await scanMemoryFiles(tempDir);

    expect(result.map((entry) => entry.filename)).toEqual(["valid.md"]);
  });

  it.runIf(process.platform !== "win32")(
    "treats a POSIX backslash as a filename byte rather than a separator",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
      await writeFile(
        join(tempDir, String.raw`literal\name.md`),
        "---\nname: literal backslash\n---\nbody",
      );

      const result = await scanMemoryFiles(tempDir);

      expect(result.map((entry) => entry.filename)).toEqual([
        String.raw`literal\name.md`,
      ]);
    },
  );

  it("returns a typed empty result when the fixed scan deadline is crossed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    let time = 0;
    const result = await scanMemoryRoots(
      [tempDir],
      new AbortController().signal,
      { now: () => (time += 1_001) },
    );

    expect(result).toMatchObject({ kind: "deadline", headers: [] });
  });

  it("propagates an abort that arrives at a descriptor-bound test seam", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "candidate.md"), "---\nname: safe\n---\nbody");
    const controller = new AbortController();
    const reason = new Error("cancel descriptor read");

    await expect(
      scanMemoryRoots([tempDir], controller.signal, {
        afterCandidateOpen: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
  });

  it("propagates abort during enumeration and bounded header read", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "candidate.md"), "---\nname: safe\n---\nbody");

    const enumeration = new AbortController();
    const enumerationReason = new Error("cancel enumeration");
    await expect(
      scanMemoryRoots([tempDir], enumeration.signal, {
        now: () => 0,
        openDirectory: async () =>
          ({
            async close() {},
            async *[Symbol.asyncIterator]() {
              enumeration.abort(enumerationReason);
              yield {
                name: "candidate.md",
                isFile: () => true,
                isDirectory: () => false,
                isSymbolicLink: () => false,
              };
            },
          }) as never,
      }),
    ).rejects.toBe(enumerationReason);

    const header = new AbortController();
    const headerReason = new Error("cancel header read");
    await expect(
      scanMemoryRoots([tempDir], header.signal, {
        beforeHeaderRead: () => header.abort(headerReason),
      }),
    ).rejects.toBe(headerReason);
  });

  it("rejects the exact root-count and root-path overflow before traversal", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const signal = new AbortController().signal;
    await expect(
      scanMemoryRoots([tempDir, tempDir, tempDir], signal),
    ).resolves.toMatchObject({ kind: "limit", headers: [] });
    await expect(
      scanMemoryRoots(["x".repeat(MAX_C3A_ROOT_PATH_UTF8_BYTES + 1)], signal),
    ).resolves.toMatchObject({ kind: "limit", headers: [] });
  });

  it("discards an oversized directory rather than ranking its prefix", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const result = await scanMemoryRoots(
      [tempDir],
      new AbortController().signal,
      {
        now: () => 0,
        openDirectory: async () =>
          fakeDirectory(MAX_C3A_CANDIDATE_FILES + 1, (index) => ({
            name: `candidate-${index}.md`,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          })),
      },
    );

    expect(result).toMatchObject({ kind: "limit", headers: [] });
  });

  it("enforces traversal-entry and aggregate-path storage ceilings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const signal = new AbortController().signal;
    const traversal = await scanMemoryRoots([tempDir], signal, {
      now: () => 0,
      openDirectory: async () =>
        fakeDirectory(MAX_C3A_TRAVERSAL_ENTRIES + 1, (index) => ({
          name: `entry-${index}.txt`,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        })),
    });
    expect(traversal).toMatchObject({ kind: "limit", headers: [] });

    const pathLength = MAX_C3A_PATH_UTF8_BYTES - 32;
    const entriesToCrossTotal =
      Math.floor(MAX_C3A_TOTAL_PATH_UTF8_BYTES / pathLength) + 2;
    const aggregate = await scanMemoryRoots([tempDir], signal, {
      now: () => 0,
      openDirectory: async () =>
        fakeDirectory(entriesToCrossTotal, (index) => {
          const suffix = `-${index}.txt`;
          return {
            name: `${"p".repeat(pathLength - suffix.length)}${suffix}`,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          };
        }),
    });
    expect(aggregate).toMatchObject({ kind: "limit", headers: [] });
  });

  it("discards all headers when their aggregate byte ceiling is crossed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const content = `---\nname: large\n---\n${"x".repeat(
      MAX_C3A_HEADER_BYTES_PER_FILE,
    )}`;
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeFile(join(tempDir, `large-${index}.md`), content),
      ),
    );

    const result = await scanMemoryRoots(
      [tempDir],
      new AbortController().signal,
      { now: () => 0 },
    );

    expect(result).toMatchObject({ kind: "limit", headers: [] });
  });
});

function fakeDirectory(
  count: number,
  entry: (index: number) => {
    readonly name: string;
    readonly isFile: () => boolean;
    readonly isDirectory: () => boolean;
    readonly isSymbolicLink: () => boolean;
  },
): never {
  return {
    async close() {},
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < count; index += 1) yield entry(index);
    },
  } as never;
}
