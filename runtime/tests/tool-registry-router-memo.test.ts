import { describe, expect, test, vi } from "vitest";
import { buildToolRegistry } from "../src/tool-registry.js";
import type { Tool } from "../src/tools/types.js";

function fixtureTool(name: string, label: string): Tool {
  return {
    name,
    description: label,
    recoveryCategory: "idempotent",
    inputSchema: { type: "object", properties: { [label]: { type: "string" } } },
    execute: vi.fn(async () => ({ content: label })),
  };
}

function find(tools: readonly Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

describe("tool router reuse", () => {
  test("reuses the router while providers return the same tools in fresh arrays", () => {
    const mcp = fixtureTool("mcp.qa.lookup", "lookup");
    const getTools = vi.fn(() => [mcp]);
    const dynamic = fixtureTool("plugin.echo", "echo");
    const registry = buildToolRegistry({
      workspaceRoot: "/private/tmp", requireAdmission: false,
      mcpToolsProvider: { getTools, getAuthenticatedDesktopToolNames: () => [] },
      dynamicTools: () => [dynamic],
    });
    const first = registry.tools;
    const second = registry.tools;
    expect(getTools).toHaveBeenCalledTimes(2);
    // Same derived objects: nothing was rebuilt.
    expect(find(second, mcp.name)).toBe(find(first, mcp.name));
    expect(find(second, dynamic.name)).toBe(find(first, dynamic.name));
    expect(second.map((tool) => tool.name)).toEqual(first.map((tool) => tool.name));
  });

  test("rebuilds when a provider adds, replaces or reorders tools", () => {
    const a = fixtureTool("mcp.qa.a", "a");
    const b = fixtureTool("mcp.qa.b", "b");
    let live: Tool[] = [a];
    const registry = buildToolRegistry({
      workspaceRoot: "/private/tmp", requireAdmission: false,
      mcpToolsProvider: { getTools: () => [...live], getAuthenticatedDesktopToolNames: () => [] },
    });
    const before = registry.tools;
    expect(find(before, b.name)).toBeUndefined();
    live = [a, b];
    expect(find(registry.tools, b.name)?.description).toBe("b");
    const replacement = fixtureTool("mcp.qa.a", "a2");
    live = [replacement, b];
    expect(find(registry.tools, "mcp.qa.a")?.description).toBe("a2");
    live = [b, replacement];
    const reordered = registry.tools;
    expect(reordered.indexOf(find(reordered, b.name)!))
      .toBeLessThan(reordered.indexOf(find(reordered, "mcp.qa.a")!));
  });

  test("rebuilds when an option array is mutated in place", () => {
    const unavailable: string[] = [];
    const extra = fixtureTool("plugin.gone", "gone");
    const registry = buildToolRegistry({
      workspaceRoot: "/private/tmp", requireAdmission: false,
      dynamicTools: [extra],
      unavailableCalledTools: unavailable,
    });
    expect(registry.getUnavailableToolNames().has(extra.name)).toBe(false);
    unavailable.push(extra.name);
    expect(registry.getUnavailableToolNames().has(extra.name)).toBe(true);
  });

  test("dispatch uses the current tools after a change", async () => {
    const first = fixtureTool("mcp.qa.lookup", "first");
    const second = fixtureTool("mcp.qa.lookup", "second");
    let live = first;
    const registry = buildToolRegistry({
      workspaceRoot: "/private/tmp", requireAdmission: false,
      mcpToolsProvider: { getTools: () => [live], getAuthenticatedDesktopToolNames: () => [] },
    });
    expect((await registry.dispatch({ id: "1", name: first.name, arguments: "{}" })).content).toBe("first");
    live = second;
    expect((await registry.dispatch({ id: "2", name: second.name, arguments: "{}" })).content).toBe("second");
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(second.execute).toHaveBeenCalledTimes(1);
  });
});

test("fast presentation cache refreshes on discovery and live catalog changes", async () => {
  const { withOneShotFastMode } = await import("../src/one-shot-fast-mode.js");
  let extra = fixtureTool("mcp.qa.lookup", "first");
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false, lightMode: true,
    mcpToolsProvider: { getTools: () => [extra], getAuthenticatedDesktopToolNames: () => [] } });
  await withOneShotFastMode(async () => {
    const first = registry.toLLMTools();
    expect(registry.toLLMTools()).toBe(first);
    registry.discoverToolNames?.([extra.name]);
    const discovered = registry.toLLMTools();
    expect(discovered).not.toBe(first);
    expect(discovered.some(tool => tool.function.name === extra.name)).toBe(true);
    extra = fixtureTool("mcp.qa.lookup", "replacement");
    expect(registry.toLLMTools().find(tool => tool.function.name === extra.name)?.function.description).toBe("replacement");
    (registry.getDiscoveredToolNames?.() as Set<string>).delete(extra.name);
    expect(registry.toLLMTools().some(tool => tool.function.name === extra.name)).toBe(false);
  });
});
