import { describe, expect, test } from "vitest";

import {
  pickToolResultDispatch,
  resultTextForTuiTool,
} from "../agenc/adapters/upstream-tool-result-dispatch.js";

describe("pickToolResultDispatch — TUI tool routing", () => {
  test("Bash tool with <bash-stdout> envelope routes to bash-output-view", () => {
    const target = pickToolResultDispatch(
      "Bash",
      "<bash-stdout>hello</bash-stdout>[exit_code=0]",
    );
    expect(target).toBe("bash-output-view");
  });

  test("Bash tool with empty <bash-stdout></bash-stdout> envelope still routes to bash-output-view (silent successful command)", () => {
    const target = pickToolResultDispatch(
      "Bash",
      "<bash-stdout></bash-stdout>[exit_code=0]",
    );
    expect(target).toBe("bash-output-view");
  });

  test("Bash tool with no envelope (legacy plain string) falls through to generic — guards the renderer's tag extraction against null", () => {
    const target = pickToolResultDispatch("Bash", "raw legacy string");
    expect(target).toBe("generic");
  });

  test("Bash tool with empty content falls through to generic", () => {
    const target = pickToolResultDispatch("Bash", "");
    expect(target).toBe("generic");
  });

  test("Bash dispatch is exact-case — lowercase 'bash' does NOT route to bash-output-view", () => {
    const target = pickToolResultDispatch(
      "bash",
      "<bash-stdout>hello</bash-stdout>",
    );
    expect(target).toBe("generic");
  });

  test("Unknown tool name with content that happens to contain <bash-stdout> does NOT route to bash-output-view (no substring or prefix matching across tool names)", () => {
    const target = pickToolResultDispatch(
      "XYZUnknown",
      "<bash-stdout>hello</bash-stdout>",
    );
    expect(target).toBe("generic");
  });

  test("Empty tool name does not throw and routes to generic", () => {
    const target = pickToolResultDispatch("", "<bash-stdout>x</bash-stdout>");
    expect(target).toBe("generic");
  });

  test("Edit tool with <edit-diff> envelope routes to edit-diff-view", () => {
    const target = pickToolResultDispatch(
      "Edit",
      "<edit-file>src/foo.ts</edit-file>\n<edit-diff>--- a\n+new</edit-diff>",
    );
    expect(target).toBe("edit-diff-view");
  });

  test("Edit tool without <edit-diff> envelope (legacy / error-path payload) falls through to generic", () => {
    const target = pickToolResultDispatch("Edit", "raw error string");
    expect(target).toBe("generic");
  });

  test("Edit dispatch is exact-case — lowercase 'edit' does NOT route to edit-diff-view", () => {
    const target = pickToolResultDispatch(
      "edit",
      "<edit-diff>diff</edit-diff>",
    );
    expect(target).toBe("generic");
  });

  test("Bash and Edit envelope tags do not cross-route — Edit tool with <bash-stdout> routes to generic, Bash tool with <edit-diff> routes to generic", () => {
    expect(
      pickToolResultDispatch("Edit", "<bash-stdout>x</bash-stdout>"),
    ).toBe("generic");
    expect(pickToolResultDispatch("Bash", "<edit-diff>x</edit-diff>")).toBe(
      "generic",
    );
  });

  test("FileRead with <read-content> envelope routes to file-read-view (live tool name is 'FileRead', NOT 'Read')", () => {
    expect(
      pickToolResultDispatch("FileRead", "<read-content>body</read-content>"),
    ).toBe("file-read-view");
  });

  test("'Read' (the old wrong pre-seed name) does NOT route to file-read-view — even with the correct envelope (canonicalization fix)", () => {
    expect(
      pickToolResultDispatch("Read", "<read-content>body</read-content>"),
    ).toBe("generic");
  });

  test("Write with <write-summary> envelope routes to file-write-view", () => {
    expect(
      pickToolResultDispatch("Write", "<write-summary>Wrote 42 bytes</write-summary>"),
    ).toBe("file-write-view");
  });

  test("Grep with <grep-matches> envelope routes to grep-matches-view", () => {
    expect(
      pickToolResultDispatch("Grep", "<grep-matches>file:1:hit</grep-matches>"),
    ).toBe("grep-matches-view");
  });

  test("Glob with <glob-paths> envelope routes to glob-paths-view", () => {
    expect(
      pickToolResultDispatch("Glob", "<glob-paths>src/foo.ts</glob-paths>"),
    ).toBe("glob-paths-view");
  });

  test("Tool error envelope dispatches to tool-error-view regardless of tool name (cross-cutting error channel)", () => {
    expect(
      pickToolResultDispatch("Bash", "<tool-error>permission denied</tool-error>"),
    ).toBe("tool-error-view");
    expect(
      pickToolResultDispatch("XYZUnknown", "<tool-error>boom</tool-error>"),
    ).toBe("tool-error-view");
    expect(
      pickToolResultDispatch("FileRead", "<tool-error>not found</tool-error>"),
    ).toBe("tool-error-view");
  });

  test("Tool error envelope takes precedence over per-tool envelope when both are present (defensive ordering)", () => {
    expect(
      pickToolResultDispatch(
        "Bash",
        "<bash-stdout>x</bash-stdout><tool-error>but also failed</tool-error>",
      ),
    ).toBe("tool-error-view");
  });

  test("Per-tool envelope dispatch is exact-case for every routed tool (FileRead/Write/Grep/Glob lowercase variants all fall through to generic)", () => {
    expect(
      pickToolResultDispatch("fileread", "<read-content>x</read-content>"),
    ).toBe("generic");
    expect(
      pickToolResultDispatch("write", "<write-summary>x</write-summary>"),
    ).toBe("generic");
    expect(pickToolResultDispatch("grep", "<grep-matches>x</grep-matches>")).toBe(
      "generic",
    );
    expect(pickToolResultDispatch("glob", "<glob-paths>x</glob-paths>")).toBe(
      "generic",
    );
  });

  test("Cross-routing: every per-tool envelope on a non-matching tool name routes to generic", () => {
    expect(
      pickToolResultDispatch("FileRead", "<bash-stdout>x</bash-stdout>"),
    ).toBe("generic");
    expect(
      pickToolResultDispatch("Bash", "<read-content>x</read-content>"),
    ).toBe("generic");
    expect(
      pickToolResultDispatch("Edit", "<glob-paths>x</glob-paths>"),
    ).toBe("generic");
  });
});

describe("resultTextForTuiTool — content shape coercion", () => {
  test("returns strings unchanged", () => {
    expect(resultTextForTuiTool("hello")).toBe("hello");
  });

  test("joins arrays with newlines (recursive)", () => {
    expect(resultTextForTuiTool(["a", "b", "c"])).toBe("a\nb\nc");
  });

  test("flattens the structured-content-block array shape (the shape formatStructuredToolResult produces) by joining .text fields with newlines", () => {
    const blocks = [
      { type: "text", text: "<bash-stdout>line</bash-stdout>" },
      { type: "text", text: "[exit_code=0]" },
    ];
    expect(resultTextForTuiTool(blocks)).toBe(
      "<bash-stdout>line</bash-stdout>\n[exit_code=0]",
    );
  });

  test("extracts the .content field of an object-shaped result", () => {
    expect(resultTextForTuiTool({ content: "extracted" })).toBe("extracted");
  });

  test("falls back to short JSON for arbitrary objects", () => {
    expect(resultTextForTuiTool({ foo: 1, bar: "baz" })).toContain("baz");
  });

  test("never throws on null", () => {
    expect(() => resultTextForTuiTool(null)).not.toThrow();
  });

  test("never throws on undefined", () => {
    expect(() => resultTextForTuiTool(undefined)).not.toThrow();
  });

  test("never throws on a circular-reference object — short JSON has no infinite recursion path", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => resultTextForTuiTool(cyc)).not.toThrow();
  });
});
