/**
 * A session `toolPolicy` (agent.create) removes every tool outside
 * `enabledTools` from BOTH the model-visible catalog and dispatch by name, so
 * a model that calls a hidden tool by name gets a refusal and nothing runs.
 */
import { describe, expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { routerFromRegistry } from "../../src/tools/router.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { buildBootstrapToolRegistry } from "../../src/bin/bootstrap-tool-registry.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { Tool } from "../../src/tools/types.js";
import type { SessionToolPolicy } from "../../src/permissions/session-tool-policy.js";

function probe(name: string, execute = vi.fn(async () => ({ content: `ran ${name}` }))): Tool {
  return { name, description: `probe ${name}`, inputSchema: { type: "object" }, execute };
}

const base = { workspaceRoot: "/private/tmp", requireAdmission: false } as const;
const refusal = (name: string) => `tool ${JSON.stringify(name)} is not enabled for this session`;

function policy(enabledTools: readonly string[], rest: Partial<SessionToolPolicy> = {}): SessionToolPolicy {
  return { enabledTools, ...rest };
}

function invocationFor(name: string): ToolInvocation {
  return {
    session: {
      eventLog: new EventLog(),
      services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) },
    } as never,
    turn: {} as never,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    callId: "c1",
    toolName: { name },
    payload: { kind: "function", arguments: "{}" },
    source: "direct",
  };
}

describe("session tool policy in the tool registry", () => {
  test("the catalog and the tool list hold only the enabled tools", () => {
    const registry = buildToolRegistry({ ...base, toolPolicy: policy(["FileRead", "Glob"]) });
    expect(registry.tools.map((tool) => tool.name).sort()).toEqual(["FileRead", "Glob"]);
    expect(registry.toLLMTools().map((tool) => tool.function.name).sort()).toEqual(["FileRead", "Glob"]);
  });

  test("without a policy the registry is unchanged", () => {
    const registry = buildToolRegistry(base);
    expect(registry.tools.length).toBeGreaterThan(10);
    expect(registry.toolPolicy).toBeUndefined();
  });

  test("a hidden tool called by name is refused and never runs", async () => {
    const hidden = probe("Hidden");
    const allowed = probe("Allowed");
    const registry = buildToolRegistry({
      ...base,
      extraTools: [hidden, allowed],
      toolPolicy: policy(["Allowed"]),
    });
    const refused = await registry.dispatch({ id: "c1", name: "Hidden", arguments: "{}" });
    expect(refused).toEqual({ content: JSON.stringify({ error: refusal("Hidden") }), isError: true });
    expect(hidden.execute).not.toHaveBeenCalled();
    // Built-ins are held to the same list.
    expect((await registry.dispatch({ id: "c2", name: "system.bash", arguments: '{"command":"true"}' })).content)
      .toContain("is not enabled for this session");
    expect((await registry.dispatch({ id: "c3", name: "Allowed", arguments: "{}" })).content).toBe("ran Allowed");
  });

  test("discovery cannot bring a hidden tool back", async () => {
    const hidden = probe("Hidden");
    const registry = buildToolRegistry({
      ...base,
      deferredTools: [hidden],
      toolPolicy: policy(["system.searchTools"]),
    });
    registry.discoverToolNames?.(["Hidden"]);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual(["system.searchTools"]);
    const search = registry.tools.find((tool) => tool.name === "system.searchTools")!;
    const found = JSON.parse((await search.execute({ query: "select:Hidden" })).content) as {
      readonly loaded: readonly string[];
    };
    expect(found.loaded).toEqual([]);
    expect((await registry.dispatch({ id: "c1", name: "Hidden", arguments: "{}" })).isError).toBe(true);
    expect(hidden.execute).not.toHaveBeenCalled();
  });

  test("it composes with tools_config by intersection", () => {
    const registry = buildToolRegistry({
      ...base,
      toolsConfig: { disabled_tools: ["Glob"] },
      toolPolicy: policy(["FileRead", "Glob"]),
    });
    expect(registry.tools.map((tool) => tool.name)).toEqual(["FileRead"]);
    const narrowed = buildToolRegistry({
      ...base,
      toolsConfig: { enabled_tools: ["FileRead", "Grep"] },
      toolPolicy: policy(["FileRead", "Glob"]),
    });
    expect(narrowed.tools.map((tool) => tool.name)).toEqual(["FileRead"]);
  });

  test("the live session router refuses a hidden name with the same message", async () => {
    const hidden = probe("Hidden");
    const registry = buildToolRegistry({
      ...base,
      extraTools: [hidden],
      toolPolicy: policy(["FileRead"]),
    });
    const router = routerFromRegistry(registry);
    const direct = await router.dispatchToolCall(invocationFor("Hidden"), {});
    expect(direct).toEqual({ content: JSON.stringify({ error: refusal("Hidden") }), isError: true });
    const call = invocationFor("Hidden");
    const modelCall = await router.dispatchModelToolCall(
      { id: "c1", name: "Hidden", arguments: "{}" },
      { ...call, approvalPolicy: "never", sandboxMode: "workspace_write" },
    );
    expect(modelCall).toEqual({ content: JSON.stringify({ error: refusal("Hidden") }), isError: true });
    expect(hidden.execute).not.toHaveBeenCalled();
    // A name the policy allows but nothing provides is still just unknown.
    const missing = await routerFromRegistry(
      buildToolRegistry({ ...base, toolPolicy: policy(["NotBuilt"]) }),
    ).dispatchToolCall(invocationFor("NotBuilt"), {});
    expect(missing.content).toContain("unknown tool: NotBuilt");
  });

  test("a child registry cannot reach a tool the parent policy removed", async () => {
    const hidden = probe("Hidden");
    const parent = buildToolRegistry({
      ...base,
      extraTools: [hidden],
      toolPolicy: policy(["FileRead"]),
    });
    const child = buildFilteredRegistry(parent, {
      allowlist: ["FileRead", "Hidden"],
      childConversationId: "child",
    });
    expect(child.tools.map((tool) => tool.name)).toEqual(["FileRead"]);
    expect((await child.dispatch({ id: "c1", name: "Hidden", arguments: "{}" })).isError).toBe(true);
    expect(hidden.execute).not.toHaveBeenCalled();
  });
});

describe("session tool policy and MCP tools", () => {
  const read = probe("mcp.desktop.read_file");
  const submit = probe("mcp.desktop.submit_work");
  const danger = probe("mcp.desktop.delete_everything");
  const other = probe("mcp.other.read_file");

  function registryFor(toolPolicy: SessionToolPolicy, tools: () => readonly Tool[], lightMode?: boolean) {
    return buildToolRegistry({
      ...base,
      mcpToolsProvider: { getTools: tools },
      toolPolicy,
      ...(lightMode !== undefined ? { lightMode } : {}),
    });
  }

  test("only allowlisted MCP tools exist, and they are deferred by default", async () => {
    const registry = registryFor(
      policy(["system.searchTools", read.name, submit.name]),
      () => [read, submit, danger, other],
    );
    expect(registry.tools.map((tool) => tool.name).sort()).toEqual(
      ["system.searchTools", read.name, submit.name].sort(),
    );
    // Deferred behind discovery, like any MCP tool today.
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual(["system.searchTools"]);
    expect((await registry.dispatch({ id: "c1", name: danger.name, arguments: "{}" })).content)
      .toContain("is not enabled for this session");
    expect(danger.execute).not.toHaveBeenCalled();
  });

  test("deferMcpTools: false shows the allowlisted MCP tools with no search step", () => {
    const registry = registryFor(
      policy([read.name, submit.name], { deferMcpTools: false }),
      () => [read, submit, danger],
    );
    expect(registry.toLLMTools().map((tool) => tool.function.name).sort())
      .toEqual([read.name, submit.name].sort());
  });

  test("deferMcpTools: false also shows them in Light mode", () => {
    const registry = registryFor(
      policy(["system.searchTools", read.name], { deferMcpTools: false }),
      () => [read, danger],
      true,
    );
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toContain(read.name);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).not.toContain(danger.name);
  });

  test("an allowlisted deferred MCP tool still runs when called by name", async () => {
    const registry = registryFor(policy([read.name]), () => [read, danger]);
    expect(registry.toLLMTools()).toEqual([]);
    expect((await registry.dispatch({ id: "c1", name: read.name, arguments: "{}" })).content)
      .toBe(`ran ${read.name}`);
  });

  test("an MCP server that connects later is filtered the same way", async () => {
    let live: readonly Tool[] = [read];
    const registry = registryFor(policy([read.name], { deferMcpTools: false }), () => live);
    expect(registry.tools.map((tool) => tool.name)).toEqual([read.name]);
    live = [read, danger, other];
    expect(registry.tools.map((tool) => tool.name)).toEqual([read.name]);
    expect((await registry.dispatch({ id: "c1", name: other.name, arguments: "{}" })).isError).toBe(true);
    expect(other.execute).not.toHaveBeenCalled();
  });
});

describe("session tool policy through the bootstrap registry", () => {
  test("model-facing, MCP and built-in tools are all held to the same list", async () => {
    const read = probe("mcp.desktop.read_file");
    const submit = probe("mcp.desktop.submit_work");
    const registry = buildBootstrapToolRegistry({
      workspaceRoot: "/private/tmp",
      mcpManager: {
        getTools: () => [read, submit],
        effectiveServers: async () => new Map(),
        toolPluginProvenance: async () => null,
      } as never,
      csvAgentJobsRepositories: {
        async withRepository(): Promise<never> {
          throw new Error("CSV repositories are not used by this test");
        },
      },
      getSession: () => null,
      emitWarning: () => {},
      toolRegistryOptions: {
        requireAdmission: false,
        toolPolicy: policy(["FileRead", read.name], { deferMcpTools: false }),
      },
    });
    // Without the policy this registry also carries web_fetch, spawn_agent,
    // Skill, the task tools and every shell tool.
    expect(registry.tools.map((tool) => tool.name).sort()).toEqual(["FileRead", read.name].sort());
    expect(registry.toLLMTools().map((tool) => tool.function.name).sort()).toEqual(["FileRead", read.name].sort());
    for (const hidden of [submit.name, "spawn_agent", "web_fetch", "system.bash", "exec_command"]) {
      expect((await registry.dispatch({ id: hidden, name: hidden, arguments: "{}" })).content)
        .toContain("is not enabled for this session");
    }
    expect(submit.execute).not.toHaveBeenCalled();
    expect(registry.toolPolicy).toEqual({ enabledTools: ["FileRead", read.name], deferMcpTools: false });
  });
});
