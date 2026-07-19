import { describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
} from "./background-agent-runner.js";
import type { AgentStatus } from "../agents/status.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";

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
  const permissionModeRegistry = {
    current: () => createEmptyToolPermissionContext(),
    update: vi.fn(async (_context: ToolPermissionContext) => {}),
  };
  const stub = makeStubConversationThreadManager({
    threadId: opts.conversationId,
  });
  const session = {
    conversationId: opts.conversationId,
    permissionModeRegistry,
    subscribeToEvents: () => () => {},
    emitPhaseEvent: () => {},
    services: { conversationThreadManager: stub },
  };
  const control = {
    shutdown: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(),
    clearConversationHistory: vi.fn(async () => {}),
  };
  const bootstrap = vi.fn(async () => ({
    session,
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
  return { runner, stub, control };
}

function runningStatus(turnId: string, startedAtMs: number): AgentStatus {
  return { status: "running", turnId, startedAtMs } as AgentStatus;
}

describe("AgenC background-agent runner: bounded + ordered events", () => {
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
