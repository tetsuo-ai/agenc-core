import { mkdtemp, readFile, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { applyPatchText } from "./runtime.js";
import { recordSessionRead } from "src/tools/system/filesystem.js";

async function tempRoot(): Promise<string> {
  // Canonicalize so the recorded session-read key matches the realpath
  // apply-patch resolves the target file to (e.g. /tmp -> /private/tmp).
  return (await realpath(await mkdtemp(join(tmpdir(), "agenc-apply-patch-gate-")))).normalize(
    "NFC",
  );
}

function wrapPatch(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

const UPDATE_PATCH = wrapPatch(`*** Update File: update.txt
@@
 foo
-bar
+baz`);

/**
 * Record a full session-read snapshot for `path` whose mtime matches the
 * file on disk, mirroring what the Read tool stores. This authorizes a
 * subsequent apply_patch update on the file.
 */
async function recordFullRead(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  const meta = await stat(path);
  recordSessionRead(sessionId, path, {
    content,
    rawContent: content,
    timestamp: meta.mtimeMs,
    viewKind: "full",
  });
}

describe("apply-patch read-before-write gate", () => {
  test("rejects updating a file that was never read this session", async () => {
    const root = await tempRoot();
    const path = join(root, "update.txt");
    await writeFile(path, "foo\nbar\n", "utf8");

    await expect(
      applyPatchText(UPDATE_PATCH, {
        cwd: root,
        allowedPaths: [root],
        sessionId: "session-no-read",
      }),
    ).rejects.toThrow("File has not been read yet");

    // Untouched on disk.
    await expect(readFile(path, "utf8")).resolves.toBe("foo\nbar\n");
  });

  test("rejects updating a file that drifted on disk since the recorded read", async () => {
    const root = await tempRoot();
    const path = join(root, "update.txt");
    await writeFile(path, "foo\nbar\n", "utf8");

    const sessionId = "session-stale";
    // Record a read snapshot whose timestamp predates a later external edit.
    recordSessionRead(sessionId, path, {
      content: "foo\nbar\n",
      rawContent: "foo\nbar\n",
      timestamp: 1,
      viewKind: "full",
    });

    // Simulate a concurrent external modification: change bytes AND advance mtime
    // well past the recorded read timestamp.
    await writeFile(path, "foo\nDRIFTED\n", "utf8");
    const future = new Date(Date.now() + 60_000);
    await utimes(path, future, future);

    await expect(
      applyPatchText(UPDATE_PATCH, {
        cwd: root,
        allowedPaths: [root],
        sessionId,
      }),
    ).rejects.toThrow("File has been modified since read");

    // Untouched by the patch.
    await expect(readFile(path, "utf8")).resolves.toBe("foo\nDRIFTED\n");
  });

  test("applies the update when the file was fully read and unchanged", async () => {
    const root = await tempRoot();
    const path = join(root, "update.txt");
    await writeFile(path, "foo\nbar\n", "utf8");

    const sessionId = "session-ok";
    await recordFullRead(sessionId, path, "foo\nbar\n");

    const result = await applyPatchText(UPDATE_PATCH, {
      cwd: root,
      allowedPaths: [root],
      sessionId,
    });

    expect(result.summary).toBe(
      "Success. Updated the following files:\nM update.txt\n",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("foo\nbaz\n");
  });

  test("does not gate when no session id is supplied (back-compat)", async () => {
    const root = await tempRoot();
    const path = join(root, "update.txt");
    await writeFile(path, "foo\nbar\n", "utf8");

    // No sessionId => no read-before-write enforcement, preserving the
    // prior behavior for callers that do not thread a session.
    const result = await applyPatchText(UPDATE_PATCH, {
      cwd: root,
      allowedPaths: [root],
    });

    expect(result.summary).toBe(
      "Success. Updated the following files:\nM update.txt\n",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("foo\nbaz\n");
  });
});
