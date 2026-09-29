import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));
vi.mock("../../../src/agents/child-routing-supervisor.js", () => ({ observeChildRoutingAttempt: vi.fn() }));

import { delegate } from "../../../src/agents/delegate.js";
import { observeChildRoutingAttempt } from "../../../src/agents/child-routing-supervisor.js";
import { requestParentFollowupTurn } from "../../../src/agents/run-agent.js";
import { createSpawnAgentTool } from "../../../src/agents/v2/spawn.js";
import { createAgentRoleWorkspace } from "../../../src/agents/role.js";
import { AgentRoleCatalog } from "../../../src/agents/role-catalog.js";
import { StaticModelsManager } from "../../../src/llm/models-manager.js";
import { defaultConfig } from "../../../src/config/schema.js";
import { BehaviorSubject } from "../../../src/utils/behavior-subject.js";
import type { Session } from "../../../src/session/session.js";
import type { AgentThread } from "../../../src/agents/thread.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import type { ChildTerminalReason } from "../../../src/agents/child-terminal.js";
import type { ChildRoutingAttemptResult } from "../../../src/agents/child-routing-fallback.js";

const workspace = createAgentRoleWorkspace("/routing-fixture");
const roles = new AgentRoleCatalog(workspace);
const mockDelegate = vi.mocked(delegate);
const mockObserve = vi.mocked(observeChildRoutingAttempt);

async function fixture(options: { deferRetry?: boolean } = {}) {
  const config = { ...defaultConfig(), model_provider: "grok", model: "grok-4.6",
    agents: { cross_provider_enabled: true, cross_provider_auto: true, allowed_providers: ["deepseek", "openai"] } };
  const modelsManager = new StaticModelsManager({ config, fallbackProvider: "grok", metadata: { env: {} } });
  const events: Array<{ msg?: { type?: string; payload?: { callId?: string } } }> = [];
  const queuedMessages: unknown[] = [];
  const send = vi.fn((message: { content: string; triggerTurn?: boolean }) => { queuedMessages.push(message); return queuedMessages.length; });
  const submitChildFollowup = vi.fn(async () => { queuedMessages.length = 0; return true; });
  let activeTurnId: string | undefined = "human-turn-a";
  let denyNextConsent = false;
  let resolveFirst!: (outcome: ChildRoutingAttemptResult<AgentThread>) => void;
  const firstObservation = new Promise<ChildRoutingAttemptResult<AgentThread>>(resolve => { resolveFirst = resolve; });
  let resolveRetry!: (outcome: ChildRoutingAttemptResult<AgentThread>) => void;
  const retryObservation = new Promise<ChildRoutingAttemptResult<AgentThread>>(resolve => { resolveRetry = resolve; });
  const requestConsent = vi.fn(async (_session: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => {
    if (denyNextConsent) return { kind: "consent_unavailable" as const, reason: "A fresh funds-stop confirmation is unavailable." };
    return { kind: "granted" as const, grant: { kind: "once" as const, ownerSessionId: "routing-parent", sessionEpoch: "epoch",
      taskId: disclosure.taskId, scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey } };
  });
  const session = {
    conversationId: "routing-parent", abortController: new AbortController(), roleWorkspace: workspace,
    userStopGeneration: 0, stoppedByUserSinceLastPrompt: false, submitChildFollowup,
    hasDeferredAgentMailboxMessages: () => false,
    onBeforeDurableClose: () => () => {}, agentStatus: new BehaviorSubject({ status: "idle" }),
    activeTurn: { unsafePeek: () => activeTurnId === undefined ? undefined : { turnId: activeTurnId } },
    mailbox: { send }, emit: (event: typeof events[number]) => events.push(event),
    nextInternalSubId: () => `event-${events.length}`, modelInfo: await modelsManager.getModelInfo("grok-4.6"),
    config: { maxTurns: 6, multiAgentV2: { hideSpawnAgentMetadata: false }, agents: config.agents },
    sessionConfiguration: { cwd: "/routing-fixture", collaborationMode: { model: "grok-4.6" } },
    providerService: { current: () => ({ provider: "grok", model: "grok-4.6" }), environment: () => ({}),
      childProviderRoutingInfo: async () => ({ connected: true, billingSource: "byok" }) },
    services: { modelsManager, configStore: { current: () => config }, crossProviderConsent: {
      ownerSessionId: "routing-parent", sessionEpoch: "epoch", request: requestConsent,
    } },
  } as unknown as Session;
  const threads: AgentThread[] = [];
  mockDelegate.mockImplementation(async options => {
    const id = `attempt-${threads.length + 1}`;
    const thread = {
      threadId: id,
      live: { agentId: id, agentPath: `/root/${options.agentName}`, nickname: id, role: { name: "default" },
        toolCallCount: 0, status: { value: { status: "running", turnId: id }, watch: () => () => {} } },
      onStatusChange: () => () => {},
      join: async () => ({ threadId: id, durationMs: 1, outcome: "completed" }),
    } as unknown as AgentThread;
    threads.push(thread);
    return { kind: "async_launched", thread } as Awaited<ReturnType<typeof delegate>>;
  });
  const observation = (thread: AgentThread, reason: ChildTerminalReason,
    options: { costUsd?: number; toolCalls?: number; modelCalls?: number } = {}): ChildRoutingAttemptResult<AgentThread> => {
    const index = threads.indexOf(thread);
    const destination = mockDelegate.mock.calls[index]![0].plan?.destination ?? { provider: "grok", model: "grok-4.6" };
    return { value: thread, terminal: { provider: destination.provider, model: destination.model, reason,
      retryable: reason === "timeout" || reason === "rate_limited" || reason === "provider_unavailable",
      dispatch: "sent", completedWork: "", unfinishedWork: reason === "completed" ? "" : "Extract IDs" },
      modelCalls: options.modelCalls ?? 2, toolCalls: options.toolCalls ?? 0, costUsd: options.costUsd ?? 0.02 };
  };
  mockObserve.mockImplementation(async (_session, thread) => threads.indexOf(thread) === 0 ? firstObservation
    : options.deferRetry ? retryObservation : observation(thread, "completed"));
  const tool = createSpawnAgentTool({ getSession: () => session, workspace, roleCatalog: roles,
    ensureAgentControl: () => ({ control: { roleWorkspace: workspace, assertRoleWorkspace: () => {}, getLive: () => undefined }, registry: {} }),
  } as unknown as MultiAgentV2Options);
  return { tool, session, config, events, send, requestConsent, submitChildFollowup, queuedMessages, threads,
    changeTurn: (id?: string) => { activeTurnId = id; },
    denyConsent: () => { denyNextConsent = true; },
    finishFirst: (reason: ChildTerminalReason, options?: Parameters<typeof observation>[2]) => resolveFirst(observation(threads[0]!, reason, options)),
    finishRetry: () => resolveRetry(observation(threads[1]!, "completed")),
  };
}

const args = { message: "Extract a short list of record IDs", task_name: "extractor", __callId: "original-tool-call", max_cost_usd: 0.5 };

beforeEach(() => { mockDelegate.mockReset(); mockObserve.mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("automatic fallback through spawn_agent", () => {
  it.each(["rate_limited", "provider_unavailable", "timeout"] as const)(
    "creates exactly one fresh allowed-provider retry after %s", async reason => {
      const value = await fixture();
      const result = await value.tool.execute(args);
      expect(result.isError).not.toBe(true);
      expect(mockDelegate).toHaveBeenCalledOnce();
      const firstProvider = mockDelegate.mock.calls[0]![0].plan?.destination.provider;
      expect(["deepseek", "openai"]).toContain(firstProvider);
      value.finishFirst(reason);
      await vi.waitFor(() => expect(mockDelegate).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Finished after 2 attempt(s)"))).toBe(true));
      const [initial, retry] = mockDelegate.mock.calls.map(([request]) => request);
      expect(retry?.plan?.destination.provider).not.toBe(firstProvider);
      expect(["deepseek", "openai"]).toContain(retry?.plan?.destination.provider);
      expect(retry?.plan).toMatchObject({ budgetAllocation: { maxModelCalls: 4, maxCostUsd: 0.48 } });
      expect(retry?.agentName).not.toBe(initial?.agentName);
      expect(retry?.plan?.task.id).not.toBe(initial?.plan?.task.id);
      const began = value.events.filter(event => event.msg?.type === "collab_agent_spawn_begin").map(event => event.msg?.payload?.callId);
      expect(new Set(began).size).toBe(2);
      expect(value.requestConsent).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["new-human-turn", undefined])("does not retry after the parent turn changes to %s", async nextTurn => {
    const value = await fixture();
    await value.tool.execute(args);
    value.changeTurn(nextTurn);
    value.finishFirst("timeout");
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("does not enable fallback for a user's explicit provider/model override", async () => {
    const value = await fixture();
    const result = await value.tool.execute({ ...args, provider: "deepseek", model: "deepseek-v4-pro" });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(mockObserve).not.toHaveBeenCalled();
    expect(JSON.parse(result.content).automatic_fallback).toBeUndefined();
  });

  it("does not enable fallback for routing=inherit", async () => {
    const value = await fixture();
    const result = await value.tool.execute({ ...args, routing: "inherit" });
    expect(result.isError).not.toBe(true);
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it("does not bypass fresh funds-stop consent", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.denyConsent();
    value.finishFirst("insufficient_funds");
    await vi.waitFor(() => expect(value.requestConsent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("does not retry work after any child tool ran", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.finishFirst("timeout", { toolCalls: 1 });
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("tools_already_run"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("rechecks current allowed providers before creating a retry", async () => {
    const value = await fixture();
    await value.tool.execute(args);
    value.config.agents.allowed_providers = [mockDelegate.mock.calls[0]![0].plan!.destination.provider];
    value.finishFirst("timeout");
    await vi.waitFor(() => expect(value.send.mock.calls.some(([message]) => message.content.includes("Stopped automatic fallback"))).toBe(true));
    expect(mockDelegate).toHaveBeenCalledOnce();
  });

  it("schedules a delayed final routing notice after earlier receipt and retry notices were drained", async () => {
    const value = await fixture({ deferRetry: true });
    vi.useFakeTimers();
    await value.tool.execute(args);
    value.send({ content: "Initial child failure receipt", triggerTurn: true });
    requestParentFollowupTurn({ parent: value.session, live: value.threads[0]!.live });
    await vi.advanceTimersByTimeAsync(200);
    expect(value.submitChildFollowup).toHaveBeenCalledOnce();
    expect(value.queuedMessages).toEqual([]);

    value.finishFirst("timeout");
    await vi.advanceTimersByTimeAsync(200);
    expect(mockDelegate).toHaveBeenCalledTimes(2);
    expect(value.submitChildFollowup).toHaveBeenCalledTimes(2);
    expect(value.queuedMessages).toEqual([]);
    value.finishRetry();
    await vi.advanceTimersByTimeAsync(200);
    expect(value.submitChildFollowup).toHaveBeenCalledTimes(3);
    expect(value.send.mock.calls.at(-1)?.[0]).toMatchObject({ triggerTurn: true,
      content: expect.stringContaining("Finished after 2 attempt(s)") });
  });

  it("holds the routing notice without scheduling when the user stopped the parent", async () => {
    const value = await fixture();
    vi.useFakeTimers();
    await value.tool.execute(args);
    Object.assign(value.session, { stoppedByUserSinceLastPrompt: true, userStopGeneration: 1 });
    value.changeTurn(undefined);
    value.finishFirst("timeout");
    await vi.advanceTimersByTimeAsync(500);
    expect(mockDelegate).toHaveBeenCalledOnce();
    expect(value.send.mock.calls.at(-1)?.[0]).toMatchObject({ triggerTurn: true,
      content: expect.stringContaining("Stopped automatic fallback") });
    expect(value.submitChildFollowup).not.toHaveBeenCalled();
    expect(value.queuedMessages).toHaveLength(1);
  });

  it("does not schedule a followup when the routing notice was refused by the mailbox", async () => {
    const value = await fixture();
    vi.useFakeTimers();
    await value.tool.execute(args);
    value.send.mockReturnValue(-1);
    value.finishFirst("timeout", { toolCalls: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(value.send).toHaveBeenCalled();
    expect(value.submitChildFollowup).not.toHaveBeenCalled();
  });
});
