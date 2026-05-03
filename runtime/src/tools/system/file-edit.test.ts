/**
 * Tests for the AgenC `Edit` and `MultiEdit` tools.
 *
 * Coverage:
 *   - successful edit on a previously-read file
 *   - read-before-write rejection
 *   - modification-since-read rejection
 *   - multi-match rejection when replace_all=false
 *   - multi-match success when replace_all=true
 *   - old_string === new_string rejection
 *   - empty old_string + nonexistent file → file creation
 *   - empty old_string + nonempty file rejection
 *   - smart-quote / curly-quote normalization (findActualString)
 *   - path safety: rejects paths outside allowedPaths
 *   - plain-text errors (no JSON wrap)
 */

import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createFileEditTool,
  createFileMultiEditTool,
  FILE_EDIT_TOOL_NAME,
  FILE_MULTI_EDIT_TOOL_NAME,
  findActualString,
} from "./file-edit.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  recordSessionRead,
  SESSION_AGENC_HOME_ARG,
  SESSION_ID_ARG,
} from "./filesystem.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  setPlanSlug,
} from "../../planning/plan-files.js";

const SESSION_ID = "edit-tool-test-session";

describe("Edit tool", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-file-edit-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
    clearSessionReadState(SESSION_ID);
    clearAllPlanSlugs();
  });

  test("exposes the AgenC tool name", () => {
    expect(FILE_EDIT_TOOL_NAME).toBe("Edit");
    const tool = createFileEditTool({ allowedPaths: [root] });
    expect(tool.name).toBe("Edit");
    expect(tool.metadata?.mutating).toBe(true);
  });

  test("exposes the AgenC multi-edit tool name", () => {
    expect(FILE_MULTI_EDIT_TOOL_NAME).toBe("MultiEdit");
    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    expect(tool.name).toBe("MultiEdit");
    expect(tool.metadata?.mutating).toBe(true);
    expect(tool.requiresApproval).toBe(true);
    expect(tool.inputSchema).toMatchObject({
      properties: {
        edits: {
          type: "array",
          minItems: 1,
        },
      },
      required: ["file_path", "edits"],
    });
  });

  test("successful edit on a previously-read file", async () => {
    const file = join(root, "hello.txt");
    await writeFile(file, "hello world\n", "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "hello world\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "hello",
      new_string: "goodbye",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("has been updated successfully");
    expect(result.metadata).toMatchObject({
      ui: {
        kind: "file_mutation",
        filePath: file,
        operation: "edit",
        additions: 1,
        removals: 1,
        replacements: 1,
      },
    });
    await expect(readFile(file, "utf8")).resolves.toBe("goodbye world\n");
    // Post-write snapshot refresh: rawContent and timestamp now reflect
    // the on-disk state so the changed-files attachment producer does
    // not fire a spurious diff for the edit we just made.
    const refreshed = getSessionReadSnapshot(SESSION_ID, file);
    expect(refreshed?.rawContent).toBe("goodbye world\n");
    expect(refreshed?.content).toBe("goodbye world\n");
    expect(refreshed?.viewKind).toBe("full");
  });

  test("edits the active session plan file outside the workspace root", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-plan-edit-home-"));
    try {
      setPlanSlug({ agencHome, sessionId: SESSION_ID }, "ivory-bridge-aaed0227");
      const planPath = getPlanFilePath({ agencHome, sessionId: SESSION_ID });
      const original = "# Plan\n\n- [ ] Verify allowlist\n";
      await writeFile(planPath, original, "utf8");
      const fileStats = await stat(planPath);
      recordSessionRead(SESSION_ID, planPath, {
        content: original,
        timestamp: fileStats.mtimeMs,
        viewKind: "full",
      });
      const tool = createFileEditTool({ allowedPaths: [root] });

      const result = await tool.execute({
        file_path: planPath,
        old_string: "Verify allowlist",
        new_string: "Verify plan edits",
        [SESSION_ID_ARG]: SESSION_ID,
        [SESSION_AGENC_HOME_ARG]: agencHome,
      });

      expect(result.isError).toBeUndefined();
      await expect(readFile(planPath, "utf8")).resolves.toContain(
        "Verify plan edits",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  test("rejects edit when the file was not read in this session", async () => {
    const file = join(root, "unread.txt");
    await writeFile(file, "stuff\n", "utf8");
    // intentionally do NOT record a session read

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "stuff",
      new_string: "things",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    // Plain text — no JSON envelope.
    expect(result.content).toBe(
      "File has not been read yet. Read it first before writing to it.",
    );
    expect(() => JSON.parse(result.content)).toThrow();
  });

  test("rejects edit when the file was modified since read", async () => {
    const file = join(root, "stale.txt");
    await writeFile(file, "v1\n", "utf8");
    const initial = await stat(file);
    // Record the read AT the original mtime, with the old content.
    recordSessionRead(SESSION_ID, file, {
      content: "v1\n",
      timestamp: initial.mtimeMs,
      viewKind: "full",
    });
    // Simulate an external mutation: bump mtime AND change content.
    await writeFile(file, "v2\n", "utf8");
    const newStats = await stat(file);
    // Force a definitively newer mtime so the comparison is unambiguous
    // even on filesystems with low mtime resolution.
    await utimes(file, newStats.atime, new Date(initial.mtimeMs + 5_000));

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "v2",
      new_string: "v3",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
  });

  test("edit staleness check compares rawContent when read content is rendered", async () => {
    const file = join(root, "rendered-read.txt");
    await writeFile(file, "v1\n", "utf8");
    const initial = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "rendered view that is not raw disk content",
      rawContent: "v1\n",
      timestamp: initial.mtimeMs,
      viewKind: "full",
    });
    await utimes(file, initial.atime, new Date(initial.mtimeMs + 5_000));

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "v1",
      new_string: "v2",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("v2\n");
  });

  test("rejects multi-match edit when replace_all is false", async () => {
    const file = join(root, "many.txt");
    await writeFile(file, "foo\nbar\nfoo\n", "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "foo\nbar\nfoo\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "foo",
      new_string: "qux",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "matches of the string to replace, but replace_all is false",
    );
    // File untouched.
    await expect(readFile(file, "utf8")).resolves.toBe("foo\nbar\nfoo\n");
  });

  test("multi-match success when replace_all is true", async () => {
    const file = join(root, "many.txt");
    await writeFile(file, "foo\nbar\nfoo\n", "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "foo\nbar\nfoo\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "foo",
      new_string: "qux",
      replace_all: true,
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("All occurrences were successfully replaced");
    expect(result.metadata).toMatchObject({
      ui: {
        kind: "file_mutation",
        filePath: file,
        operation: "edit",
        additions: 2,
        removals: 2,
        replacements: 2,
      },
    });
    await expect(readFile(file, "utf8")).resolves.toBe("qux\nbar\nqux\n");
  });

  test("rejects no-op edit (old_string === new_string)", async () => {
    const file = join(root, "noop.txt");
    await writeFile(file, "abc\n", "utf8");
    // Don't bother recording a read — the no-op check fires before
    // the read-gate.

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "abc",
      new_string: "abc",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "No changes to make: old_string and new_string are exactly the same.",
    );
  });

  test("empty old_string on a nonexistent file creates the file", async () => {
    const file = join(root, "subdir/created.txt");
    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "",
      new_string: "fresh content\n",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Created file");
    await expect(readFile(file, "utf8")).resolves.toBe("fresh content\n");
  });

  test("empty old_string on an existing nonempty file is rejected", async () => {
    const file = join(root, "existing.txt");
    await writeFile(file, "already here\n", "utf8");
    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "",
      new_string: "would clobber\n",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Cannot create new file - file already exists.");
    // Untouched.
    await expect(readFile(file, "utf8")).resolves.toBe("already here\n");
  });

  test("smart-quote normalization matches ASCII quotes against curly quotes", async () => {
    // File contains curly double quote; old_string uses straight quotes.
    const file = join(root, "smart.md");
    const fileContent = "He said “hello” to her\n"; // “hello”
    await writeFile(file, fileContent, "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: fileContent,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: 'said "hello" to her',
      new_string: 'whispered "goodbye" to her',
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    const after = await readFile(file, "utf8");
    expect(after).toBe("He whispered \"goodbye\" to her\n");
  });

  test("findActualString returns null for unrelated text", () => {
    expect(findActualString("alpha beta", "gamma")).toBeNull();
    expect(findActualString("alpha beta", "alpha")).toBe("alpha");
    // Curly quote in file, ASCII in search.
    expect(findActualString("a‘b’c", "a'b'c")).toBe("a‘b’c");
  });

  test("rejects paths outside allowedPaths", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agenc-file-edit-outside-"));
    try {
      const file = join(outside, "blocked.txt");
      await writeFile(file, "blocked\n", "utf8");
      const tool = createFileEditTool({ allowedPaths: [root] });

      const result = await tool.execute({
        file_path: file,
        old_string: "blocked",
        new_string: "unblocked",
        [SESSION_ID_ARG]: SESSION_ID,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/^Access denied/);
      await expect(readFile(file, "utf8")).resolves.toBe("blocked\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects .ipynb files with a notebook hint", async () => {
    const file = join(root, "data.ipynb");
    await writeFile(file, "{}\n", "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "{}\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "{}",
      new_string: '{"a":1}',
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Jupyter Notebook");
    expect(result.content).toContain("notebook-specific tool");
  });

  test("validates required string args", async () => {
    const tool = createFileEditTool({ allowedPaths: [root] });
    await expect(
      tool.execute({
        old_string: "x",
        new_string: "y",
        [SESSION_ID_ARG]: SESSION_ID,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: "file_path must be a non-empty string",
    });
    await expect(
      tool.execute({
        file_path: join(root, "x.txt"),
        old_string: 42,
        new_string: "y",
        [SESSION_ID_ARG]: SESSION_ID,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: "old_string must be a string",
    });
    await expect(
      tool.execute({
        file_path: join(root, "x.txt"),
        old_string: "x",
        new_string: 42,
        [SESSION_ID_ARG]: SESSION_ID,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: "new_string must be a string",
    });
  });

  test("plain-text errors are not JSON-wrapped", async () => {
    const file = join(root, "plain.txt");
    await writeFile(file, "plain\n", "utf8");
    const tool = createFileEditTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      old_string: "plain",
      new_string: "fancy",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(() => JSON.parse(result.content)).toThrow();
  });

  test("read-gate is skipped when no sessionId is injected (headless path)", async () => {
    const file = join(root, "headless.txt");
    await writeFile(file, "hi\n", "utf8");
    const tool = createFileEditTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      old_string: "hi",
      new_string: "yo",
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("yo\n");
  });

  test("workspace-relative file_path resolves against allowed root", async () => {
    const file = join(root, "rel.txt");
    await writeFile(file, "rel-before\n", "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "rel-before\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: "rel.txt",
      old_string: "rel-before",
      new_string: "rel-after",
      cwd: root,
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("rel-after\n");
  });

  test("MultiEdit applies ordered edits against the in-memory result", async () => {
    const file = join(root, "ordered.txt");
    await writeFile(file, "one two\n", "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "one two\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      edits: [
        { old_string: "one", new_string: "three" },
        { old_string: "three two", new_string: "done" },
      ],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("2 edits applied");
    expect(result.metadata).toMatchObject({
      ui: {
        kind: "file_mutation",
        filePath: file,
        operation: "edit",
        replacements: 2,
      },
    });
    await expect(readFile(file, "utf8")).resolves.toBe("done\n");
    expect(getSessionReadSnapshot(SESSION_ID, file)?.content).toBe("done\n");
  });

  test("MultiEdit leaves the file untouched when a later edit fails", async () => {
    const file = join(root, "atomic.txt");
    const original = "alpha beta gamma\n";
    await writeFile(file, original, "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: original,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      edits: [
        { old_string: "alpha", new_string: "omega" },
        { old_string: "missing", new_string: "value" },
      ],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Edit 2 failed");
    await expect(readFile(file, "utf8")).resolves.toBe(original);
  });

  test("MultiEdit supports replace_all per edit", async () => {
    const file = join(root, "replace-all.txt");
    await writeFile(file, "foo bar foo\n", "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "foo bar foo\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      edits: [
        { old_string: "foo", new_string: "qux", replace_all: true },
        { old_string: "bar", new_string: "baz" },
      ],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("3 replacements");
    expect(result.metadata).toMatchObject({
      ui: {
        replacements: 3,
      },
    });
    await expect(readFile(file, "utf8")).resolves.toBe("qux baz qux\n");
  });

  test("MultiEdit rejects unread files in sessions", async () => {
    const file = join(root, "unread-multi.txt");
    await writeFile(file, "before\n", "utf8");
    const tool = createFileMultiEditTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: file,
      edits: [{ old_string: "before", new_string: "after" }],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "File has not been read yet. Read it first before writing to it.",
    );
    await expect(readFile(file, "utf8")).resolves.toBe("before\n");
  });

  test("MultiEdit rejects files modified since read", async () => {
    const file = join(root, "stale-multi.txt");
    await writeFile(file, "v1\n", "utf8");
    const initial = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "v1\n",
      timestamp: initial.mtimeMs,
      viewKind: "full",
    });
    await writeFile(file, "v2\n", "utf8");
    const newStats = await stat(file);
    await utimes(file, newStats.atime, new Date(initial.mtimeMs + 5_000));

    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      edits: [{ old_string: "v2", new_string: "v3" }],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
    await expect(readFile(file, "utf8")).resolves.toBe("v2\n");
  });

  test("MultiEdit validates edit arrays", async () => {
    const tool = createFileMultiEditTool({ allowedPaths: [root] });

    await expect(
      tool.execute({
        file_path: join(root, "bad.txt"),
        edits: [],
        [SESSION_ID_ARG]: SESSION_ID,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: "edits must be a non-empty array",
    });

    await expect(
      tool.execute({
        file_path: join(root, "bad.txt"),
        edits: [{ old_string: "x", new_string: "x" }],
        [SESSION_ID_ARG]: SESSION_ID,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content:
        "No changes to make: edits[0].old_string and edits[0].new_string are exactly the same.",
    });
  });
});
