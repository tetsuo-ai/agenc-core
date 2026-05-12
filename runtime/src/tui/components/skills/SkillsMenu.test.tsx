import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(new URL("./SkillsMenu.tsx", import.meta.url), "utf8");

describe("SkillsMenu command sources", () => {
  test("renders only current skill, plugin, and MCP sources", () => {
    expect(source).not.toContain("commands_DEPRECATED");
    expect(source).toContain('cmd.loadedFrom === "skills"');
    expect(source).toContain('cmd.loadedFrom === "plugin"');
    expect(source).toContain('cmd.loadedFrom === "mcp"');
  });
});
