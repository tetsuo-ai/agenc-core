import { readFileSync } from "node:fs";
import vm from "node:vm";

import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  daemonEventFromUnboundSessionEvent,
  notificationFromDaemonEvent,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
  managedTokenUsage,
} from "./background-agent-runner.js";
import type { AgentStatus } from "../agents/status.js";
import type { AuthBackend } from "../auth/backend.js";
import type { AgentBudgetConfig } from "../config/schema.js";
import type { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import { requestApproval } from "../tools/orchestrator.js";

const backgroundAgentRunnerSourcePath = new URL(
  "../../src/app-server/background-agent-runner.ts",
  import.meta.url,
);

type TurnCompleteProgressProjection = (
  agentId: string,
  progress: {
    readonly kind: "turn_complete";
    readonly turnId: string;
    readonly taskId?: string;
    readonly toolCallCount: number;
    readonly finalMessage?: string;
    readonly worktree?: Readonly<Record<string, unknown>>;
    readonly worktreeEvidence?: Readonly<Record<string, unknown>>;
  },
) => Readonly<Record<string, unknown>> | null;

function loadTurnCompleteProgressProjection(): TurnCompleteProgressProjection {
  const source = readFileSync(backgroundAgentRunnerSourcePath, "utf8");
  const start = source.indexOf("function eventFromProgress(");
  const end = source.indexOf("\nfunction messageText(", start);
  if (start < 0 || end < 0) {
    throw new Error("eventFromProgress source boundary was not found");
  }
  const internalSource = `${source.slice(start, end)}
export { eventFromProgress };
`;
  const transformed = transformSync(internalSource, {
    format: "cjs",
    loader: "ts",
    sourcefile: backgroundAgentRunnerSourcePath.pathname,
    sourcemap: "inline",
    target: "node25",
  });
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(
    transformed.code,
    {
      exports: module.exports,
      module,
    },
    { filename: backgroundAgentRunnerSourcePath.pathname },
  );
  const projection = module.exports.eventFromProgress;
  if (typeof projection !== "function") {
    throw new Error("eventFromProgress was not exported by the test harness");
  }
  return projection as TurnCompleteProgressProjection;
}

function makeStubConversationThreadManager(opts: {
  readonly threadId: string;
  readonly agentPath?: string;
  readonly submit?: ReturnType<typeof vi.fn>;
  readonly shutdown?: ReturnType<typeof vi.fn>;
  readonly initialStatus?: AgentStatus;
  readonly totalTokenUsage?: () => {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}) {
  let listeners: ((status: AgentStatus) => void)[] = [];
  let currentStatus: AgentStatus =
    opts.initialStatus ??
    ({
      status: "running",
      turnId: "turn-stub",
      startedAtMs: 0,
    } as AgentStatus);
  const submit = opts.submit ?? vi.fn(async () => opts.threadId);
  const shutdown = opts.shutdown ?? vi.fn(async () => {});
  const managedThread = {
    threadId: opts.threadId,
    agentPath: opts.agentPath ?? "/root",
    kind: "root" as const,
    status: () => currentStatus,
    subscribeStatus: (cb: (status: AgentStatus) => void) => {
      cb(currentStatus);
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((listener) => listener !== cb);
      };
    },
    submit,
    appendMessage: vi.fn(async () => opts.threadId),
    shutdown,
    totalTokenUsage:
      opts.totalTokenUsage ??
      (() => ({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })),
    configSnapshot: () => ({}),
  };
  return {
    hasThread: (id: string) => id === opts.threadId,
    getThread: (id: string) => {
      if (id !== opts.threadId) {
        throw new Error(`stub conversationThreadManager has no thread ${id}`);
      }
      return managedThread;
    },
    removeThread: vi.fn(() => managedThread),
    pushStatus(next: AgentStatus) {
      currentStatus = next;
      for (const cb of [...listeners]) cb(next);
    },
    thread: managedThread,
  };
}

function makeAuthBackend(
  kind: NonNullable<AuthBackend["kind"]>,
  apiKey: string,
): AuthBackend {
  return {
    kind,
    login: vi.fn(() => ({ authenticated: true, provider: kind })),
    logout: vi.fn(() => ({ authenticated: false })),
    whoami: vi.fn(() => ({ authenticated: true, provider: kind })),
    vendKey: vi.fn((provider, sessionId) => ({
      provider: String(provider),
      sessionId,
      apiKey,
    })),
    inferAgencModel: vi.fn(() => ({
      provider: "agenc",
      model: "agenc:grok",
    })),
    getSubscriptionTier: vi.fn(() => "pro"),
  };
}

function makeTopLevelRunner(opts: {
  readonly conversationId: string;
  readonly bootstrapShutdown?: ReturnType<typeof vi.fn>;
  readonly threadShutdown?: ReturnType<typeof vi.fn>;
  readonly authBackend?: AuthBackend;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
  readonly agentBudget?: AgentBudgetConfig;
  readonly executionAdmissionKernel?: ExecutionAdmissionKernel;
  readonly rolloutItems?: unknown[];
  readonly onActiveAgentTerminated?: ReturnType<typeof vi.fn>;
  readonly totalTokenUsage?: () => {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}) {
  const shutdownImpl = opts.bootstrapShutdown ?? vi.fn(async () => {});
  const durableOperations = new Set<Promise<unknown>>();
  const beforeDurableClose = new Set<() => void | Promise<void>>();
  const permissionUpdates: ToolPermissionContext[] = [];
  const permissionModeRegistry = {
    current: () => createEmptyToolPermissionContext(),
    update: vi.fn(async (context: ToolPermissionContext) => {
      permissionUpdates.push(context);
    }),
  };
  const stub = makeStubConversationThreadManager({
    threadId: opts.conversationId,
    ...(opts.threadShutdown !== undefined
      ? { shutdown: opts.threadShutdown }
      : {}),
    ...(opts.totalTokenUsage !== undefined
      ? { totalTokenUsage: opts.totalTokenUsage }
      : {}),
  });
  const phaseSubscribers: Array<(phase: unknown) => void> = [];
  const eventLogSubscribers: Array<(event: unknown) => void> = [];
  const rolloutItems = opts.rolloutItems ?? [];
  let lastSeq = rolloutItems.reduce((highest, item) => {
    const seq = (item as { payload?: { seq?: unknown } })?.payload?.seq;
    return typeof seq === "number" && Number.isSafeInteger(seq)
      ? Math.max(highest, seq)
      : highest;
  }, 0);
  const publishSessionEvent = (event: unknown) => {
    for (const listener of [...eventLogSubscribers]) listener(event);
  };
  const rolloutStore = {
    rolloutPath: `/tmp/${opts.conversationId}.jsonl`,
    readAll: () => [...rolloutItems],
  };
  const session = {
    conversationId: opts.conversationId,
    permissionModeRegistry,
    abortAllTasks: vi.fn(async () => {}),
    trackDurableOperation: <T>(operation: Promise<T>): Promise<T> => {
      durableOperations.add(operation);
      void operation.then(
        () => durableOperations.delete(operation),
        () => durableOperations.delete(operation),
      );
      return operation;
    },
    onBeforeDurableClose: (listener: () => void | Promise<void>) => {
      beforeDurableClose.add(listener);
      return () => beforeDurableClose.delete(listener);
    },
    eventLog: {
      get lastSeq() {
        return lastSeq;
      },
      subscribe: (listener: (event: unknown) => void) => {
        eventLogSubscribers.push(listener);
        return () => {
          const index = eventLogSubscribers.indexOf(listener);
          if (index >= 0) eventLogSubscribers.splice(index, 1);
        };
      },
    },
    subscribeToEvents: (listener: (phase: unknown) => void) => {
      phaseSubscribers.push(listener);
      return () => {
        const index = phaseSubscribers.indexOf(listener);
        if (index >= 0) phaseSubscribers.splice(index, 1);
      };
    },
    emitPhaseEvent: (phase: unknown) => {
      for (const listener of [...phaseSubscribers]) listener(phase);
    },
    emitSessionEvent: (event: unknown) => {
      const sequence = (event as { seq?: unknown }).seq;
      if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
        lastSeq = Math.max(lastSeq, sequence);
      }
      publishSessionEvent(event);
    },
    emit: vi.fn((event: unknown) => {
      const sequence = ++lastSeq;
      const stamped = {
        ...(event as object),
        eventId:
          (event as { eventId?: unknown }).eventId ?? `event:${sequence}`,
        seq: sequence,
      };
      rolloutItems.push({ type: "event_msg", payload: stamped });
      publishSessionEvent(stamped);
      return stamped;
    }),
    rolloutStore,
    services: { conversationThreadManager: stub },
  };
  const shutdown = vi.fn(async () => {
    await shutdownImpl();
    while (durableOperations.size > 0) {
      await Promise.all([...durableOperations]);
    }
    const finalizers = [...beforeDurableClose];
    beforeDurableClose.clear();
    for (const finalize of finalizers) await finalize();
  });
  const control = {
    shutdown: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(),
    openThreadSpawnChildren: vi.fn(() => []),
    clearConversationHistory: vi.fn(async () => {}),
  };
  const bootstrap = vi.fn(async () => ({
    session,
    rolloutStore,
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: vi.fn(),
    },
    shutdown,
  })) as unknown as ReturnType<typeof vi.fn> & AgenCBootstrapFunction;
  const runner = new AgenCDelegateBackgroundAgentRunner({
    ...(opts.authBackend !== undefined ? { authBackend: opts.authBackend } : {}),
    bootstrap,
    ensureAgentControl: vi.fn(() => ({
      control,
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.argv !== undefined ? { argv: opts.argv } : {}),
    ...(opts.agentBudget !== undefined
      ? { agentBudget: opts.agentBudget }
      : {}),
    ...(opts.executionAdmissionKernel !== undefined
      ? { executionAdmissionKernel: opts.executionAdmissionKernel }
      : {}),
    now: opts.now ?? (() => "2026-05-09T00:00:00.000Z"),
    ...(opts.onActiveAgentTerminated !== undefined
      ? { onActiveAgentTerminated: opts.onActiveAgentTerminated }
      : {}),
  });
  return {
    runner,
    session,
    control,
    stub,
    shutdown,
    bootstrap,
    permissionUpdates,
    permissionModeRegistry,
    rolloutItems,
  };
}

describe("AgenC delegate background-agent runner", () => {
  it("projects correlated worktree completion evidence from run-agent progress", () => {
    const worktree = {
      path: "/repo/.agenc-worktrees/reviewer",
      branch: "worktree-reviewer",
      gitRoot: "/repo",
    };
    const worktreeEvidence = {
      state: "committed_clean",
      locator: worktree,
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      treeHash: "c".repeat(40),
      clean: true,
      baseIsAncestor: true,
      integrationRef: "b".repeat(40),
    };

    const event = loadTurnCompleteProgressProjection()("agent-reviewer", {
      kind: "turn_complete",
      turnId: "turn-reviewer",
      taskId: "task-reviewer",
      toolCallCount: 3,
      finalMessage: "review complete",
      worktree,
      worktreeEvidence,
    });

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      id: "turn-complete-agent-reviewer-turn-reviewer",
      type: "turn_complete",
      payload: {
        turnId: "turn-reviewer",
        taskId: "task-reviewer",
        toolCallCount: 3,
        worktree,
        worktreeEvidence,
        lastAgentMessage: "review complete",
      },
    });
  });

  it("carries the canonical rollout sequence into daemon notifications", () => {
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      eventId: "journal-progress-sequenced",
      id: "progress-sequenced",
      seq: 42,
      msg: {
        type: "tool_progress",
        payload: {
          callId: "tool-sequenced",
          toolName: "Bash",
          chunk: "ready",
        },
      },
    });

    expect(daemonEvent).toMatchObject({
      id: "progress-sequenced",
      eventId: "journal-progress-sequenced",
      sequence: 42,
    });
    expect(
      notificationFromDaemonEvent("session-1", "agent-1", daemonEvent!),
    ).toMatchObject({
      params: {
        eventId: "journal-progress-sequenced",
        sequence: 42,
        event: { id: "progress-sequenced" },
      },
    });
  });

  it("derives collision-free legacy eventIds without changing reused envelope ids", () => {
    const first = daemonEventFromUnboundSessionEvent({
      id: "reused-tool-progress-sub-id",
      seq: 8,
      msg: {
        type: "tool_progress",
        payload: { callId: "call-1", toolName: "Bash", chunk: "one" },
      },
    });
    const second = daemonEventFromUnboundSessionEvent({
      id: "reused-tool-progress-sub-id",
      seq: 9,
      msg: {
        type: "tool_progress",
        payload: { callId: "call-1", toolName: "Bash", chunk: "two" },
      },
    });

    expect(first).toMatchObject({
      id: "reused-tool-progress-sub-id",
      eventId: "legacy-event:8:reused-tool-progress-sub-id",
      sequence: 8,
    });
    expect(second).toMatchObject({
      id: "reused-tool-progress-sub-id",
      eventId: "legacy-event:9:reused-tool-progress-sub-id",
      sequence: 9,
    });
  });

  it.each([
    ["agent_message_delta", { delta: "hello" }],
    [
      "tool_call_started",
      { callId: "call-1", toolName: "Read", args: "{}" },
    ],
    [
      "tool_call_completed",
      { callId: "call-1", result: "ok", isError: false },
    ],
    ["turn_started", { turnId: "turn-1", startedAt: 1 }],
    [
      "turn_complete",
      {
        turnId: "turn-1",
        lastAgentMessage: "done",
        completedAt: 2,
        durationMs: 1,
      },
    ],
    ["turn_aborted", { turnId: "turn-1", reason: "cancelled" }],
    ["error", { cause: "test", message: "failed" }],
    ["effect_intent", { runId: "run-1", stepId: "step-1" }],
    [
      "execution_admission",
      { runId: "run-1", stepId: "step-1", event: "allowed" },
    ],
    ["artifact_committed", { runId: "run-1", artifactId: "artifact-1" }],
    ["recovery_decision", { runId: "run-1", decision: "projection_rebuilt" }],
    ["run_terminal", { runId: "run-1", epoch: 1, status: "completed" }],
  ] as const)(
    "uses canonical identity for core %s notifications",
    (type, payload) => {
      const daemonEvent = daemonEventFromUnboundSessionEvent({
        eventId: `journal-${type}`,
        id: `canonical-${type}`,
        seq: 17,
        msg: { type, payload },
      });
      expect(daemonEvent).toMatchObject({
        id: `canonical-${type}`,
        eventId: `journal-${type}`,
        sequence: 17,
        type,
      });
      expect(
        notificationFromDaemonEvent("session-1", "agent-1", daemonEvent!),
      ).toMatchObject({
        params: {
          eventId: `journal-${type}`,
          sequence: 17,
        },
      });
      expect(
        daemonEventFromUnboundSessionEvent({
          id: `unsequenced-${type}`,
          msg: { type, payload },
        }),
      ).toBeNull();
    },
  );

  it("uses PhaseEvents only for bookkeeping when the canonical bridge is installed", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-canonical-core",
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "verify canonical delivery",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-canonical-core", {
      sessionId: "session-1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({ type: "assistant_text", content: "hello" });
    session.emitPhaseEvent({
      type: "tool_call",
      toolCall: { id: "call-1", name: "Read", arguments: "{}" },
    });
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "hello",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "completed",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toEqual([]);

    session.emit({
      eventId: "journal-delta",
      id: "canonical-delta",
      msg: { type: "agent_message_delta", payload: { delta: "hello" } },
    });
    session.emit({
      eventId: "journal-tool",
      id: "canonical-tool",
      msg: {
        type: "tool_call_started",
        payload: { callId: "call-1", toolName: "Read", args: "{}" },
      },
    });
    session.emit({
      eventId: "journal-turn",
      id: "canonical-turn",
      msg: {
        type: "turn_complete",
        payload: {
          turnId: "turn-1",
          lastAgentMessage: "hello",
          completedAt: 2,
          durationMs: 1,
        },
      },
    });
    await vi.waitFor(() => expect(emitted).toHaveLength(3));
    expect(
      emitted.map(
        (event) =>
          (event as { params?: { eventId?: unknown } }).params?.eventId,
      ),
    ).toEqual(["journal-delta", "journal-tool", "journal-turn"]);
    for (const event of emitted) {
      expect(
        (event as { params?: { sequence?: unknown } }).params?.sequence,
      ).toEqual(expect.any(Number));
    }
  });

  it("drains the canonical turn tail before shutdown and terminal teardown", async () => {
    let releaseTurnDelivery!: () => void;
    const turnDeliveryBlocked = new Promise<void>((resolve) => {
      releaseTurnDelivery = resolve;
    });
    let markTurnDeliveryStarted!: () => void;
    const turnDeliveryStarted = new Promise<void>((resolve) => {
      markTurnDeliveryStarted = resolve;
    });
    const bootstrapShutdown = vi.fn(async () => {});
    const onActiveAgentTerminated = vi.fn(async () => {});
    const { runner, session, stub } = makeTopLevelRunner({
      conversationId: "session-terminal-delivery-order",
      bootstrapShutdown,
      onActiveAgentTerminated,
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "preserve the canonical tail",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-terminal-delivery-order", {
      sessionId: "session-1",
      emit: async (event) => {
        const eventId = (event as { params?: { eventId?: unknown } }).params
          ?.eventId;
        if (eventId === "turn-complete-before-shutdown") {
          markTurnDeliveryStarted();
          await turnDeliveryBlocked;
        }
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emit({
      eventId: "turn-complete-before-shutdown",
      id: "turn-complete-before-shutdown",
      msg: {
        type: "turn_complete",
        payload: {
          turnId: "turn-terminal-delivery-order",
          lastAgentMessage: "done",
          completedAt: 2,
          durationMs: 1,
        },
      },
    });
    await turnDeliveryStarted;
    stub.pushStatus({
      status: "completed",
      turnId: "turn-terminal-delivery-order",
      endedAtMs: 2,
      lastMessage: "done",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(bootstrapShutdown).not.toHaveBeenCalled();
    expect(onActiveAgentTerminated).not.toHaveBeenCalled();

    releaseTurnDelivery();
    await vi.waitFor(() =>
      expect(onActiveAgentTerminated).toHaveBeenCalledTimes(1),
    );
    expect(
      emitted.map(
        (event) =>
          (event as { params?: { eventId?: unknown } }).params?.eventId,
      ),
    ).toEqual([
      "turn-complete-before-shutdown",
      "run-terminal:session-terminal-delivery-order:1",
    ]);
    expect(bootstrapShutdown).toHaveBeenCalledTimes(1);
  });

  it("fsync-journals daemon permission requests and decisions before execution resumes", async () => {
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-durable-permission",
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "record approval evidence",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-durable-permission", {
      sessionId: "client-session",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    const resolver = (
      session.services as {
        approvalResolver?: {
          request(context: unknown): Promise<{ readonly kind: string }>;
        };
      }
    ).approvalResolver;
    expect(resolver).toBeDefined();
    const pending = requestApproval({
      ctx: {
        invocation: {
          session,
          turn: { subId: "turn-permission-1" },
          tracker: {
            appendFileDiff() {},
            snapshot: () => [],
            clear() {},
          },
          callId: "permission-call-1",
          toolName: { name: "Read" },
          payload: {
            kind: "function",
            arguments: '{"path":"README.md"}',
          },
          source: "direct",
        } as never,
        callId: "permission-call-1",
        toolName: "Read",
        turnId: "turn-permission-1",
      },
      resolver: resolver as never,
    });

    await vi.waitFor(() =>
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.permission_request",
          params: expect.objectContaining({
            requestId: "permission-call-1",
            eventId: expect.any(String),
            sequence: expect.any(Number),
          }),
        }),
      ),
    );
    expect(
      await runner.resolveToolDecision("session-durable-permission", {
        requestId: "permission-call-1",
        decision: { kind: "approved" },
      }),
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({
      decision: { kind: "approved" },
      source: "resolver",
    });

    const journalEvents = rolloutItems
      .filter(
        (item): item is {
          readonly type: "event_msg";
          readonly payload: {
            readonly eventId: string;
            readonly seq: number;
            readonly msg: {
              readonly type: string;
              readonly payload: Record<string, unknown>;
            };
          };
        } => (item as { readonly type?: unknown }).type === "event_msg",
      )
      .map((item) => item.payload);
    const request = journalEvents.find(
      (event) => event.msg.type === "request_permissions",
    );
    const decision = journalEvents.find(
      (event) => event.msg.type === "permission_decision",
    );
    expect(request).toMatchObject({
      eventId: expect.any(String),
      seq: expect.any(Number),
      msg: {
        payload: {
          callId: "permission-call-1",
          toolName: "Read",
          turnId: "turn-permission-1",
          permissions: ["tool.use"],
          input: { path: "README.md" },
        },
      },
    });
    expect(decision).toMatchObject({
      eventId: expect.any(String),
      seq: (request?.seq ?? 0) + 1,
      msg: {
        payload: {
          runId: "session-durable-permission",
          callId: "permission-call-1",
          requestEventId: request?.eventId,
          requestEventSeq: request?.seq,
          decision: "approved",
        },
      },
    });
  });

  it("aborts and journals a pending permission before stop seals the terminal tail", async () => {
    let releaseShutdown!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-stop-pending-permission",
      bootstrapShutdown: vi.fn(() => shutdownStarted),
    });
    await runner.startAgent({
      objective: "wait for permission",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const resolver = (
      session.services as {
        approvalResolver?: {
          request(context: unknown): Promise<{ readonly kind: string }>;
        };
      }
    ).approvalResolver;
    expect(resolver).toBeDefined();
    const pending = requestApproval({
      ctx: {
        invocation: {
          session,
          turn: { subId: "turn-stop-permission" },
          tracker: {
            appendFileDiff() {},
            snapshot: () => [],
            clear() {},
          },
          callId: "permission-stop-call",
          toolName: { name: "Bash" },
          payload: { kind: "function", arguments: '{"cmd":"true"}' },
          source: "direct",
        } as never,
        callId: "permission-stop-call",
        toolName: "Bash",
        turnId: "turn-stop-permission",
      },
      resolver: resolver as never,
    });
    await vi.waitFor(() =>
      expect(
        rolloutItems.some(
          (item) =>
            (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
              ?.type === "request_permissions",
        ),
      ).toBe(true),
    );

    const stopping = runner.stopAgent(
      "session-stop-pending-permission",
      "user_stopped",
    );
    await expect(pending).resolves.toMatchObject({
      decision: { kind: "abort" },
      source: "resolver",
    });
    await expect(
      runner.submitAgentMessage("session-stop-pending-permission", {
        sessionId: "session-stop-pending-permission",
        content: "too late",
        originalContent: "too late",
        displayUserMessage: null,
        messageId: "message-too-late",
        streamId: "stream-too-late",
        acceptedAt: "2026-05-09T00:00:01.000Z",
      }),
    ).rejects.toThrow("not running");
    expect(
      await runner.resolveToolDecision("session-stop-pending-permission", {
        requestId: "permission-stop-call",
        decision: { kind: "approved" },
      }),
    ).toBe(false);
    releaseShutdown();
    await stopping;

    const canonical = rolloutItems
      .filter(
        (item): item is {
          readonly payload: {
            readonly seq: number;
            readonly msg: {
              readonly type: string;
              readonly payload: Record<string, unknown>;
            };
          };
        } => (item as { type?: unknown }).type === "event_msg",
      )
      .map((item) => item.payload);
    const requestIndex = canonical.findIndex(
      (event) => event.msg.type === "request_permissions",
    );
    const decisionIndex = canonical.findIndex(
      (event) => event.msg.type === "permission_decision",
    );
    const terminalIndex = canonical.findIndex(
      (event) => event.msg.type === "run_terminal",
    );
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(decisionIndex).toBeGreaterThan(requestIndex);
    expect(terminalIndex).toBeGreaterThan(decisionIndex);
    expect(terminalIndex).toBe(canonical.length - 1);
    expect(canonical[decisionIndex]?.msg.payload).toMatchObject({
      callId: "permission-stop-call",
      decision: "abort",
    });
    expect(canonical[terminalIndex]?.msg.payload).toMatchObject({
      stopReason: "user_stopped",
    });
  });

  it("canonicalizes cancellation and admission decisions before the terminal tail", async () => {
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-two-phase-cancel",
    });
    const cancelAdmissions = vi.fn((reason: string) => {
      session.emit({
        eventId: "admission-cancelled-before-terminal",
        id: "admission-cancelled-before-terminal",
        msg: {
          type: "execution_admission",
          payload: {
            sequence: 7,
            eventId: "admission-cancelled-before-terminal",
            timestamp: "2026-05-09T00:00:00.000Z",
            runId: "session-two-phase-cancel",
            stepId: "model-turn-1",
            kind: "model_turn",
            event: "cancelled",
            reason,
          },
        },
      });
      return {
        affectedRunIds: ["session-two-phase-cancel"],
        voidedReservations: 1,
        heldUnknownReservations: 0,
      };
    });
    (
      session.services as typeof session.services & {
        executionAdmission?: { cancelAdmissions: typeof cancelAdmissions };
      }
    ).executionAdmission = { cancelAdmissions };

    await runner.startAgent({
      objective: "cancel safely",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const prepared = await runner.prepareAgentCancellation(
      "session-two-phase-cancel",
      "operator",
    );
    expect(prepared).toMatchObject({
      affectedRunIds: ["session-two-phase-cancel"],
      voidedHolds: 1,
    });
    await expect(
      runner.submitAgentMessage("session-two-phase-cancel", {
        sessionId: "session-two-phase-cancel",
        content: "late input",
        originalContent: "late input",
        messageId: "late-message",
        streamId: "late-stream",
        acceptedAt: "2026-05-09T00:00:01.000Z",
      }),
    ).rejects.toThrow("not running");

    await runner.stopAgent("session-two-phase-cancel", "operator");

    const canonical = rolloutItems
      .filter(
        (item): item is {
          readonly payload: {
            readonly seq: number;
            readonly msg: { readonly type: string };
          };
        } => (item as { type?: unknown }).type === "event_msg",
      )
      .map((item) => item.payload);
    const requestIndex = canonical.findIndex(
      (event) => event.msg.type === "run_cancel_requested",
    );
    const admissionIndex = canonical.findIndex(
      (event) => event.msg.type === "execution_admission",
    );
    const terminalIndex = canonical.findIndex(
      (event) => event.msg.type === "run_terminal",
    );
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(admissionIndex).toBeGreaterThan(requestIndex);
    expect(terminalIndex).toBeGreaterThan(admissionIndex);
    expect(terminalIndex).toBe(canonical.length - 1);
    expect(cancelAdmissions).toHaveBeenCalledOnce();
  });

  it("aborts and journals a pending permission before a budget terminal", async () => {
    let totalTokens = 0;
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-budget-pending-permission",
      agentBudget: { token_cap: 1 },
      totalTokenUsage: () => ({
        inputTokens: totalTokens,
        outputTokens: 0,
        totalTokens,
      }),
    });
    await runner.startAgent({
      objective: "wait under budget",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const resolver = (
      session.services as {
        approvalResolver?: {
          request(context: unknown): Promise<{ readonly kind: string }>;
        };
      }
    ).approvalResolver;
    const pending = requestApproval({
      ctx: {
        invocation: {
          session,
          turn: { subId: "turn-budget-permission" },
          tracker: {
            appendFileDiff() {},
            snapshot: () => [],
            clear() {},
          },
          callId: "permission-budget-call",
          toolName: { name: "Bash" },
          payload: { kind: "function", arguments: '{"cmd":"true"}' },
          source: "direct",
        } as never,
        callId: "permission-budget-call",
        toolName: "Bash",
        turnId: "turn-budget-permission",
      },
      resolver: resolver as never,
    });
    await vi.waitFor(() =>
      expect(
        rolloutItems.some(
          (item) =>
            (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
              ?.type === "request_permissions",
        ),
      ).toBe(true),
    );

    totalTokens = 2;
    session.emitPhaseEvent({ type: "assistant_text", content: "budget tick" });
    await expect(pending).resolves.toMatchObject({
      decision: { kind: "abort" },
    });
    await vi.waitFor(() =>
      expect(
        rolloutItems.some(
          (item) =>
            (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
              ?.type === "run_terminal",
        ),
      ).toBe(true),
    );

    const canonical = rolloutItems
      .filter(
        (item): item is {
          readonly payload: {
            readonly msg: {
              readonly type: string;
              readonly payload: Record<string, unknown>;
            };
          };
        } => (item as { type?: unknown }).type === "event_msg",
      )
      .map((item) => item.payload);
    const relevant = canonical.filter((event) =>
      ["request_permissions", "permission_decision", "run_terminal"].includes(
        event.msg.type,
      ),
    );
    expect(relevant.map((event) => event.msg.type)).toEqual([
      "request_permissions",
      "permission_decision",
      "run_terminal",
    ]);
    expect(relevant[1]?.msg.payload).toMatchObject({
      callId: "permission-budget-call",
      decision: "abort",
    });
    expect(relevant[2]?.msg.payload).toMatchObject({
      stopReason: "budget_limit",
    });
    expect(canonical.at(-1)?.msg.type).toBe("run_terminal");
  });

  it("commits an epoch-aware terminal at the quiesced shutdown boundary and publishes it canonically", async () => {
    const threadShutdown = vi.fn(async () => {});
    const onActiveAgentTerminated = vi.fn(async () => {});
    const rolloutItems = [
      {
        type: "event_msg",
        payload: {
          id: "reopen-2",
          seq: 7,
          msg: {
            type: "run_reopened",
            payload: {
              runId: "session-stop-epoch-2",
              previousEpoch: 1,
              epoch: 2,
              reason: "review",
              reopenedAt: "2026-05-08T00:00:00.000Z",
            },
          },
        },
      },
    ];
    const { runner, session, shutdown } = makeTopLevelRunner({
      conversationId: "session-stop-epoch-2",
      threadShutdown,
      rolloutItems,
      onActiveAgentTerminated,
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "stop durably",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-stop-epoch-2", {
      sessionId: "session-1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    await runner.stopAgent("session-stop-epoch-2", "user_stopped");

    const terminalCallIndex = session.emit.mock.calls.findIndex(
      ([event]) =>
        (event as { msg?: { type?: unknown } }).msg?.type === "run_terminal",
    );
    expect(terminalCallIndex).toBeGreaterThanOrEqual(0);
    expect(session.emit.mock.calls[terminalCallIndex]![0]).toMatchObject({
      id: "run-terminal:session-stop-epoch-2:2",
      msg: {
        type: "run_terminal",
        payload: {
          epoch: 2,
          status: "cancelled",
          stopReason: "user_stopped",
        },
      },
    });
    expect(
      session.emit.mock.invocationCallOrder[terminalCallIndex]!,
    ).toBeGreaterThan(shutdown.mock.invocationCallOrder[0]!);
    expect(threadShutdown).not.toHaveBeenCalled();
    expect(emitted).toContainEqual(
      expect.objectContaining({
        method: "event.agent_status",
        params: expect.objectContaining({
          eventId: "run-terminal:session-stop-epoch-2:2",
          sequence: expect.any(Number),
          status: "stopped",
          runStatus: "stopped",
        }),
      }),
    );
    expect(onActiveAgentTerminated).toHaveBeenCalledWith(
      "session-stop-epoch-2",
      expect.objectContaining({
        terminal: expect.objectContaining({
          epoch: 2,
          eventId: "run-terminal:session-stop-epoch-2:2",
        }),
      }),
    );
  });

  it("does not advertise a canonical terminal status when its durable append fails", async () => {
    const onActiveAgentTerminated = vi.fn(async () => {});
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-terminal-append-failure",
      onActiveAgentTerminated,
    });
    await runner.startAgent({
      objective: "fail terminal commit",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    session.emit.mockImplementationOnce(() => {
      throw new Error("terminal write failed");
    });

    await expect(
      runner.stopAgent("session-terminal-append-failure", "user_stopped"),
    ).rejects.toThrow("terminal write failed");
    expect(onActiveAgentTerminated).not.toHaveBeenCalled();
  });

  it("announces sequenced pre-attach eviction with valid cursor coordinates", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-buffer-gap",
    });
    await runner.startAgent({
      objective: "fill detached buffer",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    for (let index = 0; index < 1_005; index += 1) {
      session.emit({
        id: `delta-${index}`,
        msg: {
          type: "agent_message_delta",
          payload: { delta: String(index) },
        },
      });
    }
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const emitted: unknown[] = [];
    await runner.attachAgentSessionEvents("session-buffer-gap", {
      sessionId: "session-1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    expect(emitted).toHaveLength(1_001);
    expect(emitted[0]).toMatchObject({
      method: "event.event_gap",
      params: {
        type: "event_gap",
        runId: "session-buffer-gap",
        retiredCount: 6,
        coordinatesAvailable: true,
        afterSequence: 0,
        firstAvailableSequence: 7,
      },
    });
  });

  it("preserves the trusted Ledger clientAction through the session-event bridge", () => {
    const clientAction = {
      type: "ledger_solana_transfer_v1",
      source: "agenc-core",
      targetCapability: "portal.ledger.solana.sign.v1",
      network: "mainnet-beta",
      intentId: "ledger-action-1",
      responseNonce: "response-nonce-ledger-action-1",
      to: "11111111111111111111111111111111",
      lamports: "1",
      expiresAt: "2026-07-10T10:10:00.000Z",
    };
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      id: "ledger-event",
      msg: {
        type: "request_user_input",
        payload: {
          requestId: "ledger-request",
          callId: "ledger-call",
          turnId: "ledger-turn",
          questions: [],
          clientAction,
        },
      },
    });

    expect(daemonEvent).toMatchObject({
      type: "request_user_input",
      payload: { clientAction },
    });
    expect(
      notificationFromDaemonEvent("session-1", "agent-1", daemonEvent!),
    ).toMatchObject({
      method: "event.user_input_request",
      params: { sessionId: "session-1", clientAction },
    });
  });

  it("bridges collab subagent lifecycle session events into daemon session notifications", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "spawn-begin",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            prompt: "inspect /tmp",
            model: "qwen3.6-27b-fp8",
          },
        },
      }),
    ).toEqual({
      id: "spawn-begin",
      eventId: "spawn-begin",
      type: "collab_agent_spawn_begin",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        prompt: "inspect /tmp",
        model: "qwen3.6-27b-fp8",
      },
    });

    expect(
      daemonEventFromUnboundSessionEvent({
        id: "spawn-end",
        msg: {
          type: "collab_agent_spawn_end",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            status: {
              status: "errored",
              turnId: "call-agent",
              error: "task_name is required",
            },
          },
        },
      }),
    ).toEqual({
      id: "spawn-end",
      eventId: "spawn-end",
      type: "collab_agent_spawn_end",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        status: {
          status: "errored",
          turnId: "call-agent",
          error: "task_name is required",
        },
      },
    });

    expect(
      daemonEventFromUnboundSessionEvent({
        id: "agent-status",
        msg: {
          type: "collab_agent_status",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            threadId: "thread-agent",
            agentNickname: "Librarian",
            status: "completed",
          },
        },
      }),
    ).toEqual({
      id: "agent-status",
      eventId: "agent-status",
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "thread-agent",
        agentNickname: "Librarian",
        status: "completed",
      },
    });
  });

  it("bridges tool_progress session events for live daemon snapshots", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "progress-1",
        msg: {
          type: "tool_progress",
          payload: {
            callId: "tool-1",
            toolName: "Bash",
            chunk: "output\n",
            stream: "stdout",
          },
        },
      }),
    ).toEqual({
      id: "progress-1",
      eventId: "progress-1",
      type: "tool_progress",
      payload: {
        callId: "tool-1",
        toolName: "Bash",
        chunk: "output\n",
        stream: "stdout",
      },
    });
  });

  it("starts agent.create through the managed-thread path and keeps it alive", async () => {
    const { runner, bootstrap, permissionUpdates, permissionModeRegistry, shutdown } =
      makeTopLevelRunner({
        conversationId: "parent-session",
        argv: ["/usr/bin/node", "/opt/agenc/bin/agenc.js"],
        env: { AGENC_HOME: "/tmp/agenc-home" },
        now: () => "2026-05-01T12:00:00.500Z",
      });

    await expect(
      runner.startAgent({
        objective: "compile the daemon",
        cwd: "/workspace",
        model: "grok-4",
        metadata: { ticket: "F-06a" },
        unattendedAllow: ["FileRead", "Grep"],
        unattendedDeny: ["exec_command"],
      }),
    ).resolves.toEqual({
      agentId: "parent-session",
      agentPath: "/root",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running",
    });

    expect(bootstrap).toHaveBeenCalledWith({
      env: { AGENC_HOME: "/tmp/agenc-home" },
      argv: [
        "/usr/bin/node",
        "/opt/agenc/bin/agenc.js",
        "--model",
        "grok-4"
      ],
      cwd: "/workspace",
      executionAdmissionAutonomous: true,
    });
    expect(permissionModeRegistry.update).toHaveBeenCalledTimes(1);
    expect(permissionUpdates[0]).toMatchObject({
      mode: "unattended",
      unattendedPolicy: {
        allowlist: ["FileRead", "Grep"],
        denylist: ["system.bash"],
      },
    });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("lets the shared admission kernel exclusively enforce agent budget caps", async () => {
    const executionAdmissionKernel = {} as ExecutionAdmissionKernel;
    const { runner, bootstrap, shutdown } = makeTopLevelRunner({
      conversationId: "kernel-budget-session",
      agentBudget: { token_cap: 0 },
      executionAdmissionKernel,
    });

    await runner.startAgent({ objective: "kernel-owned budget" });
    await Promise.resolve();

    expect(await runner.getAgentSnapshot("kernel-budget-session")).toMatchObject({
      status: "running",
    });
    expect(shutdown).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAdmissionAutonomous: true,
        executionAdmissionKernel,
      }),
    );
  });

  it("setAgentPermissionMode mutates the real session permission registry", async () => {
    const { runner, permissionModeRegistry, permissionUpdates } =
      makeTopLevelRunner({
        conversationId: "parent-session",
        argv: ["node", "agenc"],
      });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });
    permissionUpdates.length = 0;
    (permissionModeRegistry.update as ReturnType<typeof vi.fn>).mockClear();

    const result = await runner.setAgentPermissionMode("parent-session", {
      sessionId: "session_1",
      mode: "plan",
    });

    expect(result).toEqual({
      applied: true,
      previousMode: "default",
      mode: "plan",
    });
    // The genuine daemon registry — the one the tool evaluator reads — is
    // updated to the new mode.
    expect(permissionModeRegistry.update).toHaveBeenCalledTimes(1);
    expect(permissionUpdates[0]).toMatchObject({ mode: "plan" });
  });

  it("getAgentHooksStatus maps the daemon session's real hooks runtime snapshot", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    // Augment the fake session.services with a hooks runtime exposing the
    // genuine ConfiguredHooksRuntime read API the runner consults.
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => false,
          issues: () => [{ level: "warning", message: "heads up" }],
          listHooks: () => [
            {
              event: "PreToolUse",
              matcher: "Read",
              command: {
                type: "command",
                command: "printf ok",
                timeout_ms: 5000,
              },
              source: "config",
              sourcePath: "/home/agent/.agenc/config.toml",
              enabled: true,
              index: 0,
            },
          ],
          latestDiagnostics: () => [],
          setDisabled: vi.fn(),
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const status = await runner.getAgentHooksStatus("parent-session");
    expect(status.available).toBe(true);
    expect(status.sourcePath).toBe("/home/agent/.agenc/config.toml");
    expect(status.disabled).toBe(false);
    expect(status.issues).toEqual([{ level: "warning", message: "heads up" }]);
    expect(status.hooks).toHaveLength(1);
    expect(status.hooks[0]).toMatchObject({
      event: "PreToolUse",
      matcher: "Read",
      index: 0,
      command: { type: "command", command: "printf ok", timeout_ms: 5000 },
    });
  });

  it("getAgentHooksStatus reports available:false when no hooks runtime is present", async () => {
    const { runner } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const status = await runner.getAgentHooksStatus("parent-session");
    expect(status).toEqual({
      available: false,
      sourcePath: "",
      disabled: true,
      issues: [],
      hooks: [],
      diagnostics: [],
    });
  });

  it("setAgentHooksDisabled toggles the daemon session's real hooks runtime", async () => {
    const setDisabled = vi.fn();
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => false,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled,
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.setAgentHooksDisabled("parent-session", {
      disabled: true,
    });
    expect(result).toEqual({ applied: true, disabled: true });
    expect(setDisabled).toHaveBeenCalledWith(true);
  });

  it("applyAgentConfig applies reasoning effort and stages a profile switch", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });

    // Augment the fake session with the config-apply surfaces the real
    // in-process Session exposes: a ConfigStore with a "fast" profile, a
    // mutable sessionConfiguration, and the typed switch mutator.
    const stateObject = {
      sessionConfiguration: {
        collaborationMode: { model: "base-model", reasoningEffort: "medium" },
      },
    };
    const stagedSwitches: Array<{
      provider: string;
      model: string;
      profile?: string;
    }> = [];
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "base-model",
            model_provider: "openai",
            profiles: {
              fast: {
                model: "fast-model",
                model_provider: "openai",
                reasoning_effort: "high",
              },
            },
          }),
        },
      },
      setPendingProviderSwitch: (spec: {
        provider: string;
        model: string;
        profile?: string;
      }) => {
        stagedSwitches.push(spec);
      },
      state: {
        with: async (fn: (state: unknown) => void) => {
          fn(stateObject);
        },
      },
    });

    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      profile: "fast",
    });

    expect(result.applied).toBe(true);
    expect(result.summary).toContain("profile fast");
    expect(result.summary).toContain("reasoning effort ->high");
    // Model/provider delta staged through the genuine switch seam, with the
    // profile threaded so consumePendingProviderSwitch re-resolves it.
    expect(stagedSwitches).toEqual([
      { provider: "openai", model: "fast-model", profile: "fast" },
    ]);
    // Reasoning effort written onto the live sessionConfiguration — the piece
    // the model-switch seam alone cannot do.
    expect(
      stateObject.sessionConfiguration.collaborationMode.reasoningEffort,
    ).toBe("high");
  });

  it("applyAgentConfig reloads config from disk when requested", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    const reload = vi.fn(async () => ({}));
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({ model: "base-model", model_provider: "openai" }),
          reload,
        },
      },
      setPendingProviderSwitch: () => {},
      state: { with: async (fn: (state: unknown) => void) => fn({}) },
    });

    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      reload: true,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.summary).toContain("config reloaded from disk");
  });

  it("setAgentPermissionMode rejects internal-only modes", async () => {
    const { runner } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.setAgentPermissionMode("parent-session", {
        sessionId: "session_1",
        mode: "unattended",
      }),
    ).rejects.toThrow(/internal-only/);
  });

  it("passes the daemon AuthBackend into delegate bootstrap", async () => {
    const authBackend = makeAuthBackend("local", "managed-key");
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "parent-session",
      authBackend,
      argv: ["node", "agenc"],
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    const bootstrapOptions = vi.mocked(bootstrap).mock.calls[0]?.[0];
    expect(bootstrapOptions).toMatchObject({
      argv: ["node", "agenc", ],
      executionAdmissionAutonomous: true,
    });
    expect(bootstrapOptions?.authBackend).not.toBe(authBackend);
    await expect(
      bootstrapOptions?.authBackend?.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({
      provider: "grok",
      sessionId: "daemon-session",
      apiKey: "managed-key",
    });
    expect(authBackend.vendKey).toHaveBeenCalledWith("grok", "daemon-session");
  });

  it("updateRuntimeConfig resets active daemon runtime provider-key cache after auth reload", async () => {
    const initialAuthBackend = makeAuthBackend("local", "managed-key-before");
    const reloadedAuthBackend = makeAuthBackend("remote", "managed-key-after");
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "parent-session",
      authBackend: initialAuthBackend,
      argv: ["node", "agenc"],
    });

    await runner.startAgent({
      objective: "before auth reload",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const firstRuntimeAuthBackend = vi.mocked(bootstrap).mock.calls[0]?.[0]
      .authBackend;
    if (firstRuntimeAuthBackend === undefined) {
      throw new Error("expected first daemon runtime auth backend");
    }
    expect(firstRuntimeAuthBackend.kind).toBe("local");
    await expect(
      firstRuntimeAuthBackend.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-before" });

    runner.updateRuntimeConfig({ authBackend: reloadedAuthBackend });

    await expect(
      firstRuntimeAuthBackend.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-after" });

    await runner.startAgent({
      objective: "after auth reload",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const secondRuntimeAuthBackend = vi.mocked(bootstrap).mock.calls[1]?.[0]
      .authBackend;
    expect(secondRuntimeAuthBackend?.kind).toBe("remote");
    await expect(
      secondRuntimeAuthBackend?.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-after" });
  });

  it("[managed-thread] returns conversationId as agentId with no delegate fork", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-storm-fix",
    });

    const result = await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(result.agentId).toBe("session-storm-fix");
    expect(result.status).toBe("running");
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "user_input",
      input: "hi",
    });
    const submittedInput = stub.thread.submit.mock.calls[0]?.[0];
    expect(JSON.stringify(submittedInput)).not.toContain(
      "You are a subagent spawned",
    );
  });

  it("[managed-thread] passes multimodal initialContent through submit verbatim", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-multimodal",
    });

    await runner.startAgent({
      objective: "ignored when initialContent is set",
      initialContent: [
        { type: "text", text: "hello" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBOR" },
        },
      ],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(stub.thread.submit).toHaveBeenCalledTimes(1);
    expect(stub.thread.submit.mock.calls[0]?.[0]).toEqual({
      type: "user_input",
      input: [
        { type: "text", text: "hello" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBOR" },
        },
      ],
    });
  });

  it("[managed-thread] empty initialContent provisions a passive agent with no turn-1 submit", async () => {
    // The channel gateway (task 34) relies on this contract: agent.create
    // with `initialContent: []` bootstraps a live, runnable agent WITHOUT
    // submitting the objective as a first turn — zero LLM calls until the
    // first real message arrives via message.send.
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-passive-gateway",
    });

    const result = await runner.startAgent({
      objective: "gateway session",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(result.agentId).toBe("session-passive-gateway");
    expect(result.status).toBe("running");
    expect(stub.thread.submit).not.toHaveBeenCalled();
  });

  it("[managed-thread] emits visible user message before routing attached input", async () => {
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-user-order",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-user-order", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;
    control.sendInput.mockImplementation(async () => {
      expect(emitted[0]).toMatchObject({
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "session-user-order",
          eventId: "event:2",
          acceptedAt: "2026-05-01T12:00:01.000Z",
          event: {
            id: "message_1",
            type: "user_message",
            messageId: "message_1",
            streamId: "stream_1",
            acceptedAt: "2026-05-01T12:00:01.000Z",
            payload: {
              message: "continue",
              displayText: "continue",
            },
          },
        },
      });
    });

    await runner.submitAgentMessage("session-user-order", {
      sessionId: "session_1",
      content: "continue",
      originalContent: "continue",
      messageId: "message_1",
      streamId: "stream_1",
      acceptedAt: "2026-05-01T12:00:01.000Z",
    });

    expect(control.sendInput).toHaveBeenCalledWith(
      "session-user-order",
      "continue",
    );
    expect(emitted).toHaveLength(1);
  });

  it("[managed-thread] persists daemon-visible user prompts without duplicate live rows", async () => {
    const { runner, control, session } = makeTopLevelRunner({
      conversationId: "session-user-durable",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "first visible prompt",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(session.emit).toHaveBeenCalledWith({
      id: "user-initial-session-user-durable",
      msg: {
        type: "user_message",
        payload: {
          message: "first visible prompt",
          displayText: "first visible prompt",
        },
      },
    });

    await runner.attachAgentSessionEvents("session-user-durable", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(
      emitted.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { readonly params?: { readonly event?: { type?: string } } })
            .params?.event?.type === "user_message",
      ),
    ).toHaveLength(1);

    emitted.length = 0;
    control.sendInput.mockImplementationOnce(async () => {
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "session-user-durable",
          eventId: "event:2",
          event: {
            id: "message_2",
            type: "user_message",
            messageId: "message_2",
            streamId: "stream_2",
            acceptedAt: "2026-05-01T12:00:02.000Z",
            payload: {
              message: "second visible prompt",
              displayText: "second visible prompt",
            },
          },
        },
      });
    });

    await runner.submitAgentMessage("session-user-durable", {
      sessionId: "session_1",
      content: "second visible prompt",
      originalContent: "second visible prompt",
      messageId: "message_2",
      streamId: "stream_2",
      acceptedAt: "2026-05-01T12:00:02.000Z",
    });

    expect(control.sendInput).toHaveBeenCalledWith(
      "session-user-durable",
      "second visible prompt",
    );
    expect(emitted).toHaveLength(1);
    expect(session.emit).toHaveBeenCalledWith({
      id: "message_2",
      msg: {
        type: "user_message",
        payload: {
          message: "second visible prompt",
          displayText: "second visible prompt",
          messageId: "message_2",
          streamId: "stream_2",
          acceptedAt: "2026-05-01T12:00:02.000Z",
        },
      },
    });
  });

  it("[managed-thread] forwards durable queued prompt events to attached clients", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-queued-user-event",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-queued-user-event", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitSessionEvent({
      id: "queued-1",
      msg: {
        type: "user_message",
        payload: {
          message: "<system-reminder>wrapped</system-reminder>",
          displayText: "visible queued prompt",
          queuedCommandUuid: "queued-1",
        },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            sessionId: "session_1",
            agentId: "session-queued-user-event",
            eventId: "queued-1",
            event: expect.objectContaining({
              id: "queued-1",
              type: "user_message",
              payload: expect.objectContaining({
                displayText: "visible queued prompt",
                queuedCommandUuid: "queued-1",
              }),
            }),
          }),
        }),
      );
    });
  });

  it("[managed-thread] replays objective-only first prompts to attached clients", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-objective-first-prompt",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "audit first prompt",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "user_input",
      input: "audit first prompt",
    });

    await runner.attachAgentSessionEvents("session-objective-first-prompt", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(emitted).toContainEqual(
      expect.objectContaining({
        method: "event.session_event",
        params: expect.objectContaining({
          sessionId: "session_1",
          agentId: "session-objective-first-prompt",
          event: expect.objectContaining({
            type: "user_message",
            payload: expect.objectContaining({
              message: "audit first prompt",
              displayText: "audit first prompt",
            }),
          }),
        }),
      }),
    );
  });

  it("[managed-thread] reports canonical max-turn errors with replay identity", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-max-turns",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-max-turns", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "partial output",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "max_turns",
    });
    session.emit({
      eventId: "max-turn-error",
      id: "max-turn-error",
      msg: {
        type: "error",
        payload: {
          cause: "max_turns",
          message: "Agent exceeded maxTurns",
        },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "error",
            runStatus: "errored",
            message: "Agent exceeded maxTurns",
            eventId: "max-turn-error",
            sequence: expect.any(Number),
          }),
        }),
      );
    });
  });

  it("[managed-thread] keeps interrupted status internal and publishes canonical abort", async () => {
    const { runner, stub, session } = makeTopLevelRunner({
      conversationId: "session-interrupted-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-interrupted-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    stub.pushStatus({
      status: "interrupted",
      turnId: "turn-interrupted",
      endedAtMs: 123,
      reason: "user_cancel",
    } as AgentStatus);
    session.emit({
      eventId: "turn-interrupted",
      id: "turn-interrupted",
      msg: {
        type: "turn_aborted",
        payload: { turnId: "turn-interrupted", reason: "user_cancel" },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            turnId: "turn-interrupted",
            message: "user_cancel",
            eventId: "turn-interrupted",
            sequence: expect.any(Number),
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-interrupted-status"),
    ).resolves.toMatchObject({ status: "idle" });
  });

  it("[managed-thread] records cancelled turn phases as idle and accepts follow-up messages", async () => {
    const { runner, session, control } = makeTopLevelRunner({
      conversationId: "session-cancelled-turn-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-cancelled-turn-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "cancelled",
    });
    session.emit({
      eventId: "turn-cancelled",
      id: "turn-cancelled",
      msg: {
        type: "turn_aborted",
        payload: { turnId: "turn-cancelled", reason: "cancelled" },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "cancelled",
            eventId: "turn-cancelled",
            sequence: expect.any(Number),
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-cancelled-turn-status"),
    ).resolves.toMatchObject({ status: "idle" });

    await expect(
      runner.submitAgentMessage("session-cancelled-turn-status", {
        sessionId: "session_1",
        content: "continue after cancel",
        originalContent: "continue after cancel",
        messageId: "message-after-cancel",
        streamId: "stream-after-cancel",
        acceptedAt: "2026-05-09T00:00:01.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(control.sendInput).toHaveBeenCalledWith(
      "session-cancelled-turn-status",
      "continue after cancel",
    );
  });

  it("[managed-thread] closes active tool rows when a turn is interrupted", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-interrupted-tool",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-interrupted-tool", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "tool_call",
      toolCall: {
        id: "call_1",
        name: "exec_command",
        arguments: '{"cmd":"sleep 120"}',
      },
    });
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "cancelled",
    });
    session.emit({
      eventId: "tool-call-1-interrupted",
      id: "tool-call-1-interrupted",
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: "call_1",
          result: "cancelled",
          isError: true,
          metadata: { cause: "user_interrupted" },
        },
      },
    });
    session.emit({
      eventId: "turn-tool-interrupted",
      id: "turn-tool-interrupted",
      msg: {
        type: "turn_aborted",
        payload: { turnId: "turn-tool-interrupted", reason: "cancelled" },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            event: expect.objectContaining({
              type: "tool_call_completed",
              payload: expect.objectContaining({
                callId: "call_1",
                isError: true,
                metadata: { cause: "user_interrupted" },
              }),
            }),
          }),
        }),
      );
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "cancelled",
          }),
        }),
      );
    });
  });

  it("[managed-thread] records completed turn phases as idle snapshots", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-completed-turn-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-completed-turn-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "done",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "completed",
    });
    session.emit({
      eventId: "turn-completed",
      id: "turn-completed",
      msg: {
        type: "turn_complete",
        payload: {
          turnId: "turn-completed",
          lastAgentMessage: "done",
          completedAt: Date.now(),
          durationMs: 1,
        },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "done",
            eventId: "turn-completed",
            sequence: expect.any(Number),
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-completed-turn-status"),
    ).resolves.toMatchObject({ status: "idle" });
  });

  it("[managed-thread] interruptAgentTurn aborts the active session and submits interrupt op on managed thread", async () => {
    const { runner, session, stub } = makeTopLevelRunner({
      conversationId: "session-interrupt",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.thread.submit.mockClear();

    const interrupted = await runner.interruptAgentTurn(
      "session-interrupt",
      "user_cancel",
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(interrupted).toBe(true);
    expect(session.abortAllTasks).toHaveBeenCalledWith("interrupted");
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "interrupt",
      reason: "user_cancel",
    });
  });

  it("[managed-thread] interruptAgentTurn cascades cancellation to live child agents", async () => {
    const { runner, stub, control } = makeTopLevelRunner({
      conversationId: "session-interrupt-subtree",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    control.openThreadSpawnChildren.mockReturnValue([
      [
        "child-agent",
        {
          agentId: "child-agent",
          agentPath: "/root/worker",
          depth: 1,
        },
      ],
    ]);
    stub.thread.submit.mockClear();

    const interrupted = await runner.interruptAgentTurn(
      "session-interrupt-subtree",
      "user_cancel",
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(interrupted).toBe(true);
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "interrupt",
      reason: "user_cancel",
    });
    expect(control.openThreadSpawnChildren).toHaveBeenCalledWith(
      "session-interrupt-subtree",
    );
    expect(control.interrupt).toHaveBeenCalledWith("child-agent", "user_cancel");
  });

  it("[managed-thread] stopAgent uses bootstrap lifecycle shutdown", async () => {
    const { runner, stub, control, shutdown } = makeTopLevelRunner({
      conversationId: "session-stop",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await runner.stopAgent("session-stop", "user_stopped");

    expect(shutdown).toHaveBeenCalledOnce();
    expect(stub.thread.shutdown).not.toHaveBeenCalled();
    expect(control.shutdown).not.toHaveBeenCalled();
  });
});

describe("managedTokenUsage shape bridging", () => {
  it("reads the daemon session accumulator's promptTokens/completionTokens shape", () => {
    // The cross-turn accumulator (stream-model.ts TokenUsageInfo port) uses
    // promptTokens/completionTokens. Reading only inputTokens/outputTokens
    // shipped {0, 0, N} in every session.snapshot — input/output zeroed while
    // totalTokens matched — so cost-per-fix was unreportable.
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({
          promptTokens: 64,
          completionTokens: 1,
          totalTokens: 65,
        }),
      }),
    ).toEqual({ inputTokens: 64, outputTokens: 1, totalTokens: 65 });
  });

  it("still reads the live-agent inputTokens/outputTokens shape", () => {
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("derives totalTokens when the shape omits it", () => {
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({ promptTokens: 7, completionTokens: 3 }),
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });
});
