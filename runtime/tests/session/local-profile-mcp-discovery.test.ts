import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MCPManager } from "../../src/mcp-client/manager.js";
import { withLocalMcpAccess } from "../../src/mcp-client/local-control.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { builtTools } from "../../src/session/run-turn-sampling-request.js";
import type { Session } from "../../src/session/session.js";
import type { TurnContext } from "../../src/session/turn-context.js";

vi.mock("../../src/mcp-client/connection.js", () => ({ createMCPConnection: vi.fn() }));
vi.mock("../../src/mcp-client/resources.js", () => ({ createResourceBridge: vi.fn(async (_client, serverName) => ({ serverName, listResources: async () => [], dispose: async () => {} })) }));
vi.mock("../../src/mcp-client/prompts.js", () => ({ createPromptBridge: vi.fn(async (_client, serverName) => ({ serverName, listPrompts: async () => [], dispose: async () => {} })) }));
import { createMCPConnection } from "../../src/mcp-client/connection.js";

const roots: string[] = [];
const managers: MCPManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.stop()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});

const name = (index: number) => `mcp.qa.lookup_${index}`;

async function fixture(localOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "agenc-local-mcp-"));
  roots.push(root);
  vi.mocked(createMCPConnection).mockResolvedValue({
    listTools: async () => ({ tools: Array.from({ length: 64 }, (_, index) => ({
      name: `lookup_${index}`, description: `Look up QA item ${index}`,
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    })) }),
    callTool: async () => ({ content: [{ type: "text", text: "QA lookup result" }] }),
    getInstructions: () => "Use lookup for QA items.", close: async () => {},
  } as never);
  const manager = new MCPManager([{
    name: "qa", transport: "stdio", command: "fixture-not-executed",
    origin: { scope: "user" }, localOnly,
  }]);
  managers.push(manager);
  await manager.start();
  expect(manager.isConnected("qa")).toBe(true);
  const registry = buildToolRegistry({ workspaceRoot: root, agencHome: root,
    mcpToolsProvider: manager, requireAdmission: false });
  const session = { services: { registry, mcpManager: manager } } as unknown as Session;
  return { root, manager, registry, session };
}

const mcpNames = (session: Session, provider: string) => builtTools(session,
  { modelProviderId: provider } as TurnContext).map(tool => tool.function.name).filter(name => name.startsWith("mcp."));

describe("local model MCP discovery survives sampling", () => {
  it.each(["ollama", "lmstudio", "openai-compatible"])(
    "%s keeps the initial catalog small and retains explicitly loaded MCP tools", async provider => {
      const { registry, session, manager } = await fixture();
      expect(mcpNames(session, provider)).toEqual([]);
      const results = await registry.dispatch({ id: "search", name: "system.searchTools",
        arguments: JSON.stringify({ query: "QA lookup" }) });
      expect(results.isError).not.toBe(true);
      expect(JSON.parse(results.content).results.length).toBeGreaterThan(0);
      expect(mcpNames(session, provider)).toEqual([]);
      for (const index of [2, 7]) {
        const loaded = await registry.dispatch({ id: `load-${index}`, name: "system.searchTools",
          arguments: JSON.stringify({ select: name(index) }) });
        expect(loaded.isError).not.toBe(true);
        expect(JSON.parse(loaded.content).loaded).toContain(name(index));
      }
      expect(mcpNames(session, provider).sort()).toEqual([name(2), name(7)]);
      // Rebuilding the next request must not silently forget searchTools.
      expect(mcpNames(session, provider).sort()).toEqual([name(2), name(7)]);
      const schema = builtTools(session, { modelProviderId: provider } as TurnContext)
        .find(tool => tool.function.name === name(2));
      expect(schema?.function.parameters).toMatchObject({ required: ["key"] });
      // Discovery is registry/session scoped, not a global MCP allowlist.
      const other = buildToolRegistry({ workspaceRoot: "/private/tmp", mcpToolsProvider: manager });
      expect(mcpNames({ services: { registry: other, mcpManager: manager } } as unknown as Session, provider)).toEqual([]);
      await manager.stop();
      expect(mcpNames(session, provider)).toEqual([]);
    },
  );

  it("does not grant an MCP exception based on names, forged metadata or discovery alone", async () => {
    const { root, session, manager } = await fixture();
    const forged = "mcp.forged.lookup";
    const registry = buildToolRegistry({ workspaceRoot: root, agencHome: root,
      extraTools: [{ name: forged, description: "Not a manager-owned MCP tool", inputSchema: { type: "object" },
        metadata: { source: "mcp", family: "mcp" }, execute: async () => ({ content: "unexpected" }) }] });
    registry.discoverToolNames?.([forged, name(3)]);
    const altered = { services: { registry, mcpManager: manager } } as unknown as Session;
    expect(mcpNames(altered, "ollama")).toEqual([]);
    session.services.registry.discoverToolNames?.([name(3)]);
    expect(mcpNames(session, "ollama")).toEqual([name(3)]);
    const noManager = { services: { registry: session.services.registry } } as unknown as Session;
    expect(mcpNames(noManager, "ollama")).toEqual([]);
  });

  it("does not retain local-only MCP outside its local turn", async () => {
    const { registry, session } = await fixture(true);
    await withLocalMcpAccess(true, async () => {
      registry.discoverToolNames?.([name(0)]);
      expect(mcpNames(session, "ollama")).toEqual([name(0)]);
    });
    expect(mcpNames(session, "ollama")).toEqual([]);
    await withLocalMcpAccess(false, async () => expect(mcpNames(session, "ollama")).toEqual([]));
  });

  it("leaves cloud-provider discovery unchanged", async () => {
    const { registry, session } = await fixture();
    expect(mcpNames(session, "openai")).toEqual([]);
    registry.discoverToolNames?.([name(1)]);
    expect(mcpNames(session, "openai")).toEqual([name(1)]);
  });

  it("also preserves explicitly selected built-ins without expanding the initial catalog", async () => {
    const { registry, session } = await fixture();
    const visible = () => builtTools(session, { modelProviderId: "ollama" } as TurnContext)
      .map(tool => tool.function.name);
    expect(visible()).not.toContain("system.gitStatus");
    const selected = await registry.dispatch({ id: "load-git", name: "system.searchTools",
      arguments: JSON.stringify({ select: "system.gitStatus" }) });
    expect(selected.isError).not.toBe(true);
    expect(JSON.parse(selected.content).loaded).toContain("system.gitStatus");
    expect(visible()).toContain("system.gitStatus");
    expect(mcpNames(session, "ollama")).toEqual([]);
  });
});
