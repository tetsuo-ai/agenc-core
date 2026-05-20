import React from "react";
import { describe, expect, test } from "vitest";

import { renderToString } from "../../../utils/staticRender.js";
import { UserToolResultMessage } from "./UserToolResultMessage.js";

describe("UserToolResultMessage additional coverage", () => {
  test("renders recovered orphan tool results with mixed content blocks", async () => {
    const output = await renderToString(
      <UserToolResultMessage
        param={{
          type: "tool_result",
          tool_use_id: "toolu_missing",
          content: [
            "plain output",
            { type: "text", text: "text block output" },
            { type: "image", source: { type: "base64", data: "abc" } },
          ],
        }}
        message={{ type: "user", message: { role: "user", content: [] } }}
        lookups={{ toolUseByToolUseID: new Map() }}
        progressMessagesForMessage={[]}
        tools={[]}
        verbose={false}
        width={80}
      />,
      { columns: 100, rows: 24 },
    );

    expect(output).toContain(
      "Tool result recovered without matching tool call:",
    );
    expect(output).toContain("plain output");
    expect(output).toContain("text block output");
    expect(output).toContain(
      '{"type":"image","source":{"type":"base64","data":"abc"}}',
    );
  });
});
