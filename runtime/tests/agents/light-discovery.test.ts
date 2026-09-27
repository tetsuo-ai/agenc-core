import { describe, expect, it, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import {
  buildFilteredRegistry,
  TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
} from "../../src/agents/run-agent.js";

const opts = (id: string) => ({
  childConversationId: id,
  lightMode: true,
  unadmittedDispatchOverride: TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
});
const names = (registry: ReturnType<typeof buildFilteredRegistry>) =>
  registry.toLLMTools().map(tool => tool.function.name);
const fixture = () => buildToolRegistry({
  workspaceRoot: process.cwd(),
  lightMode: true,
  requireAdmission: false,
  extraTools: [{
    name: "Specialist",
    description: "A specialist capability with its complete documentation.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    execute: vi.fn(async () => ({ content: "done" })),
  }],
});
const select = (registry: ReturnType<typeof buildFilteredRegistry>, name: string) =>
  registry.dispatch({ id: "discover", name: "system.searchTools", arguments: JSON.stringify({ select: name }) });

describe("Light child capability discovery", () => {
  it("keeps explicitly allowed tools usable when the role excludes discovery", async () => {
    const parent = fixture();
    const child = buildFilteredRegistry(parent, { ...opts("restricted"), allowlist: ["Specialist"] });
    expect(names(child)).toEqual(["Specialist"]);
    expect(names(child)).not.toContain("system.searchTools");
    await expect(child.dispatch({ id: "allowed", name: "Specialist", arguments: '{"task":"check"}' })).resolves.toMatchObject({ content: "done" });
    const withoutSearch = buildFilteredRegistry(parent, {
      ...opts("no-search"), disabledTools: new Set(["system.searchTools", "Write"]),
    });
    expect(names(withoutSearch)).toContain("Specialist");
    expect(names(withoutSearch)).not.toContain("system.searchTools");
    expect(names(withoutSearch)).not.toContain("Write");
  });

  it("reports only its own advertised tools despite model-supplied internal arguments", async () => {
    const child = buildFilteredRegistry(fixture(), opts("child"));
    const result = await child.dispatch({
      id: "visible", name: "system.searchTools",
      arguments: JSON.stringify({ advertisedOnly: true, __agencAdvertisedToolNames: ["Specialist"] }),
    });
    const results = JSON.parse(result.content).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry: { advertised: boolean }) => entry.advertised)).toBe(true);
    expect(results.map((entry: { name: string }) => entry.name)).not.toContain("Specialist");
  });

  it("loads full schemas in the requesting child without changing its parent or sibling", async () => {
    const parent = fixture();
    const child = buildFilteredRegistry(parent, opts("child"));
    const sibling = buildFilteredRegistry(parent, opts("sibling"));
    expect(names(child)).not.toContain("Specialist");
    expect((await child.dispatch({ id: "early", name: "Specialist", arguments: '{"task":"check"}' })).isError).toBe(true);

    const result = await select(child, "Specialist");
    expect(JSON.parse(result.content).loaded).toEqual(["Specialist"]);
    expect(child.toLLMTools().find(tool => tool.function.name === "Specialist")?.function).toMatchObject({
      description: "A specialist capability with its complete documentation.",
      parameters: { required: ["task"] },
    });
    expect(names(parent)).not.toContain("Specialist");
    expect(names(sibling)).not.toContain("Specialist");
    expect(child.getDiscoveredToolNames?.().has("Specialist")).toBe(true);
    expect(parent.getDiscoveredToolNames?.().size).toBe(0);
    await expect(child.dispatch({ id: "run", name: "Specialist", arguments: '{"task":"check"}' })).resolves.toMatchObject({ content: "done" });
  });

  it("retains undiscovered capabilities through nested children and snapshots parent visibility", async () => {
    const parent = fixture();
    const child = buildFilteredRegistry(parent, opts("child"));
    const nested = buildFilteredRegistry(child, opts("nested"));
    await select(nested, "Specialist");
    expect(names(nested)).toContain("Specialist");
    expect(names(child)).not.toContain("Specialist");
    await parent.dispatch({ id: "parent-select", name: "system.searchTools", arguments: '{"select":"MultiEdit"}' });
    expect(names(parent)).toContain("MultiEdit");
    expect(names(child)).not.toContain("MultiEdit");
    expect(names(nested)).not.toContain("MultiEdit");
  });

  it("never discovers role-denied tools or bypasses inherited execution policy", async () => {
    const parent = fixture();
    const child = buildFilteredRegistry(parent, {
      ...opts("child"),
      disabledTools: new Set(["Write"]),
      childToolPolicy: async (tool) => tool.name === "Specialist"
        ? { behavior: "deny" as const, message: "Role forbids this operation" }
        : { behavior: "allow" as const },
    });
    const nested = buildFilteredRegistry(child, opts("nested"));
    expect(JSON.parse((await select(nested, "Write")).content).missingSelections).toEqual(["Write"]);
    expect(names(nested)).not.toContain("Write");
    await select(nested, "Specialist");
    const result = await nested.dispatch({ id: "denied", name: "Specialist", arguments: '{"task":"check"}' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Role forbids this operation");
    expect(parent.tools.find(tool => tool.name === "Specialist")?.execute).not.toHaveBeenCalled();
  });

  it("retains ancestor policy when replacing the discovery executor", async () => {
    const parent = fixture();
    const child = buildFilteredRegistry(parent, {
      ...opts("child"),
      childToolPolicy: async (tool) => tool.name === "system.searchTools"
        ? { behavior: "deny" as const, message: "Discovery restricted" }
        : { behavior: "allow" as const },
    });
    const nested = buildFilteredRegistry(child, opts("nested"));
    expect((await select(nested, "Specialist")).isError).toBe(true);
    expect(names(nested)).not.toContain("Specialist");
    const search = nested.tools.find(tool => tool.name === "system.searchTools");
    expect((await search?.execute({ select: "Specialist" }))?.isError).toBe(true);
  });
});
