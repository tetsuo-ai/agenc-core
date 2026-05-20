import { describe, expect, test } from "vitest";

import {
  computeUnseenDivider,
  countUnseenAssistantTurns,
} from "./FullscreenLayout.js";

function assistantMessage(
  uuid: string,
  content: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    uuid,
    type: "assistant",
    message: {
      content,
    },
  };
}

describe("FullscreenLayout unseen divider coverage", () => {
  test("skips invisible divider anchors while counting only visible assistant turns", () => {
    const messages = [
      {
        uuid: "progress-1",
        type: "progress",
      },
      {
        uuid: "attachment-plan-mode",
        type: "attachment",
        attachment: {
          type: "plan_mode",
        },
      },
      assistantMessage("assistant-tool-only", [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: {},
        },
      ]),
      assistantMessage("assistant-empty-text", [
        {
          type: "text",
          text: "   ",
        },
      ]),
      assistantMessage("assistant-visible-1", [
        {
          type: "text",
          text: "First visible reply",
        },
      ]),
      assistantMessage("assistant-visible-continuation", [
        {
          type: "text",
          text: "same assistant turn",
        },
      ]),
      {
        uuid: "user-tool-result",
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "ok",
            },
          ],
        },
      },
      assistantMessage("assistant-visible-2", [
        {
          type: "text",
          text: "Second visible reply",
        },
      ]),
    ];

    expect(computeUnseenDivider(messages, null)).toBeUndefined();
    expect(computeUnseenDivider(messages.slice(0, 2), 0)).toBeUndefined();
    expect(computeUnseenDivider(messages.slice(0, 3), 0)).toEqual({
      firstUnseenUuid: "assistant-tool-only",
      count: 1,
    });
    expect(computeUnseenDivider(messages, 0)).toEqual({
      firstUnseenUuid: "assistant-tool-only",
      count: 2,
    });
    expect(countUnseenAssistantTurns(messages, 0)).toBe(2);
  });
});
