import React from "react";
import { expect, it } from "vitest";
import { formatStructuredToolResult, makeToolResultMessage } from "../../src/tui/session-transcript.js";
import { createTuiTool } from "../../src/tui/tool-rendering.js";
import { renderToString } from "../../src/utils/staticRender.js";
it("retains all 200 shell output lines for the expanded transcript", async () => {
  const stdout = Array.from({ length: 200 }, (_, index) => String(index + 1)).join("\n");
  const result = formatStructuredToolResult("exec_command", "tool_result", { result: `${stdout}\n\n[exec exit_code=0]` });
  const message = makeToolResultMessage("seq", result);
  const content = message.message.content[0].content;
  const text = content.map((block: { text: string }) => block.text).join("\n");
  expect(text).toContain("99\n100\n101");
  expect(text).not.toContain("198 more");
  const expanded = await renderToString(createTuiTool("exec_command").renderToolResultMessage(content, undefined, { verbose: true }) as React.ReactNode, { columns: 180, rows: 250 });
  expect(expanded).toContain("100");
  expect(expanded).toContain("200");
});
