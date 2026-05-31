import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../services/lsp/fileNotifications.js", () => ({
  notifyLspFileChanged: vi.fn(),
}));

import { createFileWriteTool } from "./file-write.js";
import {
  clearSessionReadState,
  getSessionReadSnapshot,
  recordSessionRead,
  seedSessionReadState,
  SESSION_AGENC_HOME_ARG,
  signSessionId,
} from "./filesystem.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  setPlanSlug,
} from "../../planning/plan-files.js";
import { notifyLspFileChanged } from "../../services/lsp/fileNotifications.js";

describe("Write tool", () => {
  let root = "";
  const sessionId = "test-session-write";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-file-write-"));
    vi.mocked(notifyLspFileChanged).mockClear();
  });

  afterEach(async () => {
    clearSessionReadState(sessionId);
    clearAllPlanSlugs();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("creates a new file with the given content", async () => {
    const tool = createFileWriteTool({ allowedPaths: [root] });
    const target = join(root, "new.txt");

    const result = await tool.execute({
      file_path: target,
      content: "hello\nworld\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toBe(
      `File created successfully at: ${target}`,
    );
    expect(result.metadata).toMatchObject({
      ui: {
        kind: "file_mutation",
        filePath: target,
        operation: "create",
        additions: 2,
        removals: 0,
      },
    });
    await expect(readFile(target, "utf8")).resolves.toBe("hello\nworld\n");
    expect(notifyLspFileChanged).toHaveBeenCalledWith(target, "hello\nworld\n");
    // Post-write snapshot anchors the changed-files attachment producer.
    const snap = getSessionReadSnapshot(sessionId, target);
    expect(snap?.rawContent).toBe("hello\nworld\n");
    expect(snap?.viewKind).toBe("full");
  });

  test("creates the active session plan file outside the workspace root", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-plan-write-home-"));
    try {
      setPlanSlug({ agencHome, sessionId }, "ivory-bridge-aaed0227");
      const planPath = getPlanFilePath({ agencHome, sessionId });
      const tool = createFileWriteTool({ allowedPaths: [root] });

      const result = await tool.execute({
        file_path: planPath,
        content: "# Plan\n\n- [ ] Fix plan file writes\n",
        __agencSessionId: sessionId,
        __agencSessionIdSig: signSessionId(sessionId),
        [SESSION_AGENC_HOME_ARG]: agencHome,
      });

      expect(result.isError).toBeUndefined();
      await expect(readFile(planPath, "utf8")).resolves.toContain(
        "Fix plan file writes",
      );

      const rejected = await tool.execute({
        file_path: join(agencHome, "plans", "not-active.md"),
        content: "# Not active\n",
        __agencSessionId: sessionId,
        __agencSessionIdSig: signSessionId(sessionId),
        [SESSION_AGENC_HOME_ARG]: agencHome,
      });
      expect(rejected.isError).toBe(true);
      expect(String(rejected.content)).toContain(
        "file_path is outside allowed directories",
      );
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  test("overwrites a previously-read existing file", async () => {
    const target = join(root, "existing.txt");
    const original = "alpha\nbeta\n";
    await writeFile(target, original, "utf8");

    // Simulate a prior full Read of the file in this session.
    seedSessionReadState(sessionId, [
      { path: target, content: original, viewKind: "full" },
    ]);

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "alpha\ngamma\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toBe(
      `The file ${target} has been updated successfully.`,
    );
    expect(result.metadata).toMatchObject({
      ui: {
        kind: "file_mutation",
        filePath: target,
        operation: "write",
        additions: 1,
        removals: 1,
      },
    });
    await expect(readFile(target, "utf8")).resolves.toBe("alpha\ngamma\n");
    expect(notifyLspFileChanged).toHaveBeenCalledWith(target, "alpha\ngamma\n");
  });

  test("overwrite staleness check compares rawContent when read content is rendered", async () => {
    const target = join(root, "rendered-read.txt");
    const original = "alpha\nbeta\n";
    await writeFile(target, original, "utf8");
    const fileStats = await stat(target);
    recordSessionRead(sessionId, target, {
      content: "rendered view that is not raw disk content",
      rawContent: original,
      timestamp: fileStats.mtimeMs - 1,
      viewKind: "full",
    });

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "alpha\ngamma\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("alpha\ngamma\n");
  });

  test("rejects overwrite of an existing file that was not read in the session", async () => {
    const target = join(root, "untouched.txt");
    await writeFile(target, "alpha\nbeta\n", "utf8");

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "DIFFERENT\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toBe(
      "File has not been read yet. Read it first before writing to it.",
    );
    // The original content must be untouched.
    await expect(readFile(target, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  test("authorizes overwrite after a partial session read", async () => {
    // Regression for the unsatisfiable edit loop: a partial offset/limit
    // read records `viewKind: "partial"` and must satisfy the
    // read-before-write gate. The partial snapshot lacks full content, so
    // the gate falls back to an mtime-drift check; recording the read at
    // the current mtime means no drift, so the overwrite proceeds.
    const target = join(root, "partial-read.txt");
    await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");
    const fileStats = await stat(target);
    seedSessionReadState(sessionId, [
      {
        path: target,
        content: "beta\n",
        timestamp: fileStats.mtimeMs,
        viewKind: "partial",
        readOffset: 2,
        readLimit: 1,
      },
    ]);

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "replacement\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("replacement\n");
  });

  test("rejects overwrite after only a synthetic processed partial view", async () => {
    // Auto-injected processed partial views never reflected disk bytes the
    // model chose to read, so they must NOT authorize an overwrite.
    const target = join(root, "synthetic-partial.txt");
    await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");
    const fileStats = await stat(target);
    seedSessionReadState(sessionId, [
      {
        path: target,
        content: "beta\n",
        timestamp: fileStats.mtimeMs,
        viewKind: "partial",
        isPartialView: true,
      },
    ]);

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "replacement\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toBe(
      "File has not been read yet. Read it first before writing to it.",
    );
    await expect(readFile(target, "utf8")).resolves.toBe(
      "alpha\nbeta\ngamma\n",
    );
  });

  test("rejects overwrite when a partial read is stale (mtime advanced)", async () => {
    // The partial-read fallback still rejects when the file drifted on
    // disk after the read so the model is forced to re-read.
    const target = join(root, "stale-partial.txt");
    await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");
    const initial = await stat(target);
    seedSessionReadState(sessionId, [
      {
        path: target,
        content: "beta\n",
        timestamp: initial.mtimeMs,
        viewKind: "partial",
        readOffset: 2,
        readLimit: 1,
      },
    ]);
    // External mutation: change content and force a newer mtime.
    await writeFile(target, "alpha\nDRIFT\ngamma\n", "utf8");
    const newer = await stat(target);
    await utimes(target, newer.atime, new Date(initial.mtimeMs + 5_000));

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "replacement\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe(
      "alpha\nDRIFT\ngamma\n",
    );
  });

  test("rejects overwrite when the file has been modified since the session read", async () => {
    const target = join(root, "drifted.txt");
    const seeded = "alpha\nbeta\n";
    await writeFile(target, seeded, "utf8");

    // Snapshot the seeded content as the session's read view.
    seedSessionReadState(sessionId, [
      { path: target, content: seeded, viewKind: "full" },
    ]);

    // Drift the file on disk via an external (non-tool) writer.
    await writeFile(target, "alpha\nDRIFT\n", "utf8");

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "alpha\ngamma\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toBe(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
    // Content on disk stays at the drifted value, not the rejected write.
    await expect(readFile(target, "utf8")).resolves.toBe("alpha\nDRIFT\n");
  });

  test("auto-creates missing parent directories", async () => {
    const target = join(root, "nested", "deeper", "out.txt");
    const tool = createFileWriteTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: target,
      content: "ok",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("ok");
    await expect(stat(join(root, "nested", "deeper"))).resolves.toBeTruthy();
  });

  test("rejects file_path outside the allowed directories", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-file-write-other-"));
    try {
      const tool = createFileWriteTool({ allowedPaths: [root] });
      const result = await tool.execute({
        file_path: join(otherRoot, "escape.txt"),
        content: "nope",
        __agencSessionId: sessionId,
      });

      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain(
        "file_path is outside allowed directories",
      );
      // Nothing should have been written to the other root.
      await expect(stat(join(otherRoot, "escape.txt"))).rejects.toThrow();
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("rejects agent namespace paths with a workspace-relative hint", async () => {
    const tool = createFileWriteTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: "/root/game.py",
      content: "print('hi')\n",
      cwd: root,
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("agent namespace");
    expect(String(result.content)).toContain('"game.py"');
    await expect(stat(join(root, "game.py"))).rejects.toThrow();
  });

  test("error results are plain-text strings, not JSON-wrapped envelopes", async () => {
    const target = join(root, "untouched.txt");
    await writeFile(target, "alpha\n", "utf8");

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "DIFFERENT\n",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBe(true);
    const raw = String(result.content);
    // Plain text — not a JSON envelope like {"error":"..."}.
    expect(raw.startsWith("{")).toBe(false);
    expect(() => JSON.parse(raw)).toThrow();
  });

  test("rejects `.ipynb` writes with a NotebookEdit redirect", async () => {
    const target = join(root, "notebook.ipynb");
    const tool = createFileWriteTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: target,
      content: "{}",
      __agencSessionId: sessionId,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("NotebookEdit");
    await expect(stat(target)).rejects.toThrow();
  });

  test("post-write snapshot lets a follow-up overwrite proceed without an extra read", async () => {
    const target = join(root, "iterative.txt");
    const tool = createFileWriteTool({ allowedPaths: [root] });

    const first = await tool.execute({
      file_path: target,
      content: "v1\n",
      __agencSessionId: sessionId,
    });
    expect(first.isError).toBeUndefined();

    // No explicit read between the writes — the post-write
    // recordSessionRead must satisfy the read-before-overwrite gate.
    const second = await tool.execute({
      file_path: target,
      content: "v2\n",
      __agencSessionId: sessionId,
    });
    expect(second.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("v2\n");
  });

  test("headless (no __agencSessionId) calls bypass the read-before-overwrite gate", async () => {
    const target = join(root, "headless.txt");
    await writeFile(target, "alpha\n", "utf8");

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "beta\n",
      // no __agencSessionId
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("beta\n");
  });

  test("recordSessionRead with a snapshot is honored before write", async () => {
    // Sanity: confirm the session-read state interop (used by the tool)
    // accepts an externally-set snapshot the same way a real Read tool
    // would mark the file.
    const target = join(root, "preread.txt");
    await writeFile(target, "x\n", "utf8");
    recordSessionRead(sessionId, target, {
      content: "x\n",
      timestamp: Date.now(),
      viewKind: "full",
    });

    const tool = createFileWriteTool({ allowedPaths: [root] });
    const result = await tool.execute({
      file_path: target,
      content: "y\n",
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("y\n");
  });

  test("works with workspace-relative file_path (resolved against cwd)", async () => {
    const tool = createFileWriteTool({ allowedPaths: [root] });
    await mkdir(join(root, "rel"), { recursive: true });

    const result = await tool.execute({
      file_path: "rel/relative.txt",
      content: "rel-ok\n",
      cwd: root,
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();
    await expect(readFile(join(root, "rel/relative.txt"), "utf8")).resolves.toBe(
      "rel-ok\n",
    );
  });
});
