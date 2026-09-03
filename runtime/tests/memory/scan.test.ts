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
  readMemoryContent,
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

  /**
   * GUARD: the scan's three DIRECTORY proofs comparing `dev`/`ino`/`mode`
   * rather than the full six-field identity.
   *
   * A directory's `size`, `mtime`, and `ctime` move whenever any child is
   * added, removed, or renamed, and a memory directory is written to by the
   * very runtime that scans it. While these three proofs compared those
   * fields, one benign neighbouring write anywhere in the memory directory
   * failed the whole scan, and `scanMemoryFiles` turns a failed scan into an
   * empty array — so the MCP memory listing, which cannot produce a single
   * resource without the scan, lost everything. Measured on this machine with
   * a separate process writing and removing one sibling file in the memory
   * directory and no attacker at all: the memory listing was available 113
   * times in 76,583 attempts, 0.15%. Narrowed, 22,561 of 22,561, 100.00%.
   *
   * Each of the three tests below writes a sibling file at the one seam that
   * falls inside that proof's window, and each fails if its proof is widened
   * back to `sameStats`.
   *
   * Pinned in the WIDENING direction only, and that is worth stating plainly
   * rather than leaving a reader to assume otherwise. Deleting
   * `!sameDirectoryIdentity(opened, pending.identity) ||
   * !sameDirectoryIdentity(opened, current)` outright from
   * `assertBoundDirectoryUnchanged`, `openVerifiedDirectory` or
   * `openBoundRootDirectory` leaves this suite green, unlike the
   * `bindVerifiedRoot` proofs, which each have a test that kills them on
   * deletion. These three are defence in depth: the adversarial run that
   * cleared this change attacked the narrowed scan directly for 1,963,015
   * seam-free attempts across nine shapes, including two aimed at the
   * narrowing itself, and forged nothing. That is evidence the escape is
   * closed, not evidence these clauses are individually load-bearing.
   */
  it("survives a sibling write between the root bind and the root open", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "note.md"), "---\nname: note\n---\nbody");
    let wrote = false;

    const result = await scanMemoryRoots([tempDir], new AbortController().signal, {
      // Fires after the scan bound the root and before `openBoundRootDirectory`
      // compares the opened handle against that binding.
      beforeDirectoryOpen: async (path) => {
        if (path !== tempDir || wrote) return;
        wrote = true;
        await writeFile(join(tempDir, "sibling.md"), "---\nname: sibling\n---\nb");
      },
    });

    expect(wrote).toBe(true);
    expect(result.kind).toBe("complete");
    expect(result.headers.map((header) => header.filename)).toContain("note.md");
  });

  it("survives a sibling write between a subdirectory's identity binding and its open", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    const nested = join(tempDir, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "note.md"), "---\nname: note\n---\nbody");
    let wrote = false;

    const result = await scanMemoryRoots([tempDir], new AbortController().signal, {
      // Fires after the parent's enumeration recorded this directory's
      // identity and before `openVerifiedDirectory` compares its open against
      // that record.
      beforeDirectoryOpen: async (path) => {
        if (path !== nested || wrote) return;
        wrote = true;
        await writeFile(join(nested, "sibling.md"), "---\nname: sibling\n---\nb");
      },
    });

    expect(wrote).toBe(true);
    expect(result.kind).toBe("complete");
    expect(
      result.headers.some((header) => header.relativePath === "nested/note.md"),
    ).toBe(true);
  });

  it("survives a sibling write across a directory's enumeration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "note.md"), "---\nname: note\n---\nbody");
    let wrote = false;

    const result = await scanMemoryRoots([tempDir], new AbortController().signal, {
      // Fires after the entries are read and before
      // `assertBoundDirectoryUnchanged` re-proves the directory.
      afterDirectoryEnumeration: async (path) => {
        if (path !== tempDir || wrote) return;
        wrote = true;
        await writeFile(join(tempDir, "sibling.md"), "---\nname: sibling\n---\nb");
      },
    });

    expect(wrote).toBe(true);
    expect(result.kind).toBe("complete");
    expect(result.headers.map((header) => header.filename)).toContain("note.md");
  });

  /**
   * GUARD: the root re-bind in `readMemoryContent` comparing directory
   * identity rather than the full six-field identity.
   *
   * The header was produced by one bind and the content read makes another,
   * with arbitrary time in between. Comparing `size`/`mtime`/`ctime` there
   * meant any write into the memory directory after recall selected a
   * memory — including the runtime writing the next memory — turned the read
   * into "memory root identity changed before content read". The candidate
   * FILE keeps the full identity, and that is what this test leaves intact.
   */
  it("reads memory content after a sibling was written into the memory dir", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-memory-scan-"));
    await writeFile(join(tempDir, "note.md"), "---\nname: note\n---\nbody text");

    const headers = await scanMemoryFiles(tempDir, new AbortController().signal);
    const header = headers.find((entry) => entry.filename === "note.md")!;
    expect(header).toBeDefined();
    await writeFile(join(tempDir, "sibling.md"), "---\nname: sibling\n---\nb");

    const content = await readMemoryContent(header, new AbortController().signal);
    expect(content.content).toContain("body text");
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
