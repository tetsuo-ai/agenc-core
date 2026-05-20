import React from "react";
import { describe, expect, test } from "vitest";

import type { NormalizedMessage } from "../../types/message.js";
import { renderToString } from "../../utils/staticRender.js";
import { MessageModel } from "./MessageModel.js";

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "hello" }],
      model: "gpt-5.4",
      ...overrides,
    },
  } as NormalizedMessage;
}

function RerenderMessageModel({
  message,
  isTranscriptMode,
}: {
  message: NormalizedMessage;
  isTranscriptMode: boolean;
}) {
  const [tick, setTick] = React.useState(0);

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1);
    }
  }, [tick]);

  return (
    <MessageModel
      message={message}
      isTranscriptMode={isTranscriptMode}
    />
  );
}

async function renderModel(
  message: NormalizedMessage,
  isTranscriptMode = true,
) {
  return renderToString(
    <RerenderMessageModel
      message={message}
      isTranscriptMode={isTranscriptMode}
    />,
    80,
  );
}

describe("MessageModel", () => {
  test("renders the assistant model in transcript mode when text content exists", async () => {
    const output = await renderModel(
      assistantMessage({
        content: [
          { type: "tool_use", name: "Read" },
          { type: "text", text: "hello" },
        ],
        model: "gpt-5.4",
      }),
    );

    expect(output).toContain("gpt-5.4");
  });

  test("hides the model outside transcript mode", async () => {
    expect((await renderModel(assistantMessage(), false)).trim()).toBe("");
  });

  test("hides the model for non-assistant messages", async () => {
    const output = await renderModel({
      type: "user",
      message: { content: [{ type: "text", text: "hello" }] },
    } as NormalizedMessage);

    expect(output.trim()).toBe("");
  });

  test("hides the model when the assistant message has no model name", async () => {
    expect(
      (await renderModel(assistantMessage({ model: undefined }))).trim(),
    ).toBe("");
  });

  test("hides the model when the assistant message has no text blocks", async () => {
    const output = await renderModel(
      assistantMessage({
        content: [{ type: "tool_use", name: "Read" }],
      }),
    );

    expect(output.trim()).toBe("");
  });
});
