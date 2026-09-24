import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { createSpawnAgentTool } from "../../src/agents/v2/spawn.js";
import { createAgentRoleWorkspace } from "../../src/agents/role.js";
import { AgentRoleCatalog } from "../../src/agents/role-catalog.js";
import type { MultiAgentV2Options } from "../../src/agents/v2/common.js";
import type { Session } from "../../src/session/session.js";
import type { Tool } from "../../src/tools/types.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";

// Bootstrap builds the tool registry before it creates the session. The
// spawn_agent tool must still show the session's allowed provider/model pairs:
// without them the model searched source files for valid model names.

function crossProviderSession(allowedProviders: string[]): Session {
  const config = {
    ...defaultConfig(),
    model_provider: "grok",
    model: "grok-4.7",
    agents: { cross_provider_enabled: true, allowed_providers: allowedProviders },
  };
  return {
    modelInfo: { slug: "grok-4.7" },
    sessionConfiguration: { collaborationMode: { model: "grok-4.7" } },
    providerService: { current: () => ({ provider: "grok", model: "grok-4.7" }) },
    services: {
      configStore: { current: () => config },
      modelsManager: {
        tryListModels: () => [{ slug: "grok-4.7" }],
        listModels: async () => [{ slug: "grok-4.7" }],
      },
    },
  } as unknown as Session;
}

function spawnTool(getSession: () => Session | null): Tool {
  const workspace = createAgentRoleWorkspace("/repo");
  return createSpawnAgentTool({
    getSession,
    workspace,
    roleCatalog: new AgentRoleCatalog(workspace),
    ensureAgentControl: () => { throw new Error("not used"); },
  } as unknown as MultiAgentV2Options);
}

describe("spawn_agent cross-provider surface", () => {
  it("advertises each child and descendant's live model choices", () => {
    const root = crossProviderSession(["deepseek"]);
    const base = buildToolRegistry({ workspaceRoot: "/tmp", modelFacingTools: [spawnTool(() => root)] });
    const child = crossProviderSession(["deepseek"]);
    Object.assign(child, {
      modelInfo: { slug: "deepseek-v4-pro" },
      sessionConfiguration: { collaborationMode: { model: "deepseek-v4-pro" } },
      providerService: { current: () => ({ provider: "deepseek", model: "deepseek-v4-pro" }) },
    });
    Object.assign(child.services, { modelsManager: {
      tryListModels: () => [
        { slug: "grok-4.7", provider: "grok" },
        { slug: "deepseek-v4-pro", provider: "deepseek" },
      ],
    } });
    const advertisedModel = (registry: ReturnType<typeof buildFilteredRegistry>) => {
      const spawn = registry.toLLMTools().find((tool) => tool.function.name === "spawn_agent");
      expect(spawn).toBeDefined();
      return (spawn!.function.parameters as { properties: { model: { description: string; enum?: string[] } } }).properties.model;
    };
    const childRegistry = buildFilteredRegistry(base, { childConversationId: "deepseek-child", getSession: () => child });
    expect(advertisedModel(childRegistry).description).toContain("deepseek-v4-pro");
    expect(advertisedModel(childRegistry).description).not.toContain("current model (`grok-4.7`)");
    expect(advertisedModel(childRegistry).enum).toContain("deepseek-v4-pro");
    expect(advertisedModel(childRegistry).enum).not.toContain("grok-4.7");
    const childCatalogSchema = childRegistry.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema as
      { properties: { model: { description: string } } } | undefined;
    expect(childCatalogSchema?.properties.model.description).toContain("current model (`deepseek-v4-pro`)");
    const descendant = buildFilteredRegistry(childRegistry, { childConversationId: "grandchild", getSession: () => child });
    expect(advertisedModel(descendant).description).toContain("current model (`deepseek-v4-pro`)");
  });
  it("advertises the live allowed pairs when the registry predates the session", () => {
    let session: Session | null = null;
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      modelFacingTools: [spawnTool(() => session)],
    });
    const advertised = () => registry.toLLMTools().find((tool) => tool.function.name === "spawn_agent");
    expect(advertised()?.function.description).not.toContain("Allowed provider/model pairs");

    session = crossProviderSession(["deepseek"]);
    expect(advertised()?.function.description).toMatch(/Allowed provider\/model pairs: deepseek\/\S+/u);
  });

  it("follows a config change without rebuilding the registry", () => {
    let allowed = ["deepseek"];
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      modelFacingTools: [spawnTool(() => crossProviderSession(allowed))],
    });
    const description = () =>
      registry.toLLMTools().find((tool) => tool.function.name === "spawn_agent")?.function.description ?? "";
    expect(description()).not.toMatch(/openai\//u);
    allowed = ["deepseek", "openai"];
    expect(description()).toMatch(/openai\/\S+/u);
  });

  it("treats a partial session without services as cross-provider off", () => {
    const session = {
      modelInfo: { slug: "grok-4.7" },
      config: { agents: { cross_provider_enabled: true, allowed_providers: ["openai"] } },
    } as unknown as Session;
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      modelFacingTools: [spawnTool(() => session)],
    });
    const advertised = registry.toLLMTools().find((tool) => tool.function.name === "spawn_agent");
    expect(advertised?.function.description).not.toContain("Allowed provider/model pairs");
    expect(advertised?.function.parameters).toBeDefined();
  });
});
