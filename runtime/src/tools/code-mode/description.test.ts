import { describe, expect, test } from "vitest";
import {
  codeModeToolDefinitionsFromTools,
  normalizeCodeModeIdentifier,
  parseExecSource,
} from "./description.js";
import type { Tool } from "../types.js";

describe("code-mode description helpers", () => {
  test("parses upstream-style exec pragma", () => {
    expect(
      parseExecSource(
        '// @exec: {"yield_time_ms": 25, "max_output_tokens": 50}\ntext("hi")',
      ),
    ).toEqual({
      code: 'text("hi")',
      yieldTimeMs: 25,
      maxOutputTokens: 50,
    });
  });

  test("rejects unknown pragma fields", () => {
    expect(() =>
      parseExecSource('// @exec: {"timeout": 1}\ntext("hi")'),
    ).toThrow("only supports");
  });

  test("normalizes tool names as JavaScript identifiers", () => {
    expect(normalizeCodeModeIdentifier("FileRead")).toBe("FileRead");
    expect(normalizeCodeModeIdentifier("mcp.ologs/get-profile")).toBe(
      "mcp_ologs_get_profile",
    );
  });

  test("marks string-argument nested tools as freeform for code-mode metadata", () => {
    const tool: Tool = {
      name: "system.bash",
      description: "Runs a shell command.",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "ok" }),
    };

    expect(
      codeModeToolDefinitionsFromTools([tool], {
        stringArgumentFields: { "system.bash": "command" },
      }),
    ).toEqual([
      expect.objectContaining({
        name: "system.bash",
        globalName: "system_bash",
        kind: "freeform",
      }),
    ]);
  });
});
