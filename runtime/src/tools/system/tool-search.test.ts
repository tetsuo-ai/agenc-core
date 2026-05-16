import { describe, expect, test } from "vitest";
import type { ToolCatalogEntry } from "../types.js";
import { createToolSearchTool } from "./tool-search.js";

function deferredCatalogEntry(name = "system.deepTool"): ToolCatalogEntry {
  return {
    name,
    description: "Deferred deep inspection tool",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    metadata: {
      family: name.startsWith("mcp.") ? "mcp" : "coding",
      source: name.startsWith("mcp.") ? "mcp" : "builtin",
      hiddenByDefault: false,
      mutating: false,
      deferred: true,
      keywords: ["deep", "inspect"],
      preferredProfiles: ["coding"],
    },
  };
}

describe("system.searchTools", () => {
  test("is side-effecting because selected tools update advertised session state", () => {
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry()],
      onDiscoverTools: () => {},
    });

    expect(tool.recoveryCategory).toBe("side-effecting");
  });

  test("selecting a deferred tool calls onDiscoverTools and reports it loaded", async () => {
    const discovered: string[][] = [];
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry()],
      onDiscoverTools: (names) => {
        discovered.push([...names]);
      },
    });

    const result = await tool.execute({ select: "system.deepTool" });

    expect(discovered).toEqual([["system.deepTool"]]);
    const payload = JSON.parse(result.content);
    expect(payload.loaded).toEqual(["system.deepTool"]);
    expect(payload.results[0]).toMatchObject({
      name: "system.deepTool",
      selected: true,
    });
  });

  test("MCP search results tell the model to invoke the MCP tool directly", async () => {
    const tool = createToolSearchTool({
      allowedPaths: [process.cwd()],
      persistenceRootDir: process.cwd(),
      getToolCatalog: () => [deferredCatalogEntry("mcp.audit-ping.ping")],
      onDiscoverTools: () => {},
    });

    const result = await tool.execute({ select: "mcp.audit-ping.ping" });

    const payload = JSON.parse(result.content);
    expect(payload.results[0]).toMatchObject({
      name: "mcp.audit-ping.ping",
      selected: true,
      useHint: expect.stringContaining("invoke mcp.audit-ping.ping directly"),
    });
    expect(payload.results[0].useHint).toContain("Do not use exec_command");
  });
});
