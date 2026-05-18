import { describe, expect, it } from "vitest";

import { parseSlashCommand } from "./slash-command-parsing.js";

describe("parseSlashCommand", () => {
  it("rejects empty and non-slash input", () => {
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("hello /status")).toBeNull();
    expect(parseSlashCommand("/ ")).toBeNull();
  });

  it("parses command names and trims surrounding whitespace", () => {
    expect(parseSlashCommand("  /search foo bar  ")).toEqual({
      commandName: "search",
      args: "foo bar",
      isMcp: false,
    });
  });

  it("preserves repeated spaces in the argument tail", () => {
    expect(parseSlashCommand("/search  foo bar  baz")).toEqual({
      commandName: "search",
      args: " foo bar  baz",
      isMcp: false,
    });
  });

  it("recognizes donor MCP marker syntax", () => {
    expect(parseSlashCommand("/mcp:tool (MCP) arg1 arg2")).toEqual({
      commandName: "mcp:tool (MCP)",
      args: "arg1 arg2",
      isMcp: true,
    });
  });

  it("treats lowercase MCP marker text as ordinary args", () => {
    expect(parseSlashCommand("/mcp:tool (mcp) arg")).toEqual({
      commandName: "mcp:tool",
      args: "(mcp) arg",
      isMcp: false,
    });
  });

  it("keeps multiline input permissive for future TUI input routing", () => {
    expect(parseSlashCommand("/note first\nsecond")).toEqual({
      commandName: "note",
      args: "first\nsecond",
      isMcp: false,
    });
  });
});
