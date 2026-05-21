import React, { useLayoutEffect, useState } from "react";
import { describe, expect, test } from "vitest";

import { MessageTimestamp } from "../../../src/tui/components/MessageTimestamp.js";
import { renderToString } from "../../../src/utils/staticRender.js";

const TIMESTAMP = "2026-05-20T18:07:00.000Z";

function expectedTimestamp(timestamp = TIMESTAMP): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
  });
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      content: [
        { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
        { text: "visible response", type: "text" },
      ],
    },
    timestamp: TIMESTAMP,
    type: "assistant",
    uuid: "assistant-1",
    ...overrides,
  };
}

async function renderTimestamp(
  message: Record<string, unknown>,
  isTranscriptMode = true,
): Promise<string> {
  return renderToString(
    <MessageTimestamp
      isTranscriptMode={isTranscriptMode}
      message={message as never}
    />,
    { columns: 80 },
  );
}

function RerenderSameTimestamp() {
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    if (count === 0) setCount(1);
  }, [count]);

  return (
    <MessageTimestamp
      isTranscriptMode={true}
      message={assistantMessage({ uuid: `assistant-${count}` }) as never}
    />
  );
}

describe("MessageTimestamp coverage swarm 164", () => {
  test("renders formatted assistant timestamps only in transcript mode with text content", async () => {
    const output = await renderTimestamp(assistantMessage());

    expect(output).toContain(expectedTimestamp());
  });

  test("hides timestamps outside every required visibility condition", async () => {
    const cases = [
      {
        isTranscriptMode: false,
        message: assistantMessage(),
      },
      {
        isTranscriptMode: true,
        message: assistantMessage({ timestamp: undefined }),
      },
      {
        isTranscriptMode: true,
        message: assistantMessage({ type: "user" }),
      },
      {
        isTranscriptMode: true,
        message: assistantMessage({
          message: {
            content: [
              { id: "tool-1", input: {}, name: "Read", type: "tool_use" },
              { thinking: "private", type: "thinking" },
            ],
          },
        }),
      },
    ];

    for (const { isTranscriptMode, message } of cases) {
      const output = await renderTimestamp(message, isTranscriptMode);

      expect(output.trim()).toBe("");
    }
  });

  test("keeps cached timestamp output stable across same-timestamp rerenders", async () => {
    const output = await renderToString(<RerenderSameTimestamp />, {
      columns: 80,
    });

    expect(output).toContain(expectedTimestamp());
  });
});
