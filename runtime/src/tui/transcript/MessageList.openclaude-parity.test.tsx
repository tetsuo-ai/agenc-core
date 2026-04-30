import { describe, expect, test } from "vitest";

import {
  transcriptMutationKey,
  truncateUserMessageForDisplay,
  type TranscriptMessage,
} from "./MessageList.js";
import { normalizeTranscriptMessages } from "./normalize.js";
import { transcriptMessageSearchText } from "./content-blocks.js";

function msg(partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "kind">): TranscriptMessage {
  return { turnId: "t1", content: "", timestamp: 0, ...partial };
}

describe("MessageList OpenClaude parity", () => {
  test("normalizes groups while preserving structured search text and mutation keys", () => {
    const rows = normalizeTranscriptMessages([
      msg({
        id: "u1",
        kind: "user",
        content: "visible text",
        userContent: [
          { type: "text", text: "visible text" },
          { type: "image", imageId: 1, imagePath: "/tmp/cat.png" },
        ],
      }),
      msg({
        id: "t1",
        kind: "tool_call",
        toolName: "Read",
        toolArgs: { path: "src/app.ts" },
        isComplete: true,
      }),
      msg({
        id: "t2",
        kind: "tool_call",
        toolName: "Grep",
        toolArgs: { pattern: "needle" },
        isComplete: true,
      }),
    ]);

    expect(rows.some((row) => row.kind === "tool_group")).toBe(true);
    expect(transcriptMessageSearchText(rows[0]!)).toContain("cat.png");
    const changedImageKey = transcriptMutationKey([
      {
        ...rows[0]!,
        userContent: [
          { type: "text", text: "visible text" },
          { type: "image", imageId: 1, imagePath: "/tmp/dog.png" },
        ],
      },
    ]);
    expect(transcriptMutationKey([rows[0]!])).not.toBe(changedImageKey);
  });

  test("keeps prompt display bounded for huge pasted input", () => {
    const rendered = truncateUserMessageForDisplay("x".repeat(12_000));
    expect(rendered.length).toBeLessThan(10_100);
    expect(rendered).toContain("chars omitted");
  });
});
