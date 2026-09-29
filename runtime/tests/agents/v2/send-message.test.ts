import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../src/session/session.js";
import type { AgentStatus } from "../../../src/agents/status.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import { createSendMessageTool } from "../../../src/agents/v2/send-message.js";
import { handleMessageStringTool } from "../../../src/agents/v2/message-tool.js";
import { LiveApprovalBroker } from "../../../src/app-server/live-approval-broker.js";
import type { LiveAgent } from "../../../src/agents/control.js";
import { bindLiveAgentSession } from "../../../src/agents/live-session.js";
import { signSessionId } from "../../../src/agents/_deps/filesystem-args.js";
import { ModelRegistry, modelRegistryEntryToModelInfo } from "../../../src/llm/model-registry.js";

const destinationModelInfo = modelRegistryEntryToModelInfo(new ModelRegistry({
  config: {}, metadata: { env: {} },
}).resolveSync({
  provider: "deepseek", model: "deepseek-v4-pro",
}));

function approvedChildPlan() {
  return {
    version: 1, crossProvider: true, modelInfo: destinationModelInfo,
    route: { provider: "deepseek", model: "deepseek-v4-pro" },
    destination: { provider: "deepseek", model: "deepseek-v4-pro",
      endpoint: "https://api.deepseek.com/v1", authProfile: "api_key", billingSource: "byok" },
    task: { id: "first", name: "child", text: "first task", attachments: [] },
    parent: { sessionId: "root-session", agentPath: "/root" },
    scope: { tools: [], data: "task_only", cwd: "/workspace", networkEnabled: false },
    budgetAllocation: { maxModelCalls: 2 },
  };
}

function fixture(initialStatus: AgentStatus, onBegin?: () => void, crossProvider = false) {
  let status = initialStatus;
  const sendInterAgentCommunication = vi.fn(async () => {});
  const assignTask = vi.fn(() => ({ taskId: "task-1", turnId: "turn-1" }));
  const live = {
    agentId: "child-1",
    agentPath: "/root/child",
    nickname: "Child",
    role: { name: "default" },
    metadata: crossProvider ? { executionPlan: { crossProvider: true,
      task: { id: "first", name: "child", text: "first task", attachments: [] } } } : {},
  };
  const control = {
    registerSessionRoot: vi.fn(),
    getLive: vi.fn((id: string) => id === live.agentId ? live : undefined),
    getAgentMetadata: vi.fn(() => undefined),
    resolveAgentReference: vi.fn(() => live.agentId),
    getStatus: vi.fn(async () => status),
    sendInterAgentCommunication,
    assignTask,
    sendPassiveMessageToActiveAgent: vi.fn((id: string, communication: unknown) => {
      const currentStatus = status;
      if (currentStatus.status !== "running" && currentStatus.status !== "pending_init") {
        return { accepted: false, status: currentStatus };
      }
      void sendInterAgentCommunication(id, communication);
      return { accepted: true, status: currentStatus };
    }),
  };
  const session = {
    conversationId: "root-session",
    services: {},
    nextInternalSubId: () => "event-1",
    emit: vi.fn((event: { msg: { type: string } }) => {
      if (event.msg.type === "collab_agent_interaction_begin") onBegin?.();
    }),
  } as unknown as Session;
  const opts = {
    getSession: () => session,
    workspace: {},
    ensureAgentControl: () => ({ control, registry: {} }),
  } as unknown as MultiAgentV2Options;
  const tool = createSendMessageTool(opts);
  const send = async () => {
    const result = await tool.execute({ target: live.agentPath, message: "hello" });
    return { result, body: JSON.parse(result.content) as Record<string, unknown> };
  };
  return { send, sendInterAgentCommunication, assignTask, session, live, opts, control,
    assign: () => handleMessageStringTool({ target: live.agentPath, message: "new task" }, opts, "trigger_turn"),
    setStatus: (next: AgentStatus) => { status = next; }, tool };
}

describe("send_message delivery report", () => {
  it.each([false, true])("clears spawn routing metadata for a new assignment without changing destination, crossProvider=%s", async crossProvider => {
    const f = fixture({ status: "idle", turnId: "previous", endedAtMs: 1 } as AgentStatus, undefined, true);
    const plan = { version: 1, crossProvider, modelInfo: destinationModelInfo,
      route: { provider: "deepseek", model: "deepseek-v4-pro" },
      destination: { provider: "deepseek", model: "deepseek-v4-pro",
        endpoint: "https://api.deepseek.com/v1", authProfile: "api_key", billingSource: "byok" },
      task: { id: "first", name: "child", text: "Extract names", attachments: [] },
      parent: { sessionId: "root-session", agentPath: "/root" },
      scope: { tools: [], data: "task_only", cwd: "/workspace", networkEnabled: false },
      budgetAllocation: { maxModelCalls: 2, maxCostUsd: 0.5 },
      routing: { taskKind: "extraction", complexity: "simple", reason: "Initial automatic choice" } };
    Object.assign(f.live.metadata, { executionPlan: plan });
    Object.assign(f.session.services, { crossProviderConsent: { ownerSessionId: "root-session", sessionEpoch: "epoch",
      request: async (_session: Session, disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => ({
        kind: "granted", grant: { kind: "once", ownerSessionId: "root-session", sessionEpoch: "epoch",
          taskId: disclosure.taskId, scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey },
      }),
    } });
    const result = await f.assign();
    expect(result.isError).not.toBe(true);
    expect(f.assignTask).toHaveBeenCalledOnce();
    const assigned = f.assignTask.mock.calls[0] as unknown as [string, { executionPlan: typeof plan }];
    expect(assigned[1].executionPlan.routing).toBeUndefined();
    expect(assigned[1].executionPlan.route).toEqual(plan.route);
    expect(assigned[1].executionPlan.destination).toEqual(plan.destination);
    expect(assigned[1].executionPlan.budgetAllocation).toEqual(plan.budgetAllocation);
    expect(assigned[1].executionPlan.task.text).toBe("new task");
    expect(plan.routing).toBeDefined();
  });

  it.each((["queue_only", "trigger_turn"] as const).flatMap((mode) =>
    (["root_closed", "root_replaced", "caller_revoked", "target_replaced", "target_plan_changed"] as const)
      .map((change) => ({ mode, change }))))(
    "refuses $mode after $change while consent waits", async ({ mode, change }) => {
      const f = fixture({ status: "running", turnId: "child-turn", startedAtMs: 1 }, undefined, true);
      Object.assign(f.live.metadata, { executionPlan: approvedChildPlan() });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const request = vi.fn(async (_session: Session,
        disclosure: { taskId: string; scopeKey: string; payloadKey: string }) => {
        await gate;
        return { kind: "granted" as const, grant: { kind: "once" as const,
          ownerSessionId: "root-session", sessionEpoch: "epoch", taskId: disclosure.taskId,
          scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey } };
      });
      Object.assign(f.session.services, { crossProviderConsent: {
        ownerSessionId: "root-session", sessionEpoch: "epoch", request,
      } });
      let revoke: (() => void) | undefined;
      const identity: Record<string, unknown> = {};
      if (change === "caller_revoked") {
        const caller = { agentId: "caller", agentPath: "/root/parent",
          abortController: new AbortController(), role: { name: "worker" } } as LiveAgent;
        const childSession = { conversationId: "caller", services: f.session.services,
          abortController: new AbortController(), onBeforeDurableClose: () => () => {} } as unknown as Session;
        revoke = bindLiveAgentSession(caller, childSession);
        f.control.getLive.mockImplementation((id) => id === "caller" ? caller : id === f.live.agentId ? f.live : undefined);
        identity.__agencSessionId = caller.agentId;
        identity.__agencSessionIdSig = signSessionId(caller.agentId);
      }
      try {
        const pending = handleMessageStringTool({ target: f.live.agentPath, message: "new task", ...identity }, f.opts, mode);
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        if (change === "root_closed") Object.assign(f.session, { isShuttingDown: true });
        if (change === "root_replaced") Object.assign(f.opts, { getSession: () => ({ ...f.session }) });
        if (change === "caller_revoked") revoke!();
        if (change === "target_replaced") f.control.getLive.mockImplementation(() => ({ ...f.live }));
        if (change === "target_plan_changed") Object.assign(f.live.metadata, {
          executionPlan: { ...f.live.metadata.executionPlan },
        });
        release();
        const result = await pending;
        expect(result.isError).toBe(true);
        expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
        expect(result.content).toContain("invalid-runtime-identity");
        expect(f.sendInterAgentCommunication).not.toHaveBeenCalled();
        expect(f.assignTask).not.toHaveBeenCalled();
      } finally {
        release();
        revoke?.();
      }
    },
  );

  it.each(["queue_only", "trigger_turn"] as const)(
    "%s suppresses a denial within the requesting turn and asks again on the next turn", async (mode) => {
      const f = fixture({ status: "running", turnId: "child-turn", startedAtMs: 1 }, undefined, true);
      Object.assign(f.live.metadata, { executionPlan: approvedChildPlan() });
      let humanTurnId = "human-turn-1";
      Object.assign(f.session, {
        // The user asks at each spawn, so messages to the child ask too.
        config: { agents: { cross_provider_enabled: true, allowed_providers: ["deepseek"],
          cross_provider_ask_each_spawn: true } },
        abortController: new AbortController(),
        activeTurn: { unsafePeek: () => ({ turnId: humanTurnId }) },
        currentRootHumanTurn: () => ({ turnId: humanTurnId }),
        eventLog: { subscribe: () => () => {} },
        onBeforeDurableClose: () => () => {},
      });
      const broker = new LiveApprovalBroker({ canAnswerCrossProviderConsent: () => true });
      const close = broker.register(f.session, { isActive: () => true });
      const invoke = () => mode === "queue_only" ? f.send().then(({ result }) => result) : f.assign();
      try {
        const first = invoke();
        await vi.waitFor(() => expect(broker.list("root-session")).toHaveLength(1));
        const card = broker.list("root-session")[0]!;
        expect(card.turnId).toBe(humanTurnId);
        broker.resolve("root-session", card.requestId, { kind: "denied" });
        expect(JSON.parse((await first).content)).toMatchObject({ code: "consent_denied" });
        expect(JSON.parse((await invoke()).content)).toMatchObject({ code: "consent_denied" });
        expect(broker.list("root-session")).toHaveLength(0);
        humanTurnId = "human-turn-2";
        const later = invoke();
        await vi.waitFor(() => expect(broker.list("root-session")).toHaveLength(1));
        const laterCard = broker.list("root-session")[0]!;
        expect(laterCard.turnId).toBe("human-turn-2");
        broker.resolve("root-session", laterCard.requestId, { kind: "denied" });
        expect(JSON.parse((await later).content)).toMatchObject({ code: "consent_denied" });
      } finally {
        close();
      }
    },
  );

  it("refuses messages and assignments to a cross-provider grandchild with missing consent provenance", async () => {
    const f = fixture({ status: "running", turnId: "turn-1", startedAtMs: 1 });
    f.live.agentPath = "/root/child/grandchild";
    Object.assign(f.live.metadata, { crossProvider: { provider: "deepseek", model: "deepseek-v4-pro",
      policy: "user-or-managed-agents-v1" } });
    expect((await f.send()).result.isError).toBe(true);
    expect((await f.assign()).isError).toBe(true);
    expect(f.sendInterAgentCommunication).not.toHaveBeenCalled();
    expect(f.assignTask).not.toHaveBeenCalled();
  });

  it("does not enqueue text for a cross-provider child without separate consent", async () => {
    const f = fixture({ status: "running", turnId: "turn-1", startedAtMs: 1 }, undefined, true);
    const { result } = await f.send();
    expect(result.isError).toBe(true);
    expect(f.sendInterAgentCommunication).not.toHaveBeenCalled();
  });

  it("holds a cross-provider passive message until its text receives fresh approval", async () => {
    const f = fixture({ status: "running", turnId: "turn-1", startedAtMs: 1 }, undefined, true);
    Object.assign(f.live.metadata, { executionPlan: approvedChildPlan() });
    let allow: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { allow = resolve; });
    const request = vi.fn(async (_session: Session, disclosure: { taskId: string; taskText: string; scopeKey: string; payloadKey: string },
      options?: { fresh?: boolean }) => {
      expect(disclosure.taskText).toBe("hello");
      expect(options?.fresh).toBe(true);
      await gate;
      return { kind: "granted" as const, grant: { kind: "once" as const,
        ownerSessionId: "root-session", sessionEpoch: "epoch", taskId: disclosure.taskId,
        scopeKey: disclosure.scopeKey, payloadKey: disclosure.payloadKey } };
    });
    Object.assign(f.session.services, { crossProviderConsent: {
      ownerSessionId: "root-session", sessionEpoch: "epoch", request,
    } });
    const pending = f.send();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(f.sendInterAgentCommunication).not.toHaveBeenCalled();
    allow!();
    const { result } = await pending;
    expect(result.isError).toBeUndefined();
    expect(f.sendInterAgentCommunication).toHaveBeenCalledOnce();
  });
  it("reports a running child's message as accepted but unconfirmed", async () => {
    const f = fixture({ status: "running", turnId: "turn-1", startedAtMs: 1 });
    const { result, body } = await f.send();
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      ok: true,
      delivered: false,
      delivery: "accepted_unconfirmed",
      status: { status: "running" },
    });
    expect(body.hint).toContain("If the child finishes first");
    expect(f.sendInterAgentCommunication).toHaveBeenCalledOnce();
    expect(f.tool.description).toContain("Does not trigger a new turn");
    expect(f.tool.description).toContain("next turn");
  });

  it.each([
    { status: "idle", turnId: "turn-1", endedAtMs: 2 },
    { status: "completed", turnId: "turn-1", endedAtMs: 2 },
    { status: "errored", turnId: "turn-1", endedAtMs: 2, error: "failed" },
  ] as AgentStatus[])("returns an undelivered result for $status", async (status) => {
    const f = fixture(status);
    const { result, body } = await f.send();
    expect(result.isError).toBe(true);
    expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
    expect(body).toMatchObject({ ok: false, delivered: false, status });
    expect(body.hint).toContain("assign_task");
    expect(f.sendInterAgentCommunication).not.toHaveBeenCalled();
  });

  it("refuses a child that becomes idle before the message is enqueued", async () => {
    let setIdle: () => void = () => {};
    const f = fixture(
      { status: "running", turnId: "turn-1", startedAtMs: 1 },
      () => setIdle(),
    );
    setIdle = () => f.setStatus({ status: "idle", turnId: "turn-1", endedAtMs: 2 });

    const { result, body } = await f.send();
    expect(result.isError).toBe(true);
    expect(body).toMatchObject({ ok: false, delivered: false, status: { status: "idle" } });
    expect(f.sendInterAgentCommunication).not.toHaveBeenCalled();
  });
});
