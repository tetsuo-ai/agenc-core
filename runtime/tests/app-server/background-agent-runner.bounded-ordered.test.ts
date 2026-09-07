import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
} from "./background-agent-runner.js";
import type { AgentStatus } from "../agents/status.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import {
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
  sessionConfigurationFromAgenCConfig,
  sessionExecutionAuthorityFromAgenCConfig,
} from "../session/configuration.js";

// Mirrors the harness in background-agent-runner.contract.test.ts; trimmed to
// the surface these regression tests exercise (status pushes + attach).
function makeStubConversationThreadManager(opts: {
  readonly threadId: string;
}) {
  let listeners: ((status: AgentStatus) => void)[] = [];
  let currentStatus: AgentStatus = {
    status: "running",
    turnId: "turn-stub",
    startedAtMs: 0,
  } as AgentStatus;
  const managedThread = {
    threadId: opts.threadId,
    agentPath: "/root",
    kind: "root" as const,
    status: () => currentStatus,
    subscribeStatus: (cb: (status: AgentStatus) => void) => {
      cb(currentStatus);
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((listener) => listener !== cb);
      };
    },
    submit: vi.fn(async () => opts.threadId),
    appendMessage: vi.fn(async () => opts.threadId),
    shutdown: vi.fn(async () => {}),
    totalTokenUsage: () => ({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
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

function makeTopLevelRunner(opts: { readonly conversationId: string }) {
  const permissionModeRegistry = new PermissionModeRegistry(
    createEmptyToolPermissionContext(),
  );
  const stub = makeStubConversationThreadManager({
    threadId: opts.conversationId,
  });
  const configuredExecutionAuthority = sessionExecutionAuthorityFromAgenCConfig(
    {
      config: {},
      workspaceRoot: process.cwd(),
      projectTrust: "trusted",
    },
  );
  const sandboxExecutionBroker = new SandboxExecutionBroker({
    cwd: process.cwd(),
    ...sandboxExecutionBrokerAuthorityFromSessionAuthority(
      configuredExecutionAuthority,
      process.cwd(),
    ),
  });
  const sessionState = {
    sessionConfiguration: sessionConfigurationFromAgenCConfig({
      config: {},
      workspaceRoot: process.cwd(),
      model: "grok-4.5",
      provider: "grok",
      projectTrust: "trusted",
    }),
  };
  let nextEventSequence = 0;
  const phaseListeners: ((phase: never) => void)[] = [];
  const session = {
    conversationId: opts.conversationId,
    abortController: new AbortController(),
    permissionModeRegistry,
    get sessionConfiguration() {
      return sessionState.sessionConfiguration;
    },
    subscribeToEvents: (listener: (phase: never) => void) => {
      phaseListeners.push(listener);
      return () => {};
    },
    emitPhaseEvent: () => {},
    prepareEmit: vi.fn((candidate: Record<string, unknown>) => {
      const event = { ...candidate, seq: ++nextEventSequence };
      return {
        event,
        publish: () => event,
      };
    }),
    state: {
      with: async (update: (state: typeof sessionState) => void) => {
        update(sessionState);
      },
    },
    services: { conversationThreadManager: stub, sandboxExecutionBroker },
  };
  const control = {
    shutdown: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(),
    clearConversationHistory: vi.fn(async () => {}),
  };
  const rolloutStore = {
    rolloutPath: `/tmp/${opts.conversationId}.jsonl`,
    readAll: () => [],
    recordRunRuntimeSettingsEvent: vi.fn(() => {}),
    syncCanonicalTail: vi.fn(() => {}),
  };
  const bootstrap = vi.fn(async () => ({
    workspaceRoot: process.cwd(),
    configuredExecutionAuthority,
    prepareConfiguredExecutionAuthority: () => ({
      authority: configuredExecutionAuthority,
      commit: () => {},
      rollback: () => {},
    }),
    session,
    rolloutStore,
    registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
    shutdown: vi.fn(async () => {}),
  })) as unknown as ReturnType<typeof vi.fn> & AgenCBootstrapFunction;
  const runner = new AgenCDelegateBackgroundAgentRunner({
    bootstrap,
    ensureAgentControl: vi.fn(() => ({
      control,
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction,
    now: () => "2026-05-09T00:00:00.000Z",
  });
  return { runner, stub, control, bootstrap, phaseListeners };
}

function runningStatus(turnId: string, startedAtMs: number): AgentStatus {
  return { status: "running", turnId, startedAtMs } as AgentStatus;
}

describe("AgenC background-agent runner: bounded + ordered events", () => {
  afterEach(() => vi.useRealTimers());

  async function complete(
    stub: ReturnType<typeof makeStubConversationThreadManager>,
  ) {
    stub.pushStatus({
      status: "completed",
      lastAgentMessage: "done",
    } as AgentStatus);
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function attach(
    runner: AgenCDelegateBackgroundAgentRunner,
    agentId: string,
  ) {
    const events: unknown[] = [];
    await runner.attachAgentSessionEvents(agentId, {
      sessionId: "late-client",
      emit: (event) => {
        events.push(event);
      },
    });
    return events;
  }

  const startParams = {
    objective: "retention",
    unattendedAllow: [],
    unattendedDeny: [],
  };
  const replayRequired = {
    method: "event.event_gap",
    params: expect.objectContaining({
      retiredCount: 0,
      retiredCountKnown: false,
      coordinatesAvailable: false,
      source: "background_runner_retention",
    }),
  };

  it("expires completed buffers without a later attachment", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "expired-agent",
    });
    await runner.startAgent(startParams);
    await complete(stub);
    expect(await runner.getAgentSnapshot("expired-agent")).toBeNull();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(await attach(runner, "expired-agent")).toEqual([
      expect.objectContaining(replayRequired),
    ]);
  });

  it("does not replay a completed generation into a reused agent ID", async () => {
    const first = makeTopLevelRunner({ conversationId: "reused-agent" });
    await first.runner.startAgent(startParams);
    first.stub.pushStatus(runningStatus("old-generation-only", 1));
    await complete(first.stub);
    const next = makeTopLevelRunner({ conversationId: "reused-agent" });
    first.bootstrap.mockImplementation(() => next.bootstrap({} as never));
    await first.runner.startAgent(startParams);
    const events = await attach(first.runner, "reused-agent");
    expect(JSON.stringify(events)).not.toContain("old-generation-only");
    await complete(next.stub);
  });

  it("bounds replay across thousands of completed unattached agents", async () => {
    const first = makeTopLevelRunner({ conversationId: "completed-0" });
    for (let i = 0; i < 2_000; i++) {
      const next =
        i === 0
          ? first
          : makeTopLevelRunner({ conversationId: `completed-${i}` });
      if (i !== 0)
        first.bootstrap.mockImplementation(() => next.bootstrap({} as never));
      await first.runner.startAgent(startParams);
      await complete(next.stub);
      expect(await first.runner.getAgentSnapshot(`completed-${i}`)).toBeNull();
    }
    expect(await attach(first.runner, "completed-0")).toEqual([
      expect.objectContaining(replayRequired),
    ]);
    const newest = await attach(first.runner, "completed-1999");
    expect(newest.length).toBeGreaterThan(0);
    expect(newest).not.toContainEqual(expect.objectContaining(replayRequired));
  }, 60_000);

  it("ignores delayed phase callbacks after cleanup and after ID reuse", async () => {
    const first = makeTopLevelRunner({ conversationId: "late-phase-agent" });
    await first.runner.startAgent(startParams);
    await complete(first.stub);
    for (const listener of first.phaseListeners) {
      listener({
        type: "assistant_text",
        content: "retired-before-reuse",
      } as never);
    }
    const completedEvents = await attach(first.runner, "late-phase-agent");
    expect(JSON.stringify(completedEvents)).not.toContain(
      "retired-before-reuse",
    );
    const next = makeTopLevelRunner({ conversationId: "late-phase-agent" });
    first.bootstrap.mockImplementation(() => next.bootstrap({} as never));
    await first.runner.startAgent(startParams);
    for (const listener of first.phaseListeners) {
      listener({
        type: "assistant_text",
        content: "retired-after-reuse",
      } as never);
    }
    for (const listener of next.phaseListeners) {
      listener({
        type: "assistant_text",
        content: "current-generation",
      } as never);
    }
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setImmediate(resolve));
    const events = JSON.stringify(
      await attach(first.runner, "late-phase-agent"),
    );
    expect(events).not.toContain("retired-after-reuse");
    expect(events).toContain("current-generation");
    await complete(next.stub);
  });

  it("announces buffered-event eviction while retaining the newest events", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-bounded",
    });
    await runner.startAgent({
      objective: "buffer storm",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    // No session binding is attached yet, so every status event buffers in
    // the agent's bufferedEvents array. Push far more than the 1000-event
    // cap with uniquely-identifiable turn ids so we can assert which
    // survive eviction.
    const PUSH_COUNT = 2_500;
    for (let i = 0; i < PUSH_COUNT; i += 1) {
      stub.pushStatus(runningStatus(`turn-${i}`, i + 1));
    }

    // Status emits are chained per-agent and resolve on the microtask
    // queue; let the whole buffering chain settle before attaching so the
    // events are buffered (and bounded) rather than emitted live.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const emitted: unknown[] = [];
    await runner.attachAgentSessionEvents("session-bounded", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });

    // One observable gap sentinel is exempt from the 1,000 real-event cap.
    expect(emitted).toHaveLength(1_001);
    expect(emitted[0]).toMatchObject({
      method: "event.event_gap",
      params: {
        type: "event_gap",
        kind: "event_gap",
        source: "background_runner_retention",
        reason: "retention",
        retiredCount: 1_502,
        coordinatesAvailable: false,
      },
    });

    // FIFO eviction keeps the NEWEST events. The final push (turn-2499) must
    // survive; an old event well beyond the cap (turn-0) must have been
    // dropped.
    const survivingIds = new Set(
      emitted.map(
        (event) =>
          (event as { params?: { eventId?: unknown } }).params?.eventId,
      ),
    );
    expect(survivingIds.has(`turn-${PUSH_COUNT - 1}`)).toBe(true);
    expect(survivingIds.has("turn-0")).toBe(false);

    // Surviving events remain in arrival order (oldest-kept first).
    const turnNumbers = emitted
      .map((event) => {
        const eventId = (event as { params?: { eventId?: unknown } }).params
          ?.eventId;
        return typeof eventId === "string" && eventId.startsWith("turn-")
          ? Number.parseInt(eventId.slice("turn-".length), 10)
          : Number.NaN;
      })
      .filter((value) => Number.isFinite(value));
    for (let i = 1; i < turnNumbers.length; i += 1) {
      expect(turnNumbers[i]!).toBeGreaterThan(turnNumbers[i - 1]!);
    }
  });

  it("delivers emissions for one agent in arrival order even when an earlier emit's broadcast is slow", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-ordered",
    });
    await runner.startAgent({
      objective: "ordering",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    // Gate the `turn-first` broadcast on a deferred so it completes AFTER
    // the `turn-second` broadcast would otherwise resolve. Without per-agent
    // serialization the two fire-and-forget status emits would race and the
    // second event could be delivered before the first.
    const delivered: string[] = [];
    let releaseFirstEmit: (() => void) | undefined;
    const firstEmitGate = new Promise<void>((resolve) => {
      releaseFirstEmit = resolve;
    });
    await runner.attachAgentSessionEvents("session-ordered", {
      sessionId: "session_1",
      emit: async (event) => {
        const eventId = String(
          (event as { params?: { eventId?: unknown } }).params?.eventId,
        );
        if (eventId === "turn-first") {
          // First of the two contended broadcasts is slow.
          await firstEmitGate;
        }
        delivered.push(eventId);
      },
    });

    // Two fire-and-forget status emits arrive back to back via the same
    // status-subscription callback path (#trackAgentStatus).
    stub.pushStatus(runningStatus("turn-first", 1));
    stub.pushStatus(runningStatus("turn-second", 2));

    // Let the second emit have every opportunity to overtake the first.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // turn-second must NOT be delivered while turn-first is still gated.
    expect(delivered).not.toContain("turn-second");

    releaseFirstEmit?.();
    // Drain the chain.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const contended = delivered.filter(
      (id) => id === "turn-first" || id === "turn-second",
    );
    expect(contended).toEqual(["turn-first", "turn-second"]);
  });
});
