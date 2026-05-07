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
      family: "coding",
      source: "builtin",
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
});
