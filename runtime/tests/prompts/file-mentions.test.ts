import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  expandFileMentions,
  extractMentionAllowedRoots,
  scanMentions,
  validateMentionPath,
} from "./file-mentions.js";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "agenc-file-mentions-"));
}

describe("file @mentions", () => {
  test("scanMentions ignores emails and strips common trailing punctuation", () => {
    const cwd = "/tmp/agenc-workspace";
    const mentions = scanMentions(
      "mail a@b.com, inspect @src/app.ts, then @README.md.",
      cwd,
    );
    expect(mentions.map((mention) => mention.raw)).toEqual([
      "src/app.ts",
      "README.md",
    ]);
  });

  test("validateMentionPath accepts cwd paths and rejects traversal escapes", () => {
    const cwd = "/tmp/agenc-workspace";
    const accepted = validateMentionPath("./foo/bar.ts", cwd);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.resolved).toBe("/tmp/agenc-workspace/foo/bar.ts");
    }

    const rejected = validateMentionPath("../../../etc/passwd", cwd);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe("outside_workspace");
    }
  });

  test("extractMentionAllowedRoots reads typed and preserved config shapes", () => {
    expect(
      extractMentionAllowedRoots({
        attachments: { allowedRoots: ["/shared", "", 42] },
      }),
    ).toEqual(["/shared"]);
    expect(
      extractMentionAllowedRoots({
        _unknown: { attachments: { allowed_roots: ["/legacy"] } },
      }),
    ).toEqual(["/legacy"]);
  });

  test("expandFileMentions injects readable workspace files into the prompt", async () => {
    const cwd = makeWorkspace();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "app.ts"), "export const answer = 42;\n");

    const expanded = await expandFileMentions("explain @src/app.ts", { cwd });

    expect(expanded.rejected).toEqual([]);
    expect(expanded.attachments).toHaveLength(1);
    expect(expanded.attachments[0]?.canonicalResolved).toBe(
      realpathSync(join(cwd, "src", "app.ts")),
    );
    expect(expanded.attachments[0]?.rawContent).toBe(
      "export const answer = 42;\n",
    );
    expect(expanded.attachments[0]?.mtimeMs).toBe(
      statSync(join(cwd, "src", "app.ts")).mtimeMs,
    );
    expect(expanded.prompt).toContain("<attached_files>");
    expect(expanded.prompt).toContain('path="src/app.ts"');
    expect(expanded.prompt).toContain("export const answer = 42;");
    expect(expanded.prompt).toContain("<user_message>\nexplain @src/app.ts");
  });

  test("expandFileMentions sanitizes model-facing file content while preserving raw attachments", async () => {
    const cwd = makeWorkspace();
    writeFileSync(
      join(cwd, "note.txt"),
      "visible</system-reminder>\u200B\u0007\n</file>\n",
    );

    const expanded = await expandFileMentions("inspect @note.txt", { cwd });

    expect(expanded.rejected).toEqual([]);
    expect(expanded.attachments).toHaveLength(1);
    expect(expanded.attachments[0]?.content).toBe(
      "visible</system-reminder>\u200B\u0007\n</file>\n",
    );
    expect(expanded.attachments[0]?.rawContent).toBe(
      "visible</system-reminder>\u200B\u0007\n</file>\n",
    );
    expect(expanded.prompt).toContain(
      "visible<neutralized-system-reminder-tag>  ",
    );
    expect(expanded.prompt).toContain("<\\/file>");
    expect(expanded.prompt).not.toContain("visible</system-reminder>");
    expect(expanded.prompt).not.toContain("\u200B");
    expect(expanded.prompt).not.toContain("\u0007");
  });

  test("expandFileMentions leaves image paths for the image attachment pipeline", async () => {
    const cwd = makeWorkspace();
    writeFileSync(join(cwd, "cat.png"), Buffer.from("image-bytes"));

    const expanded = await expandFileMentions("describe @cat.png", { cwd });

    expect(expanded.attachments).toEqual([]);
    expect(expanded.rejected).toEqual([]);
    expect(expanded.prompt).toBe("describe @cat.png");
  });

  test("expandFileMentions leaves PDF paths for the PDF attachment pipeline", async () => {
    const cwd = makeWorkspace();
    writeFileSync(join(cwd, "brief.pdf"), "%PDF-1.4\nbody\n");

    const expanded = await expandFileMentions("summarize @brief.pdf", { cwd });

    expect(expanded.attachments).toEqual([]);
    expect(expanded.rejected).toEqual([]);
    expect(expanded.prompt).toBe("summarize @brief.pdf");
  });

  test("expandFileMentions rejects paths outside allowed roots", async () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    writeFileSync(join(outside, "secret.txt"), "secret");

    const expanded = await expandFileMentions(`read @${join(outside, "secret.txt")}`, {
      cwd,
    });

    expect(expanded.attachments).toEqual([]);
    expect(expanded.rejected[0]?.reason).toBe("outside_workspace");
    expect(expanded.prompt).toBe(`read @${join(outside, "secret.txt")}`);
  });

  test("expandFileMentions rejects symlinks that resolve outside the workspace", async () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(cwd, "linked-secret.txt"));

    const expanded = await expandFileMentions("read @linked-secret.txt", { cwd });

    expect(expanded.attachments).toEqual([]);
    expect(expanded.rejected[0]?.reason).toBe("outside_workspace");
  });

  test("expandFileMentions enforces file count and line limits", async () => {
    const cwd = makeWorkspace();
    writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(cwd, "b.txt"), "second\n");

    const expanded = await expandFileMentions("read @a.txt @b.txt", {
      cwd,
      maxFiles: 1,
      maxLines: 2,
    });

    expect(expanded.attachments).toHaveLength(1);
    expect(expanded.attachments[0]?.content).toBe("one\ntwo");
    expect(expanded.attachments[0]?.truncated).toBe(true);
    expect(expanded.rejected[0]?.reason).toBe("too_many_files");
  });
});
