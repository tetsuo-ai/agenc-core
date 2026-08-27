import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { ConfigStore } from "../../config/store.js";
import { enterCanonicalSettingsAuthority } from "../../utils/settings/canonicalAuthority.js";
import { applyPatchText, unifiedDiffFromChunks } from "./runtime.js";
import { parsePatch } from "./parser.js";
import {
  canonicalizePath,
  clearSessionReadState,
  recordSessionRead,
} from "../system/filesystem.js";
import {
  sha256,
  workspaceMutationCoordinators,
} from "../../workspace/mutation-coordinator.js";

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

    await expect(readFile(path, "utf8")).resolves.toBe("a\nB\nc\nd\nE\nf\ng\n");
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

  test("never exposes a source-only proposal for a move from a loaded file", async () => {
    const root = await tempRoot();
    const agencHome = await tempRoot();
    const originalAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    const before = "line\n";
    await writeFile(source, before, "utf8");

    try {
      const coordinator = workspaceMutationCoordinators.getOrCreate(root);
      const lease = coordinator.acquire({
        workspaceRoot: root,
        editorInstanceId: "loaded-move-editor",
      });
      coordinator.sync({
        workspaceRoot: root,
        editorInstanceId: "loaded-move-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [
          {
            path: source,
            bufferHandle: 4,
            changedtick: 2,
            contentSha256: sha256(before),
            contentBytes: Buffer.byteLength(before),
            dirty: false,
          },
        ],
      });

      await expect(
        applyPatchText(
          wrapPatch(`*** Update File: source.txt
*** Move to: destination.txt
@@
-line
+line2`),
          { cwd: root, allowedPaths: [root] },
        ),
      ).rejects.toThrow(/multi-path transaction.*active Editor revision/u);

      await expect(readFile(source, "utf8")).resolves.toBe(before);
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        coordinator
          .listChanges({
            workspaceRoot: root,
            editorInstanceId: "loaded-move-editor",
            leaseToken: lease.leaseToken,
            epoch: lease.epoch,
          })
          .changes.some((change) => change.status === "proposed"),
      ).toBe(false);
    } finally {
      workspaceMutationCoordinators.clearForTests();
      if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = originalAgencHome;
    }
  });

  test.each([
    { label: "clean", dirty: false },
    { label: "dirty", dirty: true },
  ])(
    "blocks a true single-file delete of a loaded $label Editor path",
    async ({ dirty }) => {
      const root = await tempRoot();
      const agencHome = await tempRoot();
      const originalAgencHome = process.env.AGENC_HOME;
      process.env.AGENC_HOME = agencHome;
      const path = join(root, "loaded-delete.txt");
      const before = "must remain present\n";
      await writeFile(path, before, "utf8");

      try {
        const coordinator = workspaceMutationCoordinators.getOrCreate(root);
        const lease = coordinator.acquire({
          workspaceRoot: root,
          editorInstanceId: `loaded-delete-${dirty ? "dirty" : "clean"}`,
        });
        coordinator.sync({
          workspaceRoot: root,
          editorInstanceId: lease.editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
          sequence: 0,
          buffers: [
            {
              path,
              bufferHandle: 5,
              changedtick: 2,
              contentSha256: sha256(before),
              contentBytes: Buffer.byteLength(before),
              dirty,
              ...(dirty ? { content: before } : {}),
            },
          ],
        });

        await expect(
          applyPatchText(wrapPatch("*** Delete File: loaded-delete.txt"), {
            cwd: root,
            allowedPaths: [root],
          }),
        ).rejects.toThrow(/delete transaction.*active Editor revision/u);

        await expect(readFile(path, "utf8")).resolves.toBe(before);
        expect(
          coordinator
            .listChanges({
              workspaceRoot: root,
              editorInstanceId: lease.editorInstanceId,
              leaseToken: lease.leaseToken,
              epoch: lease.epoch,
            })
            .changes.some((change) => change.status === "proposed"),
        ).toBe(false);
      } finally {
        workspaceMutationCoordinators.clearForTests();
        if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
        else process.env.AGENC_HOME = originalAgencHome;
      }
    },
  );

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
      unifiedDiff: "@@ -1,4 +1,4 @@\n foo\n-bar\n+BAR\n baz\n-qux\n+QUX\n",
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
    clearSessionReadState(SESSION_ID, tmpdir());
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

describe("apply-patch atomicity", () => {
  // The core data-loss bug: a multi-file patch used to write each hunk to disk
  // as it went, so a failure on a LATER hunk left EARLIER hunks already mutated
  // with no rollback (and the model, seeing only the error, would retry and
  // double-apply). The apply is now a transaction — a validation failure aborts
  // with the working tree untouched.
  test("a later hunk's validation failure leaves earlier files untouched", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "first.txt"), "a1\na2\n", "utf8");
    await writeFile(join(root, "second.txt"), "b1\nb2\n", "utf8");

    await expect(
      applyPatchText(
        wrapPatch(`*** Update File: first.txt
@@
-a2
+A2
*** Update File: second.txt
@@
-NOPE
+x`),
        { cwd: root, allowedPaths: [root] },
      ),
    ).rejects.toThrow("Failed to find expected lines");

    // Before the fix first.txt would already be "a1\nA2\n".
    await expect(readFile(join(root, "first.txt"), "utf8")).resolves.toBe(
      "a1\na2\n",
    );
    await expect(readFile(join(root, "second.txt"), "utf8")).resolves.toBe(
      "b1\nb2\n",
    );
  });

  // An add staged before a failing hunk must not be left orphaned on disk.
  test("a failing later hunk does not orphan an added file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "exists.txt"), "keep\n", "utf8");

    await expect(
      applyPatchText(
        wrapPatch(`*** Add File: new.txt
+created
*** Update File: exists.txt
@@
-MISSING
+changed`),
        { cwd: root, allowedPaths: [root] },
      ),
    ).rejects.toThrow("Failed to find expected lines");

    // Before the fix new.txt would have been created and left behind.
    await expect(stat(join(root, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "exists.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
  });

  // A failure during the COMMIT phase (not just planning) must roll back the
  // ops already written. Deleting a non-existent file fails at commit time
  // after the add has been written; that add must be reverted.
  test("rolls back an already-written file when a later op fails at commit", async () => {
    const root = await tempRoot();

    await expect(
      applyPatchText(
        wrapPatch(`*** Add File: created.txt
+hello
*** Delete File: ghost.txt`),
        { cwd: root, allowedPaths: [root] },
      ),
    ).rejects.toThrow("rolled back");

    // created.txt was written during commit, then reverted when the delete of
    // the non-existent ghost.txt failed.
    await expect(stat(join(root, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("never overwrites or rolls back a missing target published after its backup", async () => {
    const root = await tempRoot();
    const agencHome = await tempRoot();
    const originalAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
    const target = join(root, "concurrent.txt");
    const concurrentContent = "owned by the concurrent writer\n";

    try {
      const coordinator = workspaceMutationCoordinators.getOrCreate(root);
      const lease = coordinator.acquire({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-concurrent-publish-editor",
      });
      coordinator.sync({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-concurrent-publish-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [],
      });

      await expect(
        applyPatchText(
          wrapPatch(`*** Add File: concurrent.txt
+owned by apply_patch`),
          {
            cwd: root,
            allowedPaths: [root],
            __testAfterBackupsCaptured: async ({ paths }) => {
              expect(paths).toEqual([target]);
              await writeFile(target, concurrentContent, "utf8");
            },
          },
        ),
      ).rejects.toThrow(/stopped before writing|path identity changed/iu);

      await expect(readFile(target, "utf8")).resolves.toBe(concurrentContent);
      expect(
        coordinator.listChanges({
          workspaceRoot: root,
          editorInstanceId: "apply-patch-concurrent-publish-editor",
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
        }).changes,
      ).toEqual([]);

      const retry = await coordinator.prepareMutation({
        path: target,
        source: "apply_patch",
        beforeText: concurrentContent,
        afterText: "retry\n",
      });
      expect(retry).toMatchObject({ decision: "allow" });
      if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
    } finally {
      workspaceMutationCoordinators.clearForTests();
      if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = originalAgencHome;
    }
  });

  test("rejects same-inode byte drift after backup without restoring over it", async () => {
    const root = await tempRoot();
    const target = join(root, "same-inode.txt");
    const originalContent = "original owner bytes\n";
    const concurrentContent = "concurrent owner bytes\n";
    await writeFile(target, originalContent, "utf8");
    const beforeIdentity = await stat(target);

    await expect(
      applyPatchText(
        wrapPatch(`*** Update File: same-inode.txt
@@
-original owner bytes
+apply_patch bytes`),
        {
          cwd: root,
          allowedPaths: [root],
          __testAfterBackupsCaptured: async ({ paths }) => {
            expect(paths).toEqual([target]);
            await writeFile(target, concurrentContent, "utf8");
            const afterIdentity = await stat(target);
            expect(afterIdentity.dev).toBe(beforeIdentity.dev);
            expect(afterIdentity.ino).toBe(beforeIdentity.ino);
          },
        },
      ),
    ).rejects.toThrow(/stopped before writing|content no longer matches/iu);

    await expect(readFile(target, "utf8")).resolves.toBe(concurrentContent);
  });

  test("never commits or rolls back through an admitted parent exchanged for an outside symlink", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const agencHome = await tempRoot();
    const originalAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
    const admittedParent = join(root, "admitted-parent");
    const displacedParent = join(root, "displaced-parent");
    const target = join(admittedParent, "escape.txt");
    const displacedTarget = join(displacedParent, "escape.txt");
    const outsideTarget = join(outsideRoot, "escape.txt");
    const outsideContent = "outside owner bytes\n";
    await mkdir(admittedParent);
    await writeFile(outsideTarget, outsideContent, "utf8");

    try {
      const coordinator = workspaceMutationCoordinators.getOrCreate(root);
      const lease = coordinator.acquire({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-parent-exchange-editor",
      });
      coordinator.sync({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-parent-exchange-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [],
      });

      await expect(
        applyPatchText(
          wrapPatch(`*** Add File: admitted-parent/escape.txt
+apply_patch bytes`),
          {
            cwd: root,
            allowedPaths: [root],
            __testAfterBackupsCaptured: async ({ paths }) => {
              expect(paths).toEqual([target]);
              await rename(admittedParent, displacedParent);
              await symlink(outsideRoot, admittedParent);
            },
          },
        ),
      ).rejects.toThrow(/stopped before writing|path identity changed/iu);

      await expect(readFile(outsideTarget, "utf8")).resolves.toBe(
        outsideContent,
      );
      await expect(stat(displacedTarget)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        coordinator.listChanges({
          workspaceRoot: root,
          editorInstanceId: "apply-patch-parent-exchange-editor",
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
        }).changes,
      ).toEqual([]);

      const retry = await coordinator.prepareMutation({
        path: displacedTarget,
        source: "apply_patch",
        beforeText: "",
        afterText: "retry\n",
      });
      expect(retry).toMatchObject({ decision: "allow" });
      if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
    } finally {
      workspaceMutationCoordinators.clearForTests();
      if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = originalAgencHome;
    }
  });

  test("never creates outside the workspace when the parent is exchanged after the final pre-write check", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const admittedParent = join(root, "admitted-parent");
    const displacedParent = join(root, "displaced-parent");
    const target = join(admittedParent, "escape.txt");
    const displacedTarget = join(displacedParent, "escape.txt");
    const outsideTarget = join(outsideRoot, "escape.txt");
    await mkdir(admittedParent);

    try {
      await expect(
        applyPatchText(
          wrapPatch(`*** Add File: admitted-parent/escape.txt
+must stay inside`),
          {
            cwd: root,
            allowedPaths: [root],
            __testAfterPreWriteCheck: async ({ path, kind }) => {
              expect(path).toBe(target);
              expect(kind).toBe("write");
              await rename(admittedParent, displacedParent);
              await symlink(outsideRoot, admittedParent);
            },
          },
        ),
      ).rejects.toThrow(/stopped before writing|path identity changed/iu);

      await expect(stat(outsideTarget)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(displacedTarget, "utf8")).resolves.toBe(
        "must stay inside\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("never overwrites an outside lookalike when an existing target's parent is exchanged after the final pre-write check", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const admittedParent = join(root, "admitted-existing");
    const displacedParent = join(root, "displaced-existing");
    const target = join(admittedParent, "value.txt");
    const displacedTarget = join(displacedParent, "value.txt");
    const outsideTarget = join(outsideRoot, "value.txt");
    const original = "identical original bytes\n";
    await mkdir(admittedParent);
    await writeFile(target, original, "utf8");
    await writeFile(outsideTarget, original, "utf8");

    try {
      await expect(
        applyPatchText(
          wrapPatch(`*** Update File: admitted-existing/value.txt
@@
-identical original bytes
+replacement`),
          {
            cwd: root,
            allowedPaths: [root],
            __testAfterPreWriteCheck: async ({ path, kind }) => {
              expect(path).toBe(target);
              expect(kind).toBe("write");
              await rename(admittedParent, displacedParent);
              await symlink(outsideRoot, admittedParent);
            },
          },
        ),
      ).rejects.toThrow(/stopped before writing|path identity changed/iu);

      await expect(readFile(outsideTarget, "utf8")).resolves.toBe(original);
      await expect(readFile(displacedTarget, "utf8")).resolves.toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("never deletes an outside lookalike when the target's parent is exchanged after the final pre-write check", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const admittedParent = join(root, "admitted-delete");
    const displacedParent = join(root, "displaced-delete");
    const target = join(admittedParent, "value.txt");
    const displacedTarget = join(displacedParent, "value.txt");
    const outsideTarget = join(outsideRoot, "value.txt");
    const original = "identical delete bytes\n";
    await mkdir(admittedParent);
    await writeFile(target, original, "utf8");
    await writeFile(outsideTarget, original, "utf8");

    try {
      await expect(
        applyPatchText(
          wrapPatch(`*** Delete File: admitted-delete/value.txt`),
          {
            cwd: root,
            allowedPaths: [root],
            __testAfterPreWriteCheck: async ({ path, kind }) => {
              expect(path).toBe(target);
              expect(kind).toBe("remove");
              await rename(admittedParent, displacedParent);
              await symlink(outsideRoot, admittedParent);
            },
          },
        ),
      ).rejects.toThrow(/rollback was incomplete|path identity changed/iu);

      await expect(readFile(outsideTarget, "utf8")).resolves.toBe(original);
      await expect(stat(displacedTarget)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("refuses rollback through a parent exchanged after an earlier batch write", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const agencHome = await tempRoot();
    const originalAgencHome = process.env.AGENC_HOME;
    process.env.AGENC_HOME = agencHome;
    const admittedParent = join(root, "rollback-parent");
    const displacedParent = join(root, "rollback-parent-displaced");
    const target = join(admittedParent, "value.txt");
    const displacedTarget = join(displacedParent, "value.txt");
    const outsideTarget = join(outsideRoot, "value.txt");
    const originalContent = "original\n";
    const patchedContent = "patched\n";
    const outsideContent = "outside concurrent bytes\n";
    await mkdir(admittedParent);
    await writeFile(target, originalContent, "utf8");
    await writeFile(outsideTarget, outsideContent, "utf8");

    try {
      const coordinator = workspaceMutationCoordinators.getOrCreate(root);
      const lease = coordinator.acquire({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-rollback-parent-editor",
      });
      coordinator.sync({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-rollback-parent-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [],
      });
      let parentExchanged = false;

      await expect(
        applyPatchText(
          wrapPatch(`*** Update File: rollback-parent/value.txt
@@
-original
+patched
*** Delete File: ghost.txt`),
          {
            cwd: root,
            allowedPaths: [root],
            __testRestoreBackup: async ({ path, restore }) => {
              if (path === target && !parentExchanged) {
                parentExchanged = true;
                await rename(admittedParent, displacedParent);
                await symlink(outsideRoot, admittedParent);
              }
              await restore();
            },
          },
        ),
      ).rejects.toThrow(/rollback was incomplete|refusing unsafe rollback/iu);

      expect(parentExchanged).toBe(true);
      await expect(readFile(outsideTarget, "utf8")).resolves.toBe(
        outsideContent,
      );
      await expect(readFile(displacedTarget, "utf8")).resolves.toBe(
        patchedContent,
      );
      expect(
        coordinator.listChanges({
          workspaceRoot: root,
          editorInstanceId: "apply-patch-rollback-parent-editor",
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
        }).changes,
      ).toContainEqual(
        expect.objectContaining({
          path: target,
          status: "unknown_outcome",
        }),
      );

      const retry = await coordinator.prepareMutation({
        path: displacedTarget,
        source: "apply_patch",
        beforeText: patchedContent,
        afterText: "retry\n",
      });
      expect(retry).toMatchObject({ decision: "allow" });
      if (retry.decision === "allow") coordinator.cancelMutation(retry.token);
    } finally {
      workspaceMutationCoordinators.clearForTests();
      if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = originalAgencHome;
    }
  });

  test("marks an unrestored path unknown, reconciles every token, and reports the partial rollback truthfully", async () => {
    const root = await tempRoot();
    const agencHome = await tempRoot();
    enterCanonicalSettingsAuthority(
      new ConfigStore({
        home: agencHome,
        env: {},
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
      }),
    );
    const firstPath = join(root, "first.txt");
    const ghostPath = join(root, "ghost.txt");
    const before = "first\n";
    const after = "FIRST\n";
    await writeFile(firstPath, before, "utf8");

    try {
      const coordinator = workspaceMutationCoordinators.getOrCreate(root);
      const lease = coordinator.acquire({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-rollback-editor",
      });
      coordinator.sync({
        workspaceRoot: root,
        editorInstanceId: "apply-patch-rollback-editor",
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence: 0,
        buffers: [],
      });
      await coordinator.flushQuarantinePersistence();

      let failure: unknown;
      try {
        await applyPatchText(
          wrapPatch(`*** Update File: first.txt
@@
-first
+FIRST
*** Delete File: ghost.txt`),
          {
            cwd: root,
            allowedPaths: [root],
            __testRestoreBackup: async ({ path, restore }) => {
              if (path === firstPath) {
                throw new Error("forced first-path restore failure");
              }
              await restore();
            },
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("rollback was incomplete");
      expect(message).toContain(firstPath);
      expect(message).toContain("forced first-path restore failure");
      expect(message).toContain("durably marked unknown_outcome");
      expect(message).not.toContain("no files were changed");
      await expect(readFile(firstPath, "utf8")).resolves.toBe(after);
      await expect(stat(ghostPath)).rejects.toMatchObject({ code: "ENOENT" });

      expect(
        coordinator.listChanges({
          workspaceRoot: root,
          editorInstanceId: "apply-patch-rollback-editor",
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
        }).changes,
      ).toContainEqual(
        expect.objectContaining({
          path: firstPath,
          status: "unknown_outcome",
          beforeSha256: sha256(before),
          afterSha256: sha256(after),
        }),
      );
      const key = createHash("sha256").update(root).digest("hex").slice(0, 32);
      const ledger = await readFile(
        join(agencHome, "workspace-mutations", key, "ledger-v1.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"status":"unknown_outcome"');
      expect(ledger).toContain(`"path":${JSON.stringify(firstPath)}`);

      // Both the failed-write token and the failed-restore token must be
      // terminal. Sync probes both paths and fails if either remains executing.
      expect(() =>
        coordinator.sync({
          workspaceRoot: root,
          editorInstanceId: "apply-patch-rollback-editor",
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
          sequence: 1,
          buffers: [
            {
              path: firstPath,
              bufferHandle: 41,
              changedtick: 2,
              contentSha256: sha256(after),
              dirty: false,
            },
            {
              path: ghostPath,
              bufferHandle: 42,
              changedtick: 1,
              contentSha256: sha256(""),
              dirty: false,
            },
          ],
        }),
      ).not.toThrow();
    } finally {
      workspaceMutationCoordinators.clearForTests();
    }
  });

  // The happy path is unchanged: a valid multi-file patch still applies fully.
  test("still applies a fully-valid multi-file patch", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "u.txt"), "x\ny\n", "utf8");

    const result = await applyPatchText(
      wrapPatch(`*** Add File: a.txt
+added
*** Update File: u.txt
@@
-y
+Y`),
      { cwd: root, allowedPaths: [root] },
    );

    await expect(readFile(join(root, "a.txt"), "utf8")).resolves.toBe(
      "added\n",
    );
    await expect(readFile(join(root, "u.txt"), "utf8")).resolves.toBe("x\nY\n");
    expect(result.affected.added).toEqual(["a.txt"]);
    expect(result.affected.modified).toEqual(["u.txt"]);
  });
});
