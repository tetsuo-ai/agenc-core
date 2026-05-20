import React from "react";
import { describe, expect, test } from "vitest";

import type { NormalizedMessage } from "../../types/message.js";
import { renderToString } from "../../utils/staticRender.js";
import { Box } from "../ink.js";
import { MessageTimestamp } from "./MessageTimestamp.js";

function assistantMessage(
  content: Array<Record<string, unknown>>,
  timestamp?: string,
): NormalizedMessage {
  return {
    message: { content },
    timestamp,
    type: "assistant",
    uuid: `assistant-${timestamp ?? "missing"}`,
  } as NormalizedMessage;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("MessageTimestamp wave200 coverage", () => {
  test("renders only transcript assistant text messages with a formatted timestamp", async () => {
    const timestamp = new Date(2026, 4, 20, 9, 4).toISOString();
    const expectedTimestamp = new Date(timestamp).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const output = await renderToString(
      <Box flexDirection="column">
        <MessageTimestamp
          message={assistantMessage([{ text: "not transcript", type: "text" }], timestamp)}
          isTranscriptMode={false}
        />
        <MessageTimestamp
          message={assistantMessage([{ text: "missing timestamp", type: "text" }])}
          isTranscriptMode={true}
        />
        <MessageTimestamp
          message={{
            message: { content: [{ text: "not assistant", type: "text" }] },
            timestamp,
            type: "user",
            uuid: "user-message",
          } as NormalizedMessage}
          isTranscriptMode={true}
        />
        <MessageTimestamp
          message={assistantMessage(
            [{ id: "tool-use", input: {}, name: "Read", type: "tool_use" }],
            timestamp,
          )}
          isTranscriptMode={true}
        />
        <MessageTimestamp
          message={assistantMessage(
            [
              { id: "first-tool", input: {}, name: "Read", type: "tool_use" },
              { text: "shown", type: "text" },
            ],
            timestamp,
          )}
          isTranscriptMode={true}
        />
      </Box>,
      { columns: 40 },
    );

    expect(output).toContain(expectedTimestamp);
    expect(output.match(new RegExp(escapeRegExp(expectedTimestamp), "g"))).toHaveLength(1);
  });
});
