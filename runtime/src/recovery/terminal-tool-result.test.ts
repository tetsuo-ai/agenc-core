import { describe, expect, test } from "vitest";
import {
  buildTerminalToolResult,
  synthesizeTerminalResults,
} from "./terminal-tool-result.js";

describe("terminal-tool-result", () => {
  test("buildTerminalToolResult by cause", () => {
    const out = buildTerminalToolResult({
      toolCall: { id: "c1", name: "system.readFile", arguments: "{}" },
      cause: "timeout",
      elapsedMs: 30000,
    });
    expect(out.isError).toBe(true);
    expect(out.cause).toBe("timeout");
    expect(out.content).toContain("timed out");
    expect(out.toolCallId).toBe("c1");
  });

  test("synthesizeTerminalResults maps a batch of orphans", () => {
    const orphans = [
      { id: "c1", name: "tool1", arguments: "{}" },
      { id: "c2", name: "tool2", arguments: "{}" },
    ];
    const results = synthesizeTerminalResults(orphans, "aborted");
    expect(results).toHaveLength(2);
    expect(results[0]!.cause).toBe("aborted");
    expect(results[1]!.cause).toBe("aborted");
  });

  test("provider_switched cause text", () => {
    const out = buildTerminalToolResult({
      toolCall: { id: "c1", name: "system.bash", arguments: "{}" },
      cause: "provider_switched",
    });
    expect(out.content).toContain("provider switched");
  });
});
