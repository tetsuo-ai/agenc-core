import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { unknownToolResult } from "../../src/tools/results.js";

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("unknownToolResult", () => {
  test("refuses before any effect and brands the result as confirmed_no_effect", () => {
    const result = unknownToolResult("Read", "call-1");
    const envelope = JSON.parse(String(result.content)) as {
      tool_use_id: string;
      is_error: boolean;
      content: string;
    };

    expect(result.isError).toBe(true);
    expect(envelope).toEqual({
      tool_use_id: "call-1",
      is_error: true,
      content: "<tool_use_error>Error: No such tool available: Read</tool_use_error>",
    });
    expect(result.effectDisposition).toEqual({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef: "tool:Read:unknown_tool",
      evidenceSha256: sha256Utf8(String(result.content)),
    });
    expect(result.metadata).toEqual({
      recoverable: true,
      hiddenFromTranscript: true,
      kind: "input_validation",
      preflightCode: "unknown_tool",
    });
  });

  test("names the closest offered tool without instructing the model", () => {
    const result = unknownToolResult("Read", "call-2", { name: "FileRead" });
    const envelope = JSON.parse(String(result.content)) as { content: string };

    expect(envelope.content).toContain("The closest available tool is FileRead");
    expect(envelope.content).toContain("which has its own parameters");
    expect(envelope.content).not.toContain("loads it");
    expect(result.effectDisposition?.evidenceRef).toBe("tool:Read:unknown_tool");
    expect(result.effectDisposition?.evidenceSha256).toBe(
      sha256Utf8(String(result.content)),
    );
  });

  test("points at the search tool that loads a deferred schema", () => {
    const result = unknownToolResult("Read", "call-3", {
      name: "FileRead",
      loadWith: "ToolSearch",
    });
    const envelope = JSON.parse(String(result.content)) as { content: string };

    expect(envelope.content).toContain(
      "Its schema is not loaded yet; ToolSearch with select:FileRead loads it.",
    );
    expect(result.metadata?.preflightCode).toBe("unknown_tool");
  });
});
