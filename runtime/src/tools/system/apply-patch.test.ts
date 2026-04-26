import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createApplyPatchTool,
  type ApplyPatchRunner,
} from "./apply-patch.js";
import {
  clearSessionReadState,
  seedSessionReadState,
} from "./filesystem.js";

describe("apply_patch tool", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-apply-patch-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("validates AgenC patch targets before invoking the runner", async () => {
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "Success. Updated the following files:\nA new.txt\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: nested/new.txt\n" +
        "+created\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Success. Updated the following files");
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: root,
        patch: expect.stringContaining("*** Add File: nested/new.txt"),
      }),
    );
  });

  test("applies add, update, and delete operations in-process", async () => {
    await writeFile(join(root, "modify.txt"), "line1\nline2\n", "utf8");
    await writeFile(join(root, "delete.txt"), "obsolete\n", "utf8");
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: nested/new.txt\n" +
        "+created\n" +
        "*** Delete File: delete.txt\n" +
        "*** Update File: modify.txt\n" +
        "@@\n" +
        "-line2\n" +
        "+changed\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "Success. Updated the following files:\nA nested/new.txt\nM modify.txt\nD delete.txt",
    );
    await expect(readFile(join(root, "nested/new.txt"), "utf8")).resolves.toBe(
      "created\n",
    );
    await expect(readFile(join(root, "modify.txt"), "utf8")).resolves.toBe(
      "line1\nchanged\n",
    );
    await expect(stat(join(root, "delete.txt"))).rejects.toThrow();
  });

  test("moves updated files in-process", async () => {
    await mkdir(join(root, "old"), { recursive: true });
    await writeFile(join(root, "old/name.txt"), "old content\n", "utf8");
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: old/name.txt\n" +
        "*** Move to: renamed/dir/name.txt\n" +
        "@@\n" +
        "-old content\n" +
        "+new content\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "Success. Updated the following files:\nM renamed/dir/name.txt",
    );
    await expect(readFile(join(root, "renamed/dir/name.txt"), "utf8")).resolves.toBe(
      "new content\n",
    );
    await expect(stat(join(root, "old/name.txt"))).rejects.toThrow();
  });

  test("appends pure-addition update hunks at end of file", async () => {
    await writeFile(join(root, "modify.txt"), "line1\nline2\n", "utf8");
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: modify.txt\n" +
        "@@ line1\n" +
        "+line3\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(join(root, "modify.txt"), "utf8")).resolves.toBe(
      "line1\nline2\nline3\n",
    );
  });

  test("matches hunks despite trailing whitespace in the file", async () => {
    await writeFile(join(root, "ws.txt"), "foo   \nbar\n", "utf8");
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: ws.txt\n" +
        "@@\n" +
        "-foo\n" +
        "+FOO\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(join(root, "ws.txt"), "utf8")).resolves.toBe(
      "FOO\nbar\n",
    );
  });

  test("matches hunks authored with ASCII dashes against typographic dashes", async () => {
    await writeFile(
      join(root, "unicode.py"),
      "import asyncio  # local import – avoids top‑level dep\n",
      "utf8",
    );
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: unicode.py\n" +
        "@@\n" +
        "-import asyncio  # local import - avoids top-level dep\n" +
        "+import asyncio  # HELLO\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(join(root, "unicode.py"), "utf8")).resolves.toBe(
      "import asyncio  # HELLO\n",
    );
  });

  test("unwraps heredoc-style patch wrappers", async () => {
    await writeFile(join(root, "heredoc.txt"), "before\n", "utf8");
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "<<'EOF'\n" +
        "*** Begin Patch\n" +
        "*** Update File: heredoc.txt\n" +
        "@@\n" +
        "-before\n" +
        "+after\n" +
        "*** End Patch\n" +
        "EOF",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    await expect(readFile(join(root, "heredoc.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
  });

  test("accepts the alternate JSON input key", async () => {
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "Success. Updated the following files:\nA new.txt\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      input:
        "*** Begin Patch\n" +
        "*** Add File: nested/new.txt\n" +
        "+created\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.stringContaining("*** Add File: nested/new.txt"),
      }),
    );
  });

  test("normalizes a missing End Patch envelope marker", async () => {
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "Success. Updated the following files:\nA new.txt\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: nested/new.txt\n" +
        "+created\n",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        patch:
          "*** Begin Patch\n" +
          "*** Add File: nested/new.txt\n" +
          "+created\n" +
          "*** End Patch",
      }),
    );
  });

  test("normalizes unprefixed Add File body lines", async () => {
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "Success. Updated the following files:\nA CMakeLists.txt\n",
      stderr: "",
      exitCode: 0,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: CMakeLists.txt\n" +
        "cmake_minimum_required(VERSION 3.16)\n" +
        "@@ literal content, not an update hunk\n" +
        "project(agenc-shell)\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        patch:
          "*** Begin Patch\n" +
          "*** Add File: CMakeLists.txt\n" +
          "+cmake_minimum_required(VERSION 3.16)\n" +
          "+@@ literal content, not an update hunk\n" +
          "+project(agenc-shell)\n" +
          "*** End Patch",
      }),
    );
  });

  test("repairs plus-prefixed patch markers after malformed Add File sections", async () => {
    await writeFile(join(root, "modify.txt"), "old\n", "utf8");
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: first.txt\n" +
        "+one\n" +
        "+*** Add File: second.txt\n" +
        "+two\n" +
        "+*** Update File: modify.txt\n" +
        "+@@\n" +
        "+-old\n" +
        "++new\n" +
        "+*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "Success. Updated the following files:\nA first.txt\nA second.txt\nM modify.txt",
    );
    await expect(readFile(join(root, "first.txt"), "utf8")).resolves.toBe(
      "one\n",
    );
    await expect(readFile(join(root, "second.txt"), "utf8")).resolves.toBe(
      "two\n",
    );
    await expect(readFile(join(root, "modify.txt"), "utf8")).resolves.toBe(
      "new\n",
    );
  });

  test("rejects git unified diffs with codex's verbatim Begin Patch parser error", async () => {
    // Codex parity: the AgenC-invented `looksLikeGitUnifiedDiff` early-return
    // is gone. Codex's parser does not special-case git diffs — they fail
    // the same validate_patch_markers check as any other malformed input,
    // returning the verbatim parser error string from
    // `codex-rs/apply-patch/src/parser.rs:289-291` with the codex handler
    // prefix `"apply_patch verification failed: "` from
    // `core/src/tools/handlers/apply_patch.rs:448-450`.
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "diff --git a/CMakeLists.txt b/CMakeLists.txt\n" +
        "--- a/CMakeLists.txt\n" +
        "+++ b/CMakeLists.txt\n" +
        "@@\n" +
        "-old\n" +
        "+new\n",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "apply_patch verification failed: The first line of the patch must be '*** Begin Patch'",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  test("tolerates leading whitespace on the *** End Patch terminator (codex parser parity)", async () => {
    // The Grok failure pattern from session conv-mof0lxho: model emitted
    // ` *** End Patch` (leading space) because the surrounding hunk lines
    // also start with whitespace. Codex's parser uses `.trim()` on the
    // first/last marker lines (`apply-patch/src/parser.rs:282-283`), so
    // the patch is accepted; AgenC's previous strict `===` check rejected
    // it and the model retried 12 times.
    const runner = vi.fn<ApplyPatchRunner>().mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: untouched.txt\n" +
        "@@\n" +
        " alpha\n" +
        "-beta\n" +
        "+gamma\n" +
        " *** End Patch", // leading space — codex tolerates, AgenC must too
      cwd: root,
    });

    // The parser-level marker check passes; the call proceeds to the
    // runner. (Whether the runner subsequently succeeds depends on the
    // hunk content; the assertion here is just that the marker check
    // does NOT reject with the parse error.)
    expect(result.content).not.toContain(
      "The last line of the patch must be '*** End Patch'",
    );
  });

  test("rejects absolute patch paths", async () => {
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        `*** Add File: ${join(root, "absolute.txt")}\n` +
        "+blocked\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("patch paths must be relative");
    expect(runner).not.toHaveBeenCalled();
  });

  test("rejects patch targets outside allowed roots", async () => {
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Add File: ../outside.txt\n" +
        "+blocked\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
    expect(runner).not.toHaveBeenCalled();
  });

  test("passes update patches through and returns runner failures", async () => {
    await writeFile(join(root, "target.txt"), "old\n", "utf8");
    const runner = vi.fn<ApplyPatchRunner>(async () => ({
      stdout: "",
      stderr: "Failed to find expected lines",
      exitCode: 1,
    }));
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: target.txt\n" +
        "@@\n" +
        "-missing\n" +
        "+new\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to find expected lines");
    expect(runner).toHaveBeenCalledOnce();
  });

  test("validates move destinations", async () => {
    await mkdir(join(root, "old"), { recursive: true });
    await writeFile(join(root, "old/name.txt"), "old\n", "utf8");
    const runner = vi.fn<ApplyPatchRunner>();
    const tool = createApplyPatchTool({ allowedPaths: [root], runner });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: old/name.txt\n" +
        "*** Move to: ../renamed.txt\n" +
        "@@\n" +
        "-old\n" +
        "+new\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("patch target is outside allowed directories");
    expect(runner).not.toHaveBeenCalled();
  });

  test("matches and updates a file written with CRLF line endings", async () => {
    // Files authored on Windows / from clipboard often have CRLF; the
    // patch text from the model is LF. Without normalizing the file's
    // endings before seek, every fallback (rstrip/trim/unicode) fails
    // because the file's lines end with \r and the pattern's don't.
    await writeFile(
      join(root, "crlf.txt"),
      "alpha\r\nbeta\r\ngamma\r\n",
      "utf8",
    );
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: crlf.txt\n" +
        "@@\n" +
        " alpha\n" +
        "-beta\n" +
        "+BETA\n" +
        " gamma\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    const written = await readFile(join(root, "crlf.txt"), "utf8");
    // Original CRLF endings preserved on write.
    expect(written).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  test("recovers from missing space prefix on context lines (lenient parse)", async () => {
    // A common model authoring mistake: writing context lines without
    // the leading space that the patch grammar requires. Strict parsers
    // reject this with "Every line should start with ' ', '+', or '-'",
    // and the model usually responds by giving up and rewriting the
    // whole file. Lenient parse treats unprefixed lines as context with
    // an implicit space; the seek path's whitespace-tolerant fallbacks
    // validate the match.
    await writeFile(
      join(root, "ast.h"),
      "#ifndef AGENC_AST_H\n#define AGENC_AST_H 1\n#endif\n",
      "utf8",
    );
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: ast.h\n" +
        "@@\n" +
        // Note: NO leading space on context lines — the model's typical mistake.
        "#ifndef AGENC_AST_H\n" +
        "-#define AGENC_AST_H 1\n" +
        "+#define AGENC_AST_H 2\n" +
        "#endif\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBeUndefined();
    const written = await readFile(join(root, "ast.h"), "utf8");
    expect(written).toBe("#ifndef AGENC_AST_H\n#define AGENC_AST_H 2\n#endif\n");
  });

  test("seek failure error matches codex's verbatim 'Failed to find expected lines' format", async () => {
    // Verbatim from codex `apply-patch/src/lib.rs:518-522`:
    //   "Failed to find expected lines in {path}:\n{old_lines.join('\n')}"
    // The previous AgenC enhancement (Patch expected / File contents around
    // line / Hints) was a deliberate divergence. Removed for codex parity.
    await writeFile(
      join(root, "target.txt"),
      "first\nsecond\nthird\n",
      "utf8",
    );
    const tool = createApplyPatchTool({ allowedPaths: [root] });

    const result = await tool.execute({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: target.txt\n" +
        "@@\n" +
        " first\n" +
        "-NOT-IN-FILE\n" +
        "+replacement\n" +
        " third\n" +
        "*** End Patch",
      cwd: root,
    });

    expect(result.isError).toBe(true);
    const message = String(result.content);
    // Codex error format: "Failed to find expected lines in <path>:\n<lines>"
    expect(message).toContain("Failed to find expected lines in");
    expect(message).toContain("target.txt");
    expect(message).toContain("first\nNOT-IN-FILE\nthird");
    // The AgenC-specific diagnostic chrome must NOT be present.
    expect(message).not.toContain("apply_patch: failed to locate");
    expect(message).not.toContain("Patch expected");
    expect(message).not.toContain("File contents around line");
    expect(message).not.toContain("Hints:");
  });

  // ─────────────────────────────────────────────────────────────────────
  // Read-before-write enforcement (openclaude FileEditTool parity:
  // FileEditTool.ts:276-286, prompt.ts:4-8). The structural rule that
  // makes models self-correct: cannot patch an existing file unless
  // the model has called system.readFile on it earlier in the session.
  // ─────────────────────────────────────────────────────────────────────

  describe("read-before-write enforcement", () => {
    const sessionId = "test-session-rbw";

    afterEach(() => {
      clearSessionReadState(sessionId);
    });

    test("rejects Update File when target was not previously read in the session", async () => {
      await writeFile(join(root, "untouched.txt"), "alpha\nbeta\n", "utf8");
      const tool = createApplyPatchTool({ allowedPaths: [root] });
      const result = await tool.execute({
        patch:
          "*** Begin Patch\n" +
          "*** Update File: untouched.txt\n" +
          "@@\n" +
          " alpha\n" +
          "-beta\n" +
          "+gamma\n" +
          "*** End Patch",
        cwd: root,
        __agencSessionId: sessionId,
      });
      expect(result.isError).toBe(true);
      const message = String(result.content);
      expect(message).toContain("file must be fully read before patching");
      expect(message).toContain("untouched.txt");
      expect(message).toContain("system.readFile");
      // Tool name must be the prerequisite step, not "apply_patch retry".
      expect(message).toContain("re-issue the apply_patch call");
      // The file must NOT have been modified.
      const after = await readFile(join(root, "untouched.txt"), "utf8");
      expect(after).toBe("alpha\nbeta\n");
    });

    test("allows Update File once the target has been read in the session", async () => {
      const path = join(root, "ready.txt");
      const content = "alpha\nbeta\n";
      await writeFile(path, content, "utf8");
      // Simulate a prior `system.readFile` (full read) for this session.
      seedSessionReadState(sessionId, [
        { path, content, viewKind: "full" },
      ]);
      const tool = createApplyPatchTool({ allowedPaths: [root] });
      const result = await tool.execute({
        patch:
          "*** Begin Patch\n" +
          "*** Update File: ready.txt\n" +
          "@@\n" +
          " alpha\n" +
          "-beta\n" +
          "+gamma\n" +
          "*** End Patch",
        cwd: root,
        __agencSessionId: sessionId,
      });
      expect(result.isError).toBeUndefined();
      const after = await readFile(path, "utf8");
      expect(after).toBe("alpha\ngamma\n");
    });

    test("Add File does not require a prior read (creating new files is exempt)", async () => {
      const tool = createApplyPatchTool({ allowedPaths: [root] });
      const result = await tool.execute({
        patch:
          "*** Begin Patch\n" +
          "*** Add File: brand-new.txt\n" +
          "+hello\n" +
          "*** End Patch",
        cwd: root,
        __agencSessionId: sessionId,
      });
      expect(result.isError).toBeUndefined();
      const after = await readFile(join(root, "brand-new.txt"), "utf8");
      expect(after).toBe("hello\n");
    });

    test("Update File targeting a non-existent path skips the read check (parser failure surfaces later with a clearer error)", async () => {
      const tool = createApplyPatchTool({ allowedPaths: [root] });
      const result = await tool.execute({
        patch:
          "*** Begin Patch\n" +
          "*** Update File: does-not-exist.txt\n" +
          "@@\n" +
          " whatever\n" +
          "*** End Patch",
        cwd: root,
        __agencSessionId: sessionId,
      });
      // Should fail — but NOT with the read-before-write error. The
      // downstream "Failed to read file to update" error is more useful.
      expect(result.isError).toBe(true);
      const message = String(result.content);
      expect(message).not.toContain("must be fully read before patching");
    });

    test("headless / no-session-id calls bypass the gate (test fixtures, embedded contexts)", async () => {
      // Existing tests don't pass __agencSessionId; the gate must
      // remain a no-op for them so headless dispatch keeps working.
      await writeFile(join(root, "headless.txt"), "alpha\nbeta\n", "utf8");
      const tool = createApplyPatchTool({ allowedPaths: [root] });
      const result = await tool.execute({
        patch:
          "*** Begin Patch\n" +
          "*** Update File: headless.txt\n" +
          "@@\n" +
          " alpha\n" +
          "-beta\n" +
          "+gamma\n" +
          "*** End Patch",
        cwd: root,
        // No __agencSessionId.
      });
      expect(result.isError).toBeUndefined();
      const after = await readFile(join(root, "headless.txt"), "utf8");
      expect(after).toBe("alpha\ngamma\n");
    });
  });
});
