import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toRuntimeTools } from "../../src/llm/runtime-tool-projection.js";
import type { LLMTool } from "../../src/llm/types.js";

describe("runtime tool projection", () => {
  it("preserves the original tool and schema while projecting canonical fields", () => {
    const schema = Object.freeze({ type: "object", properties: { text: { type: "string" } } });
    const metadata = Object.freeze({ server: "fixture", annotations: { readOnly: true } });
    const tool = Object.freeze({
      type: "function" as const,
      function: Object.freeze({ name: "mcp__fixture__echo", description: "Echo text", parameters: schema }),
      metadata,
      name: "stale-name",
      description: "stale-description",
      inputJSONSchema: {},
      isMcp: false,
      maxResultSizeChars: 999,
    });
    const projected = toRuntimeTools(Object.freeze([tool]), 123);

    expect(projected).toEqual([{
      ...tool,
      name: "mcp__fixture__echo",
      description: "Echo text",
      inputJSONSchema: schema,
      isMcp: true,
      maxResultSizeChars: 123,
    }]);
    expect(projected[0]).not.toBe(tool);
    expect(projected[0]?.function).toBe(tool.function);
    expect(projected[0]?.inputJSONSchema).toBe(schema);
    expect(projected[0]).toHaveProperty("metadata", metadata);
    expect(tool.name).toBe("stale-name");
  });

  it.each([
    ["mcp__server__tool", true],
    ["mcp__", true],
    ["MCP__server__tool", false],
    ["prefix_mcp__server__tool", false],
    ["mcp_tool", false],
    ["Bash", false],
  ])("classifies MCP name %s as %s", (name, isMcp) => {
    const tools: LLMTool[] = [{
      type: "function",
      function: { name, description: "", parameters: {} },
    }];
    expect(toRuntimeTools(tools, 1)[0]?.isMcp).toBe(isMcp);
  });

  it("uses the explicit caller limit and retains registry order", () => {
    const tools: LLMTool[] = ["second", "first"].map((name) => ({
      type: "function", function: { name, description: name, parameters: {} },
    }));
    for (const limit of [0, 1, 500_000]) {
      const projected = toRuntimeTools(tools, limit);
      expect(projected.map((tool) => tool.name)).toEqual(["second", "first"]);
      expect(projected.map((tool) => tool.maxResultSizeChars)).toEqual([limit, limit]);
    }
    expect(toRuntimeTools([], 1)).toEqual([]);
  });

  it.each([
    "agents/run-agent.ts",
    "session/agenc-tool-use-context.ts",
    "commands/session-compact.ts",
  ])("keeps %s wired to the shared projection with an explicit limit", (path) => {
    const source = readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
    expect(source).toContain('from "../llm/runtime-tool-projection.js"');
    expect(source).toMatch(/tools:\s*toRuntimeTools\([\s\S]*?DEFAULT_MAX_RESULT_SIZE_CHARS,?\s*\)/u);
    expect(source).not.toMatch(/function to(?:Agent|AgenC)RuntimeTools\(/u);
    expect(source).not.toContain('isMcp: name.startsWith("mcp__")');
  });
});
