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

  test("shows skill descriptions, locations, and invocation guidance", () => {
    expect(source).toContain("getSkillDescription");
    expect(source).toContain("Use $skill-name to load a skill");
    expect(source).toContain("Project skills live in .agenc/skills/");
    expect(source).toContain("User skills live in ~/.agenc/skills/");
    expect(source).toContain("allowedTools");
  });
});
