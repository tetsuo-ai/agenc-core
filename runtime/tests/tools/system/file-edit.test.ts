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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../services/lsp/fileNotifications.js", () => ({
  notifyLspFileChanged: vi.fn(),
}));

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
  SESSION_ID_SIG_ARG,
  signSessionId,
} from "./filesystem.js";
import { notifyLspFileChanged } from "../../services/lsp/fileNotifications.js";
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
    vi.mocked(notifyLspFileChanged).mockClear();
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

  test("rejects agent namespace paths with a workspace-relative hint", async () => {
    const edit = createFileEditTool({ allowedPaths: [root] });
    const editResult = await edit.execute({
      file_path: "/root/game.py",
      old_string: "alpha",
      new_string: "beta",
      cwd: root,
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(editResult.isError).toBe(true);
    expect(String(editResult.content)).toContain("agent namespace");
    expect(String(editResult.content)).toContain('"game.py"');

    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const multiResult = await multi.execute({
      file_path: "/root/game.py",
      edits: [{ old_string: "alpha", new_string: "beta" }],
      cwd: root,
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(multiResult.isError).toBe(true);
    expect(String(multiResult.content)).toContain("agent namespace");
    expect(String(multiResult.content)).toContain('"game.py"');
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
        [SESSION_ID_SIG_ARG]: signSessionId(SESSION_ID),
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
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "already here\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });
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

  test("empty old_string on an existing empty file requires a full read", async () => {
    const file = join(root, "empty-unread.txt");
    await writeFile(file, "", "utf8");

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "",
      new_string: "fresh\n",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "File has not been read yet. Read it first before writing to it.",
    );
    await expect(readFile(file, "utf8")).resolves.toBe("");
  });

  test("empty old_string rejects stale full reads before checking existing content", async () => {
    const file = join(root, "empty-stale.txt");
    await writeFile(file, "", "utf8");
    const initial = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "",
      timestamp: initial.mtimeMs,
      viewKind: "full",
    });
    await writeFile(file, "external\n", "utf8");
    const newer = await stat(file);
    await utimes(file, newer.atime, new Date(initial.mtimeMs + 5_000));

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "",
      new_string: "fresh\n",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
    await expect(readFile(file, "utf8")).resolves.toBe("external\n");
  });

  test("Edit and MultiEdit reject partial session reads", async () => {
    const editFile = join(root, "partial-edit.txt");
    const multiFile = join(root, "partial-multi.txt");
    await writeFile(editFile, "alpha beta\n", "utf8");
    await writeFile(multiFile, "alpha beta\n", "utf8");
    const editStats = await stat(editFile);
    const multiStats = await stat(multiFile);
    recordSessionRead(SESSION_ID, editFile, {
      content: "alpha\n",
      timestamp: editStats.mtimeMs,
      viewKind: "partial",
      readOffset: 1,
      readLimit: 1,
    });
    recordSessionRead(SESSION_ID, multiFile, {
      content: "alpha\n",
      timestamp: multiStats.mtimeMs,
      viewKind: "partial",
      readOffset: 1,
      readLimit: 1,
    });

    const editTool = createFileEditTool({ allowedPaths: [root] });
    const multiTool = createFileMultiEditTool({ allowedPaths: [root] });
    const editResult = await editTool.execute({
      file_path: editFile,
      old_string: "beta",
      new_string: "gamma",
      [SESSION_ID_ARG]: SESSION_ID,
    });
    const multiResult = await multiTool.execute({
      file_path: multiFile,
      edits: [{ old_string: "beta", new_string: "gamma" }],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(editResult.isError).toBe(true);
    expect(editResult.content).toBe(
      "File has not been read yet. Read it first before writing to it.",
    );
    expect(multiResult.isError).toBe(true);
    expect(multiResult.content).toBe(
      "File has not been read yet. Read it first before writing to it.",
    );
    await expect(readFile(editFile, "utf8")).resolves.toBe("alpha beta\n");
    await expect(readFile(multiFile, "utf8")).resolves.toBe("alpha beta\n");
  });

  test("smart-quote normalization preserves file quote style in replacements", async () => {
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
    expect(after).toBe("He whispered “goodbye” to her\n");
  });

  test("semantic no-op after quote preservation is rejected", async () => {
    const file = join(root, "smart-noop.md");
    const fileContent = "“x”\n";
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
      old_string: '"x"',
      new_string: "“x”",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "No changes to make: old_string and new_string are exactly the same.",
    );
    await expect(readFile(file, "utf8")).resolves.toBe(fileContent);
  });

  test("deleting line contents removes the trailing newline", async () => {
    const file = join(root, "delete-line.txt");
    const fileContent = "alpha\nbeta\ngamma\n";
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
      old_string: "beta",
      new_string: "",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\ngamma\n");
  });

  test("inline empty replacements remove the following newline", async () => {
    const file = join(root, "delete-inline.txt");
    const fileContent = "alpha beta\ngamma\n";
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
      old_string: "beta",
      new_string: "",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("alpha gamma\n");
  });

  test("replace_all empty replacement follows old_string newline semantics", async () => {
    const file = join(root, "delete-all-mixed.txt");
    const fileContent = "beta\nalpha beta\nbeta";
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
      old_string: "beta",
      new_string: "",
      replace_all: true,
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({
      ui: {
        replacements: 2,
      },
    });
    await expect(readFile(file, "utf8")).resolves.toBe("alpha beta");
  });

  test("replacement strings are applied literally", async () => {
    const file = join(root, "literal-replacement.txt");
    const fileContent = "value = foo\n";
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
      old_string: "foo",
      new_string: "$&bar",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("value = $&bar\n");
  });

  test("replace_all replacement strings are applied literally", async () => {
    const file = join(root, "literal-replace-all.txt");
    const fileContent = "foo foo\n";
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
      old_string: "foo",
      new_string: "$&bar",
      replace_all: true,
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("$&bar $&bar\n");
  });

  test("replace_all preserves quote style across normalized matches", async () => {
    const file = join(root, "smart-replace-all.md");
    const fileContent = "“one” and “one”\n";
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
      old_string: '"one"',
      new_string: '"two"',
      replace_all: true,
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("“two” and “two”\n");
  });

  test("ASCII dash matches stay literal when typographic dashes are present", async () => {
    const file = join(root, "mixed-dash-literal.md");
    const fileContent = "a-b\na—b\n";
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
      old_string: "a-b",
      new_string: "c-d",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("c-d\na—b\n");
  });

  test("replace_all does not edit dash or space typographic variants", async () => {
    const file = join(root, "mixed-literal-replace-all.md");
    const fileContent = "a-b a—b\nx y x y\n";
    await writeFile(file, fileContent, "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: fileContent,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      edits: [
        { old_string: "a-b", new_string: "c-d", replace_all: true },
        { old_string: "x y", new_string: "z y", replace_all: true },
      ],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.metadata).toMatchObject({
      ui: {
        replacements: 2,
      },
    });
    await expect(readFile(file, "utf8")).resolves.toBe("c-d a—b\nz y x y\n");
  });

  test("edits preserve CRLF line endings on disk", async () => {
    const file = join(root, "crlf.txt");
    const diskContent = "alpha\r\nbeta\r\n";
    await writeFile(file, diskContent, "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: "alpha\nbeta\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "beta",
      new_string: "gamma",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\r\ngamma\r\n");
  });

  test("edits preserve UTF-16LE encoding on disk", async () => {
    const file = join(root, "utf16.txt");
    const diskContent = "\ufeffalpha\nbeta\n";
    await writeFile(file, Buffer.from(diskContent, "utf16le"));

    const tool = createFileEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      old_string: "beta",
      new_string: "gamma",
      __testBypassSessionGuard: true,
    });

    expect(result.isError).toBeUndefined();
    const after = await readFile(file);
    expect(after[0]).toBe(0xff);
    expect(after[1]).toBe(0xfe);
    expect(after.toString("utf16le")).toBe("\ufeffalpha\ngamma\n");
  });

  test("findActualString returns null for unrelated text", () => {
    expect(findActualString("alpha beta", "gamma")).toBeNull();
    expect(findActualString("alpha beta", "alpha")).toBe("alpha");
    // Curly quote in file, ASCII in search.
    expect(findActualString("a‘b’c", "a'b'c")).toBe("a‘b’c");
    expect(findActualString("a—b", "a-b")).toBeNull();
    expect(findActualString("x y", "x y")).toBeNull();
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

  test("read-gate is skipped only when __testBypassSessionGuard is set", async () => {
    const file = join(root, "headless.txt");
    await writeFile(file, "hi\n", "utf8");
    const tool = createFileEditTool({ allowedPaths: [root] });

    // Without the bypass flag AND without SESSION_ID_ARG, the tool
    // must REFUSE the edit. Production callers always inject
    // SESSION_ID_ARG via canonicalToolSurface.mapCanonicalInput; the
    // previous silent-skip on undefined sessionId let any production
    // path that lost the session id slip past the read-before-write
    // safety. Failing loud is the safer default.
    const refused = await tool.execute({
      file_path: file,
      old_string: "hi",
      new_string: "yo",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("session id");
    await expect(readFile(file, "utf8")).resolves.toBe("hi\n");

    // With the bypass flag, the read-before-write check is skipped
    // and the edit applies — this is the explicit opt-out for unit
    // tests that don't fake a full session lifecycle.
    const allowed = await tool.execute({
      file_path: file,
      old_string: "hi",
      new_string: "yo",
      __testBypassSessionGuard: true,
    });
    expect(allowed.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("yo\n");
  });

  test("__testBypassSessionGuard is ignored outside NODE_ENV=test (defense in depth)", async () => {
    // The runtime's tool-call dispatch path does not enforce the
    // JSON schema's `additionalProperties: false`, so a malicious
    // model could include this arg key and reach tool.execute(args)
    // with the flag set. The bypass MUST be gated on NODE_ENV so a
    // production build refuses the bypass even if the flag is
    // present in args.
    const file = join(root, "exploit-attempt.txt");
    await writeFile(file, "secret\n", "utf8");
    const tool = createFileEditTool({ allowedPaths: [root] });

    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const refused = await tool.execute({
        file_path: file,
        old_string: "secret",
        new_string: "leaked",
        __testBypassSessionGuard: true,
      });
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("session id");
      // The file MUST be untouched — the bypass cannot be triggered
      // in production no matter what the model sends.
      await expect(readFile(file, "utf8")).resolves.toBe("secret\n");
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
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
    expect(notifyLspFileChanged).toHaveBeenCalledWith(file, "done\n");
  });

  test("MultiEdit empty replacement follows the same newline semantics", async () => {
    const file = join(root, "multi-delete-inline.txt");
    const fileContent = "one beta\ntwo\n";
    await writeFile(file, fileContent, "utf8");
    const fileStats = await stat(file);
    recordSessionRead(SESSION_ID, file, {
      content: fileContent,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: file,
      edits: [
        { old_string: "beta", new_string: "" },
        { old_string: "two", new_string: "three" },
      ],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("one three\n");
  });

  test("notifies LSP for Edit create and empty-file writes", async () => {
    const created = join(root, "created.ts");
    const empty = join(root, "empty.ts");
    await writeFile(empty, "", "utf8");
    const emptyStats = await stat(empty);
    recordSessionRead(SESSION_ID, empty, {
      content: "",
      timestamp: emptyStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileEditTool({ allowedPaths: [root] });
    await tool.execute({
      file_path: created,
      old_string: "",
      new_string: "export const created = true;\n",
      [SESSION_ID_ARG]: SESSION_ID,
    });
    await tool.execute({
      file_path: empty,
      old_string: "",
      new_string: "export const empty = true;\n",
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(notifyLspFileChanged).toHaveBeenCalledWith(
      created,
      "export const created = true;\n",
    );
    expect(notifyLspFileChanged).toHaveBeenCalledWith(
      empty,
      "export const empty = true;\n",
    );
  });

  test("notifies LSP for MultiEdit create and empty-file writes", async () => {
    const created = join(root, "multi-created.ts");
    const empty = join(root, "multi-empty.ts");
    await writeFile(empty, "", "utf8");
    const emptyStats = await stat(empty);
    recordSessionRead(SESSION_ID, empty, {
      content: "",
      timestamp: emptyStats.mtimeMs,
      viewKind: "full",
    });

    const tool = createFileMultiEditTool({ allowedPaths: [root] });
    await tool.execute({
      file_path: created,
      edits: [{ old_string: "", new_string: "export const created = true;\n" }],
      [SESSION_ID_ARG]: SESSION_ID,
    });
    await tool.execute({
      file_path: empty,
      edits: [{ old_string: "", new_string: "export const empty = true;\n" }],
      [SESSION_ID_ARG]: SESSION_ID,
    });

    expect(notifyLspFileChanged).toHaveBeenCalledWith(
      created,
      "export const created = true;\n",
    );
    expect(notifyLspFileChanged).toHaveBeenCalledWith(
      empty,
      "export const empty = true;\n",
    );
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
    // The richer message must spell out:
    //   - which edit failed (index of N)
    //   - which earlier edits would have validated
    //   - that the file was NOT written (all-or-nothing)
    // so the model can recover by re-emitting the full edit list with
    // the broken edit corrected. Pinning these substrings prevents a
    // future regression to the terse "Edit N failed: ..." form that
    // looped weak local models.
    expect(result.content).toContain("Edit 2 of 2 failed");
    expect(result.content).toContain("Edits 1..1 validated");
    expect(result.content).toContain("file was NOT written");
    expect(result.content).toContain("Re-emit the full edit list");
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
