import { describe, expect, it } from "vitest";

import { clampGenericToolResult } from "../../src/tui/session-transcript.js";
import { summarizeResultText } from "../../src/tui/tool-rendering.js";
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
