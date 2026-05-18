import { describe, expect, it } from "vitest";

import type { LLMMessage } from "../../llm/types.js";
import { llmMessageToAgentSummaryMessage } from "./transcript.js";

describe("AgentSummary transcript conversion", () => {
  it("preserves malformed tool-call JSON as raw arguments", () => {
    const converted = llmMessageToAgentSummaryMessage(
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-malformed", name: "Read", arguments: '{"path":' },
        ],
      },
      0,
    );

    expect(converted.message.content).toEqual([
      expect.objectContaining({
        type: "tool_use",
        id: "call-malformed",
        input: { arguments: '{"path":' },
      }),
    ]);
  });

  it("preserves non-object JSON tool arguments as raw arguments", () => {
    const converted = llmMessageToAgentSummaryMessage(
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-array", name: "Read", arguments: '["not-object"]' },
        ],
      },
      0,
    );

    expect(converted.message.content).toEqual([
      expect.objectContaining({
        type: "tool_use",
        id: "call-array",
        input: { arguments: '["not-object"]' },
      }),
    ]);
  });

  it("keeps assistant text before assistant tool uses", () => {
    const converted = llmMessageToAgentSummaryMessage(
      {
        role: "assistant",
        content: "I will inspect it.",
        toolCalls: [
          {
            id: "call-read",
            name: "Read",
            arguments: '{"file_path":"src/index.ts"}',
          },
        ],
      },
      0,
    );

    expect(converted.message.content).toEqual([
      { type: "text", text: "I will inspect it." },
      expect.objectContaining({
        type: "tool_use",
        id: "call-read",
        input: { file_path: "src/index.ts" },
      }),
    ]);
  });

  it("converts tool messages with array content into text tool results", () => {
    const toolMessage: LLMMessage = {
      role: "tool",
      toolCallId: "call-read",
      toolName: "Read",
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
        { type: "image_url", image_url: { url: "file:///tmp/shot.png" } },
      ],
    };

    const converted = llmMessageToAgentSummaryMessage(toolMessage, 0);

    expect(converted.message).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-read",
          content: [{ type: "text", text: "line one\nline two" }],
          name: "Read",
        },
      ],
    });
  });
});
