import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
} from "../../src/app-server/background-agent-runner.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { registerChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { AgentStatus } from "../../src/agents/status.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import {
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
  sessionConfigurationFromAgenCConfig,
  sessionExecutionAuthorityFromAgenCConfig,
} from "../../src/session/configuration.js";

// A sub-agent's approval is forwarded to its owner's clients. When no client
// that can show it receives it (none attached, or only clients that do not
// take approvals) and none will list it later, it must be denied at once as a
// runtime refusal with no effect, never left pending behind an invisible card.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function childSession(conversationId: string): Session {
  const eventLog = new EventLog();
  let sequence = 0;
  const session = {
    conversationId,
    eventLog,
    abortController: new AbortController(),
    permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext()),
    services: { admissionRequired: false },
    rolloutStore: {},
    sessionConfiguration: {
      sessionSource: { kind: "subagent", source: {
        kind: "thread_spawn", parentThreadId: "owner", depth: 1, agentPath: "/root/echo_probe", agentNickname: "Braindance",
      } },
    },
    emit: (event: Parameters<EventLog["emit"]>[0]) => {
      const canonical = { ...event, eventId: `${conversationId}:${++sequence}`, seq: sequence };
      eventLog.emit(canonical);
      return canonical;
    },
    onBeforeDurableClose: () => () => {},
  } as unknown as Session;
  cleanups.push(() => session.abortController.abort());
  return session;
}

function ask(owner: { services: { approvalResolver?: unknown } }, child: Session) {
  const ctx: ApprovalCtx = {
    callId: "call_exec", toolName: "exec_command", turnId: `sub-${child.conversationId}-0`,
    invocation: {
      callId: "call_exec", session: child,
      payload: { kind: "function", name: "exec_command", arguments: '{"cmd":"echo SUBAGENT_OK"}' },
      turn: { subId: `sub-${child.conversationId}-0` },
    } as ApprovalCtx["invocation"],
  };
  return requestApproval({ ctx, resolver: owner.services.approvalResolver as never, args: { command: "echo SUBAGENT_OK" } });
}

/** The trimmed runner harness of background-agent-runner.bounded-ordered.test.ts. */
async function startOwner(conversationId: string) {
  const status: AgentStatus = { status: "running", turnId: "turn-owner", startedAtMs: 0 } as AgentStatus;
  const thread = {
    threadId: conversationId, agentPath: "/root", kind: "root" as const,
    status: () => status,
    subscribeStatus: (cb: (value: AgentStatus) => void) => { cb(status); return () => {}; },
    submit: vi.fn(async () => conversationId), appendMessage: vi.fn(async () => conversationId),
    shutdown: vi.fn(async () => {}),
    totalTokenUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    configSnapshot: () => ({}),
  };
  const conversationThreadManager = {
    hasThread: (id: string) => id === conversationId, getThread: () => thread, removeThread: vi.fn(() => thread),
  };
  const configuredExecutionAuthority = sessionExecutionAuthorityFromAgenCConfig({
    config: {}, workspaceRoot: process.cwd(), projectTrust: "trusted",
  });
  const sandboxExecutionBroker = new SandboxExecutionBroker({
    cwd: process.cwd(),
    ...sandboxExecutionBrokerAuthorityFromSessionAuthority(configuredExecutionAuthority, process.cwd()),
  });
  const sessionState = {
    sessionConfiguration: sessionConfigurationFromAgenCConfig({
      config: {}, workspaceRoot: process.cwd(), model: "grok-4.5", provider: "grok", projectTrust: "trusted",
    }),
  };
  let nextEventSequence = 0;
  const session = {
    conversationId,
    abortController: new AbortController(),
    permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext()),
    get sessionConfiguration() { return sessionState.sessionConfiguration; },
    subscribeToEvents: () => () => {},
    emitPhaseEvent: () => {},
    prepareEmit: vi.fn((candidate: Record<string, unknown>) => {
      const event = { ...candidate, seq: ++nextEventSequence };
      return { event, publish: () => event };
    }),
    state: { with: async (update: (state: typeof sessionState) => void) => { update(sessionState); } },
    services: { conversationThreadManager, sandboxExecutionBroker } as { approvalResolver?: unknown },
  };
  const bootstrap = vi.fn(async () => ({
    workspaceRoot: process.cwd(),
    configuredExecutionAuthority,
    prepareConfiguredExecutionAuthority: () => ({ authority: configuredExecutionAuthority, commit: () => {}, rollback: () => {} }),
    session,
    rolloutStore: {
      rolloutPath: `${process.env.TMPDIR ?? "/tmp"}/${conversationId}.jsonl`, readAll: () => [],
      recordRunRuntimeSettingsEvent: vi.fn(() => {}), syncCanonicalTail: vi.fn(() => {}),
    },
    registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
    shutdown: vi.fn(async () => {}),
  })) as unknown as AgenCBootstrapFunction;
  const broker = new LiveApprovalBroker();
  const runner = new AgenCDelegateBackgroundAgentRunner({
    bootstrap,
    ensureAgentControl: vi.fn(() => ({
      control: { shutdown: vi.fn(async () => {}), sendInput: vi.fn(async () => {}), interrupt: vi.fn(), clearConversationHistory: vi.fn(async () => {}) },
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction,
    now: () => "2026-09-22T19:01:34.000Z",
    approvalBroker: broker,
  });
  await runner.startAgent({ objective: "spawn a sub-agent", unattendedAllow: [], unattendedDeny: [] });
  expect(session.services.approvalResolver).toBeDefined();
  const child = childSession(`child-of-${conversationId}`);
  registerChildApprovalSession(child, session as unknown as Session);
  return { runner, broker, session, child };
}

async function settledWithin<T>(promise: Promise<T>, ms = 300): Promise<T | "pending"> {
  return await Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms))]);
}

const undeliverable = expect.objectContaining({
  kind: "denied",
  reason: expect.stringMatching(/could not be shown to the user.*did not run/),
});

describe("forwarded sub-agent approval delivery through the runner", () => {
  it("denies at once, as a runtime refusal, when no client is attached", async () => {
    const { broker, session, child } = await startOwner("owner-unattached");
    const result = await settledWithin(ask(session, child));
    expect(result).not.toBe("pending");
    const decision = (result as Awaited<ReturnType<typeof ask>>).decision;
    expect(decision).toEqual(undeliverable);
    // Not the person's decision: the child's turn must not end as their stop.
    expect((decision as { decidedBy?: string }).decidedBy).toBeUndefined();
    expect(broker.list("owner-unattached")).toEqual([]);
  });

  it("denies at once when the only attached client does not take approvals", async () => {
    const { runner, session, child } = await startOwner("owner-incapable");
    await runner.attachAgentSessionEvents("owner-incapable", {
      sessionId: "owner-incapable",
      // What the multiplexer reports when every attached client refused the method.
      emit: async () => ({ sessionId: "owner-incapable", deliveredClientIds: [], failed: [] }),
    });
    const result = await settledWithin(ask(session, child));
    expect(result).not.toBe("pending");
    expect((result as Awaited<ReturnType<typeof ask>>).decision).toEqual(undeliverable);
  });

  it.each([
    ["a client that lists pending requests is connected", { deliveredClientIds: [], pendingListing: true }],
    ["a capable client received it", { deliveredClientIds: ["desktop"], failed: [] }],
  ])("keeps the request for the user when %s", async (_label, delivery) => {
    const { runner, broker, session, child } = await startOwner(`owner-${delivery.deliveredClientIds.length}`);
    const ownerId = session.conversationId;
    await runner.attachAgentSessionEvents(ownerId, { sessionId: ownerId, emit: async () => ({ sessionId: ownerId, ...delivery }) });
    const decision = ask(session, child);
    expect(await settledWithin(decision)).toBe("pending");
    const [pending] = broker.list(ownerId);
    expect(pending).toMatchObject({ sessionId: child.conversationId, sourceAgentNickname: "Braindance" });
    expect(broker.resolve(ownerId, pending!.requestId, { kind: "approved" })).toBe(true);
    expect((await decision).decision.kind).toBe("approved");
  });
});
