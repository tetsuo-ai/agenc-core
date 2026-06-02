import {
  access,
  mkdtemp,
  readFile,
  realpath,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { applyPatchText } from "src/tools/apply-patch/runtime";
import { recordSessionRead } from "src/tools/system/filesystem";

// gaphunt3 #40: the apply_patch `*** Delete File:` hunk is a mutation and
// must honor the same read-before-write / mtime-drift gate as the update
// path. A model must not be able to blind-delete an in-allowlist file it
// never observed this session.

async function tempRoot(): Promise<string> {
  // Canonicalize so the recorded session-read key matches the realpath
  // apply-patch resolves the target file to (e.g. /tmp -> /private/tmp).
  return (
    await realpath(await mkdtemp(join(tmpdir(), "agenc-apply-patch-delete-")))
  ).normalize("NFC");
}

function wrapPatch(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

const DELETE_PATCH = wrapPatch(`*** Delete File: doomed.txt`);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

describe("apply-patch delete read-before-write gate (gaphunt3 #40)", () => {
  test("refuses to delete a file that was never read this session and leaves it on disk", async () => {
    const root = await tempRoot();
    const path = join(root, "doomed.txt");
    await writeFile(path, "keep me\n", "utf8");

    await expect(
      applyPatchText(DELETE_PATCH, {
        cwd: root,
        allowedPaths: [root],
        sessionId: "session-no-read",
      }),
    ).rejects.toThrow("File has not been read yet");

    // Untouched on disk: before the fix the delete would have succeeded.
    await expect(exists(path)).resolves.toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe("keep me\n");
  });

  test("refuses to delete a file that drifted on disk since the recorded read", async () => {
    const root = await tempRoot();
    const path = join(root, "doomed.txt");
    await writeFile(path, "keep me\n", "utf8");

    const sessionId = "session-stale";
    // Recorded read predates a later external edit.
    recordSessionRead(sessionId, path, {
      content: "keep me\n",
      rawContent: "keep me\n",
      timestamp: 1,
      viewKind: "full",
    });

    // Simulate a concurrent external modification: change bytes AND advance
    // mtime well past the recorded read timestamp.
    await writeFile(path, "DRIFTED\n", "utf8");
    const future = new Date(Date.now() + 60_000);
    await utimes(path, future, future);

    await expect(
      applyPatchText(DELETE_PATCH, {
        cwd: root,
        allowedPaths: [root],
        sessionId,
      }),
    ).rejects.toThrow("File has been modified since read");

    await expect(exists(path)).resolves.toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe("DRIFTED\n");
  });

  test("deletes the file when it was fully read and unchanged", async () => {
    const root = await tempRoot();
    const path = join(root, "doomed.txt");
    await writeFile(path, "keep me\n", "utf8");

    const sessionId = "session-ok";
    await recordFullRead(sessionId, path, "keep me\n");

    const result = await applyPatchText(DELETE_PATCH, {
      cwd: root,
      allowedPaths: [root],
      sessionId,
    });

    expect(result.summary).toBe(
      "Success. Updated the following files:\nD doomed.txt\n",
    );
    await expect(exists(path)).resolves.toBe(false);
  });

  test("does not gate when no session id is supplied (back-compat)", async () => {
    const root = await tempRoot();
    const path = join(root, "doomed.txt");
    await writeFile(path, "keep me\n", "utf8");

    // No sessionId => no read-before-write enforcement, preserving the prior
    // behavior for callers that do not thread a session.
    const result = await applyPatchText(DELETE_PATCH, {
      cwd: root,
      allowedPaths: [root],
    });

    expect(result.summary).toBe(
      "Success. Updated the following files:\nD doomed.txt\n",
    );
    await expect(exists(path)).resolves.toBe(false);
  });
});
