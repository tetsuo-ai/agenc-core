import { describe, expect, it } from "vitest";

import { approvalInputText } from "../../../src/tui/workbench/approvals/inputText.js";

describe("approvalInputText", () => {
  it("renders empty, primitive, and direct text values", () => {
    expect(approvalInputText(null)).toBe("");
    expect(approvalInputText(undefined)).toBe("");
    expect(approvalInputText("raw input")).toBe("raw input");
    expect(approvalInputText(42)).toBe("42");
    expect(approvalInputText(false)).toBe("false");
    expect(approvalInputText(12n)).toBe("12");
  });

  it("uses the first non-empty text key when no command is present", () => {
    expect(
      approvalInputText({
        input: "",
        query: "rg target",
        path: "src/ignored.ts",
      }),
    ).toBe("rg target");
    expect(approvalInputText({ path: "src/app.ts" })).toBe("src/app.ts");
    expect(approvalInputText({ file_path: "src/file.ts" })).toBe("src/file.ts");
  });

  it("renders split shell command and args as one command line", () => {
    expect(
      approvalInputText({
        command: "rm",
        args: ["-rf", "/tmp/agenc-danger"],
      }),
    ).toBe("rm -rf /tmp/agenc-danger");
  });

  it("renders local-shell argv arrays as one command line", () => {
    expect(
      approvalInputText({
        command: ["bash", "-lc", "rm -rf /tmp/agenc-danger"],
        cwd: "/tmp/agenc",
      }),
    ).toBe("bash -lc rm -rf /tmp/agenc-danger");
  });

  it("does not hide structured command arguments", () => {
    expect(
      approvalInputText({
        command: "bash",
        args: [{ script: "rm -rf /tmp/agenc-danger" }],
      }),
    ).toContain("rm -rf /tmp/agenc-danger");
  });

  it("renders command aliases and non-string command array parts", () => {
    expect(
      approvalInputText({
        cmd: "echo",
        args: [1, true, 3n],
      }),
    ).toBe("echo 1 true 3");
    expect(
      approvalInputText({
        command: ["tool", Symbol("unsafe")],
      }),
    ).toBe("tool Symbol(unsafe)");
  });

  it("does not hide command arguments that JSON cannot represent", () => {
    expect(
      approvalInputText({
        command: "tool",
        args: [Symbol("unsafe")],
      }),
    ).toBe("tool Symbol(unsafe)");
  });

  it("renders scalar arrays and falls back for empty or structured arrays", () => {
    expect(approvalInputText(["echo", 1, false, 2n])).toBe("echo 1 false 2");
    expect(approvalInputText([])).toBe("[]");
    expect(approvalInputText([{ path: "src/app.ts" }])).toBe('[{"path":"src/app.ts"}]');
  });

  it("renders fallback objects with optional pretty JSON", () => {
    expect(approvalInputText({ nested: { value: 1 } })).toBe('{"nested":{"value":1}}');
    expect(approvalInputText({ nested: { value: 1 } }, { prettyJson: true })).toBe([
      "{",
      '  "nested": {',
      '    "value": 1',
      "  }",
      "}",
    ].join("\n"));
  });

  it("falls back to String when JSON serialization throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(approvalInputText(circular)).toBe("[object Object]");
  });
});
