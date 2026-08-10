import { describe, expect, it } from "vitest";

import { formatStructuredToolResult } from "./session-transcript.js";

/**
 * A successful Skill load returns the entire skill prompt as the tool result
 * — instructions for the model, not conversation. Rendering it verbatim
 * buried the chat under 12k+ characters on every invocation (user report:
 * "the tui shows me the complete iot builder prompt"). The transcript shows
 * a one-line receipt instead; failures keep their short verbatim errors.
 */
describe("Skill tool results render as a receipt, not the whole prompt", () => {
  it("collapses a successful load to one line", () => {
    const guide =
      "<command-name>iot-builder</command-name>\n" +
      "Base directory for this skill: /tmp/x\n\n# IoT builder\n" +
      "## 1. Identify the hardware — by measuring, not by recalling\n" +
      "x".repeat(8000);
    const blocks = formatStructuredToolResult("Skill", "tool_call_completed", {
      result: guide,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain("Loaded skill iot-builder");
    expect(blocks[0]!.text.length).toBeLessThan(120);
    expect(blocks[0]!.text).not.toContain("Identify the hardware");
  });

  it("leaves failed loads verbatim so the error stays visible", () => {
    const blocks = formatStructuredToolResult("Skill", "tool_call_completed", {
      result: '{"error":"skill not found: nope","available":["iot-builder"]}',
    });

    expect(blocks.map((b) => b.text).join("\n")).toContain(
      "skill not found: nope",
    );
  });

  it("does not touch other tools' results", () => {
    const blocks = formatStructuredToolResult("FileRead", "tool_call_completed", {
      result: { content: "<command-name>decoy</command-name>", path: "/x" },
    });

    expect(blocks.map((b) => b.text).join("\n")).not.toContain("Loaded skill");
  });
});
