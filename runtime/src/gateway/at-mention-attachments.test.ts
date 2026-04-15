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
  });
});
