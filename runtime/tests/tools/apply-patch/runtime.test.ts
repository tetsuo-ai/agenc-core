import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { applyPatchText, unifiedDiffFromChunks } from "./runtime.js";
import { parsePatch } from "./parser.js";
import {
  canonicalizePath,
  clearSessionReadState,
  recordSessionRead,
} from "../system/filesystem.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-apply-patch-"));
}

function wrapPatch(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

describe("apply-patch runtime", () => {
  test("adds, updates, deletes, and summarizes files", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "delete.txt"), "remove me\n", "utf8");
    await writeFile(join(root, "update.txt"), "foo\nbar\n", "utf8");

    const result = await applyPatchText(
      wrapPatch(`*** Add File: add.txt
+ab
+cd
*** Update File: update.txt
@@
 foo
-bar
+baz
*** Delete File: delete.txt`),
      { cwd: root, allowedPaths: [root] },
    );

    await expect(readFile(join(root, "add.txt"), "utf8")).resolves.toBe(
      "ab\ncd\n",
    );
    await expect(readFile(join(root, "update.txt"), "utf8")).resolves.toBe(
      "foo\nbaz\n",
    );
    await expect(stat(join(root, "delete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.summary).toBe(
      "Success. Updated the following files:\nA add.txt\nM update.txt\nD delete.txt\n",
    );
  });

  test("applies interleaved chunks and end-of-file additions", async () => {
    const root = await tempRoot();
    const path = join(root, "interleaved.txt");
    await writeFile(path, "a\nb\nc\nd\ne\nf\n", "utf8");

    await applyPatchText(
      wrapPatch(`*** Update File: interleaved.txt
@@
 a
-b
+B
@@
 c
 d
-e
+E
@@
 f
+g
*** End of File`),
      { cwd: root, allowedPaths: [root] },
    );

    await expect(readFile(path, "utf8")).resolves.toBe(
      "a\nB\nc\nd\nE\nf\ng\n",
    );
  });

  test("inserts a context-anchored pure addition after the anchor, not at EOF", async () => {
    // Regression: a `@@ <context>` chunk with only `+` lines (oldLines empty)
    // used to ignore the located context and append at end-of-file.
    const root = await tempRoot();
    const path = join(root, "anchored.txt");
    await writeFile(path, "alpha\nbeta\ngamma\ndelta\n", "utf8");

    await applyPatchText(
      wrapPatch(`*** Update File: anchored.txt
@@ beta
+INSERTED`),
      { cwd: root, allowedPaths: [root] },
    );

    await expect(readFile(path, "utf8")).resolves.toBe(
      "alpha\nbeta\nINSERTED\ngamma\ndelta\n",
    );
  });

  test("moves updated files and creates destination parents", async () => {
    const root = await tempRoot();
    const source = join(root, "source.txt");
    const destination = join(root, "nested", "destination.txt");
    await writeFile(source, "line\n", "utf8");

    const result = await applyPatchText(
      wrapPatch(`*** Update File: source.txt
*** Move to: nested/destination.txt
@@
-line
+line2`),
      { cwd: root, allowedPaths: [root] },
    );

    await expect(readFile(destination, "utf8")).resolves.toBe("line2\n");
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.summary).toBe(
      "Success. Updated the following files:\nM nested/destination.txt\n",
    );
  });

  test("matches typographic punctuation with ASCII patch text", async () => {
    const root = await tempRoot();
    const path = join(root, "unicode.py");
    await writeFile(
      path,
      "import asyncio  # local import \u2013 avoids top\u2011level dep\n",
      "utf8",
    );

    await applyPatchText(
      wrapPatch(`*** Update File: unicode.py
@@
-import asyncio  # local import - avoids top-level dep
+import asyncio  # fixed`),
      { cwd: root, allowedPaths: [root] },
    );

    await expect(readFile(path, "utf8")).resolves.toBe(
      "import asyncio  # fixed\n",
    );
  });

  test("builds donor-shaped unified diff bodies", async () => {
    const root = await tempRoot();
    const path = join(root, "multi.txt");
    await writeFile(path, "foo\nbar\nbaz\nqux\n", "utf8");
    const parsed = parsePatch(
      wrapPatch(`*** Update File: multi.txt
@@
 foo
-bar
+BAR
@@
 baz
-qux
+QUX`),
    );
    const update = parsed.hunks[0];
    if (update?.kind !== "update") throw new Error("expected update hunk");

    await expect(unifiedDiffFromChunks(path, update.chunks)).resolves.toEqual({
      unifiedDiff:
        "@@ -1,4 +1,4 @@\n foo\n-bar\n+BAR\n baz\n-qux\n+QUX\n",
      content: "foo\nBAR\nbaz\nQUX\n",
    });
  });

  test("rejects paths outside allowed roots", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();

    await expect(
      applyPatchText(
        wrapPatch(`*** Add File: ${join(outside, "escape.txt")}
+nope`),
        { cwd: root, allowedPaths: [root] },
      ),
    ).rejects.toThrow("path is outside allowed directories");
  });
});

describe("apply-patch read-before-write gate", () => {
  const SESSION_ID = "apply-patch-gate-test-session";

  afterEach(() => {
    clearSessionReadState(SESSION_ID);
  });

  const updatePatch = (file: string, from: string, to: string): string =>
    wrapPatch(`*** Update File: ${file}\n@@\n-${from}\n+${to}`);

  test("rejects an update when the file was not read this session", async () => {
    const root = await tempRoot();
    const path = join(root, "unread.txt");
    await writeFile(path, "foo\n", "utf8");
    // intentionally do NOT record a session read

    await expect(
      applyPatchText(updatePatch(path, "foo", "bar"), {
        cwd: root,
        allowedPaths: [root],
        sessionId: SESSION_ID,
      }),
    ).rejects.toThrow(
      "File has not been read yet. Read it first before writing to it.",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("foo\n");
  });

  test("authorizes an update after a partial offset/limit read", async () => {
    // Regression: a partial read must satisfy the gate just like a full
    // read so a model reading in windows is not stuck in an edit loop.
    const root = await tempRoot();
    const path = join(root, "partial.txt");
    await writeFile(path, "foo\n", "utf8");
    const canonical = await canonicalizePath(path);
    const fileStats = await stat(path);
    recordSessionRead(SESSION_ID, canonical, {
      content: "foo\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "partial",
      readOffset: 1,
      readLimit: 1,
    });

    const result = await applyPatchText(updatePatch(path, "foo", "bar"), {
      cwd: root,
      allowedPaths: [root],
      sessionId: SESSION_ID,
    });

    expect(result.affected.modified.length).toBe(1);
    await expect(readFile(path, "utf8")).resolves.toBe("bar\n");
  });

  test("rejects a synthetic processed partial view", async () => {
    const root = await tempRoot();
    const path = join(root, "synthetic.txt");
    await writeFile(path, "foo\n", "utf8");
    const canonical = await canonicalizePath(path);
    const fileStats = await stat(path);
    recordSessionRead(SESSION_ID, canonical, {
      content: "foo\n",
      timestamp: fileStats.mtimeMs,
      viewKind: "partial",
      isPartialView: true,
    });

    await expect(
      applyPatchText(updatePatch(path, "foo", "bar"), {
        cwd: root,
        allowedPaths: [root],
        sessionId: SESSION_ID,
      }),
    ).rejects.toThrow(
      "File has not been read yet. Read it first before writing to it.",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("foo\n");
  });

  test("rejects a stale partial read when the file mtime advanced", async () => {
    const root = await tempRoot();
    const path = join(root, "stale.txt");
    await writeFile(path, "foo\n", "utf8");
    const canonical = await canonicalizePath(path);
    const initial = await stat(path);
    recordSessionRead(SESSION_ID, canonical, {
      content: "foo\n",
      timestamp: initial.mtimeMs,
      viewKind: "partial",
      readOffset: 1,
      readLimit: 1,
    });
    // External mutation: change content and force a newer mtime.
    await writeFile(path, "changed\n", "utf8");
    const newer = await stat(path);
    await utimes(path, newer.atime, new Date(initial.mtimeMs + 5_000));

    await expect(
      applyPatchText(updatePatch(path, "changed", "bar"), {
        cwd: root,
        allowedPaths: [root],
        sessionId: SESSION_ID,
      }),
    ).rejects.toThrow(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("changed\n");
  });
});
