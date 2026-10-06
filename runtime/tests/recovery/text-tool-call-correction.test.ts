import { describe, expect, it } from "vitest";

import { readTextToolCallCorrection } from "../../src/recovery/rejected-text-tool-call.js";

describe("readTextToolCallCorrection", () => {
  it("accepts a builtin invalid-arguments identity", () => {
    expect(
      readTextToolCallCorrection({
        toolName: "system.readFile",
        reason: "invalid_arguments",
      }),
    ).toEqual({ toolName: "system.readFile", reason: "invalid_arguments" });
  });

  it("accepts a not-advertised MCP name and refuses any other spelling for that reason", () => {
    expect(
      readTextToolCallCorrection({
        toolName: "mcp.qa.lookup",
        reason: "not_advertised",
      }),
    ).toEqual({ toolName: "mcp.qa.lookup", reason: "not_advertised" });
    expect(
      readTextToolCallCorrection({
        toolName: "mcp.qa.lookup.nested",
        reason: "not_advertised",
      }),
    ).toEqual({ toolName: "mcp.qa.lookup.nested", reason: "not_advertised" });
    expect(
      readTextToolCallCorrection({
        toolName: "system.readFile",
        reason: "not_advertised",
      }),
    ).toBeUndefined();
    expect(
      readTextToolCallCorrection({
        toolName: "mcp.",
        reason: "not_advertised",
      }),
    ).toBeUndefined();
  });

  it("refuses extra keys, unknown reasons, and malformed names", () => {
    expect(
      readTextToolCallCorrection({
        toolName: "system.readFile",
        reason: "invalid_arguments",
        extra: true,
      }),
    ).toBeUndefined();
    expect(
      readTextToolCallCorrection({
        toolName: "system.readFile",
        reason: "approved",
      }),
    ).toBeUndefined();
    expect(
      readTextToolCallCorrection({
        toolName: "system readFile",
        reason: "invalid_arguments",
      }),
    ).toBeUndefined();
    expect(
      readTextToolCallCorrection({
        toolName: "a".repeat(257),
        reason: "invalid_arguments",
      }),
    ).toBeUndefined();
    expect(
      readTextToolCallCorrection({
        toolName: "",
        reason: "invalid_arguments",
      }),
    ).toBeUndefined();
  });

  it("refuses values that are not a data-identity object", () => {
    for (const value of [null, undefined, [], "system.readFile", 1]) {
      expect(readTextToolCallCorrection(value)).toBeUndefined();
    }
  });
});
