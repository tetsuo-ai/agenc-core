import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAtMentionAttachments } from "./at-mention-attachments.js";

describe("resolveAtMentionAttachments", () => {
  it("expands @-mentioned workspace files into synthetic file-read prelude", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-at-mention-"));
    const planPath = join(workspaceRoot, "PLAN.md");
    writeFileSync(planPath, "# Plan\nBuild the shell in C.\n", "utf8");

    const resolved = await resolveAtMentionAttachments({
      content: "Read @PLAN.md and implement it.",
      workspaceRoot,
    });

    expect(resolved.sourceArtifacts).toEqual([planPath]);
    expect(resolved.executionEnvelope?.requiredSourceArtifacts).toEqual([planPath]);
    expect(resolved.historyPrelude).toHaveLength(2);
    expect(resolved.historyPrelude[0]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          name: "system.readFile",
        },
      ],
    });
    expect(resolved.historyPrelude[1]).toMatchObject({
      role: "tool",
      toolName: "system.readFile",
      toolCallId: "at_mention_file_1",
    });
    expect(String(resolved.historyPrelude[1]?.content)).toContain(
      "Build the shell in C.",
    );
    expect(resolved.readSeeds).toEqual([
      expect.objectContaining({
        path: planPath,
        content: "# Plan\nBuild the shell in C.\n",
        viewKind: "full",
      }),
    ]);
    expect(resolved.anchorRegistrations).toHaveLength(1);
    expect(resolved.anchorRegistrations[0]).toMatchObject({
      path: planPath,
      content: "# Plan\nBuild the shell in C.\n",
      source: "user_mention",
      sizeBytes: Buffer.byteLength("# Plan\nBuild the shell in C.\n", "utf8"),
    });
    expect(resolved.anchorRegistrations[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns empty anchorRegistrations when no @mention is present", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-at-mention-"));
    const resolved = await resolveAtMentionAttachments({
      content: "Plain message with no mentions.",
      workspaceRoot,
    });
    expect(resolved.anchorRegistrations).toEqual([]);
  });

  it("records partial-view anchor when a line range is mentioned", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-at-mention-"));
    const planPath = join(workspaceRoot, "PLAN.md");
    writeFileSync(
      planPath,
      "line 1\nline 2\nline 3\nline 4\n",
      "utf8",
    );

    const resolved = await resolveAtMentionAttachments({
      content: "Read @PLAN.md#L2-3 for context.",
      workspaceRoot,
    });

    expect(resolved.anchorRegistrations).toHaveLength(1);
    expect(resolved.anchorRegistrations[0]).toMatchObject({
      path: planPath,
      lineStart: 2,
      lineEnd: 3,
      source: "user_mention",
    });
    expect(resolved.anchorRegistrations[0]?.content).toBe("line 2\nline 3");
  });
});
