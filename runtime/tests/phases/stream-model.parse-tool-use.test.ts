import { describe, expect, test } from "vitest";

import type { LLMToolCall } from "../../src/llm/types.js";
import { parseToolUseBlocks } from "../../src/phases/stream-model.js";

function toolCall(
  id: string,
  name: string,
  args: string,
): LLMToolCall {
  return { id, name, arguments: args };
}

describe("parseToolUseBlocks", () => {
  test("returns an empty list for an empty provider batch", () => {
    expect(parseToolUseBlocks([])).toEqual([]);
  });

  test("parses JSON arguments and leaves empty arguments undefined", () => {
    expect(
      parseToolUseBlocks([
        toolCall("c1", "FileRead", '{"path":"/workspace/README.md"}'),
        toolCall("c2", "Grep", ""),
      ]),
    ).toEqual([
      {
        type: "tool_use",
        id: "c1",
        name: "FileRead",
        input: { path: "/workspace/README.md" },
      },
      {
        type: "tool_use",
        id: "c2",
        name: "Grep",
        input: undefined,
      },
    ]);
  });

  test("keeps malformed arguments as the raw string instead of dropping the call", () => {
    const raw = "{not-json";
    expect(parseToolUseBlocks([toolCall("c3", "Edit", raw)])).toEqual([
      {
        type: "tool_use",
        id: "c3",
        name: "Edit",
        input: raw,
      },
    ]);
  });
});
