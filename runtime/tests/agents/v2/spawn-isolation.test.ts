import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../delegate.js", () => ({
  delegate: vi.fn(),
}));

import { createSpawnAgentTool } from "./spawn.js";
import { delegate } from "../delegate.js";
import type { MultiAgentV2Options } from "./common.js";
import type { Session } from "../../session/session.js";
import { createAgentRoleWorkspace } from "../role.js";
import { AgentRoleCatalog } from "../role-catalog.js";
import { signSessionId } from "../_deps/filesystem-args.js";
import { StaticModelsManager } from "../../../src/llm/models-manager.js";
import { defaultConfig } from "../../../src/config/schema.js";
import { validationErrorToolResult } from "../../../src/tools/results.js";
import { bindLiveAgentSession } from "../../../src/agents/live-session.js";
import type { LiveAgent } from "../../../src/agents/control.js";
import { BehaviorSubject } from "../../../src/utils/behavior-subject.js";
import { childTerminalOutcome } from "../../../src/agents/child-terminal.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace("/repo");
const ROLE_CATALOG = new AgentRoleCatalog(ROLE_WORKSPACE);

const mockDelegate = vi.mocked(delegate);

interface FakeSchema {
  readonly properties: Record<string, Record<string, unknown>>;
}

function fakeThread(
  withWorktree: boolean,
  opts: {
    readonly threadId?: string;
    readonly agentPath?: string;
    readonly worktreeSlug?: string;
  } = {},
): unknown {
  const threadId = opts.threadId ?? "thread-x";
  const agentPath = opts.agentPath ?? "/root/writer_a";
  const worktreeSlug = opts.worktreeSlug ?? "writer_a";
  return {
    threadId,
    live: {
      agentId: threadId,
      agentPath,
      nickname: "wt",
      role: { name: "default" },
      status: { value: "running", watch: () => () => {} },
    },
    ...(withWorktree
      ? {
          worktree: {
            path: `/repo/.agenc-worktrees/${worktreeSlug}`,
            branch: `worktree-${worktreeSlug}`,
            gitRoot: "/repo",
            created: true,
          },
        }
      : {}),
    onStatusChange: () => () => {},
    join: async () => ({
      threadId,
      durationMs: 1,
      outcome: "completed",
    }),
  };
}

function makeSession(): Session {
  const emitted: unknown[] = [];
  return {
    conversationId: "conv-1",
    abortController: new AbortController(),
    onBeforeDurableClose: () => () => {},
    agentStatus: new BehaviorSubject({ status: "idle" }),
    roleWorkspace: ROLE_WORKSPACE,
    emit: (event: unknown) => emitted.push(event),
    nextInternalSubId: () => `sub-${emitted.length}`,
    modelInfo: { slug: "test-model" },
    sessionConfiguration: {
      cwd: "/repo",
      collaborationMode: { model: "test-model" },
    },
    config: { multiAgentV2: { hideSpawnAgentMetadata: false } },
    services: {
      modelsManager: {
        tryListModels: () => undefined,
        listModels: async () => [],
        getModelInfo: async () => ({ slug: "test-model" }),
      },
    },
  } as unknown as Session;
}

function makeOptions(
  session: Session,
  liveById: Readonly<Record<string, unknown>> = {},
): MultiAgentV2Options {
  return {
    getSession: () => session,
    workspace: ROLE_WORKSPACE,
    roleCatalog: ROLE_CATALOG,
    ensureAgentControl: () => ({
      control: {
        roleWorkspace: ROLE_WORKSPACE,
        assertRoleWorkspace: () => {},
        getLive: (id: string) => liveById[id],
        getAgentMetadata: (id: string) => (liveById[id] as { metadata?: unknown } | undefined)?.metadata,
      },
      registry: {},
    }),
  } as unknown as MultiAgentV2Options;
}

describe("spawn_agent isolation", () => {
  beforeEach(() => {
    mockDelegate.mockReset();
  });

  async function crossProviderFixture(allowed: readonly string[], enabled = true, activeProvider: "grok" | "deepseek" = "grok") {
    const config = {
      ...defaultConfig(),
      model_provider: activeProvider,
      model: activeProvider === "grok" ? "grok-4.6" : "deepseek-v4-pro",
      agents: { cross_provider_enabled: enabled, allowed_providers: allowed },
    };
    const modelsManager = new StaticModelsManager({ config, fallbackProvider: activeProvider });
    const base = makeSession();
    const session = {
      ...base,
      modelInfo: await modelsManager.getModelInfo(config.model),
      sessionConfiguration: {
        ...base.sessionConfiguration,
        collaborationMode: { model: config.model },
      },
      config: { ...base.config, agents: config.agents },
      providerService: { current: () => ({ provider: activeProvider, model: config.model }) },
      services: {
        ...base.services,
        modelsManager,
        configStore: { current: () => config },
        crossProviderConsent: {
          ownerSessionId: "conv-1", sessionEpoch: "test-interactive-session",
          request: async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
            kind: "granted" as const,
            grant: { kind: "once" as const, ownerSessionId: "conv-1", sessionEpoch: "test-interactive-session",
              taskId: disclosure.taskId, scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
          }),
        },
      },
    } as unknown as Session;
    return { session, tool: createSpawnAgentTool(makeOptions(session)) };
  }

  it("keeps cross-provider spawning off by default", async () => {
    const { tool } = await crossProviderFixture(["deepseek"], false);
    const result = await tool.execute({ message: "inspect", task_name: "worker", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cross_provider_enabled = true");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("does not dispatch the task payload before a human grant", async () => {
    const { session, tool } = await crossProviderFixture(["deepseek"]);
    const request = vi.fn(async (_session: Session, disclosure: { taskText: string }) => {
      expect(disclosure.taskText).toBe("read the confidential design");
      expect(mockDelegate).not.toHaveBeenCalled();
      return { kind: "consent_denied" as const, reason: "User denied" };
    });
    Object.assign(session.services, { crossProviderConsent: {
      ownerSessionId: session.conversationId, sessionEpoch: "test-interactive-session", request,
    } });
    const result = await tool.execute({ message: "read the confidential design", task_name: "worker",
      provider: "deepseek", model: "deepseek-v4-pro" });
    expect(request).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content).toContain("consent_denied");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("accepts an explicit pair on the current provider without the cross-provider switch", async () => {
    const { tool } = await crossProviderFixture(["grok"], false);
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await tool.execute({ message: "inspect", task_name: "worker", provider: "grok", model: "grok-4.6" });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate.mock.calls[0]?.[0].providerSelection).toBeUndefined();
    expect(mockDelegate.mock.calls[0]?.[0].plan).toBeUndefined();
  });

  it.each(["string", "object"] as const)("projects a %s live status safely", async (shape) => {
    const session = makeSession();
    const events: Array<{ msg: { type: string; payload: Record<string, unknown> } }> = [];
    Object.assign(session, { emit: (event: typeof events[number]) => events.push(event) });
    const terminal = childTerminalOutcome({ provider: "grok", model: "test-model",
      reason: "completed", dispatch: "sent", completedWork: "done" });
    const thread = fakeThread(false, { threadId: `thread-${shape}` }) as {
      live: { status: { value: unknown } };
    };
    thread.live.status.value = shape === "string" ? "running" : { status: "idle", terminal };
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: thread as never });
    const result = await createSpawnAgentTool(makeOptions(session)).execute({ message: "inspect", task_name: `worker_${shape}` });
    expect(result.isError).not.toBe(true);
    const statuses = events.filter((event) => event.msg.type === "collab_agent_status");
    expect(statuses.length).toBeGreaterThan(0);
    if (shape === "string") expect(statuses[0]!.msg.payload).not.toHaveProperty("terminal");
    else expect(statuses[0]!.msg.payload.terminal).toEqual(terminal);
  });

  it("refuses a provider outside the operator allowlist", async () => {
    const { tool } = await crossProviderFixture(["openai"]);
    const result = await tool.execute({ message: "inspect", task_name: "worker", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("allowed_providers");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("refuses a model known to lack client-side tools unless tool_free is explicit", async () => {
    const { tool } = await crossProviderFixture(["grok"], true, "deepseek");
    const refused = await tool.execute({ message: "inspect", task_name: "worker", provider: "grok", model: "grok-4.20-multi-agent-0309" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("client-side tool calling");
    expect(mockDelegate).not.toHaveBeenCalled();
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const allowed = await tool.execute({ message: "summarize", task_name: "worker", provider: "grok", model: "grok-4.20-multi-agent-0309", tool_free: true });
    expect(allowed.isError).not.toBe(true);
    expect(mockDelegate.mock.calls[0]?.[0].plan?.scope.tools).toEqual([]);
  });

  it("does not inherit a same-named service tier across providers", async () => {
    const { session } = await crossProviderFixture(["openai"]);
    Object.assign(session.sessionConfiguration, { serviceTier: "priority" });
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await createSpawnAgentTool(makeOptions(session)).execute({
      message: "inspect", task_name: "worker", provider: "openai", model: "gpt-5.4",
    });
    expect(result.isError).not.toBe(true);
    const delegated = mockDelegate.mock.calls[0]?.[0];
    expect(delegated?.plan?.serviceTier ?? delegated?.serviceTier).toBeUndefined();
  });

  it("reports a role-selected destination and effort in spawn events and result", async () => {
    const { session } = await crossProviderFixture(["openai"]);
    const events: Array<{ msg: { type: string; payload: Record<string, unknown> } }> = [];
    Object.assign(session, { emit: (event: typeof events[number]) => events.push(event) });
    const options = makeOptions(session);
    const roleOptions = {
      ...options,
      ensureAgentControl: () => {
        const original = options.ensureAgentControl(session);
        return { ...original, control: { ...original.control,
          roleCatalog: { require: () => ({ name: "research", config: {
            model: "openai/gpt-5.4", reasoningEffort: "high",
          } }) },
        } };
      },
    } as unknown as MultiAgentV2Options;
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await createSpawnAgentTool(roleOptions).execute({
      message: "inspect", task_name: "worker", agent_type: "research",
    });
    expect(result.isError).not.toBe(true);
    for (const event of events.filter((entry) => entry.msg.type.startsWith("collab_agent_spawn_"))) {
      expect(event.msg.payload).toMatchObject({ provider: "openai", model: "gpt-5.4", reasoningEffort: "high" });
    }
    expect(result.content).toContain('"provider":"openai"');
    expect(result.content).toContain('"model":"gpt-5.4"');
  });

  it("refuses a foreign bare slug instead of treating the flattened list as local", async () => {
    const { session, tool } = await crossProviderFixture(["deepseek"]);
    session.services.modelsManager.tryListModels = () => [session.modelInfo];
    const result = await tool.execute({ message: "inspect", task_name: "worker", model: "deepseek-v4-pro" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown model `deepseek-v4-pro` for spawn_agent");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("keeps a slash-containing local model on its current provider", async () => {
    const config = {
      ...defaultConfig(), model_provider: "openrouter", model: "openai/gpt-4o-mini",
      agents: { cross_provider_enabled: false, allowed_providers: [] },
    };
    const modelsManager = new StaticModelsManager({ config, fallbackProvider: "openrouter" });
    const base = makeSession();
    const session = {
      ...base,
      modelInfo: await modelsManager.getModelInfo("openai/gpt-4o-mini"),
      sessionConfiguration: { ...base.sessionConfiguration, collaborationMode: { model: "openai/gpt-4o-mini" } },
      providerService: { current: () => ({ provider: "openrouter", model: "openai/gpt-4o-mini" }) },
      services: { ...base.services, modelsManager, configStore: { current: () => config } },
    } as unknown as Session;
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await createSpawnAgentTool(makeOptions(session)).execute({
      message: "inspect", task_name: "worker", model: "openai/gpt-4o-mini",
    });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate.mock.calls[0]?.[0].providerSelection).toBeUndefined();
    expect(mockDelegate.mock.calls[0]?.[0].plan).toBeUndefined();
  });

  it("advertises a live-only local model with a production configStore", async () => {
    const { session } = await crossProviderFixture([], false);
    const local = { ...session.modelInfo, slug: "team/live-only" };
    session.services.modelsManager.tryListModels = () => [session.modelInfo, local];
    session.services.modelsManager.listModels = async () => [session.modelInfo, local];
    session.services.modelsManager.getModelInfo = async (slug) => slug === local.slug ? local : session.modelInfo;
    const tool = createSpawnAgentTool(makeOptions(session));
    const schema = tool.inputSchema as unknown as FakeSchema;
    expect(schema.properties.model?.enum).toContain(local.slug);
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await tool.execute({ message: "inspect", task_name: "worker", model: local.slug });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate.mock.calls[0]?.[0].providerSelection).toBeUndefined();
  });

  it.each([
    { provider: "deepseek", model: "deepseek-v4-pro" },
    { model: "deepseek/deepseek-v4-pro" },
  ])("passes a validated target pair and full metadata to the child: %j", async (selection) => {
    const { tool } = await crossProviderFixture(["deepseek"]);
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await tool.execute({ message: "inspect", task_name: "worker", ...selection });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        route: { provider: "deepseek", model: "deepseek-v4-pro" },
        destination: expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-pro" }),
        modelInfo: expect.objectContaining({ slug: "deepseek-v4-pro", contextWindow: 1_048_576 }),
      }),
    }));
    expect(tool.description).toContain("deepseek/deepseek-v4-pro");
    expect(tool.description).toContain("BYOK API key at the provider's canonical endpoint");
  });

  it.each([
    { reasoning_effort: "medium", expected: "Reasoning effort" },
    { service_tier: "priority", expected: "Service tier" },
  ])("validates target model metadata: %j", async ({ expected, ...override }) => {
    const { tool } = await crossProviderFixture(["deepseek"]);
    const result = await tool.execute({ message: "inspect", task_name: "worker", provider: "deepseek", model: "deepseek-v4-pro", ...override });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(expected);
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("validates a role's effective service tier against the target model", async () => {
    const { session } = await crossProviderFixture(["deepseek"]);
    const options = makeOptions(session);
    const roleOptions = {
      ...options,
      ensureAgentControl: () => {
        const original = options.ensureAgentControl(session);
        return {
          ...original,
          control: {
            ...original.control,
            roleCatalog: { require: () => ({ name: "priority-role", config: { serviceTier: "priority" } }) },
          },
        };
      },
    } as unknown as MultiAgentV2Options;
    const result = await createSpawnAgentTool(roleOptions).execute({
      message: "inspect", task_name: "worker", agent_type: "priority-role",
      provider: "deepseek", model: "deepseek-v4-pro",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Role service tier");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it.each(["all", "3"])("requires a clean history for a cross-provider child: %s", async (fork_turns) => {
    const { tool } = await crossProviderFixture(["deepseek"]);
    const result = await tool.execute({ message: "inspect", task_name: "worker", provider: "deepseek", model: "deepseek-v4-pro", fork_turns });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("fork_turns = none");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  function callerFixture() {
    const root = makeSession();
    const child = { ...makeSession(), conversationId: "calling-child", sessionConfiguration: { ...root.sessionConfiguration, cwd: "/repo/implementation" }, services: { ...root.services, sandboxExecutionBroker: { authority: "child-only" } } } as unknown as Session;
    const live = { agentId: child.conversationId, agentPath: "/root/implementation", nickname: "implementation", role: { name: "default" }, abortController: new AbortController() } as LiveAgent;
    const liveById: Record<string, LiveAgent> = { [live.agentId]: live };
    const revoke = bindLiveAgentSession(live, child);
    const opts = makeOptions(root, liveById);
    return { child, live, liveById, revoke, opts, args: { message: "inspect", task_name: "worker", __agencSessionId: live.agentId, __agencSessionIdSig: signSessionId(live.agentId) } };
  }

  it("routes a nested cross-provider spawn from the live child authority", async () => {
    const fixture = callerFixture();
    const config = {
      ...defaultConfig(),
      model_provider: "deepseek", model: "deepseek-v4-pro",
      agents: { cross_provider_enabled: true, allowed_providers: ["openai"] },
    };
    Object.assign(fixture.child, {
      providerService: { current: () => ({ provider: "deepseek", model: "deepseek-v4-pro" }) },
      services: {
        ...fixture.child.services,
        configStore: { current: () => config },
        modelsManager: new StaticModelsManager({ config, fallbackProvider: "deepseek" }),
        crossProviderConsent: {
          ownerSessionId: "conv-1", sessionEpoch: "test-interactive-session",
          request: async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
            kind: "granted" as const,
            grant: { kind: "once" as const, ownerSessionId: "conv-1", sessionEpoch: "test-interactive-session",
              taskId: disclosure.taskId, scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
          }),
        },
      },
    });
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await createSpawnAgentTool(fixture.opts).execute({
      ...fixture.args, provider: "openai", model: "gpt-5.4",
    });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate).toHaveBeenCalledWith(expect.objectContaining({
      parent: fixture.child,
      plan: expect.objectContaining({ route: { provider: "openai", model: "gpt-5.4" } }),
    }));
    expect(mockDelegate.mock.calls[0]?.[0].parent.services.sandboxExecutionBroker)
      .toBe(fixture.child.services.sandboxExecutionBroker);
    fixture.revoke();
  });

  it("keeps consent destination provenance on a same-provider grandchild", async () => {
    const fixture = callerFixture();
    const config = { ...defaultConfig(), model_provider: "deepseek", model: "deepseek-v4-pro",
      agents: { cross_provider_enabled: true, allowed_providers: ["deepseek"] } };
    const request = vi.fn(async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
      kind: "granted" as const, grant: { kind: "once" as const,
        ownerSessionId: "conv-1", sessionEpoch: "epoch", taskId: disclosure.taskId,
        scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
    }));
    Object.assign(fixture.live, { metadata: { executionPlan: { crossProvider: true,
      destination: { provider: "deepseek", model: "deepseek-v4-pro" } } } });
    Object.assign(fixture.child, { modelInfo: { slug: "deepseek-v4-pro", provider: "deepseek", supportsToolUse: true },
      sessionConfiguration: { ...fixture.child.sessionConfiguration,
        collaborationMode: { model: "deepseek-v4-pro" } },
      providerService: { current: () => ({ provider: "deepseek", model: "deepseek-v4-pro" }) },
      services: { ...fixture.child.services, configStore: { current: () => config },
        modelsManager: new StaticModelsManager({ config, fallbackProvider: "deepseek" }),
        crossProviderConsent: { ownerSessionId: "conv-1", sessionEpoch: "epoch", request } } });
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await createSpawnAgentTool(fixture.opts).execute(fixture.args);
    expect(result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(mockDelegate.mock.calls[0]?.[0].plan).toMatchObject({ crossProvider: true,
      destination: { provider: "deepseek", model: "deepseek-v4-pro" },
      consentGrant: { ownerSessionId: "conv-1" } });
    fixture.revoke();
  });

  it("resolves inherited-provenance descendant metadata locally before consent", async () => {
    const fixture = callerFixture();
    const config = { ...defaultConfig(), model_provider: "openai", model: "gpt-5.3-codex",
      agents: { cross_provider_enabled: true, allowed_providers: ["openai"] } };
    const modelsManager = new StaticModelsManager({ config, fallbackProvider: "openai" });
    const authenticatedDiscovery = vi.spyOn(modelsManager, "getModelInfoForProvider")
      .mockImplementation(async () => { throw new Error("authenticated metadata discovery before consent"); });
    const request = vi.fn(async () => {
      expect(authenticatedDiscovery).not.toHaveBeenCalled();
      return { kind: "consent_denied" as const, reason: "User denied" };
    });
    Object.assign(fixture.live, { metadata: { executionPlan: { crossProvider: true,
      destination: { provider: "openai", model: "gpt-5.3-codex" } } } });
    Object.assign(fixture.child, {
      modelInfo: await modelsManager.getModelInfo("gpt-5.3-codex"),
      sessionConfiguration: { ...fixture.child.sessionConfiguration,
        collaborationMode: { model: "gpt-5.3-codex" } },
      config: { ...fixture.child.config, agents: config.agents },
      providerService: { current: () => ({ provider: "openai", model: "gpt-5.3-codex" }) },
      services: { ...fixture.child.services, configStore: { current: () => config },
        modelsManager, crossProviderConsent: { ownerSessionId: "conv-1", sessionEpoch: "epoch", request } },
    });
    const result = await createSpawnAgentTool(fixture.opts).execute({ ...fixture.args,
      model: "gpt-5.4" });
    expect(result.content).toContain("consent_denied");
    expect(request).toHaveBeenCalledOnce();
    expect(authenticatedDiscovery).not.toHaveBeenCalled();
    expect(mockDelegate).not.toHaveBeenCalled();
    fixture.revoke();
  });

  it.each(["explicit", "inherited"] as const)("carries %s effort in a descendant consent plan", async (kind) => {
    const fixture = callerFixture();
    const config = { ...defaultConfig(), model_provider: "openai", model: "gpt-5.4",
      agents: { cross_provider_enabled: true, allowed_providers: ["openai"] } };
    const modelsManager = new StaticModelsManager({ config, fallbackProvider: "openai" });
    Object.assign(fixture.live, { metadata: { executionPlan: { crossProvider: true,
      destination: { provider: "openai", model: "gpt-5.4" } } } });
    Object.assign(fixture.child, {
      modelInfo: await modelsManager.getModelInfo("gpt-5.4"),
      sessionConfiguration: { ...fixture.child.sessionConfiguration,
        collaborationMode: { model: "gpt-5.4", reasoningEffort: "high" } },
      config: { ...fixture.child.config, agents: config.agents },
      providerService: { current: () => ({ provider: "openai", model: "gpt-5.4" }) },
      services: { ...fixture.child.services, configStore: { current: () => config }, modelsManager,
        crossProviderConsent: { ownerSessionId: "conv-1", sessionEpoch: "epoch",
          request: async (_requester: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
            kind: "granted" as const, grant: { kind: "once" as const, ownerSessionId: "conv-1",
              sessionEpoch: "epoch", taskId: disclosure.taskId, scopeKey: disclosure.scopeKey,
              payloadKey: disclosure.payloadKey },
          }) } },
    });
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await createSpawnAgentTool(fixture.opts).execute({ ...fixture.args,
      ...(kind === "explicit" ? { reasoning_effort: "low" } : {}) });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate.mock.calls[0]?.[0].plan?.reasoningEffort)
      .toBe(kind === "explicit" ? "low" : "high");
    fixture.revoke();
  });

  it("uses the authenticated child's session and retains the root control namespace", async () => {
    const fixture = callerFixture();
    const ensure = vi.spyOn(fixture.opts, "ensureAgentControl");
    mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) as never });
    const result = await createSpawnAgentTool(fixture.opts).execute(fixture.args);
    expect(result.isError).not.toBe(true);
    expect(mockDelegate.mock.calls[0]![0].parent).toBe(fixture.child);
    expect(mockDelegate.mock.calls[0]![0].parent.services.sandboxExecutionBroker).toBe(fixture.child.services.sandboxExecutionBroker);
    expect(ensure.mock.calls.every(([session]) => session === fixture.opts.getSession())).toBe(true);
  });

  it.each(["missing", "copied", "revoked", "aborted", "closing", "changed_path", "forged"] as const)("refuses %s caller authority before delegation", async (kind) => {
    const fixture = callerFixture();
    if (kind === "missing") delete fixture.liveById[fixture.live.agentId];
    if (kind === "copied") fixture.liveById[fixture.live.agentId] = { ...fixture.live };
    if (kind === "revoked") fixture.revoke();
    if (kind === "aborted") fixture.live.abortController.abort();
    if (kind === "closing") Object.defineProperty(fixture.child, "isShuttingDown", { value: true });
    if (kind === "changed_path") Object.defineProperty(fixture.live, "agentPath", { value: "/root/sibling" });
    if (kind === "forged") fixture.args.__agencSessionIdSig = "forged";
    const result = await createSpawnAgentTool(fixture.opts).execute(fixture.args);
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toBeDefined();
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("cannot bind a sibling's Session to another live agent", () => {
    const fixture = callerFixture();
    fixture.revoke();
    expect(() => bindLiveAgentSession(fixture.live, { ...fixture.child, conversationId: "sibling" } as Session)).toThrow(/does not match/);
  });

  it.each(["revoked", "replaced"] as const)("rechecks a caller %s during model validation", async (kind) => {
    const fixture = callerFixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.spyOn(fixture.child.services.modelsManager, "listModels").mockImplementation(async () => { await pending; return [{ slug: "test-model" }] as never; });
    const call = createSpawnAgentTool(fixture.opts).execute({ ...fixture.args, model: "test-model" });
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    fixture.revoke();
    if (kind === "replaced") bindLiveAgentSession(fixture.live, { ...fixture.child } as Session);
    release();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no longer live");
    expect(result.effectDisposition).toBeDefined();
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves only authoritative delegate refusal evidence: %s", async (confirmed) => {
    const evidence = validationErrorToolResult("worktree:precondition", "invalid HEAD").effectDisposition;
    mockDelegate.mockResolvedValue({
      kind: "rejected",
      code: "WORKTREE_UNAVAILABLE",
      category: "environment",
      reason: "invalid HEAD",
      ...(confirmed ? { effectDisposition: evidence } : {}),
    });
    const result = await createSpawnAgentTool(makeOptions(makeSession())).execute({
      message: "write files",
      task_name: "worker",
      __callId: "spawn-precondition",
    });
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toEqual(confirmed ? evidence : undefined);
  });

  it.each(["override", "role"] as const)("validates Gemini %s effort against real model metadata", async (source) => {
    const modelsManager = new StaticModelsManager({
      config: { ...defaultConfig(), model_provider: "gemini", model: "gemini-3.1-pro-preview" },
    });
    const base = makeSession();
    const session = {
      ...base,
      modelInfo: await modelsManager.getModelInfo("gemini-3.1-pro-preview"),
      sessionConfiguration: { ...base.sessionConfiguration, collaborationMode: { model: "gemini-3.1-pro-preview" } },
      providerService: { current: () => ({ provider: "gemini", model: "gemini-3.1-pro-preview" }) },
      services: { ...base.services, modelsManager },
    } as Session;
    for (const effort of ["low", "medium", "high", "none", "minimal", "xhigh", "max"] as const) {
      mockDelegate.mockReset();
      mockDelegate.mockResolvedValue({ kind: "async_launched", thread: fakeThread(false) } as never);
      const options = makeOptions(session);
      const roleOptions = source === "role" ? {
        ...options,
        ensureAgentControl: () => {
          const original = options.ensureAgentControl(session);
          return { ...original, control: { ...original.control, roleCatalog: { require: () => ({ name: "gemini-review", config: { reasoningEffort: effort } }) } } };
        },
      } as unknown as MultiAgentV2Options : options;
      const result = await createSpawnAgentTool(roleOptions).execute({
        message: "review fixture",
        task_name: "gemini_review",
        ...(source === "role" ? { agent_type: "gemini-review" } : { reasoning_effort: effort }),
        __callId: `gemini-${source}-${effort}`,
      });
      if (["low", "medium", "high", "none"].includes(effort)) {
        expect(result.isError).not.toBe(true);
        expect(mockDelegate).toHaveBeenCalledWith(expect.objectContaining({
          reasoningEffort: effort,
        }));
      } else {
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/is not supported for model|invalid reasoning_effort/u);
        expect(mockDelegate).not.toHaveBeenCalled();
      }
    }
  });

  it("refuses an unknown model as a confirmed no-effect failure before anything is spawned", async () => {
    // #2190: a bare isError from a side-effecting tool is filed as an unknown
    // outcome and gates the session behind /resolve; nothing was spawned here.
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));

    const result = await tool.execute({
      message: "review the change",
      task_name: "review",
      model: "sonnet",
      __callId: "spawn-unknown-model",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Unknown model");
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it.each([
    ["review-patch", "review_patch"],
    ["Review Patch", "review_patch"],
    ["plan#1", "plan_1"],
  ])(
    "normalizes task_name %j before public spawn dispatch",
    async (input, expected) => {
      const session = makeSession();
      const tool = createSpawnAgentTool(makeOptions(session));
      mockDelegate.mockResolvedValueOnce({
        kind: "async_launched",
        thread: fakeThread(false, { agentPath: `/root/${expected}` }) as never,
      });

      const result = await tool.execute({
        message: "review the change",
        task_name: input,
        __callId: `spawn-${expected}`,
      });

      expect(result.isError).not.toBe(true);
      expect(mockDelegate).toHaveBeenCalledOnce();
      expect(mockDelegate.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ agentName: expected }),
      );
    },
  );

  it.each([
    ["root", "agent_name `root` is reserved"],
    [".", "agent_name `.` is reserved"],
    ["..", "agent_name `..` is reserved"],
    ["", "task_name is required"],
    [" \t\n ", "task_name is required"],
    [
      "---",
      "agent_name must use only lowercase letters, digits, and underscores",
    ],
    ["/", "agent_name must not contain `/`"],
    [
      "مرحبا",
      "agent_name must use only lowercase letters, digits, and underscores",
    ],
  ])(
    "rejects task_name %j with its public validation error",
    async (input, error) => {
      const session = makeSession();
      const tool = createSpawnAgentTool(makeOptions(session));

      const result = await tool.execute({
        message: "review the change",
        task_name: input,
        __callId: "spawn-invalid-name",
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(String(result.content))).toEqual({ error });
      expect(mockDelegate).not.toHaveBeenCalled();
    },
  );

  it("exposes the isolation enum in the input schema", () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    const schema = tool.inputSchema as unknown as FakeSchema;
    expect(schema.properties.isolation?.enum).toEqual(["none", "worktree"]);
    expect(String(schema.properties.isolation?.description)).toContain(
      "worktree",
    );
  });

  it("passes a session/path/spawn-scoped worktree slug through to delegate", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    mockDelegate.mockImplementationOnce(async (delegateOpts) => {
      const worktreeSlug = delegateOpts.worktreeSlug;
      return {
        kind: "async_launched",
        thread: fakeThread(true, {
          ...(worktreeSlug !== undefined ? { worktreeSlug } : {}),
        }) as never,
      };
    });
    const result = await tool.execute({
      message: "write the parser",
      task_name: "writer_a",
      fork_turns: "none",
      isolation: "worktree",
      __callId: "spawn-writer-a",
    });
    const delegateOpts = mockDelegate.mock.calls[0]?.[0];
    expect(delegateOpts).toEqual(
      expect.objectContaining({ isolation: "worktree" }),
    );
    const worktreeSlug = delegateOpts?.worktreeSlug;
    expect(worktreeSlug).toMatch(/^writer_a-[a-f0-9]{32}$/u);
    expect(worktreeSlug?.length).toBeLessThanOrEqual(64);
    const payload = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >;
    expect(payload.isolation).toBe("worktree");
    expect(payload.worktree_path).toBe(
      `/repo/.agenc-worktrees/${worktreeSlug}`,
    );
    expect(payload.worktree_branch).toBe(`worktree-${worktreeSlug}`);
  });

  it("gives nested parents with the same child name distinct worktree paths and branches", async () => {
    const session = makeSession();
    const liveById = {
      "parent-a": {
        agentId: "parent-a",
        agentPath: "/root/parent_a",
        nickname: "parent-a",
        role: { name: "default" },
        abortController: new AbortController(),
      },
      "parent-b": {
        agentId: "parent-b",
        agentPath: "/root/parent_b",
        nickname: "parent-b",
        role: { name: "default" },
        abortController: new AbortController(),
      },
    };
    const parentA = { ...makeSession(), conversationId: "parent-a" } as Session;
    const parentB = { ...makeSession(), conversationId: "parent-b" } as Session;
    bindLiveAgentSession(liveById["parent-a"] as LiveAgent, parentA);
    bindLiveAgentSession(liveById["parent-b"] as LiveAgent, parentB);
    const tool = createSpawnAgentTool(makeOptions(session, liveById));
    let threadCounter = 0;
    mockDelegate.mockImplementation(async (delegateOpts) => {
      threadCounter += 1;
      const worktreeSlug = delegateOpts.worktreeSlug;
      return {
        kind: "async_launched",
        thread: fakeThread(true, {
          threadId: `thread-${threadCounter}`,
          agentPath: `${delegateOpts.parentPath}/shared_writer`,
          ...(worktreeSlug !== undefined ? { worktreeSlug } : {}),
        }) as never,
      };
    });

    const first = await tool.execute({
      message: "write from parent A",
      task_name: "shared_writer",
      isolation: "worktree",
      __agencSessionId: "parent-a",
      __agencSessionIdSig: signSessionId("parent-a"),
      __callId: "shared-spawn-epoch",
    });
    const second = await tool.execute({
      message: "write from parent B",
      task_name: "shared_writer",
      isolation: "worktree",
      __agencSessionId: "parent-b",
      __agencSessionIdSig: signSessionId("parent-b"),
      __callId: "shared-spawn-epoch",
    });

    const firstOpts = mockDelegate.mock.calls[0]?.[0];
    const secondOpts = mockDelegate.mock.calls[1]?.[0];
    expect(firstOpts?.parentPath).toBe("/root/parent_a");
    expect(secondOpts?.parentPath).toBe("/root/parent_b");
    expect(firstOpts?.parent).toBe(parentA);
    expect(secondOpts?.parent).toBe(parentB);
    expect(firstOpts?.worktreeSlug).not.toBe(secondOpts?.worktreeSlug);
    expect(firstOpts?.worktreeSlug).toMatch(
      /^shared_writer-[a-f0-9]{32}$/u,
    );
    expect(secondOpts?.worktreeSlug).toMatch(
      /^shared_writer-[a-f0-9]{32}$/u,
    );

    const firstPayload = JSON.parse(String(first.content)) as Record<
      string,
      unknown
    >;
    const secondPayload = JSON.parse(String(second.content)) as Record<
      string,
      unknown
    >;
    expect(firstPayload.worktree_path).not.toBe(secondPayload.worktree_path);
    expect(firstPayload.worktree_branch).not.toBe(
      secondPayload.worktree_branch,
    );
  });

  it("gives a later logical respawn at the same path a fresh worktree", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    let threadCounter = 0;
    mockDelegate.mockImplementation(async (delegateOpts) => {
      threadCounter += 1;
      const worktreeSlug = delegateOpts.worktreeSlug;
      return {
        kind: "async_launched",
        thread: fakeThread(true, {
          threadId: `respawn-thread-${threadCounter}`,
          agentPath: "/root/shared_writer",
          ...(worktreeSlug !== undefined ? { worktreeSlug } : {}),
        }) as never,
      };
    });

    const first = await tool.execute({
      message: "first logical worker",
      task_name: "shared_writer",
      isolation: "worktree",
      __callId: "spawn-epoch-one",
    });
    const second = await tool.execute({
      message: "replacement logical worker",
      task_name: "shared_writer",
      isolation: "worktree",
      __callId: "spawn-epoch-two",
    });

    const firstOpts = mockDelegate.mock.calls[0]?.[0];
    const secondOpts = mockDelegate.mock.calls[1]?.[0];
    expect(firstOpts?.parentPath).toBe("/root");
    expect(secondOpts?.parentPath).toBe("/root");
    expect(firstOpts?.worktreeSlug).not.toBe(secondOpts?.worktreeSlug);

    const firstPayload = JSON.parse(String(first.content)) as Record<
      string,
      unknown
    >;
    const secondPayload = JSON.parse(String(second.content)) as Record<
      string,
      unknown
    >;
    expect(firstPayload.worktree_path).not.toBe(secondPayload.worktree_path);
    expect(firstPayload.worktree_branch).not.toBe(
      secondPayload.worktree_branch,
    );
  });

  it("omits isolation from delegate opts when not requested", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    mockDelegate.mockResolvedValueOnce({
      kind: "async_launched",
      thread: fakeThread(false) as never,
    });
    const result = await tool.execute({
      message: "scan the repo",
      task_name: "scanner_a",
      fork_turns: "none",
    });
    const delegateOpts = mockDelegate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(delegateOpts.isolation).toBeUndefined();
    expect(delegateOpts.worktreeSlug).toBeUndefined();
    const payload = JSON.parse(String(result.content)) as Record<
      string,
      unknown
    >;
    expect(payload.worktree_path).toBeUndefined();
  });

  it("rejects invalid isolation values before spawning", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    const result = await tool.execute({
      message: "do it",
      task_name: "x",
      isolation: "chroot",
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain(
      "isolation must be `none` or `worktree`",
    );
    expect(mockDelegate).not.toHaveBeenCalled();
  });

  it("does not claim no effect after delegate crosses the spawn boundary", async () => {
    const session = makeSession();
    const tool = createSpawnAgentTool(makeOptions(session));
    mockDelegate.mockResolvedValueOnce({
      kind: "rejected",
      reason: "worktree cleanup uncertain",
    });

    const result = await tool.execute({
      message: "do it",
      task_name: "worker",
      isolation: "worktree",
    });

    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toBeUndefined();
  });
});
