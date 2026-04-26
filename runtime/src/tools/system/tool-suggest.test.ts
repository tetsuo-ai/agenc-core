import { describe, expect, test } from "vitest";

import {
  createToolSuggestTool,
  TOOL_SUGGEST_TOOL_NAME,
  type ToolSuggestEntry,
} from "./tool-suggest.js";

describe("tool_suggest tool (codex parity)", () => {
  test("tool name is exactly `tool_suggest`", () => {
    const tool = createToolSuggestTool();
    expect(tool.name).toBe("tool_suggest");
    expect(TOOL_SUGGEST_TOOL_NAME).toBe("tool_suggest");
  });

  test("schema exposes the codex 4 properties with codex descriptions", () => {
    const tool = createToolSuggestTool({ discoverableTools: [] });
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, { type: string; description: string }>;
      required: readonly string[];
      additionalProperties: boolean;
    };

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "tool_type",
      "action_type",
      "tool_id",
      "suggest_reason",
    ]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "action_type",
      "suggest_reason",
      "tool_id",
      "tool_type",
    ]);

    // Codex descriptions verbatim from
    // codex-rs/tools/src/tool_discovery.rs lines 282-306.
    expect(schema.properties.tool_type?.type).toBe("string");
    expect(schema.properties.tool_type?.description).toBe(
      'Type of discoverable tool to suggest. Use "connector" or "plugin".',
    );
    expect(schema.properties.action_type?.type).toBe("string");
    expect(schema.properties.action_type?.description).toBe(
      'Suggested action for the tool. Use "install" or "enable".',
    );
    expect(schema.properties.tool_id?.type).toBe("string");
    expect(schema.properties.tool_id?.description).toBe(
      "Connector or plugin id to suggest. Must be one of: .",
    );
    expect(schema.properties.suggest_reason?.type).toBe("string");
    expect(schema.properties.suggest_reason?.description).toBe(
      "Concise one-line user-facing reason why this tool can help with the current request.",
    );
  });

  test("description contains the codex verbatim sentences", () => {
    const tool = createToolSuggestTool({ discoverableTools: [] });
    const description = tool.description;

    // Verbatim phrases lifted from codex tool_discovery.rs lines 310-311.
    expect(description).toContain("# Tool suggestion discovery");
    expect(description).toContain(
      "Suggests a missing connector in an installed plugin, or in narrower cases a not installed but discoverable plugin, when the user clearly wants a capability that is not currently available in the active `tools` list.",
    );
    expect(description).toContain("Use this ONLY when:");
    expect(description).toContain(
      "Tool suggestions should only use the discoverable tools listed here. DO NOT explore or recommend tools that are not on this list.",
    );
    expect(description).toContain(
      "If one tool clearly fits, call `tool_suggest` with:",
    );
    expect(description).toContain(
      "if the user finished the install or enable flow, continue by searching again or using the newly available tool",
    );
    expect(description).toContain("`tool_search`");
  });

  test("tool_id description embeds the discoverable tool ids", () => {
    const entries: readonly ToolSuggestEntry[] = [
      {
        id: "github",
        name: "GitHub",
        description: "Work with GitHub repositories.",
        toolType: "connector",
      },
      {
        id: "research",
        name: "Research",
        toolType: "plugin",
        hasSkills: true,
        mcpServerNames: ["serpapi"],
      },
    ];
    const tool = createToolSuggestTool({ discoverableTools: entries });
    const schema = tool.inputSchema as {
      properties: Record<string, { description: string }>;
    };

    expect(schema.properties.tool_id?.description).toBe(
      "Connector or plugin id to suggest. Must be one of: github, research.",
    );

    // Sorted by name then id, with codex's exact line format.
    expect(tool.description).toContain(
      "- GitHub (id: `github`, type: connector, action: install): Work with GitHub repositories.",
    );
    // Plugin without explicit description falls back to plugin_summary.
    expect(tool.description).toContain(
      "- Research (id: `research`, type: plugin, action: install): skills; MCP servers: serpapi",
    );
  });

  test("plugin without description and without skills falls back to `No description provided.`", () => {
    const tool = createToolSuggestTool({
      discoverableTools: [
        {
          id: "empty",
          name: "Empty",
          toolType: "plugin",
        },
      ],
    });
    expect(tool.description).toContain(
      "- Empty (id: `empty`, type: plugin, action: install): No description provided.",
    );
  });

  test("connector without description falls back to `No description provided.`", () => {
    const tool = createToolSuggestTool({
      discoverableTools: [
        {
          id: "anon",
          name: "Anon",
          toolType: "connector",
        },
      ],
    });
    expect(tool.description).toContain(
      "- Anon (id: `anon`, type: connector, action: install): No description provided.",
    );
  });

  test("execute() returns plain-text content (not JSON)", async () => {
    const tool = createToolSuggestTool({
      discoverableTools: [
        {
          id: "github",
          name: "GitHub",
          description: "Work with GitHub repositories.",
          toolType: "connector",
        },
      ],
    });
    const result = await tool.execute({
      tool_type: "connector",
      action_type: "install",
      tool_id: "github",
      suggest_reason: "Needed to open issues on the user's repo.",
    });

    expect(result.isError).toBeUndefined();
    expect(typeof result.content).toBe("string");
    // Plain text — not JSON parseable as an object literal.
    expect(() => JSON.parse(result.content)).toThrow();
    expect(result.content).toContain("connector");
    expect(result.content).toContain("github");
    expect(result.content).toContain("install");
    expect(result.content).toContain(
      "Needed to open issues on the user's repo.",
    );
    expect(result.metadata).toMatchObject({
      tool_type: "connector",
      action_type: "install",
      tool_id: "github",
      suggest_reason: "Needed to open issues on the user's repo.",
      matched_name: "GitHub",
    });
  });

  test("rejects missing required fields", async () => {
    const tool = createToolSuggestTool();

    const missingType = await tool.execute({
      action_type: "install",
      tool_id: "github",
      suggest_reason: "x",
    });
    expect(missingType.isError).toBe(true);

    const missingAction = await tool.execute({
      tool_type: "connector",
      tool_id: "github",
      suggest_reason: "x",
    });
    expect(missingAction.isError).toBe(true);

    const missingId = await tool.execute({
      tool_type: "connector",
      action_type: "install",
      suggest_reason: "x",
    });
    expect(missingId.isError).toBe(true);

    const missingReason = await tool.execute({
      tool_type: "connector",
      action_type: "install",
      tool_id: "github",
    });
    expect(missingReason.isError).toBe(true);
  });

  test("rejects invalid enum values", async () => {
    const tool = createToolSuggestTool();

    const badType = await tool.execute({
      tool_type: "skill",
      action_type: "install",
      tool_id: "x",
      suggest_reason: "y",
    });
    expect(badType.isError).toBe(true);

    const badAction = await tool.execute({
      tool_type: "connector",
      action_type: "uninstall",
      tool_id: "x",
      suggest_reason: "y",
    });
    expect(badAction.isError).toBe(true);
  });
});
