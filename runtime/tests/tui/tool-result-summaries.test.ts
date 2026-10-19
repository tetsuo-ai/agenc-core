import { describe, expect, it } from "vitest";

import { clampGenericToolResult, formatStructuredToolResult } from "../../src/tui/session-transcript.js";
import { createTuiTool, summarizeResultText } from "../../src/tui/tool-rendering.js";
import { pickToolResultDispatch } from "../../src/tui/tool-result-routing.js";
import { summarizeToolError } from "../../src/tui/tool-error-text.js";

// A shell command whose long output ends in its failure, as the daemon sends
// it (recorded from a DeepSeek run): 64 output lines, then the exit trailer.
const failingShell = [
  "#!/usr/bin/env node",
  ...Array.from({ length: 62 }, (_, i) => `const line${i} = ${i};`),
  "zsh:1: === not found",
  "",
  "",
  "[exec exit_code=1 wall_time=0.1130s tokens=559]",
].join("\n");

describe("clampGenericToolResult", () => {
  it("keeps a shell result's last line and exit trailer", () => {
    const clamped = clampGenericToolResult(failingShell);

    expect(clamped).toBe(
      [
        "#!/usr/bin/env node",
        "… +62 more lines (ctrl+o for the full result)",
        "zsh:1: === not found",
        "",
        "[exec exit_code=1 wall_time=0.1130s tokens=559]",
      ].join("\n"),
    );
    expect(pickToolResultDispatch("exec_command", clamped)).toBe("bash-output-view");
    expect(summarizeToolError(clamped)).toBe("exit 1, zsh:1: === not found");
  });

  it("keeps only the head of other long results", () => {
    const text = Array.from({ length: 40 }, (_, i) => `row ${i} with some words`).join("\n");

    expect(clampGenericToolResult(text)).toBe(
      "row 0 with some words\n… +39 more lines (ctrl+o for the full result)",
    );
  });

  it("cuts one long line by characters", () => {
    const text = "x".repeat(250);

    expect(clampGenericToolResult(text)).toBe(
      `${"x".repeat(200)}\n… +50 more characters (ctrl+o for the full result)`,
    );
  });

  it("leaves short results alone", () => {
    expect(clampGenericToolResult("ok\n\n[exec exit_code=0]")).toBe("ok\n\n[exec exit_code=0]");
  });
});

describe("summarizeResultText", () => {
  it("counts hidden lines and never shows the clamp marker", () => {
    const body = clampGenericToolResult(failingShell).split("\n\n[exec")[0]!;

    expect(summarizeResultText(body)).toBe("64 lines");
  });

  it("shows a single short line as itself", () => {
    expect(summarizeResultText("py_compile OK")).toBe("py_compile OK");
    expect(summarizeResultText("")).toBe("no output");
  });

  it("counts a character clamp as one line", () => {
    expect(summarizeResultText(clampGenericToolResult("y".repeat(250)))).toBe("1 line");
  });
});

describe("summarizeToolError", () => {
  it("keeps the Node diagnostic in the daemon error-result projection", () => {
    const raw = "exec_command error\nevalmachine.<anonymous>:113\n  els.input.focus();\n            ^\n\nTypeError: els.input.focus is not a function\n    at evalmachine.<anonymous>:113:13\n\nNode.js v26.5.0\n\n[exec exit_code=1 wall_time=0.1230s tokens=253]";
    const projected = formatStructuredToolResult("exec_command", "tool_call_completed", { result: raw, isError: true });
    expect(summarizeToolError(projected.map(block => block.text).join("\n")))
      .toBe("exit 1, TypeError: els.input.focus is not a function");
    expect(projected[0]!.text).toContain("Node.js v26.5.0");
  });

  it("drops protocol wrappers and machine prefixes", () => {
    expect(
      summarizeToolError(
        "<tool_use_error>InputValidationError: shell_workspace_file_write_disallowed: shell commands may not write workspace files</tool_use_error>",
      ),
    ).toBe("shell commands may not write workspace files");
  });

  it("never reads the clamp marker as the reason", () => {
    expect(
      summarizeToolError(
        "first line\n… +12 more lines (ctrl+o for the full result)",
      ),
    ).toBe("first line");
  });
});

describe("readable unknown tool rows", () => {
  it("decodes nested error envelopes into a readable line", () => {
    const raw = JSON.stringify({ tool_use_id: "unknown", is_error: true, content: "<tool_use_error>Error: No such tool available: UnknownMystery</tool_use_error>" });
    expect(summarizeToolError(raw)).toBe("Error: No such tool available: UnknownMystery");
    expect(summarizeToolError(JSON.stringify({ error: { message: "Missing file", code: "ENOENT" } }))).toBe("Missing file");
    expect(summarizeToolError(JSON.stringify({ debug: { unsafe: "machine details" } }))).toBe("Tool execution failed");
  });
  it("summarizes unknown arguments without JSON braces or nested payloads", () => {
    const tool = createTuiTool("UnknownMystery");
    expect(tool.renderToolUseMessage({ path: "/ws/read.txt", payload: { debug: "machine details" } })).toBe("/ws/read.txt");
    expect(tool.renderToolUseMessage({ count: 2, enabled: true, payload: { debug: "machine details" } })).toBe("count=2 enabled=true");
  });
});

describe("Read alias result projection", () => {
  it("preserves the actual read line count instead of counting a generic preview", () => {
    const result = Array.from({ length: 230 }, (_, index) => `${490 + index}→SAFE_LINE_${490 + index}`).join("\n");
    expect(formatStructuredToolResult("Read", "tool_call_completed", { result, metadata: { numLines: 230 }, isError: false })).toEqual([{ type: "text", text: "<read-lines>1-230</read-lines>" }]);
  });
});
