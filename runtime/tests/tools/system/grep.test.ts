import {
  access,
  chmod,
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

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __INTERNAL,
  __resetRipgrepProbeForTests,
  __setRipgrepAvailabilityForTests,
  createGrepTool as createUnboundGrepTool,
  GREP_TOOL_NAME,
} from "./grep.js";
import {
  sha256,
  workspaceMutationCoordinators,
  type WorkspaceEditorLease,
  type WorkspaceMutationCoordinator,
} from "../../../src/workspace/mutation-coordinator.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { attachToolRuntimeContext } from "../../../src/tools/runtimes/context.js";

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

function attachTrustedEditorContext(args: Record<string, unknown>): void {
  attachToolRuntimeContext(args, {
    callId: "trusted-editor-grep",
    toolName: GREP_TOOL_NAME,
    sandboxMode: "read_only",
    invocation: {
      turn: {
        editorInteraction: {
          interactionId: "trusted-editor-grep",
          policy: "read_only",
        },
      },
    },
  } as never);
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
    workspaceMutationCoordinators.clearForTests();
    __resetRipgrepProbeForTests();
  });

  afterEach(async () => {
    workspaceMutationCoordinators.clearForTests();
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
        "context",
        "-n",
        "-i",
        "type",
        "head_limit",
        "offset",
        "multiline",
      ]),
    );
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
    workspaceMutationCoordinators.getOrCreate(workspace).acquire({
      workspaceRoot: workspace,
      editorInstanceId: "grep-confinement-editor",
    });
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

  test("keeps trusted Editor searches bound after the live lease disappears", async () => {
    const workspace = join(root, "workspace");
    const displaced = join(root, "workspace-displaced");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(
      join(workspace, "inside.ts"),
      "const trustedNeedle = 'inside-trusted-grep';\n",
      "utf8",
    );
    await writeFile(
      join(outside, "outside.ts"),
      "const trustedNeedle = 'outside-trusted-grep-secret';\n",
      "utf8",
    );
    workspaceMutationCoordinators.getOrCreate(workspace).acquire({
      workspaceRoot: workspace,
      editorInstanceId: "expired-grep-editor",
    });
    workspaceMutationCoordinators.clearForTests();
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
    const args: Record<string, unknown> = {
      pattern: "trustedNeedle",
      path: workspace,
      output_mode: "content",
    };
    attachTrustedEditorContext(args);

    const result = await tool.execute(args);

    expectCompletedExchangeAttempt(exchangeOutcome);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("inside-trusted-grep");
    expect(result.content).not.toContain("outside-trusted-grep-secret");
    expect(result.content).not.toContain("outside.ts");
  });

  test("protected content search preserves head-limit termination as truncation", async () => {
    await writeFile(
      join(root, "many.txt"),
      Array.from({ length: 20 }, (_, index) => `needle-${index}`).join("\n"),
      "utf8",
    );
    workspaceMutationCoordinators.getOrCreate(root).acquire({
      workspaceRoot: root,
      editorInstanceId: "grep-head-limit-editor",
    });
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
      head_limit: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("needle-");
    expect(result.content).toContain("results truncated");
  });

  test("ignores RIPGREP_CONFIG_PATH preprocessors", async () => {
    const marker = join(root, "preprocessor-ran");
    const preprocessor = join(root, "hostile-preprocessor");
    const config = join(root, "ripgrep.conf");
    await writeFile(
      preprocessor,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ncat "$1"\n`,
      "utf8",
    );
    await chmod(preprocessor, 0o755);
    await writeFile(config, `--pre=${preprocessor}\n`, "utf8");
    await writeFile(join(root, "target.txt"), "needle\n", "utf8");
    const savedConfig = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = config;
    const tool = createGrepTool({ allowedPaths: [root] });

    try {
      const result = await tool.execute({
        pattern: "needle",
        path: root,
        output_mode: "content",
      });

      expect(result.isError).toBeUndefined();
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (savedConfig === undefined) {
        delete process.env.RIPGREP_CONFIG_PATH;
      } else {
        process.env.RIPGREP_CONFIG_PATH = savedConfig;
      }
    }
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

  test("head_limit truncates broad ripgrep output before buffer exhaustion", async () => {
    const line = `needle ${"x".repeat(360)}`;
    const body = Array.from({ length: 35_000 }, (_, i) => `${line} ${i}`).join(
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

  test("head_limit=0 returns unlimited content without truncation note", async () => {
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

  test("fallback glob filter supports brace alternatives", async () => {
    await writeFile(join(root, "keep.ts"), "needle\n", "utf8");
    await writeFile(join(root, "also.tsx"), "needle\n", "utf8");
    await writeFile(join(root, "skip.js"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
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

  test("fallback glob matcher normalizes Windows-style separators", () => {
    const matchesGlob = __INTERNAL.compileGlobMatcher(["src/*.ts"]);

    expect(matchesGlob("src\\keep.ts")).toBe(true);
    expect(matchesGlob("src\\skip.js")).toBe(false);
  });

  test("fallback files_with_matches honors root ignore files", async () => {
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "needle\n", "utf8");
    await writeFile(join(root, "visible.txt"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
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

  test("fallback files_with_matches honors nested ignore files", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/.ignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "src/ignored.txt"), "needle\n", "utf8");
    await writeFile(join(root, "src/visible.txt"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
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

  test("fallback files_with_matches honors rgignore files", async () => {
    await writeFile(join(root, ".rgignore"), "rg-hidden.txt\n", "utf8");
    await writeFile(join(root, "rg-hidden.txt"), "needle\n", "utf8");
    await writeFile(join(root, "visible.txt"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
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

  test("fallback nested ignore negation can reinclude parent ignores", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "src/*.txt\n", "utf8");
    await writeFile(join(root, "src/.ignore"), "!keep.txt\n", "utf8");
    await writeFile(join(root, "src/drop.txt"), "needle\n", "utf8");
    await writeFile(join(root, "src/keep.txt"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
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

  test("context aliases -C for surrounding content lines", async () => {
    await writeFile(
      join(root, "ctx-alias.txt"),
      ["before", "TARGET", "after"].join("\n"),
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "TARGET",
      path: root,
      output_mode: "content",
      context: 1,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("before");
    expect(result.content).toContain("TARGET");
    expect(result.content).toContain("after");
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

  test("fallback content mode honors the -n line-number flag", async () => {
    await writeFile(join(root, "a.txt"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
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

  test("fallback rejects count mode with an explicit unsupported error", async () => {
    await writeFile(join(root, "a.txt"), "needle\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "count",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("output_mode=count");
    expect(result.content).toContain("not supported by the fallback search");
  });

  test("fallback content mode preserves file context for single-file targets", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    const target = join(root, "nested", "single.txt");
    await writeFile(target, "alpha\nneedle\nomega\n", "utf8");
    __setRipgrepAvailabilityForTests(false);
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

  test("fallback search skips oversized files with an explicit safety note", async () => {
    await writeFile(
      join(root, "huge.txt"),
      `${"x".repeat(2 * 1024 * 1024 + 1)}needle\n`,
      "utf8",
    );
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "No matches found.\n(fallback scan stopped at safety limit; refine query)",
    );
  });

  test("fallback search follows in-tree symlinks after allowlist checks", async () => {
    await mkdir(join(root, "store"), { recursive: true });
    const realTarget = join(root, "store", "target.txt");
    await writeFile(realTarget, "inside-secret\n", "utf8");
    await symlink(realTarget, join(root, "link.txt"));
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "inside-secret",
      path: root,
      glob: "link.txt",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(["Found 1 file", "link.txt"]);
  });

  test("fallback search preserves distinct symlink display paths", async () => {
    await mkdir(join(root, "store"), { recursive: true });
    const realTarget = join(root, "store", "target.txt");
    await writeFile(realTarget, "shared-secret\n", "utf8");
    await symlink(realTarget, join(root, "link-a.txt"));
    await symlink(realTarget, join(root, "link-b.txt"));
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "shared-secret",
      path: root,
      glob: "link-*.txt",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(fileResultPaths(result.content).sort()).toEqual([
      "link-a.txt",
      "link-b.txt",
    ]);
  });

  test("fallback files_with_matches keeps newest matches when truncating", async () => {
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
    __setRipgrepAvailabilityForTests(false);
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

  test("fallback files_with_matches reports the safety cap without matches", async () => {
    for (let i = 0; i < 5001; i += 1) {
      await writeFile(join(root, `miss-${i}.txt`), "haystack\n", "utf8");
    }
    __setRipgrepAvailabilityForTests(false);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "No files found.\n(fallback scan stopped at safety limit; refine query)",
    );
  });

  test("fallback files_with_matches treats anchored patterns as line matches", async () => {
    await writeFile(
      join(root, "anchored.txt"),
      "alpha\nneedle\nomega\n",
      "utf8",
    );
    __setRipgrepAvailabilityForTests(false);
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

  test("relativizes Unix ripgrep content lines with colon filenames", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    const target = join(root, "src", "a:b.txt");
    await writeFile(target, "needle\n", "utf8");

    expect(
      __INTERNAL.rewriteRipgrepContentLine(
        `${target}\u001f12\u001fneedle`,
        root,
      ),
    ).toBe("src/a:b.txt:12:needle");
  });

  test("relativizes Unix ripgrep content lines for missing files", () => {
    const missing = join(root, "gone.txt");

    expect(
      __INTERNAL.rewriteRipgrepContentLine(
        `${missing}\u001f12\u001fneedle`,
        root,
      ),
    ).toBe("gone.txt:12:needle");
  });

  test("fallback search rejects symlinks that point outside allowed paths", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-grep-other-"));
    try {
      const secret = join(otherRoot, "secret.txt");
      await writeFile(secret, "outside-secret\n", "utf8");
      await symlink(secret, join(root, "leak.txt"));
      __setRipgrepAvailabilityForTests(false);
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

  test("replaces stale disk matches with the exact unsaved Editor snapshot", async () => {
    const path = join(root, "src", "authoritative.ts");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(path, "const staleDiskNeedle = true;\n", "utf8");
    await establishDirtyEditorSnapshot({
      workspaceRoot: root,
      path,
      content: "const unsavedEditorNeedle = true;\n",
    });
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    const stale = await tool.execute({
      pattern: "staleDiskNeedle",
      output_mode: "content",
    });
    expect(stale.isError).toBeFalsy();
    expect(stale.content).toBe("No matches found.");

    const unsaved = await tool.execute({
      pattern: "unsavedEditorNeedle",
      output_mode: "content",
    });
    expect(unsaved.isError).toBeFalsy();
    expect(unsaved.content).toContain(
      "src/authoritative.ts:1:const unsavedEditorNeedle = true;",
    );
    expect(unsaved.content).not.toContain("staleDiskNeedle");
  });

  test("discovers a dirty-only named file through glob and ripgrep type filters", async () => {
    const path = join(root, "new", "nested", "unsaved-only.ts");
    await establishDirtyEditorSnapshot({
      workspaceRoot: root,
      path,
      content: "export const dirtyOnlyNeedle = 1;\n",
    });
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "dirtyOnlyNeedle",
      glob: "*.ts",
      type: "ts",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeFalsy();
    expect(lines(result.content)).toEqual([
      "Found 1 file",
      "new/nested/unsaved-only.ts",
    ]);

    const exact = await tool.execute({
      pattern: "dirtyOnlyNeedle",
      path: "new/nested/unsaved-only.ts",
      output_mode: "content",
    });
    expect(exact.isError).toBeFalsy();
    expect(exact.content).toContain(
      "new/nested/unsaved-only.ts:1:export const dirtyOnlyNeedle = 1;",
    );
  });

  test("preserves multiline, context, and count semantics over unsaved bytes", async () => {
    const path = join(root, "src", "multiline.ts");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(path, "disk-only-secret\n", "utf8");
    await establishDirtyEditorSnapshot({
      workspaceRoot: root,
      path,
      content: [
        "before-context",
        "beginNeedle",
        "middle",
        "endNeedle",
        "after-context",
        "countNeedle",
        "countNeedle",
        "",
      ].join("\n"),
    });
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({ allowedPaths: [root] });

    const content = await tool.execute({
      pattern: "beginNeedle.*endNeedle",
      output_mode: "content",
      multiline: true,
      "-C": 1,
    });
    expect(content.isError).toBeFalsy();
    expect(content.content).toContain("before-context");
    expect(content.content).toContain("beginNeedle");
    expect(content.content).toContain("middle");
    expect(content.content).toContain("endNeedle");
    expect(content.content).toContain("after-context");
    expect(content.content).not.toContain("disk-only-secret");

    const count = await tool.execute({
      pattern: "countNeedle",
      output_mode: "count",
    });
    expect(count.isError).toBeFalsy();
    expect(count.content).toContain("src/multiline.ts:2");
    expect(count.content).toContain("2 total occurrences");
  });

  test("fails closed instead of searching disk when Editor authority is stale", async () => {
    const path = join(root, "src", "stale.ts");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(path, "const staleDiskNeedle = true;\n", "utf8");
    const { coordinator, lease } = await establishDirtyEditorSnapshot({
      workspaceRoot: root,
      path,
      content: "const unsavedNeedle = true;\n",
    });
    await coordinator.release({
      workspaceRoot: root,
      editorInstanceId: lease.editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    });
    __setRipgrepAvailabilityForTests(true);

    const result = await createGrepTool({
      allowedPaths: [root],
    }).execute({
      pattern: "staleDiskNeedle",
      output_mode: "content",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(
      /authoritative Editor workspace|reconnect/iu,
    );
    expect(result.content).not.toContain("const staleDiskNeedle");
  });

  test("rejects all search output when the authoritative revision changes before return", async () => {
    const path = join(root, "src", "racing.ts");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(path, "const diskValue = 1;\n", "utf8");
    const { coordinator, lease } = await establishDirtyEditorSnapshot({
      workspaceRoot: root,
      path,
      content: "const firstRevisionNeedle = 1;\n",
    });
    let changed = false;
    __setRipgrepAvailabilityForTests(true);
    const tool = createGrepTool({
      allowedPaths: [root],
      beforeAuthoritativeSnapshotValidation: async () => {
        if (changed) return;
        changed = true;
        coordinator.sync({
          workspaceRoot: root,
          editorInstanceId: lease.editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
          sequence: 1,
          buffers: [
            {
              path,
              bufferHandle: 7,
              changedtick: 42,
              contentSha256: sha256("const secondRevisionNeedle = 2;\n"),
              dirty: true,
              content: "const secondRevisionNeedle = 2;\n",
            },
          ],
        });
        await coordinator.flushQuarantinePersistence();
      },
    });

    const result = await tool.execute({
      pattern: "firstRevisionNeedle",
      output_mode: "content",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(
      /changed while the search|synchronization/iu,
    );
    expect(result.content).not.toContain("firstRevisionNeedle = 1");
  });
});

async function establishDirtyEditorSnapshot({
  workspaceRoot,
  path,
  content,
}: {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly content: string;
}): Promise<{
  readonly coordinator: WorkspaceMutationCoordinator;
  readonly lease: WorkspaceEditorLease;
}> {
  const coordinator = workspaceMutationCoordinators.getOrCreate(workspaceRoot);
  const lease = coordinator.acquire({
    workspaceRoot,
    editorInstanceId: "grep-editor",
  });
  coordinator.sync({
    workspaceRoot,
    editorInstanceId: lease.editorInstanceId,
    leaseToken: lease.leaseToken,
    epoch: lease.epoch,
    sequence: 0,
    buffers: [
      {
        path,
        bufferHandle: 7,
        changedtick: 41,
        contentSha256: sha256(content),
        dirty: true,
        content,
      },
    ],
  });
  await coordinator.flushQuarantinePersistence();
  return { coordinator, lease };
}
