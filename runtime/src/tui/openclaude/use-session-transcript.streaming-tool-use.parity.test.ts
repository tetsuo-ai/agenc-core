import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "./message-adapter.js";

const HOOK_SOURCE_PATH = path.resolve(
  import.meta.dirname,
  "use-session-transcript.ts",
);

function readSource(): string {
  return fs.readFileSync(HOOK_SOURCE_PATH, "utf8");
}

describe("R5 useSessionTranscript exposes streamingToolUses on transcript snapshot", () => {
  test("B5.6 use-session-transcript.ts memoizes the adaptTranscriptEvents result, so any field added to AdaptedTranscript (including streamingToolUses) is automatically surfaced to App.tsx", () => {
    const source = readSource();
    expect(source).toMatch(
      /useMemo\s*\(\s*\(\)\s*=>\s*adaptTranscriptEvents\s*\(\s*state\.events\s*,\s*startupMessages\s*\)/,
    );
  });

  test("B5.6 the snapshot returned by adaptTranscriptEvents always has streamingToolUses, including in the no-events case the hook produces on first mount", () => {
    const snapshot = adaptTranscriptEvents([]);
    expect(snapshot).toHaveProperty("streamingToolUses");
    expect(Array.isArray(snapshot.streamingToolUses)).toBe(true);
  });

  test("B5.6 streamingToolUses populated by R5 propagates through the adapt path that the hook memoizes (end-to-end shape check)", () => {
    const snapshot = adaptTranscriptEvents([
      { id: "turn", msg: { type: "turn_started", payload: { turnId: "t1" } } },
      {
        id: "bs",
        msg: {
          type: "tool_input_block_start",
          payload: { callId: "c1", index: 0, toolName: "Bash" },
        },
      },
      {
        id: "d",
        msg: {
          type: "tool_input_delta",
          payload: { callId: "c1", index: 0, partialJson: '{"k":1}' },
        },
      },
    ]);
    expect(snapshot.streamingToolUses).toHaveLength(1);
    expect(snapshot.streamingToolUses[0]?.unparsedToolInput).toBe('{"k":1}');
  });
});
