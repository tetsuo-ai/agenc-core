import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));

import { delegate } from "../../../src/agents/delegate.js";
import { createSpawnAgentTool } from "../../../src/agents/v2/spawn.js";
import { childRoutingSupervisorCanFallback } from "../../../src/agents/child-routing-retries.js";
import { createAgentRoleWorkspace } from "../../../src/agents/role.js";
import { AgentRoleCatalog } from "../../../src/agents/role-catalog.js";
import { StaticModelsManager } from "../../../src/llm/models-manager.js";
import { defaultConfig, type AgentsConfig } from "../../../src/config/schema.js";
import { BehaviorSubject } from "../../../src/utils/behavior-subject.js";
import { SESSION_BOUND_TOOL_SURFACE } from "../../../src/tools/session-bound-surface.js";
import type { AgentThread } from "../../../src/agents/thread.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import type { Session } from "../../../src/session/session.js";
import type { Tool } from "../../../src/tools/types.js";

const workspace = createAgentRoleWorkspace("/automatic-selection-off");
const roles = new AgentRoleCatalog(workspace);
const mockDelegate = vi.mocked(delegate);

/** spawn_agent's arguments on main, before automatic selection, in order. */
const MAIN_PROPERTIES = ["message", "message_ref", "task_name", "description", "agent_type", "model", "provider",
  "reasoning_effort", "service_tier", "exact_output", "tool_free", "fork_turns", "isolation"];
const AUTOMATIC_ARGUMENTS = {
  routing: "inherit", routing_preference: "economy", task_kind: "extraction", complexity: "simple", requires_vision: false,
  context_tokens: 1_000, max_cost_usd: 0.5,
} as const;
const MAIN_GUIDANCE = "Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed.";

async function fixture(agents?: Partial<AgentsConfig>) {
  const config = { ...defaultConfig(), model_provider: "grok", model: "grok-4.6",
    ...(agents !== undefined ? { agents: { allowed_providers: ["deepseek"], ...agents } } : {}) };
  const modelsManager = new StaticModelsManager({ config, fallbackProvider: "grok", metadata: { env: {} } });
  const session = {
    conversationId: "off-parent", abortController: new AbortController(), roleWorkspace: workspace,
    userStopGeneration: 0, stoppedByUserSinceLastPrompt: false,
    onBeforeDurableClose: () => () => {}, agentStatus: new BehaviorSubject({ status: "idle" }),
    activeTurn: { unsafePeek: () => ({ turnId: "turn-a" }) },
    emit: () => {}, nextInternalSubId: () => "event", modelInfo: await modelsManager.getModelInfo("grok-4.6"),
    config: { multiAgentV2: { hideSpawnAgentMetadata: false }, ...(agents !== undefined ? { agents: config.agents } : {}) },
    sessionConfiguration: { cwd: "/automatic-selection-off", collaborationMode: { model: "grok-4.6" } },
    providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }), environment: () => ({}),
      childProviderRoutingInfo: async () => ({ connected: true, billingSource: "byok" }) },
    services: { modelsManager, configStore: { current: () => config } },
  } as unknown as Session;
  const tool = createSpawnAgentTool({ getSession: () => session, workspace, roleCatalog: roles,
    ensureAgentControl: () => ({ control: { roleWorkspace: workspace, assertRoleWorkspace: () => {}, getLive: () => undefined }, registry: {} }),
  } as unknown as MultiAgentV2Options);
  return { session, tool };
}

function surface(tool: Tool, session: Session): { readonly description: string; readonly inputSchema: Record<string, unknown> } {
  return (tool as unknown as Record<symbol, (session: Session) => { description: string; inputSchema: Record<string, unknown> }>)[
    SESSION_BOUND_TOOL_SURFACE]!(session);
}

function fakeThread(): AgentThread {
  return { threadId: "child-1",
    live: { agentId: "child-1", agentPath: "/root/worker", nickname: "worker", role: { name: "default" },
      toolCallCount: 0, status: { value: { status: "running", turnId: "child-1" }, watch: () => () => {} } },
    onStatusChange: () => () => {}, join: async () => ({ threadId: "child-1", durationMs: 1, outcome: "completed" }),
  } as unknown as AgentThread;
}

const OFF_SETTINGS: readonly [string, Partial<AgentsConfig> | undefined][] = [
  ["no agents settings", undefined],
  ["cross-provider on, automatic choice off", { cross_provider_enabled: true, cross_provider_auto: false }],
  ["automatic choice on, cross-provider off", { cross_provider_enabled: false, cross_provider_auto: true }],
];

beforeEach(() => { mockDelegate.mockReset(); });

describe("spawn_agent with automatic selection off", () => {
  it.each(OFF_SETTINGS)("keeps main's schema and guidance: %s", async (_name, agents) => {
    const { session, tool } = await fixture(agents);
    for (const { description, inputSchema } of [surface(tool, session), { description: tool.description, inputSchema: tool.inputSchema }]) {
      const properties = inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(properties)).toEqual(MAIN_PROPERTIES);
      expect(inputSchema).toMatchObject({ required: ["task_name"], additionalProperties: false });
      expect(description).toContain(MAIN_GUIDANCE);
      expect(description).not.toMatch(/routing=inherit|automatic selection/iu);
    }
  });

  it("differs from the enabled schema only by the automatic selection arguments", async () => {
    const off = await fixture({ cross_provider_enabled: true, cross_provider_auto: false });
    const on = await fixture({ cross_provider_enabled: true, cross_provider_auto: true });
    const enabled = structuredClone(surface(on.tool, on.session).inputSchema) as { properties: Record<string, unknown> };
    expect(Object.keys(enabled.properties)).toEqual(expect.arrayContaining(Object.keys(AUTOMATIC_ARGUMENTS)));
    for (const key of Object.keys(AUTOMATIC_ARGUMENTS)) delete enabled.properties[key];
    expect(JSON.stringify(surface(off.tool, off.session).inputSchema)).toBe(JSON.stringify(enabled));
    expect(surface(on.tool, on.session).description).toContain("routing=inherit");
  });

  it("offers routing_preference only with automatic selection on, and validates it there", async () => {
    const on = await fixture({ cross_provider_enabled: true, cross_provider_auto: true });
    const properties = surface(on.tool, on.session).inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(properties.routing_preference?.enum).toEqual(["balanced", "economy", "quality", "fast"]);
    expect(properties.routing_preference?.description).toContain("Without a cap price never moves the child off your model.");
    expect(properties.routing_preference?.description).toContain("balanced, the default, and quality keep your model while it is adequate");
    const invalid = await on.tool.execute({ message: "Extract names", task_name: "worker", routing_preference: "cheapest" });
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.content)).toEqual({ error: "Invalid routing preference" });
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it.each(Object.entries(AUTOMATIC_ARGUMENTS))("rejects %s as an unknown field before any child exists", async (key, value) => {
    const { tool } = await fixture({ cross_provider_enabled: true, cross_provider_auto: false });
    const result = await tool.execute({ message: "Extract names", task_name: "worker", [key]: value });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ error: `unknown field \`${key}\`` });
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it.each(OFF_SETTINGS)("spawns as main does without the new arguments: %s", async (_name, agents) => {
    const { tool } = await fixture(agents);
    const thread = fakeThread();
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread } as Awaited<ReturnType<typeof delegate>>);
    const result = await tool.execute({ message: "Extract names", task_name: "worker", __callId: "spawn-1" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual({ task_name: "/root/worker", nickname: "worker" });
    expect(mockDelegate).toHaveBeenCalledOnce();
    const request = mockDelegate.mock.calls[0]![0];
    // No plan, so no model-call cap, forced wrap-up budget, task dollar cap,
    // context check or outcome record for this child.
    expect(request.plan).toBeUndefined();
    expect(request.model).toBeUndefined();
    expect(request).toMatchObject({ taskPrompt: "Extract names", taskId: "spawn-1", agentName: "worker",
      runInBackground: true, keepAlive: true, summarizeAtStepLimit: true, exactOutput: false });
    expect(childRoutingSupervisorCanFallback(thread.live)).toBe(false);
  });
});
