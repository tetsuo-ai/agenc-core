import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgenCSessionSnapshotPolicy } from "./snapshot-policy.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import {
  readRotatedToolOutputLog,
  recordInFlightToolCallStart,
  resolveToolOutputLogPath,
} from "./tool-output-rotation.js";
import { recoverDaemonStateOnStartup } from "./recovery.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-snapshot-policy-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-snapshot-policy-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("AgenCSessionSnapshotPolicy", () => {
  it("snapshots message, tool, and status triggers into session_state_snapshots", () => {
    seedRun("run-1", "session-1");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
        "2026-05-01T00:00:04.000Z",
        "2026-05-01T00:00:05.000Z",
        "2026-05-01T00:00:06.000Z",
        "2026-05-01T00:00:07.000Z",
      ]),
      agencHome: home,
    });

    policy.recordMessageExchange({
      sessionId: "session-1",
      agentId: "run-1",
      content: "hello",
      messageId: "message-1",
      streamId: "stream-1",
      acceptedAt: "2026-05-01T00:00:00.000Z",
    });
    policy.recordSessionEvent("session-1", {
      method: "event.tool_request",
      params: {
        eventId: "event-tool-1",
        requestId: "tool-1",
        toolName: "FileRead",
        recoveryCategory: "idempotent",
        input: { path: "a.txt" },
      },
    });
    policy.recordSessionEvent("session-1", {
      method: "event.session_event",
      params: {
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-1",
            result: "ok",
            isError: false,
          },
        },
      },
    });
    policy.recordAgentStatusTransition({
      sessionId: "session-1",
      agentId: "run-1",
      status: "running",
      transitionAt: "2026-05-01T00:00:03.000Z",
    });

    expect(snapshotCount("session-1")).toBe(4);
    const latest = latestSnapshot("session-1");
    expect(latest.toolState).toMatchObject({
      lastTrigger: "agent_status",
      inFlight: {},
      completed: {
        "tool-1": {
          requestId: "tool-1",
          recoveryCategory: "idempotent",
          status: "completed",
          result: "ok",
        },
      },
      statusTransitions: [
        {
          agentId: "run-1",
          status: "running",
          transitionAt: "2026-05-01T00:00:03.000Z",
        },
      ],
    });
    expect(latest.conversation).toEqual([
      {
        role: "user",
        agentId: "run-1",
        content: "hello",
        messageId: "message-1",
        streamId: "stream-1",
        acceptedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);
    expect(runLastSnapshotAt("run-1")).toBe("2026-05-01T00:00:05.000Z");
  });

  // OOM fix: a long-lived (e.g. `agenc --yolo`) session fires many tool calls;
  // the in-memory `completed` map previously pinned the RAW result of every one
  // forever (unbounded large-payload growth → ~4GB heap → crash). Assert it is
  // now FIFO-capped and each retained result is truncated to a bounded preview.
  it("bounds the in-memory completed tool-call map and truncates large results (OOM fix)", () => {
    seedRun("run-oom", "session-oom");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
      maxCompletedToolCalls: 50,
      maxInMemoryToolResultBytes: 1024,
    });

    const big = "x".repeat(64 * 1024); // 64 KB per result — the leak's payload shape
    const total = 300;
    for (let i = 0; i < total; i++) {
      policy.recordSessionEvent("session-oom", {
        method: "event.tool_request",
        params: {
          eventId: `evt-req-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileRead",
        },
      });
      policy.recordSessionEvent("session-oom", {
        method: "event.session_event",
        params: {
          event: {
            type: "tool_call_completed",
            payload: { callId: `tool-${i}`, result: `${big}-${i}`, isError: false },
          },
        },
      });
    }

    const completed = latestSnapshot("session-oom").toolState.completed as Record<
      string,
      { result?: string }
    >;
    const keys = Object.keys(completed);
    // Before the fix this held all 300 entries (each pinning 64 KB).
    expect(keys.length).toBeLessThanOrEqual(50);
    // Oldest entries are evicted (FIFO); the newest survive.
    expect(completed["tool-0"]).toBeUndefined();
    expect(completed["tool-299"]).toBeDefined();
    // Each retained result is a bounded preview, not the full 64 KB payload
    // (the untruncated result lives in the rotated-output snapshot store).
    for (const key of keys) {
      expect((completed[key]?.result ?? "").length).toBeLessThan(2048);
    }
  });

  // OOM fix: `inFlight` normally drains on tool_call_completed/poisoned, but an
  // orphaned tool call (cancellation, crash, or a lost completion event)
  // previously pinned an entry forever — the sibling leak to `completed`, the
  // same unbounded-per-session class as #946/#947. Assert it is now FIFO-capped.
  it("bounds the in-memory in-flight tool-call map for orphaned calls (OOM fix)", () => {
    seedRun("run-oom-inflight", "session-oom-inflight");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
      maxInFlightToolCalls: 50,
    });

    // 300 tool requests, NONE completed → all remain "in flight" (orphaned).
    const total = 300;
    for (let i = 0; i < total; i++) {
      policy.recordSessionEvent("session-oom-inflight", {
        method: "event.tool_request",
        params: {
          eventId: `evt-req-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileRead",
        },
      });
    }

    const inFlight = latestSnapshot("session-oom-inflight").toolState
      .inFlight as Record<string, unknown>;
    const keys = Object.keys(inFlight);
    // Before the fix this held all 300 orphaned entries.
    expect(keys.length).toBeLessThanOrEqual(50);
    // Oldest are evicted (FIFO by insertion order); the newest survive.
    expect(inFlight["tool-0"]).toBeUndefined();
    expect(inFlight["tool-299"]).toBeDefined();
  });

  // The cap must not interfere with the happy-path lifecycle: a completed tool
  // call still drains its in-flight entry, so a well-behaved session keeps
  // `inFlight` near-empty regardless of the cap.
  it("drains in-flight entries on completion (cap leaves the happy path intact)", () => {
    seedRun("run-inflight-drain", "session-inflight-drain");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      agencHome: home,
      maxInFlightToolCalls: 50,
    });

    for (let i = 0; i < 120; i++) {
      policy.recordSessionEvent("session-inflight-drain", {
        method: "event.tool_request",
        params: {
          eventId: `evt-${i}`,
          requestId: `tool-${i}`,
          toolName: "FileRead",
        },
      });
      policy.recordSessionEvent("session-inflight-drain", {
        method: "event.session_event",
        params: {
          event: {
            type: "tool_call_completed",
            payload: { callId: `tool-${i}`, result: "ok", isError: false },
          },
        },
      });
    }

    const inFlight = latestSnapshot("session-inflight-drain").toolState
      .inFlight as Record<string, unknown>;
    expect(Object.keys(inFlight).length).toBe(0);
  });

  // OOM fix: the per-session status-transition log was an unbounded push target.
  it("bounds the status-transition log (OOM fix)", () => {
    seedRun("run-oom-st", "session-oom-st");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:00.000Z",
      maxStatusTransitions: 25,
    });
    for (let i = 0; i < 300; i++) {
      policy.recordAgentStatusTransition({
        sessionId: "session-oom-st",
        agentId: "run-oom-st",
        status: `status-${i}`, // distinct status forces a push (no dedup)
        transitionAt: "2026-05-01T00:00:00.000Z",
      });
    }
    const transitions = latestSnapshot("session-oom-st").toolState
      .statusTransitions as unknown[];
    expect(transitions.length).toBeLessThanOrEqual(25);
  });

  it("updates agent_runs from runner-emitted terminal run statuses", () => {
    seedRun("run-complete", "session-complete");
    seedRun("run-error", "session-error");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:10.000Z",
        "2026-05-01T00:00:11.000Z",
      ]),
    });

    policy.recordSessionEvent("session-complete", {
      method: "event.agent_status",
      params: {
        agentId: "run-complete",
        status: "idle",
        runStatus: "completed",
      },
    });
    policy.recordSessionEvent("session-error", {
      method: "event.agent_status",
      params: {
        agentId: "run-error",
        status: "error",
        runStatus: "errored",
      },
    });

    expect(runStatus("run-complete")).toEqual({
      status: "completed",
      last_active_at: "2026-05-01T00:00:10.000Z",
    });
    expect(runStatus("run-error")).toEqual({
      status: "errored",
      last_active_at: "2026-05-01T00:00:11.000Z",
    });
  });

  it("persists budget halt markers from runner-emitted agent status", () => {
    seedRun("run-budget", "session-budget");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:12.000Z"]),
    });
    const budgetHalt = {
      kind: "token_cap",
      cap: 10,
      observed: 12,
      reason: "token_cap:12",
      haltedAt: "2026-05-01T00:00:12.000Z",
      tokens: { input: 8, output: 4, total: 12 },
      costUsd: 0.0001,
      wallClockSeconds: 12,
      model: "gpt-5.4",
      provider: "openai",
    };
    const budgetUsage = {
      inputTokens: 8,
      outputTokens: 4,
      totalTokens: 12,
      costUsd: 0.0001,
      costBasis: "input_output_token_usage",
    };

    policy.recordSessionEvent("session-budget", {
      method: "event.agent_status",
      params: {
        agentId: "run-budget",
        status: "stopped",
        runStatus: "stopped",
        message: "agent budget token_cap reached",
        budgetHalt,
        budgetUsage,
      },
    });

    expect(runStatus("run-budget")).toEqual({
      status: "stopped",
      last_active_at: "2026-05-01T00:00:12.000Z",
    });
    expect(runMetadata("run-budget")).toEqual({ budgetHalt, budgetUsage });
    expect(latestSnapshot("session-budget").toolState).toMatchObject({
      statusTransitions: [
        {
          agentId: "run-budget",
          status: "stopped",
          reason: "agent budget token_cap reached",
          metadataPatch: { budgetHalt, budgetUsage },
        },
      ],
    });
  });

  it("ignores array-shaped budget metadata in status events", () => {
    seedRun("run-budget-arrays", "session-budget-arrays");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:12.000Z", "2026-05-01T00:00:13.000Z"]),
    });

    policy.recordSessionEvent("session-budget-arrays", {
      method: "event.agent_status",
      params: {
        agentId: "run-budget-arrays",
        status: "stopped",
        runStatus: "stopped",
        message: "agent budget token_cap reached",
        budgetHalt: ["spoof"],
        budgetUsage: ["spoof"],
      },
    });

    expect(runMetadata("run-budget-arrays")).toBeNull();
    const [transition] = latestSnapshot("session-budget-arrays").toolState
      .statusTransitions as Record<string, unknown>[];
    expect(transition).toMatchObject({
      agentId: "run-budget-arrays",
      status: "stopped",
      reason: "agent budget token_cap reached",
    });
    expect(transition).not.toHaveProperty("metadataPatch");
  });

  it("periodically flushes tracked sessions and stops the timer", () => {
    const clearInterval = vi.fn();
    let tick: (() => void) | undefined;
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:30.000Z",
      ]),
      setInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(30_000);
        tick = callback;
        return { unref: vi.fn() };
      },
      clearInterval,
    });

    policy.recordMessageExchange({
      sessionId: "session-periodic",
      agentId: "agent-periodic",
      content: "watch",
      messageId: "message-periodic",
      streamId: "stream-periodic",
      acceptedAt: "2026-05-01T00:00:00.000Z",
    });
    policy.startPeriodic();
    tick?.();
    policy.stopPeriodic();

    expect(snapshotCount("session-periodic")).toBe(2);
    expect(latestSnapshot("session-periodic").toolState).toMatchObject({
      lastTrigger: "periodic",
    });
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("hydrates recovered session state before periodic flush", () => {
    seedRun("run-hydrate", "session-hydrate");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:30.000Z"]),
    });

    policy.hydrateSession({
      sessionId: "session-hydrate",
      snapshotAt: "2026-05-01T00:00:10.000Z",
      conversation: [{ role: "assistant", content: "previous" }],
      toolState: {
        pending: ["tool-hydrate"],
        inFlight: {
          "tool-hydrate": { requestId: "tool-hydrate", status: "running" },
        },
      },
      mcpConnectionState: { connected: true },
    });
    policy.flushPeriodic();

    const latest = latestSnapshot("session-hydrate");
    expect(latest.conversation).toEqual([
      { role: "assistant", content: "previous" },
    ]);
    expect(latest.toolState).toMatchObject({
      lastTrigger: "periodic",
      pending: ["tool-hydrate"],
      inFlight: {
        "tool-hydrate": { requestId: "tool-hydrate", status: "running" },
      },
    });
    expect(latest.mcpConnectionState).toMatchObject({ connected: true });
    expect(runLastSnapshotAt("run-hydrate")).toBe(
      "2026-05-01T00:00:30.000Z",
    );
  });

  it("drops array-shaped hydrated tool-state maps before flushing", () => {
    seedRun("run-hydrate-arrays", "session-hydrate-arrays");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:30.000Z"]),
    });

    policy.hydrateSession({
      sessionId: "session-hydrate-arrays",
      snapshotAt: "2026-05-01T00:00:10.000Z",
      conversation: [],
      toolState: {
        inFlight: ["spoof"],
        completed: ["spoof"],
      },
      mcpConnectionState: {},
    });
    policy.flushPeriodic();

    expect(latestSnapshot("session-hydrate-arrays").toolState).toMatchObject({
      inFlight: {},
      completed: {},
      lastTrigger: "periodic",
    });
  });

  it("persists session agent ownership for retention pruning", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver);

    policy.trackSession("session-linked", "agent-linked");

    expect(sessionAgent("session-linked")).toBe("agent-linked");
  });

  it("keeps tool identity for completion-only tool events", () => {
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock(["2026-05-01T00:00:00.000Z"]),
    });

    policy.recordSessionEvent("session-completion-only", {
      method: "event.session_event",
      params: {
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-completion-only",
            result: "done",
            isError: false,
            metadata: {
              toolName: "FileRead",
            },
          },
        },
      },
    });

    expect(latestSnapshot("session-completion-only").toolState).toMatchObject({
      completed: {
        "tool-completion-only": {
          requestId: "tool-completion-only",
          toolName: "FileRead",
          status: "completed",
          result: "done",
        },
      },
    });
  });

  it("persists replay poison events as terminal recovery state", () => {
    seedRun("run-replay-poison", "session-replay-poison");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
      ]),
      agencHome: home,
    });

    policy.recordSessionEvent("session-replay-poison", {
      method: "event.tool_request",
      params: {
        agentId: "run-replay-poison",
        requestId: "tool-replay-poison",
        toolName: "FileWrite",
        recoveryCategory: "idempotent",
        input: { file_path: "a.txt", content: "x" },
      },
    });
    policy.recordSessionEvent("session-replay-poison", {
      method: "event.session_event",
      params: {
        agentId: "run-replay-poison",
        event: {
          type: "tool_call_recovery_poisoned",
          payload: {
            callId: "tool-replay-poison",
            result: "current registry says side-effecting",
            metadata: {
              toolName: "FileWrite",
              recoveryCategory: "side-effecting",
            },
          },
        },
      },
    });

    expect(latestSnapshot("session-replay-poison").toolState).toMatchObject({
      inFlight: {},
      completed: {
        "tool-replay-poison": {
          requestId: "tool-replay-poison",
          toolName: "FileWrite",
          recoveryCategory: "side-effecting",
          recoveryAction: "poison",
          status: "poisoned",
          result: "current registry says side-effecting",
        },
      },
    });
    expect(inFlightToolOutput("session-replay-poison", "tool-replay-poison"))
      .toMatchObject({
        status: "poisoned",
        output_partial: "current registry says side-effecting",
      });
    expect(
      inFlightToolRecoveryCategory(
        "session-replay-poison",
        "tool-replay-poison",
      ),
    ).toBe("side-effecting");
  });

  it("persists capped tool output rows from daemon tool events", () => {
    seedRun("agent-output", "session-output");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      agencHome: home,
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
      ]),
      outputRotation: {
        outputPartialMaxBytes: 4,
        logMaxBytes: 3,
        rotatedLogCount: 1,
      },
    });

    policy.recordSessionEvent("session-output", {
      method: "event.tool_request",
      params: {
        agentId: "agent-output",
        eventId: "event-tool-output-start",
        requestId: "tool-output",
        toolName: "Bash",
        input: { command: "printf output" },
      },
    });
    policy.recordSessionEvent("session-output", {
      method: "event.session_event",
      params: {
        agentId: "agent-output",
        event: {
          type: "tool_call_completed",
          payload: {
            callId: "tool-output",
            result: "abcdefghij",
            isError: false,
            metadata: {
              toolName: "Bash",
            },
          },
        },
      },
    });

    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-output",
      toolCallId: "tool-output",
    });
    expect(inFlightToolOutput("session-output", "tool-output")).toEqual({
      status: "completed",
      output_partial: "abcd",
      output_log_path: outputLogPath,
      output_log_bytes: 6,
    });
    expect(existsSync(outputLogPath)).toBe(true);
    expect(existsSync(`${outputLogPath}.1`)).toBe(true);
    expect(inFlightToolRecoveryCategory("session-output", "tool-output")).toBe(
      "side-effecting",
    );
  });

  it("persists capped running output from tool_progress chunks", () => {
    seedRun("agent-progress", "session-progress");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      agencHome: home,
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:03.000Z",
        "2026-05-01T00:00:04.000Z",
        "2026-05-01T00:00:05.000Z",
      ]),
      outputRotation: {
        outputPartialMaxBytes: 4,
        logMaxBytes: 3,
        rotatedLogCount: 1,
      },
    });

    policy.recordSessionEvent("session-progress", {
      method: "event.tool_request",
      params: {
        agentId: "agent-progress",
        eventId: "event-tool-progress-start",
        requestId: "tool-progress",
        toolName: "Bash",
        input: { command: "printf output" },
      },
    });
    for (const chunk of ["abc", "def", "ghij"]) {
      policy.recordSessionEvent("session-progress", {
        method: "event.session_event",
        params: {
          agentId: "agent-progress",
          event: {
            type: "tool_progress",
            payload: {
              callId: "tool-progress",
              toolName: "Bash",
              chunk,
            },
          },
        },
      });
    }

    const outputLogPath = resolveToolOutputLogPath({
      agencHome: home,
      agentId: "agent-progress",
      toolCallId: "tool-progress",
    });
    expect(inFlightToolOutput("session-progress", "tool-progress")).toEqual({
      status: "running",
      output_partial: "abcd",
      output_log_path: outputLogPath,
      output_log_bytes: 6,
    });
    expect(readRotatedToolOutputLog(outputLogPath, {
      outputPartialMaxBytes: 4,
      logMaxBytes: 3,
      rotatedLogCount: 1,
    })).toBe("efghij");
    expect(existsSync(outputLogPath)).toBe(true);
    expect(existsSync(`${outputLogPath}.1`)).toBe(true);
  });

  it("applies snapshotRetention after writing each snapshot", () => {
    seedRun("run-retention", "session-retention");
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: clock([
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:02.000Z",
      ]),
      snapshotRetention: { snapshot_max_count: 2 },
    });

    for (const index of [1, 2, 3]) {
      policy.recordMessageExchange({
        sessionId: "session-retention",
        agentId: "run-retention",
        content: `message-${index}`,
        messageId: `message-${index}`,
        streamId: "stream-retention",
        acceptedAt: `2026-05-01T00:00:0${index}.000Z`,
      });
    }

    expect(snapshotCount("session-retention")).toBe(2);
    expect(latestSnapshot("session-retention").conversation).toEqual([
      expect.objectContaining({ content: "message-1" }),
      expect.objectContaining({ content: "message-2" }),
      expect.objectContaining({ content: "message-3" }),
    ]);
    expect(runLastSnapshotAt("run-retention")).toBe(
      "2026-05-01T00:00:02.000Z",
    );
  });
});

describe("unknown-outcome gate violations in snapshots", () => {
  it("persists (and round-trips) the flag-mode violation for a poisoned session", () => {
    seedRun("run-gate", "session-gate");
    // Crash-poison a side-effecting call through real recovery.
    recordInFlightToolCallStart(driver, {
      sessionId: "session-gate",
      agentId: "run-gate",
      toolCallId: "tool-poisoned",
      toolName: "Bash",
      args: { command: "curl -X POST https://example.invalid/charge" },
      startedAt: "2026-05-01T00:00:00.000Z",
      recoveryCategory: "side-effecting",
      agencHome: home,
    });
    recoverDaemonStateOnStartup(driver);
    // The observer records a NEW already-dispatched side-effecting call:
    // flag mode must record it AND persist the violation into the snapshot.
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      now: () => "2026-05-01T00:00:01.000Z",
      agencHome: home,
    });
    policy.recordSessionEvent("session-gate", {
      method: "event.tool_request",
      params: {
        eventId: "event-gate-1",
        requestId: "tool-dependent",
        toolName: "Bash",
        recoveryCategory: "side-effecting",
        input: { command: "echo dependent" },
      },
    });
    const inFlight = latestSnapshot("session-gate").toolState as {
      inFlight: Record<string, Record<string, unknown>>;
    };
    expect(
      inFlight.inFlight["tool-dependent"]?.unknownOutcomeGateViolation,
    ).toEqual({
      blockedBy: [{ toolCallId: "tool-poisoned", toolName: "Bash" }],
    });
    // The dependent call itself was still recorded (observer never loses
    // bookkeeping).
    const row = driver
      .prepareState<[string], { status?: string }>(
        "SELECT status FROM in_flight_tool_calls WHERE tool_call_id = ?",
      )
      .get("tool-dependent");
    expect(row).toEqual({ status: "running" });
  });
});

function seedRun(runId: string, sessionId: string): void {
  driver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id,
        created_by_client,
        last_snapshot_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      "snapshot work",
      "running",
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      sessionId,
      "client-1",
      null,
    );
}

function snapshotCount(sessionId: string): number {
  return (
    driver
      .prepareState<[string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM session_state_snapshots
         WHERE session_id = ?`,
      )
      .get(sessionId)?.count ?? 0
  );
}

function latestSnapshot(sessionId: string): {
  readonly conversation: unknown;
  readonly toolState: unknown;
  readonly mcpConnectionState: unknown;
} {
  const row = driver
    .prepareState<
      [string],
      {
        conversation_json: string;
        tool_state_json: string;
        mcp_connection_state_json: string;
      }
    >(
      `SELECT conversation_json, tool_state_json, mcp_connection_state_json
       FROM session_state_snapshots
       WHERE session_id = ?
       ORDER BY snapshot_at DESC
       LIMIT 1`,
    )
    .get(sessionId);
  if (row === undefined) throw new Error("snapshot missing");
  return {
    conversation: JSON.parse(row.conversation_json),
    toolState: JSON.parse(row.tool_state_json),
    mcpConnectionState: JSON.parse(row.mcp_connection_state_json),
  };
}

function runLastSnapshotAt(runId: string): string | null {
  return (
    driver
      .prepareState<[string], { last_snapshot_at: string | null }>(
        "SELECT last_snapshot_at FROM agent_runs WHERE id = ?",
      )
      .get(runId)?.last_snapshot_at ?? null
  );
}

function runStatus(runId: string): {
  readonly status: string;
  readonly last_active_at: string;
} | undefined {
  return driver
    .prepareState<[string], { status: string; last_active_at: string }>(
      "SELECT status, last_active_at FROM agent_runs WHERE id = ?",
    )
    .get(runId);
}

function runMetadata(runId: string): unknown {
  const value = driver
    .prepareState<[string], { metadata_json: string | null }>(
      "SELECT metadata_json FROM agent_runs WHERE id = ?",
    )
    .get(runId)?.metadata_json;
  return value === null || value === undefined ? null : JSON.parse(value);
}

function sessionAgent(sessionId: string): string | undefined {
  return driver
    .prepareState<[string], { agent_id: string }>(
      "SELECT agent_id FROM session_agent_links WHERE session_id = ?",
    )
    .get(sessionId)?.agent_id;
}

function inFlightToolOutput(
  sessionId: string,
  toolCallId: string,
): {
  readonly status: string;
  readonly output_partial: string | null;
  readonly output_log_path: string | null;
  readonly output_log_bytes: number;
} {
  const row = driver
    .prepareState<
      [string, string],
      {
        status: string;
        output_partial: string | null;
        output_log_path: string | null;
        output_log_bytes: number;
      }
    >(
      `SELECT status, output_partial, output_log_path, output_log_bytes
       FROM in_flight_tool_calls
       WHERE session_id = ?
         AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId);
  if (row === undefined) throw new Error("tool output row missing");
  return row;
}

function inFlightToolRecoveryCategory(
  sessionId: string,
  toolCallId: string,
): string | undefined {
  return driver
    .prepareState<[string, string], { recovery_category: string }>(
      `SELECT recovery_category
       FROM in_flight_tool_calls
       WHERE session_id = ?
         AND tool_call_id = ?`,
    )
    .get(sessionId, toolCallId)?.recovery_category;
}

function clock(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index] ?? values.at(-1);
    if (value === undefined) throw new Error("empty clock");
    index += 1;
    return value;
  };
}
