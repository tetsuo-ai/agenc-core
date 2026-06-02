/**
 * Regression coverage for the read-before-write session guard on the
 * `Write` tool when the session id is absent.
 *
 * Bug: when an EXISTING file was overwritten without a session id, the
 * tool fell straight through to an unconditional write — no
 * read-before-write check, no modification-drift check — silently
 * clobbering concurrent external modifications. `Edit`/`MultiEdit`
 * already fail loud (SESSION_ID_MISSING_ERROR) in the same situation;
 * `Write` retained the unsafe silent skip.
 *
 * These tests pin the loud-fail behavior so the fix cannot be reverted
 * without turning the suite red.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../services/lsp/fileNotifications.js", () => ({
  notifyLspFileChanged: vi.fn(),
}));

import { createFileWriteTool } from "./file-write.js";
import { clearSessionReadState } from "./filesystem.js";

describe("Write tool — session-guard hardening (no session id)", () => {
  let root = "";
  const sessionId = "test-session-write-guard-ihunt";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-file-write-guard-"));
  });

  afterEach(async () => {
    clearSessionReadState(sessionId);
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("rejects overwrite of an existing file when no session id is injected", async () => {
    const target = join(root, "existing.txt");
    const original = "alpha\nbeta\n";
    await writeFile(target, original, "utf8");

    const tool = createFileWriteTool({ allowedPaths: [root] });
    // No __agencSessionId, and NOT bypassing the guard. This is the
    // "production path lost the session id" case. Before the fix this
    // silently overwrote the file; now it must fail loud.
    const result = await tool.execute({
      file_path: target,
      content: "CLOBBERED\n",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/without a session id/i);
    // The on-disk content MUST be untouched — this is the data-loss
    // assertion that fails if the fix is reverted.
    await expect(readFile(target, "utf8")).resolves.toBe(original);
  });

  test("still allows creating a brand-new file with no session id", async () => {
    const target = join(root, "brand-new.txt");
    const tool = createFileWriteTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: target,
      content: "fresh\n",
    });

    // The guard only applies to existing files; creation must not regress.
    expect(result.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("fresh\n");
  });

  test("test-only bypass flag permits overwrite without a session id", async () => {
    const target = join(root, "bypass.txt");
    await writeFile(target, "old\n", "utf8");
    const tool = createFileWriteTool({ allowedPaths: [root] });

    const result = await tool.execute({
      file_path: target,
      content: "new\n",
      __testBypassSessionGuard: true,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("new\n");
  });
});
