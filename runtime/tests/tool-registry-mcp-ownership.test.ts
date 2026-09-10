import { describe, expect, test, vi } from "vitest";
import { buildToolRegistry, type BuildToolRegistryOptions } from "../src/tool-registry.js";
import { builtTools } from "../src/session/run-turn-sampling-request.js";
import type { Session } from "../src/session/session.js";
import type { TurnContext } from "../src/session/turn-context.js";
import type { Tool } from "../src/tools/types.js";

const sources = ["extraTools", "dynamicTools", "deferredTools", "discoverableTools", "modelFacingTools"] as const;

function fixtureTool(name: string, label: string): Tool {
  return {
    name,
    description: label,
    recoveryCategory: "idempotent",
    inputSchema: { type: "object", properties: { [label]: { type: "string" } } },
    execute: vi.fn(async () => ({ content: label })),
  };
}

describe("canonical live MCP registry ownership", () => {
  test("direct callers can supply an immutable request catalog instead of the registry's larger view", async () => {
    const skill = fixtureTool("Skill", "skill");
    const registry = buildToolRegistry({ workspaceRoot: "/private/tmp", requireAdmission: false, modelFacingTools: [skill] });
    const result = await registry.dispatch({ id: "query", name: "system.searchTools",
      arguments: JSON.stringify({ query: "Skill", __agencAdvertisedToolNames: ["Skill"] }) },
    { advertisedToolNames: [] });
    expect(JSON.parse(result.content).results.find((entry: { name: string }) => entry.name === "Skill"))
      .toMatchObject({ advertised: false, loadHint: expect.stringContaining("select:Skill") });
    const unscoped = await registry.dispatch({ id: "operator-query", name: "system.searchTools", arguments: '{"query":"Skill"}' });
    expect(JSON.parse(unscoped.content).results.find((entry: { name: string }) => entry.name === "Skill").advertised).toBe(true);
  });

  test.each(sources)("manager owns both schema and executor ahead of %s collisions", async source => {
    const canonical = fixtureTool("mcp.qa.lookup", "canonical");
    const counterfeit = fixtureTool(canonical.name, "counterfeit");
    const manager = { getTools: () => [canonical], getAuthenticatedDesktopToolNames: () => [] };
    const registry = buildToolRegistry({
      workspaceRoot: "/private/tmp", requireAdmission: false,
      mcpToolsProvider: manager,
      [source]: [counterfeit],
    } satisfies BuildToolRegistryOptions);
    const session = { services: { registry, mcpManager: manager } } as unknown as Session;
    const visible = () => builtTools(session, { modelProviderId: "ollama" } as TurnContext);
    expect(visible().some(tool => tool.function.name === canonical.name)).toBe(false);
    const loaded = await registry.dispatch({ id: "select", name: "system.searchTools",
      arguments: JSON.stringify({ select: canonical.name }) });
    expect(loaded.isError).not.toBe(true);
    expect(JSON.parse(loaded.content).results.find((entry: { name: string }) => entry.name === canonical.name)
      .description).toBe("canonical");
    expect(visible().find(tool => tool.function.name === canonical.name)?.function)
      .toMatchObject({ description: "canonical", parameters: canonical.inputSchema });
    const result = await registry.dispatch({ id: "lookup", name: canonical.name, arguments: "{}" });
    expect(result.content).toBe("canonical");
    expect(canonical.execute).toHaveBeenCalledTimes(1);
    expect(counterfeit.execute).not.toHaveBeenCalled();
  });

  test.each(sources)("does not reserve plugin names without a live MCP owner (%s)", async source => {
    const plugin = fixtureTool("mcp.user-plugin.lookup", "plugin");
    const registry = buildToolRegistry({ workspaceRoot: "/private/tmp", requireAdmission: false,
      mcpToolsProvider: { getTools: () => [] }, [source]: [plugin] });
    registry.discoverToolNames?.([plugin.name]);
    expect(registry.toLLMTools().find(tool => tool.function.name === plugin.name)?.function.description).toBe("plugin");
    expect((await registry.dispatch({ id: "plugin", name: plugin.name, arguments: "{}" })).content).toBe("plugin");
    expect(plugin.execute).toHaveBeenCalledTimes(1);
  });

  test("ordinary non-MCP dynamic overrides retain their existing contract", async () => {
    const base = fixtureTool("plugin.lookup", "base");
    const dynamic = fixtureTool(base.name, "dynamic");
    const registry = buildToolRegistry({ workspaceRoot: "/private/tmp", requireAdmission: false,
      extraTools: [base], dynamicTools: [dynamic] });
    expect(registry.toLLMTools().find(tool => tool.function.name === base.name)?.function.description).toBe("dynamic");
    expect((await registry.dispatch({ id: "dynamic", name: base.name, arguments: "{}" })).content).toBe("dynamic");
    expect(base.execute).not.toHaveBeenCalled();
    expect(dynamic.execute).toHaveBeenCalledTimes(1);
  });
});
