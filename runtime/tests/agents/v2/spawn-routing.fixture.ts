import { vi } from "vitest";

import { delegate } from "../../../src/agents/delegate.js";
import { observeChildRoutingAttempt } from "../../../src/agents/child-routing-supervisor.js";
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
export const mockDelegate = vi.mocked(delegate);
export const mockObserve = vi.mocked(observeChildRoutingAttempt);

export async function fixture(options: { deferRetry?: boolean } = {}) {
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
  let currentSession: Session = session;
  const tool = createSpawnAgentTool({ getSession: () => currentSession, workspace, roleCatalog: roles,
    ensureAgentControl: () => ({ control: { roleWorkspace: workspace, assertRoleWorkspace: () => {}, getLive: () => undefined }, registry: {} }),
  } as unknown as MultiAgentV2Options);
  return { tool, session, config, events, send, requestConsent, submitChildFollowup, queuedMessages, threads,
    replaceSession: () => { currentSession = { ...session } as Session; },
    changeTurn: (id?: string) => { activeTurnId = id; },
    denyConsent: () => { denyNextConsent = true; },
    finishFirst: (reason: ChildTerminalReason, options?: Parameters<typeof observation>[2]) => resolveFirst(observation(threads[0]!, reason, options)),
    finishRetry: () => resolveRetry(observation(threads[1]!, "completed")),
  };
}

export const args = { message: "Extract a short list of record IDs", task_name: "extractor", __callId: "original-tool-call", max_cost_usd: 0.5 };
