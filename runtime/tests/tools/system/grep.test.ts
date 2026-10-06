import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __INTERNAL,
  __resetRipgrepProbeForTests,
  __setRipgrepAvailabilityForTests,
  createGrepTool as createUnboundGrepTool,
  GREP_TOOL_NAME,
} from "./grep.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { attachToolRuntimeContext } from "../../../src/tools/runtimes/context.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../../src/session/runtime-options.js";

const createGrepTool = (...args: Parameters<typeof createUnboundGrepTool>) =>
  bindExplicitDangerBoundary(createUnboundGrepTool(...args));

function lines(content: string): string[] {
  return content.split("\n").filter(Boolean);
}

function fileResultPaths(content: string): string[] {
  const resultLines = lines(content);
  expect(resultLines[0]).toMatch(/^Found \d+ files?/);
  return resultLines.slice(1);
}

function isWindowsExchangeDenial(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    process.platform === "win32" &&
    (code === "EPERM" || code === "EACCES" || code === "EBUSY")
  );
}

async function exchangeDirectory(
  current: string,
  displaced: string,
  outside: string,
): Promise<"exchanged" | "kernel_denied"> {
  try {
    await rename(current, displaced);
  } catch (error) {
    if (isWindowsExchangeDenial(error)) return "kernel_denied";
    throw error;
  }
  try {
    await symlink(
      outside,
      current,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    await rename(displaced, current).catch(() => {});
    if (isWindowsExchangeDenial(error)) return "kernel_denied";
    throw error;
  }
  return "exchanged";
}

function expectCompletedExchangeAttempt(
  outcome: "pending" | "exchanged" | "kernel_denied",
): void {
  expect(outcome).not.toBe("pending");
  if (outcome === "kernel_denied") expect(process.platform).toBe("win32");
}

describe("Grep tool", () => {
  let root = "";
  let previousAgencHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-grep-"));
    previousAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = join(root, ".agenc-test-home");
    __resetRipgrepProbeForTests();
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
    if (previousAgencHome === undefined) {
      delete process.env.AGENC_HOME;
    } else {
      process.env.AGENC_HOME = previousAgencHome;
    }
    __resetRipgrepProbeForTests();
  });

  test("exposes the AgenC-bare tool name and required schema", () => {
    expect(GREP_TOOL_NAME).toBe("Grep");
    const tool = createGrepTool({ allowedPaths: [root] });
    expect(tool.name).toBe("Grep");
    expect(tool.isReadOnly).toBe(true);
    expect(tool.metadata?.mutating).toBe(false);
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["pattern"]);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        "pattern",
        "path",
        "glob",
        "output_mode",
        "-B",
        "-A",
        "-C",
        "-n",
        "-i",
        "type",
        "head_limit",
        "offset",
        "multiline",
      ]),
    );
    expect(schema.properties).not.toHaveProperty("context");
  });

  test("returns matching content lines for a basic pattern", async () => {
    await writeFile(join(root, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
    await writeFile(join(root, "b.txt"), "delta\nepsilon\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "beta",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("beta");
    expect(result.content).not.toContain("alpha");
  });

  test("never returns outside matches after a final ancestor exchange", async () => {
    const workspace = join(root, "workspace");
    const displaced = join(root, "workspace-displaced");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(
      join(workspace, "inside.ts"),
      "const needle = 'inside-grep';\n",
      "utf8",
    );
    await writeFile(
      join(outside, "outside.ts"),
      "const needle = 'outside-grep-secret';\n",
      "utf8",
    );
    let exchangeOutcome: "pending" | "exchanged" | "kernel_denied" = "pending";
    const tool = createGrepTool({
      allowedPaths: [workspace],
      __testAfterFinalPathCheck: async () => {
        exchangeOutcome = await exchangeDirectory(
          workspace,
          displaced,
          outside,
        );
      },
    });

    const result = await tool.execute({
      pattern: "needle",
      path: workspace,
      output_mode: "content",
    });

    expectCompletedExchangeAttempt(exchangeOutcome);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("inside-grep");
    expect(result.content).not.toContain("outside-grep-secret");
    expect(result.content).not.toContain("outside.ts");
  });

  test("accepts one internal truncation witness at the exact public result cap", async () => {
    // Revert-sensitive: record 100001 used to trip RESULT_LIMIT before it
    // could serve as the non-returned truncation witness.
    const target = join(root, "exact-result-cap.txt");
    await writeFile(
      target,
      `${Array.from({ length: 100_001 }, () => "needle").join("\n")}\n`,
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });
    const execute = () =>
      tool.execute({
        pattern: "needle",
        path: target,
        output_mode: "content",
        head_limit: 100_000,
      });

    const unprotected = await execute();
    expect(unprotected.isError).toBeUndefined();
    expect(unprotected.content).not.toContain("RESULT_LIMIT");
    expect(unprotected.content).toContain("results truncated at 100000");
    expect(unprotected.content.split("\n")).toHaveLength(100_001);

    const protectedResult = await execute();
    expect(protectedResult.isError).toBeUndefined();
    expect(protectedResult.content).not.toContain("RESULT_LIMIT");
    expect(protectedResult.content).toContain("results truncated at 100000");
    expect(protectedResult.content.split("\n")).toHaveLength(100_001);
  }, 60_000);

  test("stops a multi-record stdout chunk at the complete witness boundary", () => {
    const parser = __INTERNAL.createCollectionWireParser(
      "files_with_matches",
      2,
    );
    const state = { inspectedRecords: 0, renderedLines: 0 };

    const reached = __INTERNAL.pushRipgrepChunkWithinLineLimit(
      parser,
      "files_with_matches",
      Buffer.from("first.txt\0second.txt\0must-not-parse.txt\0", "utf8"),
      2,
      state,
    );

    expect(reached).toBe(true);
    expect(parser.records).toHaveLength(2);
    expect(
      parser.records.map((record) => record.path.toString("utf8")),
    ).toEqual(["first.txt", "second.txt"]);
  });

  test.each([
    {
      outputMode: "files_with_matches" as const,
      wire: Buffer.from("\0kept.txt\0", "utf8"),
      reason: "INVALID_WIRE_TEXT",
    },
    {
      outputMode: "count" as const,
      wire: Buffer.from("skipped.txt\x00not-decimal\nkept.txt\x001\n", "utf8"),
      reason: "INVALID_COUNT",
    },
  ])(
    "validates malformed $outputMode records before the requested offset",
    ({ outputMode, wire, reason }) => {
      const window = new __INTERNAL.StreamingRipgrepWireWindow(
        outputMode,
        1,
        1,
      );

      expect(() => window.push(wire)).toThrowError(
        expect.objectContaining({ reason }),
      );
    },
  );

  test("validates JSON ordering before applying the requested offset", () => {
    const path = { text: "skipped.txt" };
    const nestedBegins = Buffer.from(
      `${JSON.stringify({ type: "begin", data: { path } })}\n${JSON.stringify({ type: "begin", data: { path } })}\n`,
      "utf8",
    );
    const window = new __INTERNAL.StreamingRipgrepWireWindow("content", 1, 1);

    expect(() => window.push(nestedBegins)).toThrowError(
      expect.objectContaining({ reason: "INVALID_JSON_RECORD_ORDER" }),
    );
  });

  test("bounds rendered path-prefix amplification before retaining output", () => {
    const records = [
      {
        kind: "content" as const,
        recordType: "match" as const,
        path: Buffer.from("a-very-long-result-path.ts", "utf8"),
        lines: Buffer.from("first\nsecond\n", "utf8"),
        lineNumber: 1,
        absoluteOffset: 0,
        submatches: [],
      },
    ];

    expect(() =>
      __INTERNAL.renderContentRecordsWithinBudget({
        records,
        displayRoot: root,
        showLineNumbers: true,
        headLimit: 0,
        maximumBytes: 32,
      }),
    ).toThrowError(
      expect.objectContaining({ reason: "RENDERED_OUTPUT_LIMIT" }),
    );
  });

  test.each(["files_with_matches", "count"] as const)(
    "permits the exact internal witness for %s wire records",
    (outputMode) => {
      const maximumLines = 100_001;
      const parser = __INTERNAL.createCollectionWireParser(
        outputMode,
        maximumLines,
      );
      const state = { inspectedRecords: 0, renderedLines: 0 };
      const record =
        outputMode === "files_with_matches"
          ? "x\0"
          : ["x", "\0", "1", "\n"].join("");
      const chunk = Buffer.from(record.repeat(maximumLines), "utf8");

      const reached = __INTERNAL.pushRipgrepChunkWithinLineLimit(
        parser,
        outputMode,
        chunk,
        maximumLines,
        state,
      );

      expect(reached).toBe(true);
      expect(parser.records).toHaveLength(maximumLines);
      expect(state.renderedLines).toBe(maximumLines);
    },
  );

  test.each(["files_with_matches", "count"] as const)(
    "enforces the unpaginated hard result cap for %s wire records",
    (outputMode) => {
      const overHardLimit = 100_001;
      const record =
        outputMode === "files_with_matches"
          ? "x\0"
          : ["x", "\0", "1", "\n"].join("");
      const window = new __INTERNAL.StreamingRipgrepWireWindow(
        outputMode,
        0,
        undefined,
      );

      expect(() =>
        window.push(Buffer.from(record.repeat(overHardLimit), "utf8")),
      ).toThrowError(expect.objectContaining({ reason: "RESULT_LIMIT" }));
    },
  );

  test("rejects non-adjacent dirty path prefix collisions before oracle I/O", async () => {
    const result = await __INTERNAL.pinnedSnapshotPathEligibility({
      relativePaths: ["a", "a-foo", "a/b"],
      globs: ["*"],
    });

    expect("error" in result ? result.error : "").toContain(
      "file/directory prefix collision",
    );
  });

  test("isolates path-oracle artifacts across concurrent session temp roots", async () => {
    const rootA = await mkdtemp(join(root, "path-oracle-a-"));
    const rootB = await mkdtemp(join(root, "path-oracle-b-"));
    const run = (sessionRoot: string) =>
      runWithAgentRuntimeOptions(
        resolveAgentRuntimeOptions({}, { sessionTempRoot: sessionRoot }),
        async () => {
          await Promise.resolve();
          let temporaryRoot = "";
          const result = await __INTERNAL.pinnedSnapshotPathEligibility({
            relativePaths: ["inside.ts"],
            globs: ["*.ts"],
            onTemporaryRoot(path) {
              temporaryRoot = path;
            },
          });
          return { result, temporaryRoot };
        },
      );

    const [a, b] = await Promise.all([run(rootA), run(rootB)]);

    expect("error" in a.result ? a.result.error : undefined).toBeUndefined();
    expect("error" in b.result ? b.result.error : undefined).toBeUndefined();
    expect(a.temporaryRoot.startsWith(`${rootA}${sep}`)).toBe(true);
    expect(b.temporaryRoot.startsWith(`${rootB}${sep}`)).toBe(true);
  });

  test("maps a renamed path-oracle placeholder only by object identity", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    if (platformDescriptor?.configurable !== true) {
      throw new Error("process.platform is not configurable for this test");
    }
    const nfcPath = "caf\u00e9.ts";
    const nfdPath = "cafe\u0301.ts";
    let temporaryRoot = "";
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "darwin",
    });
    try {
      const result = await __INTERNAL.pinnedSnapshotPathEligibility({
        relativePaths: [nfcPath],
        globs: ["*.ts"],
        onTemporaryRoot(path) {
          temporaryRoot = path;
        },
        async afterPlaceholder() {
          await rename(
            join(temporaryRoot, nfcPath),
            join(temporaryRoot, nfdPath),
          );
        },
      });

      expect("error" in result ? result.error : undefined).toBeUndefined();
      if (!("error" in result)) {
        expect(result.has(nfcPath)).toBe(true);
        expect(result.has(nfdPath)).toBe(false);
      }
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  test.runIf(process.platform === "linux")(
    "keeps normalization-sensitive Darwin path-oracle siblings distinct",
    async () => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (platformDescriptor?.configurable !== true) {
        throw new Error("process.platform is not configurable for this test");
      }
      const nfcPath = "caf\u00e9.ts";
      const nfdPath = "cafe\u0301.ts";
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "darwin",
      });
      try {
        const result = await __INTERNAL.pinnedSnapshotPathEligibility({
          relativePaths: [nfcPath, nfdPath],
          globs: ["*.ts"],
        });

        expect("error" in result ? result.error : undefined).toBeUndefined();
        if (!("error" in result)) {
          expect(result.has(nfcPath)).toBe(true);
          expect(result.has(nfdPath)).toBe(true);
          expect(result.size).toBe(2);
        }
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    },
  );

  test("path-oracle construction obeys the aggregate deadline and cleans up", async () => {
    const deadline = { expiresAt: Number.POSITIVE_INFINITY };
    let temporaryRoot = "";
    const result = await __INTERNAL.pinnedSnapshotPathEligibility({
      relativePaths: ["one.ts", "two.ts"],
      globs: ["*.ts"],
      deadline,
      onTemporaryRoot(path) {
        temporaryRoot = path;
      },
      afterPlaceholder() {
        deadline.expiresAt = 0;
      },
    });

    expect("error" in result ? result.error : "").toContain("timed out");
    expect(temporaryRoot).not.toBe("");
    await expect(access(temporaryRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("never resolves the production ripgrep binary through PATH", async () => {
    const bin = join(root, "bin");
    const marker = join(root, "path-rg-ran");
    const fakeRipgrep = join(bin, "rg");
    await mkdir(bin);
    await writeFile(
      fakeRipgrep,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 99\n`,
      "utf8",
    );
    await chmod(fakeRipgrep, 0o755);
    await writeFile(join(root, "target.txt"), "needle\n", "utf8");
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    const tool = createGrepTool({ allowedPaths: [root] });

    try {
      const result = await tool.execute({
        pattern: "needle",
        path: root,
        output_mode: "content",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("needle");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
    }
  });

  test("content mode returns long matching lines", async () => {
    const line = `needle${"x".repeat(700)}`;
    await writeFile(join(root, "long.txt"), `${line}\n`, "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("needle");
    expect(result.content).toContain("(line truncated at 500 chars)");
    expect(result.content).not.toContain(line);
    expect(result.content).not.toContain("Omitted long matching line");
  });

  test("content mode preserves Unix filenames containing colons", async () => {
    await writeFile(join(root, "a:b.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a:b.txt:1:needle");
  });

  test("content mode preserves Unix filenames containing colon-number runs", async () => {
    await writeFile(join(root, "a:1:b.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const withLineNumbers = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expect(withLineNumbers.isError).toBeUndefined();
    expect(withLineNumbers.content).toContain("a:1:b.txt:1:needle");

    const withoutLineNumbers = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
      "-n": false,
    });

    expect(withoutLineNumbers.isError).toBeUndefined();
    expect(withoutLineNumbers.content).toContain("a:1:b.txt:needle");
  });

  test("content mode preserves match text containing colon-number-colon", async () => {
    await writeFile(join(root, "a.txt"), "foo:123:bar\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "foo",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a.txt:1:foo:123:bar");
  });

  test("content mode without line numbers preserves Unix filenames containing colons", async () => {
    await writeFile(join(root, "a:b.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
      "-n": false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a:b.txt:needle");
  });

  test("accepts a file path as the search target for content mode", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    const target = join(root, "nested", "target.txt");
    await writeFile(target, "alpha\nneedle\ngamma\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: target,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("nested/target.txt:2:needle");
  });

  test("accepts a file path as the search target for files_with_matches", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    const target = join(root, "nested", "hit.txt");
    await writeFile(target, "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: target,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(["Found 1 file", "nested/hit.txt"]);
  });

  test("output_mode=files_with_matches returns a summary and paths", async () => {
    await writeFile(join(root, "hit.txt"), "needle\n", "utf8");
    await writeFile(join(root, "miss.txt"), "haystack\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(["Found 1 file", "hit.txt"]);
  });

  test("output_mode=files_with_matches sorts newest-first before truncating", async () => {
    const oldFile = join(root, "old.txt");
    const midFile = join(root, "mid.txt");
    const newFile = join(root, "new.txt");
    await writeFile(oldFile, "needle\n", "utf8");
    await writeFile(midFile, "needle\n", "utf8");
    await writeFile(newFile, "needle\n", "utf8");
    const now = Date.now() / 1000;
    await utimes(oldFile, now - 300, now - 300);
    await utimes(midFile, now - 150, now - 150);
    await utimes(newFile, now, now);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
      head_limit: 2,
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual([
      "Found 2 files (results truncated at 2; refine query)",
      "new.txt",
      "mid.txt",
    ]);
  });

  test("defaults to files_with_matches when output_mode is omitted", async () => {
    await writeFile(join(root, "hit.txt"), "needle\n", "utf8");
    await writeFile(join(root, "miss.txt"), "haystack\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(["Found 1 file", "hit.txt"]);
    expect(result.content).not.toContain("needle");
  });

  test("omitted head_limit keeps up to the donor default of 250 files", async () => {
    for (let i = 0; i < 120; i += 1) {
      await writeFile(
        join(root, `hit-${String(i).padStart(3, "0")}.txt`),
        "needle\n",
        "utf8",
      );
    }
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).not.toContain("results truncated");
    expect(fileResultPaths(result.content)).toHaveLength(120);
  });

  test("output_mode=count emits path:count lines", async () => {
    await writeFile(join(root, "a.txt"), "needle\nneedle\nother\n", "utf8");
    await writeFile(join(root, "b.txt"), "needle\nother\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "count",
    });

    expect(result.isError).toBeUndefined();
    const counts = new Map<string, number>();
    for (const line of result.content.split("\n").filter(Boolean)) {
      const idx = line.lastIndexOf(":");
      if (idx <= 0) continue;
      counts.set(line.substring(0, idx), Number(line.substring(idx + 1)));
    }
    expect(counts.get("a.txt")).toBe(2);
    expect(counts.get("b.txt")).toBe(1);
    expect(result.content).toContain(
      "Found 3 total occurrences across 2 files.",
    );
  });

  test("output_mode=count emits a zero summary when no files match", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "count",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "No matches found.\nFound 0 total occurrences across 0 files.",
    );
  });

  test("output_mode=count labels truncated summaries as returned results", async () => {
    await writeFile(join(root, "a.txt"), "needle\nneedle\n", "utf8");
    await writeFile(join(root, "b.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "count",
      head_limit: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      [
        "a.txt:2",
        "",
        "Showing 2 occurrences across 1 file in returned results. (results truncated at 1; refine query)",
      ].join("\n"),
    );
  });

  test("output_mode=count preserves colon paths when parsing counts", async () => {
    await writeFile(join(root, "a:1:b.txt"), "needle\nneedle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "count",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a:1:b.txt:2");
    expect(result.content).toContain(
      "Found 2 total occurrences across 1 file.",
    );
  });

  test("-i case-insensitive flag matches mixed casing", async () => {
    await writeFile(join(root, "a.txt"), "HELLO world\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const sensitive = await tool.execute({
      pattern: "hello",
      path: root,
      output_mode: "files_with_matches",
    });
    expect(sensitive.content).toBe("No files found.");

    const insensitive = await tool.execute({
      pattern: "hello",
      path: root,
      "-i": true,
      output_mode: "files_with_matches",
    });
    expect(lines(insensitive.content)).toEqual(["Found 1 file", "a.txt"]);
  });

  test("head_limit truncation appends the polite truncation note", async () => {
    let body = "";
    for (let i = 0; i < 25; i += 1) body += `match-${i}\n`;
    await writeFile(join(root, "many.txt"), body, "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "match-",
      path: root,
      output_mode: "content",
      head_limit: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      [
        "many.txt:1:match-0",
        "many.txt:2:match-1",
        "many.txt:3:match-2",
        "many.txt:4:match-3",
        "many.txt:5:match-4",
        "(results truncated at 5; refine query)",
      ].join("\n"),
    );
  });

  test("offset skips earlier content results before applying head_limit", async () => {
    await writeFile(
      join(root, "paged.txt"),
      Array.from({ length: 6 }, (_, i) => `needle-${i}`).join("\n"),
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle-",
      path: root,
      output_mode: "content",
      head_limit: 2,
      offset: 2,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("paged.txt:3:needle-2");
    expect(result.content).toContain("paged.txt:4:needle-3");
    expect(result.content).not.toContain("needle-0");
    expect(result.content).toContain(
      "(results truncated at 2 after offset 2; refine query)",
    );
  });

  test("streams offsets beyond the public result-count safety cap", async () => {
    const target = join(root, "large-offset.txt");
    await writeFile(
      target,
      `${Array.from({ length: 100_003 }, (_, index) => `needle-${index}`).join("\n")}\n`,
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle-",
      path: target,
      output_mode: "content",
      head_limit: 0,
      offset: 100_000,
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual([
      "large-offset.txt:100001:needle-100000",
      "large-offset.txt:100002:needle-100001",
      "large-offset.txt:100003:needle-100002",
      "(offset 100000)",
    ]);

    const protectedResult = await tool.execute({
      pattern: "needle-",
      path: target,
      output_mode: "content",
      head_limit: 0,
      offset: 100_000,
    });
    expect(protectedResult.isError).toBeUndefined();
    expect(lines(protectedResult.content)).toEqual(lines(result.content));
  }, 60_000);

  test("head_limit truncates broad ripgrep output before buffer exhaustion", async () => {
    const line = `needle ${"x".repeat(360)}`;
    const body = Array.from({ length: 90_000 }, (_, i) => `${line} ${i}`).join(
      "\n",
    );
    await writeFile(join(root, "large.txt"), `${body}\n`, "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
      head_limit: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("(results truncated at 3; refine query)");
    expect(result.content).not.toContain("Grep error");
    const lines = result.content.split("\n").filter(Boolean);
    expect(lines.length).toBe(4);
  });

  test("head_limit=0 returns unpaginated content without truncation note", async () => {
    await writeFile(
      join(root, "unlimited.txt"),
      Array.from({ length: 8 }, (_, i) => `needle-${i}`).join("\n"),
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle-",
      path: root,
      output_mode: "content",
      head_limit: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).not.toContain("results truncated");
    expect(result.content.split("\n").filter(Boolean)).toHaveLength(8);
  });

  test("head_limit=0 can return more than the bounded collection size", async () => {
    const body = Array.from({ length: 20_005 }, (_, i) => `needle-${i}`).join(
      "\n",
    );
    await writeFile(join(root, "very-large.txt"), `${body}\n`, "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle-",
      path: root,
      output_mode: "content",
      head_limit: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).not.toContain("results truncated");
    expect(result.content.split("\n").filter(Boolean)).toHaveLength(20_005);
  });

  test("head_limit=0 rejects one multiline record beyond the hard rendered-line cap", async () => {
    const excessiveRenderedLines = 100_001;
    await writeFile(
      join(root, "newline-amplification.txt"),
      `START\n${"x\n".repeat(excessiveRenderedLines)}END\n`,
      "utf8",
    );
    const execute = () =>
      createGrepTool({ allowedPaths: [root] }).execute({
        pattern: "START(?s:.*)END",
        path: root,
        output_mode: "content",
        multiline: true,
        head_limit: 0,
      });

    const unprotected = await execute();
    expect(unprotected.isError).toBe(true);
    expect(unprotected.content).toMatch(/\[RESULT_LIMIT\].*100000/iu);
    expect(unprotected.content.length).toBeLessThan(1_000);

    const protectedResult = await execute();
    expect(protectedResult.isError).toBe(true);
    expect(protectedResult.content).toMatch(/\[RESULT_LIMIT\].*100000/iu);
    expect(protectedResult.content.length).toBeLessThan(1_000);
  }, 60_000);

  test("glob filter restricts the searched files", async () => {
    await writeFile(join(root, "keep.ts"), "needle\n", "utf8");
    await writeFile(join(root, "skip.md"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      glob: "*.ts",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const matches = fileResultPaths(result.content);
    expect(matches).toContain("keep.ts");
    expect(matches).not.toContain("skip.md");
  });

  test("pinned ripgrep owns brace-alternative glob semantics", async () => {
    await writeFile(join(root, "keep.ts"), "needle\n", "utf8");
    await writeFile(join(root, "also.tsx"), "needle\n", "utf8");
    await writeFile(join(root, "skip.js"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      glob: "*.{ts,tsx}",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const matches = fileResultPaths(result.content);
    expect(matches).toContain("keep.ts");
    expect(matches).toContain("also.tsx");
    expect(matches).not.toContain("skip.js");
  });

  test("passes positive, negated, and negative-only globs unchanged", () => {
    const args = __INTERNAL.buildRipgrepArgs({
      pattern: "needle",
      absolutePath: "/workspace",
      outputMode: "files_with_matches",
      caseInsensitive: false,
      showLineNumbers: true,
      multiline: false,
      includeIgnored: false,
      globs: ["src/?.ts", "!generated/**", "!*.map"],
    });

    expect(args).toEqual(
      expect.arrayContaining(["src/?.ts", "!generated/**", "!*.map"]),
    );
  });

  test("pinned ripgrep honors root ignore files", async () => {
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "needle\n", "utf8");
    await writeFile(join(root, "visible.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const matches = fileResultPaths(result.content);
    expect(matches).toContain("visible.txt");
    expect(matches).not.toContain("ignored.txt");
  });

  test("pinned ripgrep honors nested ignore files", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/.ignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "src/ignored.txt"), "needle\n", "utf8");
    await writeFile(join(root, "src/visible.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const matches = fileResultPaths(result.content);
    expect(matches).toContain("src/visible.txt");
    expect(matches).not.toContain("src/ignored.txt");
  });

  test("pinned ripgrep honors rgignore files", async () => {
    await writeFile(join(root, ".rgignore"), "rg-hidden.txt\n", "utf8");
    await writeFile(join(root, "rg-hidden.txt"), "needle\n", "utf8");
    await writeFile(join(root, "visible.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const matches = fileResultPaths(result.content);
    expect(matches).toContain("visible.txt");
    expect(matches).not.toContain("rg-hidden.txt");
  });

  test("ignores parent and git-info exclude metadata outside the search policy", async () => {
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".git", "info"), { recursive: true });
    await writeFile(
      join(root, ".gitignore"),
      "workspace/parent-hidden.txt\n",
      "utf8",
    );
    await writeFile(
      join(workspace, ".git", "info", "exclude"),
      "info-hidden.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "parent-hidden.txt"), "needle\n", "utf8");
    await writeFile(join(workspace, "info-hidden.txt"), "needle\n", "utf8");

    const result = await createGrepTool({
      allowedPaths: [workspace],
    }).execute({
      pattern: "needle",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(fileResultPaths(result.content).sort()).toEqual([
      "info-hidden.txt",
      "parent-hidden.txt",
    ]);
  });

  test("honors in-root VCS ignores for normal and linked worktrees", async () => {
    const normal = join(root, "normal");
    const linked = join(root, "linked");
    await mkdir(join(normal, ".git"), { recursive: true });
    await mkdir(linked);
    await writeFile(join(normal, ".gitignore"), "hidden.ts\n", "utf8");
    await writeFile(join(normal, "hidden.ts"), "normalNeedle\n", "utf8");
    await writeFile(
      join(linked, ".git"),
      "gitdir: ../common-worktree-metadata\n",
      "utf8",
    );
    await writeFile(join(linked, ".gitignore"), "hidden.ts\n", "utf8");
    await writeFile(join(linked, "hidden.ts"), "linkedDiskNeedle\n", "utf8");
    await mkdir(join(linked, "nested"));
    await writeFile(
      join(linked, "nested", ".gitignore"),
      "nested-hidden.ts\n",
      "utf8",
    );
    await writeFile(
      join(linked, "nested", "nested-hidden.ts"),
      "linkedDiskNeedle\n",
      "utf8",
    );

    const normalResult = await createGrepTool({
      allowedPaths: [normal],
    }).execute({
      pattern: "normalNeedle",
      output_mode: "files_with_matches",
    });
    expect(normalResult.content).toBe("No files found.");

    const linkedTool = createGrepTool({ allowedPaths: [linked] });
    const linkedDisk = await linkedTool.execute({
      pattern: "linkedDiskNeedle",
      output_mode: "files_with_matches",
    });
    expect(linkedDisk.isError).toBeUndefined();
    expect(linkedDisk.content).toBe("No files found.");
  });

  test("pinned ripgrep applies nested ignore negation", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "src/*.txt\n", "utf8");
    await writeFile(join(root, "src/.ignore"), "!keep.txt\n", "utf8");
    await writeFile(join(root, "src/drop.txt"), "needle\n", "utf8");
    await writeFile(join(root, "src/keep.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const matches = fileResultPaths(result.content);
    expect(matches).toContain("src/keep.txt");
    expect(matches).not.toContain("src/drop.txt");
  });

  test.runIf(process.platform !== "win32")(
    "uses snapshotted root ignore bytes after the admitted pathname becomes a symlink",
    async () => {
      const scoped = join(root, "sub");
      const ignorePath = join(root, ".gitignore");
      const admittedPath = join(root, ".gitignore-admitted");
      const replacementPath = join(root, "replacement.ignore");
      await mkdir(scoped);
      await writeFile(ignorePath, "sub/ignored.txt\n", "utf8");
      await writeFile(replacementPath, "!sub/ignored.txt\n", "utf8");
      await writeFile(join(scoped, "ignored.txt"), "needle ignored\n", "utf8");
      await writeFile(join(scoped, "visible.txt"), "needle visible\n", "utf8");

      const run = async (editorProtected: boolean) => {
        if (editorProtected) {
        }
        let exchanged = false;
        const tool = createGrepTool({
          allowedPaths: [root],
          __testAfterRootIgnoreSnapshot: async () => {
            await rename(ignorePath, admittedPath);
            await symlink(replacementPath, ignorePath, "file");
            exchanged = true;
          },
        });

        const result = await tool.execute({
          pattern: "needle",
          path: scoped,
          output_mode: "files_with_matches",
        });

        expect(exchanged).toBe(true);
        expect(result.isError).toBeUndefined();
        expect(fileResultPaths(result.content)).toEqual(["sub/visible.txt"]);
        await rm(ignorePath, { force: true });
        await rename(admittedPath, ignorePath);
      };

      await run(false);
      await run(true);
    },
  );

  test("-B and -A return surrounding context lines", async () => {
    await writeFile(
      join(root, "ctx.txt"),
      ["before-2", "before-1", "TARGET", "after-1", "after-2"].join("\n"),
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const both = await tool.execute({
      pattern: "TARGET",
      path: root,
      output_mode: "content",
      "-B": 1,
      "-A": 1,
    });
    expect(both.isError).toBeUndefined();
    expect(both.content).toContain("before-1");
    expect(both.content).toContain("TARGET");
    expect(both.content).toContain("after-1");
    expect(both.content).not.toContain(root);

    const c = await tool.execute({
      pattern: "TARGET",
      path: root,
      output_mode: "content",
      "-C": 2,
    });
    expect(c.isError).toBeUndefined();
    expect(c.content).toContain("before-2");
    expect(c.content).toContain("after-2");
  });

  test("does not publish the removed context input alias", () => {
    const tool = createGrepTool({ allowedPaths: [root] });
    expect(tool.inputSchema.properties).not.toHaveProperty("context");
  });

  test("multiline mode matches across line boundaries", async () => {
    await writeFile(
      join(root, "multi.txt"),
      ["alpha", "needle middle", "omega"].join("\n"),
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "alpha[\\s\\S]*omega",
      path: root,
      output_mode: "content",
      multiline: true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("multi.txt:1:alpha");
    expect(result.content).toContain("multi.txt:2:needle middle");
    expect(result.content).toContain("multi.txt:3:omega");
  });

  test("empty default files results return polite plain text and not isError", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "no-such-thing",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No files found.");
  });

  test("empty content results return polite plain text and not isError", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "no-such-thing",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No matches found.");
  });

  test("rejects path outside the allowed paths", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-grep-other-"));
    try {
      await writeFile(join(otherRoot, "b.txt"), "beta\n", "utf8");
      const tool = createGrepTool({ allowedPaths: [root] });

      const result = await tool.execute({
        pattern: "beta",
        path: otherRoot,
      });

      expect(result.isError).toBe(true);
      expect(result.content.toLowerCase()).toContain("access denied");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform === "linux")(
    "rejects a POSIX backslash sibling outside the allowed root",
    async () => {
      const allowed = join(root, "scope");
      const sibling = `${allowed}\\outside`;
      await mkdir(allowed);
      await mkdir(sibling);
      await writeFile(join(sibling, "secret.ts"), "escapeNeedle\n", "utf8");

      const result = await createGrepTool({ allowedPaths: [allowed] }).execute({
        pattern: "escapeNeedle",
        path: sibling,
        output_mode: "content",
      });

      expect(result.isError).toBe(true);
      expect(result.content.toLowerCase()).toContain("access denied");
      expect(result.content).not.toContain("escapeNeedle");
    },
  );

  test.runIf(process.platform === "linux")(
    "searches explicit NFD targets and NFD allowed roots without selecting NFC siblings",
    async () => {
      const nfcDirectory = join(root, "caf\u00e9");
      const nfdDirectory = join(root, "cafe\u0301");
      const nfcFile = join(nfcDirectory, "value.ts");
      const nfdFile = join(nfdDirectory, "value.ts");
      await mkdir(nfcDirectory);
      await mkdir(nfdDirectory);
      await writeFile(nfcFile, "nfcExplicitNeedle\n", "utf8");
      await writeFile(nfdFile, "nfdExplicitNeedle\n", "utf8");

      const rootTool = createGrepTool({ allowedPaths: [root] });
      for (const path of [nfdDirectory, nfdFile]) {
        const result = await rootTool.execute({
          pattern: "nfdExplicitNeedle",
          path,
          output_mode: "content",
        });
        expect(result.isError).toBeUndefined();
        expect(result.content).toContain("nfdExplicitNeedle");
        expect(result.content).not.toContain("nfcExplicitNeedle");
      }

      const nfdRootResult = await createGrepTool({
        allowedPaths: [nfdDirectory],
      }).execute({
        pattern: "nfdExplicitNeedle",
        output_mode: "content",
      });
      expect(nfdRootResult.isError).toBeUndefined();
      expect(nfdRootResult.content).toContain("nfdExplicitNeedle");
      expect(nfdRootResult.content).not.toContain("nfcExplicitNeedle");
    },
  );

  test("structured content mode honors the -n line-number flag", async () => {
    await writeFile(join(root, "a.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const withLineNumbers = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
      "-n": true,
    });
    expect(withLineNumbers.isError).toBeUndefined();
    expect(withLineNumbers.content).toBe("a.txt:1:needle");

    const withoutLineNumbers = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
      "-n": false,
    });
    expect(withoutLineNumbers.isError).toBeUndefined();
    expect(withoutLineNumbers.content).toBe("a.txt:needle");
  });

  test("missing pinned ripgrep fails closed in every output mode", async () => {
    await writeFile(join(root, "a.txt"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "count",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("PINNED_RIPGREP_UNAVAILABLE");
    expect(result.content).toContain("pinned ripgrep");
    expect(result.content).toContain("agenc doctor");
    expect(result.content).toContain("reinstall");
    expect(result.content).not.toContain("slower");
  });

  test("structured content mode preserves file context for single-file targets", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    const target = join(root, "nested", "single.txt");
    await writeFile(target, "alpha\nneedle\nomega\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const withLineNumbers = await tool.execute({
      pattern: "needle",
      path: target,
      output_mode: "content",
      "-n": true,
    });
    expect(withLineNumbers.isError).toBeUndefined();
    expect(withLineNumbers.content).toBe("nested/single.txt:2:needle");

    const withoutLineNumbers = await tool.execute({
      pattern: "needle",
      path: target,
      output_mode: "content",
      "-n": false,
    });
    expect(withoutLineNumbers.isError).toBeUndefined();
    expect(withoutLineNumbers.content).toBe("nested/single.txt:needle");
  });

  test("pinned ripgrep searches files beyond the removed fallback ceiling", async () => {
    await writeFile(
      join(root, "huge.txt"),
      `${"x".repeat(2 * 1024 * 1024 + 1)}needle\n`,
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("huge.txt");
    expect(result.content).toContain("line truncated at 500 chars");
  });

  test("pinned ripgrep never follows in-tree symlinks", async () => {
    await mkdir(join(root, "store"), { recursive: true });
    const realTarget = join(root, "store", "target.txt");
    await writeFile(realTarget, "inside-secret\n", "utf8");
    await symlink(realTarget, join(root, "link.txt"));
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "inside-secret",
      path: root,
      glob: "link.txt",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No files found.");
  });

  test("pinned ripgrep does not duplicate content through symlink aliases", async () => {
    await mkdir(join(root, "store"), { recursive: true });
    const realTarget = join(root, "store", "target.txt");
    await writeFile(realTarget, "shared-secret\n", "utf8");
    await symlink(realTarget, join(root, "link-a.txt"));
    await symlink(realTarget, join(root, "link-b.txt"));
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "shared-secret",
      path: root,
      glob: "link-*.txt",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No files found.");
  });

  test("files_with_matches keeps newest matches when truncating", async () => {
    const oldFile = join(root, "old.txt");
    const midFile = join(root, "mid.txt");
    const staleFile = join(root, "stale.txt");
    const newFile = join(root, "new.txt");
    await writeFile(oldFile, "needle\n", "utf8");
    await writeFile(midFile, "needle\n", "utf8");
    await writeFile(staleFile, "needle\n", "utf8");
    await writeFile(newFile, "needle\n", "utf8");
    const now = Date.now() / 1000;
    await utimes(oldFile, now - 300, now - 300);
    await utimes(midFile, now - 100, now - 100);
    await utimes(staleFile, now - 200, now - 200);
    await utimes(newFile, now, now);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
      head_limit: 2,
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual([
      "Found 2 files (results truncated at 2; refine query)",
      "new.txt",
      "mid.txt",
    ]);
  });

  test("files_with_matches has no JavaScript fallback file cap", async () => {
    for (let i = 0; i < 5001; i += 1) {
      await writeFile(join(root, `miss-${i}.txt`), "haystack\n", "utf8");
    }
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No files found.");
  });

  test("pinned ripgrep treats anchored patterns as line matches", async () => {
    await writeFile(
      join(root, "anchored.txt"),
      "alpha\nneedle\nomega\n",
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "^needle$",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(["Found 1 file", "anchored.txt"]);
  });

  test("relativizes Windows-style paths", () => {
    expect(
      __INTERNAL.toRelativeIfInside("C:\\repo\\src\\file.txt", "C:\\repo"),
    ).toBe("src\\file.txt");
  });

  test("structured content keeps colon filenames unambiguous", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    const target = join(root, "src", "a:b.txt");
    await writeFile(target, "needle\n", "utf8");

    const result = await createGrepTool({ allowedPaths: [root] }).execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("src/a:b.txt:1:needle");
  });

  test("all-whitespace patterns are passed to ripgrep without trimming", async () => {
    await writeFile(join(root, "space.txt"), "left   right\n", "utf8");

    const result = await createGrepTool({ allowedPaths: [root] }).execute({
      pattern: "   ",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("space.txt:1:left   right");
  });

  test("pinned ripgrep rejects symlinks that point outside allowed paths", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-grep-other-"));
    try {
      const secret = join(otherRoot, "secret.txt");
      await writeFile(secret, "outside-secret\n", "utf8");
      await symlink(secret, join(root, "leak.txt"));
      const tool = createGrepTool({ allowedPaths: [root] });

      const result = await tool.execute({
        pattern: "outside-secret",
        path: root,
        glob: "leak.txt",
        output_mode: "content",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("No matches found.");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("invalid regex is reported by pinned ripgrep without blocking the event loop", async () => {
    await writeFile(join(root, "hostile.txt"), `${"a".repeat(64)}!\n`, "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });
    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats += 1;
    }, 5);
    const startedAt = Date.now();
    try {
      const adversarial = await tool.execute({
        pattern: "(a+)+$",
        path: root,
        output_mode: "content",
      });
      expect(adversarial.isError).toBeUndefined();
      expect(adversarial.content).toBe("No matches found.");

      const invalid = await tool.execute({
        pattern: "(",
        path: root,
        output_mode: "content",
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toContain("regex parse error");
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(heartbeats).toBeGreaterThan(0);
  });

  test("preserves leading/trailing whitespace, Unicode, and zero-width patterns", async () => {
    await writeFile(
      join(root, "patterns.txt"),
      "left needle right\nλ-value\nfinal\n",
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const padded = await tool.execute({
      pattern: " needle ",
      path: root,
      output_mode: "content",
    });
    expect(padded.content).toContain("left needle right");

    const unicode = await tool.execute({
      pattern: "λ-value",
      path: root,
      output_mode: "content",
    });
    expect(unicode.content).toContain("λ-value");

    const zeroWidth = await tool.execute({
      pattern: "^",
      path: join(root, "patterns.txt"),
      output_mode: "content",
      head_limit: 1,
    });
    expect(zeroWidth.isError).toBeUndefined();
    expect(zeroWidth.content).toContain("patterns.txt:1:left needle right");
  });

  test("delegates positive, negated, negative-only, and separator glob semantics", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "keep.ts"), "needle\n", "utf8");
    await writeFile(join(root, "skip.ts"), "needle\n", "utf8");
    await writeFile(join(root, "skip.js"), "needle\n", "utf8");
    await writeFile(join(root, "src", "a.ts"), "needle\n", "utf8");
    await writeFile(join(root, "!important.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const combined = await tool.execute({
      pattern: "needle",
      path: root,
      glob: "*.ts,!skip.ts",
      output_mode: "files_with_matches",
    });
    expect(fileResultPaths(combined.content).sort()).toEqual([
      "keep.ts",
      "src/a.ts",
    ]);

    const negativeOnly = await tool.execute({
      pattern: "needle",
      path: root,
      glob: "!*.js",
      output_mode: "files_with_matches",
    });
    expect(fileResultPaths(negativeOnly.content)).not.toContain("skip.js");

    const separator = await tool.execute({
      pattern: "needle",
      path: root,
      glob: "src?.ts",
      output_mode: "files_with_matches",
    });
    expect(separator.content).toBe("No files found.");

    const literalBang = await tool.execute({
      pattern: "needle",
      path: root,
      glob: "\\!important.txt",
      output_mode: "files_with_matches",
    });
    expect(fileResultPaths(literalBang.content)).toEqual(["!important.txt"]);
  });

  test("escapes raw filename bytes consistently in every output mode", async () => {
    if (process.platform !== "linux") return;
    const rawPath = Buffer.concat([
      Buffer.from(`${root}/raw-`, "utf8"),
      Buffer.from([0xff]),
      Buffer.from(".txt", "utf8"),
    ]);
    await writeFile(rawPath, "needle\nneedle\n", { mode: 0o600 });
    const tool = createGrepTool({ allowedPaths: [root] });

    for (const outputMode of [
      "content",
      "files_with_matches",
      "count",
    ] as const) {
      const result = await tool.execute({
        pattern: "needle",
        path: root,
        output_mode: outputMode,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("raw-\\xff.txt [path-encoding=bytes]");
    }
  });

  test("keeps control-byte and long filenames unambiguous in every mode", async () => {
    if (process.platform === "win32") return;
    const names = [
      "colon:name.txt",
      "line\nname.txt",
      "tab\tname.txt",
      `control-${String.fromCharCode(1)}.txt`,
      `${"long-".repeat(40)}name.txt`,
    ];
    for (const name of names) {
      await writeFile(join(root, name), "needle\nneedle\n", "utf8");
    }
    const tool = createGrepTool({ allowedPaths: [root] });

    for (const outputMode of [
      "content",
      "files_with_matches",
      "count",
    ] as const) {
      const result = await tool.execute({
        pattern: "needle",
        path: root,
        output_mode: outputMode,
        head_limit: 0,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("colon:name.txt");
      expect(result.content).toContain("line\\nname.txt");
      expect(result.content).toContain("tab\\tname.txt");
      expect(result.content).toContain("control-\\x01.txt");
      expect(result.content).toContain(`${"long-".repeat(40)}name.txt`);
    }
  });

  test("preserves leading UTF-8 BOM data in filenames", async () => {
    const name = "\ufeffbom-name.txt";
    await writeFile(join(root, name), "\ufeffneedle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    for (const outputMode of [
      "content",
      "files_with_matches",
      "count",
    ] as const) {
      const result = await tool.execute({
        pattern: "needle",
        path: root,
        output_mode: outputMode,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain(name);
    }
  });

  test("rejects portable input limits and invalid encoding before path lookup", async () => {
    const missingPath = join(root, "does-not-exist");
    const tool = createGrepTool({ allowedPaths: [root] });
    const cases: Array<readonly [Record<string, unknown>, string]> = [
      [
        { pattern: "a".repeat(65_537), path: missingPath },
        "pattern is 65537 UTF-8 bytes",
      ],
      [{ pattern: "a\0b", path: missingPath }, "ARGUMENT_NUL"],
      [{ pattern: "\ud800", path: missingPath }, "ARGUMENT_LONE_SURROGATE"],
      [{ pattern: "x", path: "a".repeat(16_385) }, "path is 16385 UTF-8 bytes"],
      [
        { pattern: "x", path: missingPath, glob: "a".repeat(65_537) },
        "glob is 65537 UTF-8 bytes",
      ],
      [
        { pattern: "x", path: missingPath, type: "a".repeat(257) },
        "type is 257 UTF-8 bytes",
      ],
      [
        { pattern: "x", path: missingPath, "-C": 10_001 },
        "-C exceeds the maximum 10000",
      ],
      [
        { pattern: "x", path: missingPath, head_limit: 100_001 },
        "head_limit exceeds the maximum 100000",
      ],
      [
        { pattern: "x", path: missingPath, offset: 1_000_001 },
        "offset exceeds the maximum 1000000",
      ],
    ];

    for (const [input, expected] of cases) {
      const result = await tool.execute(input);
      expect(result.isError).toBe(true);
      expect(result.content).toContain(expected);
      expect(result.content).not.toContain("Path does not exist");
    }
  });

  test("missing pattern returns a plain-text error", async () => {
    const tool = createGrepTool({ allowedPaths: [root] });
    const result = await tool.execute({ path: root });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("pattern must be a non-empty string");
  });

  test("recurses into nested directories", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested/deep.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(
      fileResultPaths(result.content).some((line) => line.endsWith("deep.txt")),
    ).toBe(true);
  });

  test("directory targets keep paths relative to the allowed root", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/file.ts"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: join(root, "src"),
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(["Found 1 file", "src/file.ts"]);
  });

  // Regression: a `path` pointing at a single FILE (not a directory) must be
  // accepted and return that file's matches. ripgrep takes a file argument
  // directly; the tool resolves a file target's searchRoot to its parent and
  // hands rg the absolute file path. Previously an agent could not grep a
  // single file (e.g. {"pattern":"IO_NUMBER","path":"src/syntax/lexer.c"}) and
  // had to re-Read whole files instead.
  test("ripgrep path=<single file> returns matching content lines", async () => {
    await mkdir(join(root, "src", "syntax"), { recursive: true });
    const target = join(root, "src", "syntax", "lexer.c");
    await writeFile(
      target,
      "line one\nIO_NUMBER here\nIO_NUMBER again\nline four\n",
      "utf8",
    );
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "IO_NUMBER",
      path: target,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual([
      "src/syntax/lexer.c:2:IO_NUMBER here",
      "src/syntax/lexer.c:3:IO_NUMBER again",
    ]);
  });

  test("ripgrep path=<single file> works in default files_with_matches mode", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    const target = join(root, "src", "lexer.c");
    await writeFile(target, "alpha\nIO_NUMBER\nomega\n", "utf8");
    // A sibling that also matches must NOT appear: the file target scopes
    // the search to exactly one file.
    await writeFile(join(root, "src", "other.c"), "IO_NUMBER\n", "utf8");
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "IO_NUMBER",
      path: target,
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(["Found 1 file", "src/lexer.c"]);
  });

  test("ripgrep path=<single file> works in count mode", async () => {
    const target = join(root, "lexer.c");
    await writeFile(target, "IO_NUMBER\nx\nIO_NUMBER\n", "utf8");
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "IO_NUMBER",
      path: target,
      output_mode: "count",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("lexer.c:2");
    expect(result.content).toContain("2 total occurrences");
  });

  test("ripgrep accepts a RELATIVE single-file path resolved against the allowed root, not cwd", async () => {
    await mkdir(join(root, "src", "syntax"), { recursive: true });
    const target = join(root, "src", "syntax", "lexer.c");
    await writeFile(target, "line one\nIO_NUMBER here\n", "utf8");
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    // Run from a cwd that is NOT the allowed root. The relative path must be
    // resolved against `root`, not `process.cwd()`. Use the OS temp dir
    // (outside `root`) as cwd so resolving against cwd would be denied.
    const prevCwd = process.cwd();
    process.chdir(tmpdir());
    try {
      const result = await tool.execute({
        pattern: "IO_NUMBER",
        path: "src/syntax/lexer.c",
        output_mode: "content",
      });
      expect(result.isError).toBeUndefined();
      expect(lines(result.content)).toEqual([
        "src/syntax/lexer.c:2:IO_NUMBER here",
      ]);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("an added memory root does not change a relative path's execution cwd", async () => {
    const memory = join(root, "memory");
    const worktree = join(root, "worktree");
    await mkdir(memory);
    await mkdir(worktree);
    await writeFile(join(worktree, "worktree-only.txt"), "worktree-only-token\n");
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [memory, worktree] });
    const result = await tool.execute({
      pattern: "worktree-only-token", path: "worktree-only.txt", cwd: worktree,
    });
    expect(result.isError, result.content).not.toBe(true);
    expect(result.content).toContain("worktree-only.txt");
  });

  test("relative single-file path with ZERO matches is not an error", async () => {
    await mkdir(join(root, "src", "syntax"), { recursive: true });
    const target = join(root, "src", "syntax", "empty.c");
    await writeFile(target, "line one\nline two\n", "utf8");
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    const prevCwd = process.cwd();
    process.chdir(tmpdir());
    try {
      const result = await tool.execute({
        pattern: "IO_NUMBER",
        path: "src/syntax/empty.c",
        output_mode: "content",
      });
      expect(result.isError).toBeFalsy();
    } finally {
      process.chdir(prevCwd);
    }
  });

});
